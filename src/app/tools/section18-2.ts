/**
 * §18.2 tools — the spec's tool strings for process 18.2, verbatim, via `defineTools("18.2", "qc-audit", defs)`
 * from ../tools.ts (see section13.ts). Spread by ./section18.ts.
 *
 * The Tools line: "`evidence.query(taxonomy_node, loan_ids, period)`, `documents.compile_pdf`, `privilege.screen`,
 * `pii.redact`, `letters.render`, `escalations.create`, `human_portal_task.create`, `cases.create{qc_finding}`".
 * Guardrails: "the agent never characterizes legal compliance in a response without counsel review when a finding
 * alleges a violation; no communication leaves without `officer` signature (baseline §8 item 3 — 'MORA/exam
 * responses' are officer certifications); the partner's officer signs anything submitted under the partner's
 * servicer number."
 *
 * Counsel review on `letters.render` is an act, not an input: `op=counsel_review` is gated to the `attorney` actor and
 * appends `exam.response.counsel_reviewed{draft_hash}` (ops-18-2 recordCounselReview); `op=release` looks that event up
 * for the exact draft being released (counselReviewOnRecord) — no date or role the caller asserts lifts the gate — and,
 * for a finding on record, stores the signed letter and appends `exam.finding.responded{response_document_id}`.
 * Officer approval of a package is the same shape: `documents.compile_pdf op=approve` is gated to the `officer` actor,
 * checked against the `exam.package.assembled` on record (its manifest and review window) and appends
 * `exam.package.approved{manifest_sha256}` (recordPackageApproval); `human_portal_task.create` — the communication
 * that leaves — looks that approval up for the exact manifest it carries (packageApprovalOnRecord) and stamps the
 * approving officer from the record, never from its input. The compiled PDF is persisted as a `documents` row and the
 * hash-manifest QA runs against what was stored, not the in-memory string.
 *
 * `SPEC_TOOLS_18_2` is the full set. `TOOLS_18_2` — what ./section18.ts puts on the bus — is the subset
 * spec/registry/agents.json names for 18.2 (src/app/tools.test.ts refuses any bus tool the registry does not name):
 * tools/extract_agents.py cannot read this Tools line (its first entry carries parentheses and commas), so the
 * registry lists none today and the bus list is empty until the extractor is fixed; the definitions go live then
 * with no code change. 18-2.spec.test.ts binds SPEC_TOOLS_18_2 through the same bus and proves the guardrails.
 */
import { defineTools, compute, guard, never, needsRole, escalate, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { loadAgentsFile } from "../agents.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { fannieEt, federal, servicer, type Calendar } from "../../kernel/calendar/business.ts";
import { compileReviewFile, type ReviewFileInput } from "../../domain/qc-audit/ops.ts";
import {
  type EvidenceBundle, type ExamFindingInput, type ExamResponseLetter, type ProductionDocument, type ResponseParagraph, type SignatureBlock,
  counselReviewOnRecord, ingestExamFinding, latestPackageAssembled, legalConclusion18_2, packageApprovalOnRecord, packageAssembled, privilegeScreen, productionCompleteness, recordCounselReview, recordFindingResponse, recordPackageApproval, renderExamResponse, responseDraftReview, reviewFileQa,
} from "../../domain/qc-audit/ops-18-2.ts";
import type { EventStore } from "../../kernel/events/index.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const date = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const optDate = (i: ToolInput, k: string): PlainDate | null => (typeof i[k] === "string" && i[k] !== "" ? D(i[k] as string) : null);
const calendar = (i: ToolInput): Calendar => (str(i, "calendar") === "federal" ? federal : str(i, "calendar") === "fannie_et" ? fannieEt : servicer);
const writeShaped = (i: ToolInput): boolean => i.op === "write" || i.op === "post" || i.op === "apply" || i.op === "delete" || i.changes !== undefined;
const releaseShaped = (i: ToolInput): boolean => i.op === "release" || i.op === "send" || i.op === "finalize" || flag(i, "send") || flag(i, "release");
const AGENT = "qc-audit";
const GUARD_COUNSEL = "§18.2 guardrails: the agent never characterizes legal compliance in a response without counsel review when a finding alleges a violation";
const GUARD_OFFICER = "§18.2 guardrails: no communication leaves without `officer` signature (baseline §8 item 3 — \"MORA/exam responses\" are officer certifications)";
const GUARD_PARTNER = "§18.2 guardrails: the partner's officer signs anything submitted under the partner's servicer number";
const A2_4_1_02 = "Selling Guide A2-4.1-02: loan records are Fannie Mae's property — nothing Fannie Mae owns is withheld or redacted from a production";
/** The counsel-first condition, recomputed from the tool input (same rule as ops-18-2 responseDraftReview): a finding that alleges a violation, or a legal conclusion in the draft. */
const counselFirst = (i: ToolInput): boolean => flag(i, "alleged_violation") || list<ResponseParagraph>(i, "paragraphs").some((p) => legalConclusion18_2(String(p?.text ?? "")).attorney);
/** The EXAM-RESP-v1 draft the input describes — rendered identically by the handler and by the counsel-review guard, so the hash counsel reviewed is the hash being released. */
const renderFromInput = (i: ToolInput, ctx: CommandContext): ExamResponseLetter => {
  need(i, "examiner", "exam_id", "reference", "paragraphs"); const ref = i.reference as { reference: string; received_on: string; cited_requirement?: string | null }; const el = (i.elements as Record<string, boolean> | undefined) ?? {};
  return renderExamResponse({ examiner: str(i, "examiner"), exam_id: str(i, "exam_id"), date: optDate(i, "date") ?? D(ctx.now.slice(0, 10)), subject_entity: (str(i, "subject_entity") || "partner") as "partner" | "supermortgage" | "both", servicer_number_owner: owner(i), reference: { reference: ref.reference, received_on: D(ref.received_on), cited_requirement: ref.cited_requirement ?? null }, paragraphs: list<ResponseParagraph>(i, "paragraphs"), elements: { root_cause: el.root_cause === true, remediation: el.remediation === true, affected_population_with_count: el.affected_population_with_count === true, evidence_of_correction: el.evidence_of_correction === true }, ...(i.signature_block ? { signature_block: i.signature_block as SignatureBlock } : {}) });
};
/** Counsel's review as recorded in the event store for this exact draft (`exam.response.counsel_reviewed{draft_hash}` appended by the `attorney` actor) — never a date or a role the input asserts. */
const counselReviewFor = (i: ToolInput, ctx: CommandContext) => { const draft = renderFromInput(i, ctx); return { draft, review: counselReviewOnRecord(ctx.events, { exam_id: str(i, "exam_id"), reference: (i.reference as { reference: string }).reference, draft_hash: draft.draft_hash }) }; };
const counselReviewShaped = (i: ToolInput): boolean => i.op === "counsel_review";
const approveShaped = (i: ToolInput): boolean => i.op === "approve";
const owner = (i: ToolInput): "partner" | "supermortgage" => (str(i, "servicer_number_owner") === "supermortgage" ? "supermortgage" : "partner");
const partnerMismatch = (i: ToolInput, entityKey: string): boolean => owner(i) === "partner" && str(i, entityKey) !== "partner";
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
/** The officer approval on record for the package the upload task names (exam, request, manifest) — the only thing that satisfies the officer-signature guardrail on the communication that leaves. */
const approvalFor = (i: ToolInput, events: EventStore) => packageApprovalOnRecord(events, { exam_id: str(i, "exam_id"), request_no: str(i, "request_no"), manifest_sha256: str(i, "manifest_sha256") });
/** The review-window refusal (if any) for the officer's approval today of the package on record — the same check recordPackageApproval makes, surfaced as a guardrail so a refusal writes nothing. */
const approvalWindowRefusal = (i: ToolInput, ctx: CommandContext): string | undefined => {
  const a = latestPackageAssembled(ctx.events, { exam_id: str(i, "exam_id"), request_no: str(i, "request_no") }); if (!a) return `no \`exam.package.assembled\` on record for ${str(i, "exam_id")}/${str(i, "request_no")} — compile the package first`;
  const p = a.payload as { review_opens_on?: string; approve_by?: string }; const on = today(ctx);
  if (p.review_opens_on && on < p.review_opens_on) return `approval ${on} before the package sat ≥1 BD for review (opens ${p.review_opens_on})`;
  if (p.approve_by && on > p.approve_by) return `approval ${on} after approve-by ${p.approve_by} (≥1 BD before due; officer 3 BD) — the extension request is drafted, the package is not approved late`;
  return undefined;
};

export const SPEC_TOOLS_18_2: readonly ToolDef[] = defineTools("18.2", AGENT, [
  // Evidence retrieval via the taxonomy: `evidence_index` rows (loan_id, node, ref_type, ref_id, occurred_at, document_hash) for a taxonomy node, a loan list and a period — the only source a response may cite.
  { name: "evidence.query(taxonomy_node, loan_ids, period)", kind: "read", handler: compute((i, _c, rt) => {
      need(i, "taxonomy_node", "loan_ids"); const node = str(i, "taxonomy_node"); const loans = new Set(list<string>(i, "loan_ids")); const period = (i.period as { from?: string; to?: string } | undefined) ?? {};
      const rows = rt.store.list("evidence_index", (d) => String(d.node ?? "").startsWith(node) && loans.has(String(d.loan_id)) && (!period.from || String(d.occurred_at) >= period.from) && (!period.to || String(d.occurred_at) <= period.to)).map((r) => r.data);
      return { taxonomy_node: node, loan_ids: [...loans], period, rows, evidence_refs: rows.map((r) => ({ ref_type: r.ref_type, ref_id: r.ref_id })) }; }),
    guardrails: [never("EVIDENCE_INDEX_READ_ONLY", "§18.2 data model: `evidence_index` is materialized nightly from `loan_events`, `notices`, `documents`, `timers`, `agent_decisions`, `contacts`, `cases`", writeShaped, "the exam module never writes evidence; a gap is disclosed in the response, never filled")] },
  // Rule 2: the single-PDF A2-4-01 servicing review file with its hash manifest, persisted as a `documents` row, QA'd against the stored copy (contents, header, E-3.2-15 comparison, hash, timer evidence) and, when it passes, `exam.package.assembled{approve_by}`.
  // `op=approve` is the `officer` actor's approval of the package on record (recordPackageApproval → `exam.package.approved{manifest_sha256}`), refused before the review window opens, after approve-by, by anyone else, or by the wrong entity's officer.
  { name: "documents.compile_pdf", kind: "write", handler: compute((i, ctx, rt) => {
      if (approveShaped(i)) {
        need(i, "exam_id", "request_no", "approver_entity");
        const r = recordPackageApproval(ctx.events, { exam_id: str(i, "exam_id"), request_no: str(i, "request_no"), approved_on: today(ctx), approver_entity: str(i, "approver_entity") as "partner" | "supermortgage", servicer_number_owner: owner(i), manifest_sha256: str(i, "manifest_sha256") || null }, ctx.actor);
        const production = r.production ? rt.store.put("exam_productions", `${str(i, "exam_id")}/${str(i, "request_no")}`, { exam_request_id: `${str(i, "exam_id")}/${str(i, "request_no")}`, ...r.production }, ctx.actor, ctx.now) : null;
        return { approved: r.approved, refusal: r.refusal, event_id: r.appended?.id ?? null, production: production?.data ?? null, portal_task: r.portal_task };
      }
      need(i, "exam_id", "request_no", "file", "due_at"); const file = compileReviewFile(i.file as ReviewFileInput); const expect = (i.expect as { bankruptcy?: boolean; foreclosure?: boolean; jurisdiction?: { state: string; county?: string | null; sale_on?: PlainDate | null } } | undefined) ?? {};
      const key = `${str(i, "exam_id")}/${str(i, "request_no")}`; const version = rt.store.list("documents", (d) => d.exam_request_id === key && d.kind === "exam_production_package").length + 1;
      const documentId = str(i, "package_document_id") || `exam-pkg-${str(i, "exam_id")}-${str(i, "request_no")}-v${version}`;
      // The PDF is stored first; the hash-manifest QA reads it back so the check is against what the platform holds, not the string it was hashed from.
      rt.store.put("documents", documentId, { kind: "exam_production_package", exam_id: str(i, "exam_id"), request_no: str(i, "request_no"), exam_request_id: key, sha256: file.manifest.sha256, pages: file.manifest.pages, loan_header: file.manifest.loan_header, content: file.document, retention: "corporate_7y" }, ctx.actor, ctx.now);
      const stored = String(rt.store.require("documents", documentId).data.content ?? "");
      const qa = reviewFileQa(file, stored, { bankruptcy: expect.bankruptcy ?? (i.file as ReviewFileInput).bankruptcy !== null, foreclosure: expect.foreclosure ?? (i.file as ReviewFileInput).foreclosure !== null, ...(expect.jurisdiction ? { jurisdiction: expect.jurisdiction } : {}) });
      const screen = i.privilege_screen as ReturnType<typeof privilegeScreen> | undefined; const docs = list<ProductionDocument>(i, "documents");
      const completeness = screen ? productionCompleteness({ documents: docs, screen, compiled_document_ids: list<string>(i, "compiled_document_ids") }) : null;
      const assembled = packageAssembled({ exam_id: str(i, "exam_id"), request_no: str(i, "request_no"), assembled_on: optDate(i, "assembled_on") ?? today(ctx), due_at: date(i, "due_at"), manifest_sha256: file.manifest.sha256, qa: completeness && !completeness.complete ? { ...qa, passed: false, checklist: [...qa.checklist, { id: "a2401_contents_present" as const, ok: false }] } : qa, cal: calendar(i) });
      const production = rt.store.put("exam_productions", key, { exam_request_id: key, manifest: file.manifest, package_document_id: documentId, privilege_log_document_id: screen?.production.privilege_log_document_id ?? null, pii_redaction_applied: screen?.production.pii_redaction_applied ?? false, approved_by_officer_id: null, approver_entity: null, approved_at: null }, ctx.actor, ctx.now);
      rt.store.put("exam_requests", key, { exam_id: str(i, "exam_id"), request_no: str(i, "request_no"), due_at: str(i, "due_at"), package_document_id: assembled.event ? documentId : null, status: assembled.request_status }, ctx.actor, ctx.now);
      if (assembled.event) { const { type, ...payload } = assembled.event; ctx.events.append({ type, aggregate: { kind: "exam", id: str(i, "exam_id") }, actor: ctx.actor, payload }); }
      return { manifest: file.manifest, package_document_id: documentId, qa, completeness, request_status: assembled.request_status, refusal: assembled.refusal, window: assembled.window, production_version: production.version }; }),
    guardrails: [
      never("PRIVILEGE_SCREEN_REQUIRED", "§18.2 agent design: package QA = A2-4-01 contents, header fields, hash manifest, privilege screen (rule 3)", (i) => i.file !== undefined && i.privilege_screen === undefined && !flag(i, "privilege_screened"), "run `privilege.screen` over the loan's documents first — counsel material is listed on the privilege log, nothing else is withheld"),
      needsRole("OFFICER_SIGNATURE_REQUIRED", GUARD_OFFICER, approveShaped, ["officer"], "package approval is the officer's act — the agent assembles, the officer approves"),
      never("PARTNER_OFFICER_SIGNS", GUARD_PARTNER, (i) => approveShaped(i) && partnerMismatch(i, "approver_entity"), "a package submitted under the partner's servicer number is approved by the partner's officer"),
      guard("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD", "§18.2 timer table: package must sit ≥1 BD for review and be approved ≥1 BD before due; officer has 3 BD", (i, ctx) => (approveShaped(i) && i.exam_id !== undefined ? approvalWindowRefusal(i, ctx) : undefined)),
    ] },
  // Rule 3: counsel work product / attorney communications excluded and logged; every proposed non-privilege withholding refused (A2-4.1-02).
  { name: "privilege.screen", kind: "read", handler: compute((i) => { need(i, "exam_request_id", "documents"); return privilegeScreen({ exam_request_id: str(i, "exam_request_id"), documents: list<ProductionDocument>(i, "documents"), proposed_withholdings: list<{ document_id: string; reason: string }>(i, "proposed_withholdings") }); }),
    guardrails: [never("FNMA_RECORDS_NEVER_WITHHELD", A2_4_1_02, (i) => i.op === "withhold" || flag(i, "withhold"), "a record is kept out of a production only by document class on the privilege log; propose it as `proposed_withholdings` and the screen refuses what is not privileged")] },
  // Rule 3: PII of non-borrowers is redacted; never the borrower's own data, never a Fannie Mae-owned record.
  { name: "pii.redact", kind: "read", handler: compute((i) => { need(i, "documents"); const docs = list<ProductionDocument>(i, "documents"); return { redactions: docs.filter((d) => (d.non_borrower_pii?.length ?? 0) > 0).map((d) => ({ document_id: d.document_id, redacted: [...d.non_borrower_pii!], reason: "non_borrower_pii" as const })), untouched: docs.filter((d) => (d.non_borrower_pii?.length ?? 0) === 0).map((d) => d.document_id) }; }),
    guardrails: [never("NO_REDACTION_OF_FNMA_RECORDS", A2_4_1_02, (i) => str(i, "target") === "borrower" || str(i, "target") === "fannie_mae_record" || flag(i, "redact_borrower_pii"), "only non-borrower PII is redacted; the borrower's data and the record itself go to Fannie Mae as held")] },
  // Outputs: the EXAM-RESP-v1 letter with the guardrail review. `op=counsel_review` is the `attorney` actor's act (recorded as `exam.response.counsel_reviewed{draft_hash}`); `op=release` is the officer's act and is refused before counsel's review of this draft is on record, without the officer, or by the wrong entity's officer.
  { name: "letters.render", kind: "write", handler: compute((i, ctx, rt) => {
      const { draft, review: onRecord } = counselReviewFor(i, ctx);
      if (counselReviewShaped(i)) {
        const rec = recordCounselReview(ctx.events, { exam_id: str(i, "exam_id"), reference: (i.reference as { reference: string }).reference, draft, reviewed_on: optDate(i, "reviewed_on") ?? D(ctx.now.slice(0, 10)) }, ctx.actor);
        return { template: "EXAM-RESP-v1", draft, counsel_review: rec.review, event_id: rec.event?.id ?? null, refusal: rec.refusal, released: false };
      }
      const review = responseDraftReview({ draft, alleged_violation: flag(i, "alleged_violation"), counsel_review: onRecord });
      if (!releaseShaped(i)) return { template: "EXAM-RESP-v1", draft, review, counsel_review: onRecord, released: false };
      // Release: the officer-signed letter is stored as the response document; for a finding on record the release appends `exam.finding.responded{response_document_id}` (satisfies FNMA_SCR_FINDING_RESPONSE_AS_STATED) and the `exam_findings` row carries the document.
      const reference = (i.reference as { reference: string }).reference; const signerEntity = (str(i, "signer_entity") || null) as "partner" | "supermortgage" | null;
      const documentId = str(i, "response_document_id") || `exam-resp-${str(i, "exam_id")}-${reference}-${draft.draft_hash.slice(0, 12)}`;
      rt.store.put("documents", documentId, { kind: "exam_response", template: "EXAM-RESP-v1", exam_id: str(i, "exam_id"), reference, sha256: draft.draft_hash, content: JSON.stringify(draft), signed_by: ctx.actor.id, signer_role: ctx.actor.role ?? null, signer_entity: signerEntity, released_on: today(ctx), retention: "corporate_7y" }, ctx.actor, ctx.now);
      const responded = recordFindingResponse(ctx.events, { exam_id: str(i, "exam_id"), finding_ref: reference, review, signer_entity: signerEntity, servicer_number_owner: owner(i), response_document_id: documentId, submitted_on: today(ctx) }, ctx.actor);
      if (responded.refusal && responded.refusal !== "NO_FINDING_ON_RECORD") throw new RangeError(`release refused: ${responded.refusal}`);
      if (responded.event) rt.store.put("exam_findings", `${str(i, "exam_id")}/${reference}`, { exam_id: str(i, "exam_id"), finding_ref: reference, response_document_id: documentId, status: "responded" }, ctx.actor, ctx.now);
      else ctx.events.append({ type: "exam.response.released", aggregate: { kind: "exam", id: str(i, "exam_id") }, actor: ctx.actor, payload: { exam_id: str(i, "exam_id"), reference, response_document_id: documentId, released_at: today(ctx) } });
      return { template: "EXAM-RESP-v1", draft, review, counsel_review: onRecord, released: true, response_document_id: documentId, event_id: responded.event?.id ?? null, finding_on_record: responded.event !== null }; }),
    guardrails: [
      needsRole("COUNSEL_REVIEW_IS_AN_ATTORNEY_ACT", GUARD_COUNSEL, counselReviewShaped, ["attorney"], "counsel review is recorded by counsel — the agent, the officer or an analyst cannot record it"),
      guard("COUNSEL_REVIEW_REQUIRED", GUARD_COUNSEL, (i, ctx) => (releaseShaped(i) && counselFirst(i) && counselReviewFor(i, ctx).review === null ? "route the draft to `attorney` first; release once counsel's `exam.response.counsel_reviewed` for this draft (same hash) is on record" : undefined)),
      needsRole("OFFICER_SIGNATURE_REQUIRED", GUARD_OFFICER, releaseShaped, ["officer"], "the agent drafts; only the officer releases"),
      never("PARTNER_OFFICER_SIGNS", GUARD_PARTNER, (i) => releaseShaped(i) && partnerMismatch(i, "signer_entity"), "the response goes out under the partner's servicer number — the partner's officer signs"),
    ] },
  // Escalations: `officer` (sign/submit; extension requests), `attorney` (privilege, legal characterizations, litigation discovery), `fnma_portal_operator` (uploads), partner officer.
  { name: "escalations.create", kind: "act", handler: escalate("officer"),
    guardrails: [never("ESCALATION_ROLE", "§18.2 escalations: `officer`, `attorney`, `fnma_portal_operator` (human_portal_task), partner officer", (i) => i.kind !== undefined && !["officer", "attorney", "human_portal_task", "sev1", "sev2", "sev3"].includes(String(i.kind)), "an exam escalation goes to the officer, counsel or the portal operator")] },
  // Integrations: the LQC/portal upload task for `fnma_portal_operator` with the officer-approved package (manifest, identifiers, upload instructions, expected confirmation).
  // The approving officer is read from the `exam.package.approved` on record for this exact manifest (recordPackageApproval), never from the input — the guardrails below look the record up.
  { name: "human_portal_task.create", kind: "act", handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => { need(i, "exam_id", "request_no", "manifest_sha256"); const approval = approvalFor(i, ctx.events); if (!approval) throw new RangeError("no officer approval on record for this package"); return escalate("human_portal_task")({ ...i, kind: "human_portal_task", owner_role: str(i, "owner_role") || "fnma_portal_operator", payload: { exam_id: str(i, "exam_id"), request_no: str(i, "request_no"), manifest_sha256: str(i, "manifest_sha256"), approved_by_officer_id: approval.approved_by_officer_id, approver_entity: approval.approver_entity, approved_at: approval.approved_at, lqc_identifiers: i.lqc_identifiers ?? null, upload_instructions: i.upload_instructions ?? null, expected_confirmation: "LQC confirmation id or screenshot → exam.request.submitted" } }, ctx, rt); },
    guardrails: [
      guard("OFFICER_SIGNATURE_REQUIRED", GUARD_OFFICER, (i, ctx) => (i.exam_id !== undefined && approvalFor(i, ctx.events) === null ? "the upload task carries the officer-approved package only: no `exam.package.approved` on record for this exam, request and manifest (documents.compile_pdf op=approve by the officer) — an officer id asserted on the input is not an approval" : undefined)),
      guard("PARTNER_OFFICER_SIGNS", GUARD_PARTNER, (i, ctx) => (i.exam_id !== undefined && owner(i) === "partner" && approvalFor(i, ctx.events)?.approver_entity === "supermortgage" ? "a package submitted under the partner's servicer number is approved by the partner's officer — the approval on record is the supermortgage officer's" : undefined)),
    ] },
  // Rule 6: every examiner finding becomes a `qc_finding` case with CAPA (18.1 owns the state machine: root cause required before `capa_assigned`).
  // The finding is ingested as `exam.finding.received{response_due_stated, qc_finding_case_id}` (ops-18-2 ingestExamFinding — arms SM_EXAM_REMEDIATION_PLAN_15BD and FNMA_SCR_FINDING_RESPONSE_AS_STATED); CAPA due is computed (receipt + 15 BD), never caller-asserted.
  { name: "cases.create{qc_finding}", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "exam_id", "finding_ref", "text");
      const finding: ExamFindingInput = { exam_id: str(i, "exam_id"), finding_ref: str(i, "finding_ref"), text: str(i, "text"), severity: (str(i, "severity") || "medium") as ExamFindingInput["severity"], taxonomy_nodes: list<string>(i, "taxonomy_nodes"), cited_requirement: str(i, "cited_requirement"), alleged_violation: flag(i, "alleged_violation"), loan_ids: list<string>(i, "loan_ids") };
      const evidence = (i.evidence as EvidenceBundle | undefined) ?? { contacts: [], timers: [] };
      const r = ingestExamFinding(ctx.events, { finding, received_on: optDate(i, "received_on") ?? today(ctx), stated_response_due: optDate(i, "stated_response_due"), examiner: str(i, "examiner") || "Fannie Mae", subject_entity: (str(i, "subject_entity") || "partner") as "partner" | "supermortgage" | "both", servicer_number_owner: owner(i), evidence, cal: calendar(i) }, ctx.actor);
      const id = r.case.case_id;
      const rec = rt.store.put("cases", id, { ...r.case }, ctx.actor, ctx.now);
      rt.store.put("exam_findings", `${finding.exam_id}/${finding.finding_ref}`, { ...r.finding_row }, ctx.actor, ctx.now);
      ctx.events.append({ type: "case.opened", aggregate: { kind: "case", id }, actor: ctx.actor, payload: { case_id: id, kind: "qc_finding", source: "exam", exam_id: finding.exam_id, finding_ref: finding.finding_ref } });
      return { ...rec.data, finding_event_id: r.appended.id, timers: r.timers, draft: r.draft, review: r.review }; }),
    guardrails: [never("QC_FINDING_ONLY", "§18.2 rule 6: every examiner finding becomes a `qc_finding` case with CAPA", (i) => i.kind !== undefined && i.kind !== "qc_finding", "the exam module opens `qc_finding` cases only; other case kinds belong to their sections")] },
]);

const namedByRegistry = new Set(loadAgentsFile().processes.find((p) => p.process === "18.2")?.tools ?? []);
export const TOOLS_18_2: readonly ToolDef[] = SPEC_TOOLS_18_2.filter((t) => namedByRegistry.has(t.name));
