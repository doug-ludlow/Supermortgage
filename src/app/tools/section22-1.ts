/**
 * §22.1 process-owned tools — bus tools for 22.1 defined with `defineTools("22.1", "verification", defs)` from ../tools.ts.
 * Every tool string is one spec/registry/agents.json names for 22.1; src/app/tools.test.ts refuses the rest. Spread by
 * ./index.ts. The handlers are thin: the rules live in src/domain/verification/ops-22-1.ts; the store keeps `documents`
 * (shared, 22.1 columns), `document_extractions`, `document_integrity_checks`, `document_requests` (migration 0078) and the
 * in-flight `needs_list_batches`; the scheduled note date is read from 26.x's `closing.scheduled` events (or the input),
 * the LE-delivered gate from 21.2's `disclosure.le.delivered`. Guardrails encode the AI-design sentences: never alter,
 * redact or "enhance" a document; never accept a `failed` document or waive a Fannie Mae documentation requirement
 * other than through a DU validation outcome or an owning-process rule; never verify a source through contact details
 * taken from a borrower-supplied document; never request a verifying document before the LE is delivered; never send a
 * needs-list item that is not linked to a condition, an intake rule or a freshness rule; never SMS without TCPA consent;
 * never process a document for a person who is not an applicant; `officer` only through 28.4.
 */
import { defineTools, compute, never, needsRole, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { creditor, type Calendar } from "../../kernel/calendar/business.ts";
import type { CorporateAccount } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import type { Recipient, ChannelContext } from "../../notices/channel.ts";
import {
  AGENT, RULE_SET_VERSION, DocumentGateClosed, applyFundingRetention, applyWithdrawalRetention, assertGateOpen, civilDate, classifyDocument, clearFlaggedDocument, computeFreshness, decisionRecord, documentClass, duConditionNeeds, expireRequests, extractFields, freshnessSweep,
  ingestDocument, intakeNeeds, markNeedsListSent, matchToRequests, needsListBatch, needsListPayload, noiaRecommendation, openRequest, paystubGate, releaseQueuedBatches, reviewDue, reviewRequest, runIntegrityBattery, scheduledNoteDate, sendReminders, supersede, taxYearGate, vendorFraudScoreCheck, waiveByDuValidation, waiveRequest,
  type BatteryInput, type DocumentGateCode, type DocumentRecord, type DocumentRequest, type EmailAuthentication, type Extraction, type IntegrityCheck, type NeedsListBatch, type NeedsListItem, type NeedsListParty, type PaystubEvidence, type ReliedDocument, type SourceChannel, type TaxReturnEvidence,
} from "../../domain/verification/ops-22-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && i[k] ? String(i[k]) : null);
const obj = (i: ToolInput, k: string): Record<string, unknown> => ((i[k] as Record<string, unknown> | undefined) ?? {});
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const calendarOf = (i: ToolInput): Calendar => (i.calendar as Calendar | undefined) ?? creditor;
const docOf = (rt: ToolRuntime, i: ToolInput): DocumentRecord => { need(i, "document_id"); return rt.store.require("documents", str(i, "document_id")).data as unknown as DocumentRecord; };
const putDoc = (rt: ToolRuntime, d: DocumentRecord, ctx: CommandContext): void => { rt.store.put("documents", d.document_id, { ...d }, ctx.actor, ctx.now); };
const docsOf = (rt: ToolRuntime, app: string): DocumentRecord[] => rt.store.list("documents", (d) => d.application_id === app).map((r) => r.data as unknown as DocumentRecord);
const requestOf = (rt: ToolRuntime, i: ToolInput): DocumentRequest => { need(i, "request_id"); return rt.store.require("document_requests", str(i, "request_id")).data as unknown as DocumentRequest; };
const requestsOf = (rt: ToolRuntime, app: string): DocumentRequest[] => rt.store.list("document_requests", (d) => d.application_id === app).map((r) => r.data as unknown as DocumentRequest);
const putRequests = (rt: ToolRuntime, rs: readonly DocumentRequest[], ctx: CommandContext): void => { for (const r of rs) rt.store.put("document_requests", r.request_id, { ...r }, ctx.actor, ctx.now); };
const batchesOf = (rt: ToolRuntime, app: string): NeedsListBatch[] => rt.store.list("needs_list_batches", (d) => d.application_id === app).map((r) => r.data as unknown as NeedsListBatch);
const putBatch = (rt: ToolRuntime, b: NeedsListBatch, ctx: CommandContext): void => { rt.store.put("needs_list_batches", b.batch_id, { ...b }, ctx.actor, ctx.now); };
const noteDateOf = (i: ToolInput, ctx: CommandContext, app: string): PlainDate | null => optDate(i, "scheduled_note_date") ?? scheduledNoteDate(ctx.events, app);
/** The INITIAL application date: input, then the `applications` row — never an amendment date (R3). */
const applicationDateOf = (i: ToolInput, rt: ToolRuntime, app: string): PlainDate | null => {
  const explicit = optDate(i, "initial_application_date") ?? optDate(i, "application_date"); if (explicit) return explicit;
  const row = rt.store.get("applications", app)?.data; const v = row?.application_date; return typeof v === "string" && v ? D(v) : null;
};
const leDelivered = (ctx: CommandContext, app: string): boolean => ctx.events.all().some((e) => e.type === "disclosure.le.delivered" && (e.applicationId === app || (e.payload as Record<string, unknown>).application_id === app));
const recipientsOf = (i: ToolInput): Recipient[] => (Array.isArray(i.recipients) ? (i.recipients as Recipient[]) : []);
const partyOf = (i: ToolInput, ctx: CommandContext): NeedsListParty => {
  const p = obj(i, "party");
  const s = (k: string, fallback: string) => (typeof p[k] === "string" && p[k] ? String(p[k]) : typeof i[k] === "string" && i[k] ? String(i[k]) : fallback);
  return { borrower_names: Array.isArray(p.borrower_names) ? (p.borrower_names as string[]) : [], partner_name: s("partner_name", ""), mlo_name: s("mlo_name", ""), mlo_nmlsr_id: s("mlo_nmlsr_id", ""), upload_url: s("upload_url", ""), human_contact: s("human_contact", ""), notice_date: optDate(i, "notice_date") ?? civilDate(ctx.now) };
};
const reliedDocuments = (docs: readonly DocumentRecord[]): ReliedDocument[] => docs.filter((d) => d.status !== "superseded" && d.status !== "quarantined" && d.status !== "failed" && d.document_date !== null)
  .map((d) => ({ document_id: d.document_id, doc_class: d.doc_class, document_date: d.document_date, subject_borrower_id: d.subject_borrower_id, account_last4: typeof d.fields?.account_last4 === "string" ? d.fields.account_last4 : null }));
const paystubsOf = (docs: readonly DocumentRecord[]): PaystubEvidence[] => docs.filter((d) => d.doc_class === "paystub" && d.status !== "superseded" && d.status !== "quarantined" && d.status !== "failed")
  .map((d) => ({ document_id: d.document_id, pay_date: d.document_date, gross_ytd_cents: d.fields?.gross_ytd_cents === undefined || d.fields?.gross_ytd_cents === null ? null : cents(d.fields.gross_ytd_cents), employer_name: d.issuer_name, borrower_id: d.subject_borrower_id }));
const returnsOf = (docs: readonly DocumentRecord[]): TaxReturnEvidence[] => docs.filter((d) => ["form_1040", "irs_return_transcript", "form_1065", "form_1120", "form_1120s"].includes(d.doc_class) && d.status !== "superseded" && d.status !== "failed" && Number.isInteger(Number(d.fields?.tax_year)))
  .map((d) => ({ tax_year: Number(d.fields!.tax_year), kind: d.doc_class === "form_1040" ? "form_1040" : d.doc_class === "irs_return_transcript" ? "irs_return_transcript" : "business_return" }));
/** The facts each gate evaluator reads, assembled from the application's documents plus the caller's overrides. */
const gateFacts = (code: DocumentGateCode, i: ToolInput, ctx: CommandContext, rt: ToolRuntime, app: string): Record<string, unknown> => {
  const docs = docsOf(rt, app); const extra = obj(i, "facts");
  switch (code) {
    case "FNMA_B1_1_03_CREDIT_DOCS_4M": return { scheduled_note_date: noteDateOf(i, ctx, app), relied_documents: Array.isArray(extra.relied_documents) ? extra.relied_documents : reliedDocuments(docs), ...extra };
    case "FNMA_B3_3_2_01_PAYSTUB_30D_GATE": return { initial_application_date: applicationDateOf(i, rt, app), paystubs: Array.isArray(extra.paystubs) ? extra.paystubs : paystubsOf(docs), ...extra };
    case "FNMA_B1_1_03_TAX_YEAR_GATE": return { application_date: applicationDateOf(i, rt, app), scheduled_disbursement_date: optDate(i, "scheduled_disbursement_date"), returns: Array.isArray(extra.returns) ? extra.returns : returnsOf(docs), extension_evidence: flag(i, "extension_evidence"), tax_liability_comparison_recorded: flag(i, "tax_liability_comparison_recorded"), irs_no_transcript_response_recorded: flag(i, "irs_no_transcript_response_recorded"), form_4506c_signed: flag(i, "form_4506c_signed"), ...extra };
  }
};
const GATE_CODES: readonly DocumentGateCode[] = ["FNMA_B1_1_03_CREDIT_DOCS_4M", "FNMA_B3_3_2_01_PAYSTUB_30D_GATE", "FNMA_B1_1_03_TAX_YEAR_GATE"];
const THIRD_PARTY_COSTS = { scope: "corporate" as const, account: "third_party_costs" as const };
const CORPORATE_CASH = { scope: "corporate" as const, account: "corporate_cash" as CorporateAccount };
const ALTERING_OPS = ["alter", "enhance", "redact", "edit", "rewrite"];
/** ops-22-1 gate refusals (DocumentGateClosed) surface as CommandRefused with the gate code and citation. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof DocumentGateClosed) throw new CommandRefused(d.name, e.code, e.citation, e.message); throw e; } } }));
/** A request opened from a NeedsListItem through ops openRequest, stored, with the twin returned when one is open. */
const openItem = (rt: ToolRuntime, ctx: CommandContext, app: string, item: NeedsListItem, requested_at: string, existing: DocumentRequest[], seq: () => string): { request: DocumentRequest; opened: boolean } => {
  const r = openRequest(ctx.events, { request_id: seq(), application_id: app, borrower_id: item.borrower_id, doc_class: item.doc_class, qualifier: item.qualifier ?? {}, reason_code: item.reason_code, reason_text: item.reason_text, condition_id: item.condition_id ?? null, requested_at, existing }, ctx.actor);
  if (r.opened) { putRequests(rt, [r.request], ctx); existing.push(r.request); }
  return { request: r.request, opened: r.opened };
};
const sequence = (rt: ToolRuntime, prefix: string, kind: string, i: ToolInput, key: string): (() => string) => { let n = rt.store.list(kind).length; const given = optStr(i, key); let used = false; return () => { if (given && !used) { used = true; return given; } n += 1; return `${prefix}-${n}`; }; };
const sla = (d: DocumentRecord["received_at"], cal: Calendar) => ({ n: 1, unit: "business_days_creditor", due: reviewDue(d, cal) });
let REG: TimerRegistry | null = null;
const registryDef = (code: string) => { REG ??= loadOverriddenRegistry(); const d = REG.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };
/**
 * The engine keys a timer instance to the application, so one `document.received{request_id}` (or `document_request.satisfied`) satisfies every
 * armed instance of the code on the application. The clocks of the OTHER open requests/documents are re-armed from their original trigger events
 * (same anchor, same due date), the way the engine itself re-arms a recurring row — `keep` says which trigger payloads still need their clock.
 */
const rearmOthers = (ctx: CommandContext, code: string, app: string, keep: (triggerPayload: Record<string, unknown>) => boolean, act: () => void): void => {
  const before = ctx.timers.byCode(code).filter((t) => (t.status === "armed" || t.status === "breached") && t.applicationId === app);
  act();
  for (const t of before) {
    const trig = ctx.events.all().find((e) => e.id === t.armedByEventId); if (!trig || !keep(trig.payload as Record<string, unknown>)) continue;
    const inst = ctx.timers.byCode(code).find((x) => x.id === t.id); if (!inst || inst.status === "armed" || inst.status === "breached") continue;
    if (!ctx.timers.byCode(code).some((x) => x.armedByEventId === trig.id && (x.status === "armed" || x.status === "breached"))) ctx.timers.arm(registryDef(code), trig);
  }
};

export const TOOLS_22_1: readonly ToolDef[] = defineTools("22.1", "verification", refusing([
  // Intake: borrower upload / e-mail / mail scan / vendor delivery → `document.received` (with request_id when uploaded against a request); e-mail attachments pass
  // sender authentication or are quarantined with a portal prompt (T11); a non-applicant subject is quarantined; a duplicate hash is linked, not re-processed.
  { name: "ingestDocument", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "document_id", "source_channel", "sha256"); const app = appOf(i, ctx); const received_at = at(i, "received_at", ctx);
      const request_id = optStr(i, "request_id");
      let r!: ReturnType<typeof ingestDocument>;
      rearmOthers(ctx, "SM_NEEDS_LIST_BORROWER_RESPONSE_5", app, (p) => p.request_id !== request_id, () => {
        r = ingestDocument(ctx.events, { document_id: str(i, "document_id"), application_id: app, source_channel: str(i, "source_channel") as SourceChannel, sender_identity: obj(i, "sender_identity"), received_at, sha256: str(i, "sha256"), page_count: Number(i.page_count ?? 0),
          declared_class: optStr(i, "declared_class"), subject_borrower_id: optStr(i, "subject_borrower_id"), ...(Array.isArray(i.applicant_borrower_ids) ? { applicant_borrower_ids: i.applicant_borrower_ids as string[] } : {}), request_id,
          email_authentication: (i.email_authentication as EmailAuthentication | undefined) ?? null, pii_flags: list<string>(i, "pii_flags"), existing: docsOf(rt, app) }, ctx.actor);
      });
      putDoc(rt, r.doc, ctx);
      for (const c of r.checks) rt.store.put("document_integrity_checks", `${r.doc.document_id}:${c.check_type}:${rt.store.list("document_integrity_checks").length + 1}`, { document_id: r.doc.document_id, ...c, checked_at: received_at }, ctx.actor, ctx.now);
      if (r.quarantined) return { document_id: r.doc.document_id, status: r.doc.status, integrity_status: r.doc.integrity_status, quarantined: true, quarantine_reason: r.quarantine_reason, sender_authentication: r.checks.find((c) => c.check_type === "sender_authentication")?.result ?? "n_a", portal_upload_prompt: r.portal_upload_prompt, request_satisfied: false, event_id: r.event.id };
      const reqs = requestsOf(rt, app); const m = matchToRequests(r.doc, reqs); putRequests(rt, m.matched, ctx);
      if (m.matched.length) putDoc(rt, { ...r.doc, request_ids: [...new Set([...r.doc.request_ids, ...m.matched.map((x) => x.request_id)])] }, ctx);
      return { document_id: r.doc.document_id, status: r.doc.status, integrity_status: r.doc.integrity_status, quarantined: false, duplicate_of: r.duplicate_of, retention_classes: r.doc.retention_classes, matched_request_ids: m.matched.map((x) => x.request_id), review_due: reviewDue(received_at, calendarOf(i)), review_timer: "SM_NEEDS_LIST_REVIEW_1BD", event_id: r.event.id }; }),
    guardrails: [never("NON_APPLICANT_DOCUMENT", "22.1 AI design guardrail: never process a document for a person who is not an applicant on the file (wrong-borrower upload is quarantined)", (i) => i.subject_is_applicant === false, "the upload is quarantined and deleted after 30 days unless the borrower explains (31.3 privacy incident check)"),
      never("DOCUMENT_ALTERATION", "22.1 AI design guardrail; A2-4.1-03: the agent may never alter, redact or 'enhance' a document — only derived data is created", (i) => ALTERING_OPS.includes(str(i, "op")), "store the original bytes; create derived data only")] },
  // Classification: per-class confidence floor; two passes (second at 400 dpi), then the borrower's answer in the portal, then `human_agent`.
  { name: "classifyDocument", kind: "write", handler: compute((i, ctx, rt) => {
      const doc = docOf(rt, i); need(i, "doc_class");
      const r = classifyDocument(ctx.events, doc, { doc_class: str(i, "doc_class"), confidence: i.confidence === undefined ? (flag(i, "borrower_declared") ? 1 : 0) : num(i, "confidence"), classifier_version: str(i, "classifier_version") || "doc-classifier-2026.09", doc_subclass: optStr(i, "doc_subclass"), ...(i.ocr_dpi !== undefined ? { ocr_dpi: num(i, "ocr_dpi") } : {}), borrower_declared: flag(i, "borrower_declared") }, ctx.actor, at(i, "at", ctx));
      putDoc(rt, r.doc, ctx);
      let escalation_id: string | null = null;
      if (r.next_step === "human_agent") escalation_id = rt.escalations.open({ kind: "human_agent", applicationId: doc.application_id, payload: { reason: "unclassified after two classifier passes and the borrower's answer", document_id: doc.document_id } }, ctx.actor).id;
      return { document_id: doc.document_id, doc_class: r.doc.doc_class, doc_family: r.doc.doc_class === "unclassified" ? "other" : documentClass(r.doc.doc_class).family, status: r.doc.status, confidence: r.doc.classification_confidence, next_step: r.next_step, escalation_id, event_id: r.event.id }; }),
    guardrails: [never("DOCUMENT_ALTERATION", "22.1 AI design guardrail: only derived data is created", (i) => ALTERING_OPS.includes(str(i, "op")), "classification is derived data; the document is untouched")] },
  // Extraction: per-class fields → R1 document date, R2 freshness against the current scheduled note date (`document.extracted{expires_at, scheduled_note_date}` arms the 4M gate and the 14-day warning); a newer document of the same class/subject/period supersedes the prior.
  { name: "extractFields", kind: "write", handler: compute((i, ctx, rt) => {
      const doc = docOf(rt, i); need(i, "fields"); const app = doc.application_id; const created_at = at(i, "at", ctx);
      const r = extractFields(ctx.events, doc, { extraction_id: str(i, "extraction_id") || `x-${rt.store.list("document_extractions").length + 1}`, fields: obj(i, "fields"), ...(optStr(i, "schema_version") ? { schema_version: str(i, "schema_version") } : {}), extractor_version: str(i, "extractor_version") || "doc-extractor-2026.09", ocr_engine: optStr(i, "ocr_engine"), field_confidence: obj(i, "field_confidence") as Record<string, number>, human_verified: flag(i, "human_verified"), created_at },
        { scheduled_note_date: noteDateOf(i, ctx, app), application_date: applicationDateOf(i, rt, app), as_of: optDate(i, "as_of") ?? civilDate(created_at) }, ctx.actor);
      rt.store.put("document_extractions", r.extraction.extraction_id, { ...r.extraction } as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      const s = supersede(ctx.events, docsOf(rt, app).filter((d) => d.document_id !== doc.document_id), r.doc, ctx.actor, created_at);
      for (const d of s.docs) if (s.superseded.includes(d.document_id)) putDoc(rt, d, ctx);
      putDoc(rt, r.doc, ctx);
      return { document_id: doc.document_id, extraction_id: r.extraction.extraction_id, document_date: r.doc.document_date, period_end: r.doc.period_end, freshness: r.freshness, expires_at: r.freshness.expires_at, freshness_status: r.freshness.status, superseded_document_ids: s.superseded, event_id: r.event.id }; }),
    guardrails: [never("DOCUMENT_ALTERATION", "22.1 AI design guardrail: only derived data is created", (i) => ALTERING_OPS.includes(str(i, "op")), "extraction is derived data; the document is untouched")] },
  // R5 battery → pass/warn/fail per check, aggregate passed/flagged/failed (`document.integrity.*`); failed → sev-2 underwriting_reviewer with a 1 business_days_creditor SLA and a 22.6 fraud-case candidate;
  // a flagged income/asset document gets a source-obtained request before 22.3/22.4 may use the fact. op=clear: flagged → accepted only with a written decision naming the resolving evidence; failed is never accepted.
  { name: "runIntegrityBattery", kind: "write", handler: compute((i, ctx, rt) => {
      const doc = docOf(rt, i); const app = doc.application_id; const when = at(i, "at", ctx);
      if (i.op === "clear") {
        need(i, "rationale", "resolving_evidence_document_ids", "decision_id");
        const next = clearFlaggedDocument(ctx.events, doc, { rationale: str(i, "rationale"), resolving_evidence_document_ids: list<string>(i, "resolving_evidence_document_ids"), decision_id: str(i, "decision_id") }, ctx.actor, when);
        putDoc(rt, next, ctx); return { document_id: doc.document_id, integrity_status: next.integrity_status, status: next.status };
      }
      const b = (i.battery as BatteryInput | undefined) ?? {};
      const r = runIntegrityBattery(ctx.events, { ...doc, sole_evidence: i.sole_evidence === undefined ? doc.sole_evidence : flag(i, "sole_evidence") }, b, ctx.actor, when, calendarOf(i));
      putDoc(rt, r.doc, ctx);
      for (const c of r.checks) rt.store.put("document_integrity_checks", `${doc.document_id}:${c.check_type}:${rt.store.list("document_integrity_checks").length + 1}`, { document_id: doc.document_id, ...c, checked_at: when }, ctx.actor, ctx.now);
      let escalation_id: string | null = null; let fraud_case_candidate = false; let follow_up_request_id: string | null = null;
      if (r.escalation) {
        const e = rt.escalations.open({ kind: "underwriting_reviewer", applicationId: app, severity: r.escalation.severity, payload: { reason: "document integrity failed", document_id: doc.document_id, doc_class: doc.doc_class, sla: r.escalation.sla, fraud_case_candidate: true, hand_off: "22.6", findings: (r.event.payload as Record<string, unknown>).findings } }, ctx.actor);
        escalation_id = e.id; fraud_case_candidate = true;
        ctx.events.append({ type: "fraud.case.candidate", applicationId: app, actor: ctx.actor, occurredAt: when, payload: { application_id: app, source: "origination", document_id: doc.document_id, doc_class: doc.doc_class, escalation_id: e.id, opened_by: "22.1", owner: "22.6", reason: "document.integrity.failed" } });
      }
      if (r.follow_up_request && doc.subject_borrower_id) {
        const existing = requestsOf(rt, app);
        const o = openItem(rt, ctx, app, { borrower_id: doc.subject_borrower_id, doc_class: r.follow_up_request.doc_class, qualifier: { employer: doc.issuer_name, for_document_id: doc.document_id }, reason_code: r.follow_up_request.reason_code, reason_text: r.follow_up_request.reason_text }, when, existing, sequence(rt, "req", "document_requests", i, "follow_up_request_id"));
        follow_up_request_id = o.request.request_id;
      }
      return { document_id: doc.document_id, integrity_status: r.integrity_status, status: r.doc.status, checks: r.checks.map((c) => ({ check_type: c.check_type, result: c.result, details: c.details })), escalation_id, escalation_role: r.escalation?.kind ?? null, escalation_sla: r.escalation?.sla ?? null, fraud_case_candidate, follow_up_request: r.follow_up_request, follow_up_request_id, income_usable_by_22_3: r.integrity_status === "passed", event_id: r.event.id }; }),
    guardrails: [never("ACCEPT_FAILED_DOCUMENT", "22.1 AI design guardrail: the agent may never accept a `failed` document (22.6 owns the fraud review)", (i) => i.op === "clear" && flag(i, "accept_failed"), "a failed document is never silently dropped or accepted"),
      never("DOCUMENT_ALTERATION", "22.1 AI design guardrail: only derived data is created", (i) => ALTERING_OPS.includes(str(i, "op")), "the battery reads; it never writes into the document")] },
  // Document-forensics vendor (contract-gated; open question 5): the vendor band maps to pass/warn/fail; an outage is `n_a` (in-house battery only, flagged ceiling). The SM-borne fee posts to third_party_costs (baseline §5).
  { name: "orderForensicScan", kind: "act", moneyFields: ["fee_cents"], handler: compute(async (i, ctx, rt) => {
      const doc = docOf(rt, i); const when = at(i, "at", ctx);
      const svc = rt.services.documentForensics as { scan(d: { document_id: string; sha256: string; doc_class: string }): Promise<{ vendor: string; band: "low" | "medium" | "high" | "unavailable"; score?: number | null }> | { vendor: string; band: "low" | "medium" | "high" | "unavailable"; score?: number | null } } | undefined;
      const given = i.vendor_result as { vendor: string; band: "low" | "medium" | "high" | "unavailable"; score?: number | null } | undefined;
      const result = given ?? (svc ? await svc.scan({ document_id: doc.document_id, sha256: doc.sha256, doc_class: doc.doc_class }) : { vendor: str(i, "vendor") || "document-forensics", band: "unavailable" as const, score: null });
      const c: IntegrityCheck = vendorFraudScoreCheck(result);
      rt.store.put("document_integrity_checks", `${doc.document_id}:vendor_fraud_score:${rt.store.list("document_integrity_checks").length + 1}`, { document_id: doc.document_id, ...c, checked_at: when }, ctx.actor, ctx.now);
      const fee = cents(i.fee_cents); let ledger_set_id: string | null = null;
      if (fee > 0n && result.band !== "unavailable") ledger_set_id = ctx.ledger.post({ effectiveDate: civilDate(when), description: `document forensic scan ${doc.document_id} (${result.vendor})`, lines: [{ account: THIRD_PARTY_COSTS, amountCents: fee, ruleRef: "22.1 outputs: vendor forensic-scan fees post to third_party_costs (SM-borne) per baseline §5" }, { account: CORPORATE_CASH, amountCents: -fee, ruleRef: "22.1 outputs: SM-borne vendor fee settled from corporate cash" }] }, ctx.now).id;
      ctx.events.append({ type: "document.forensic_scan.ordered", applicationId: doc.application_id, actor: ctx.actor, occurredAt: when, payload: { application_id: doc.application_id, document_id: doc.document_id, vendor: result.vendor, band: result.band, result: c.result, outage: result.band === "unavailable", fee_cents: String(fee), ledger_set_id } });
      return { document_id: doc.document_id, vendor: result.vendor, band: result.band, result: c.result, outage: result.band === "unavailable", ceiling_when_outage: "flagged", ledger_set_id }; }),
    guardrails: [never("DOCUMENT_ALTERATION", "22.1 AI design guardrail: the vendor receives bytes or fields; nothing is written back", (i) => ALTERING_OPS.includes(str(i, "op")), "only derived data is created")] },
  // R2/R3/R4: freshness of one document (default), op=gate → assertGateOpen(applicationId, code) over the application's relied documents (refuses on an expired document),
  // op=sweep → the nightly re-evaluation against the scheduled note date (expiring/expired events + replacement requests 14 days ahead), op=paystub_floor / op=tax_year → the rule outputs.
  { name: "computeFreshness", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "document";
      if (op === "gate") {
        need(i, "gate"); const app = appOf(i, ctx); const code = str(i, "gate") as DocumentGateCode; if (!GATE_CODES.includes(code)) throw new RangeError(`gate ${code} is not one of ${GATE_CODES.join("/")}`);
        const facts = gateFacts(code, i, ctx, rt, app); assertGateOpen(app, code, facts); return { gate: code, open: true, application_id: app, facts_summary: { scheduled_note_date: facts.scheduled_note_date ?? null, initial_application_date: facts.initial_application_date ?? facts.application_date ?? null, documents: Array.isArray(facts.relied_documents) ? (facts.relied_documents as unknown[]).length : Array.isArray(facts.paystubs) ? (facts.paystubs as unknown[]).length : Array.isArray(facts.returns) ? (facts.returns as unknown[]).length : 0 } };
      }
      if (op === "sweep") {
        const app = appOf(i, ctx); const note = noteDateOf(i, ctx, app); if (!note) throw new RangeError("scheduled_note_date is required (no closing.scheduled event on the application)");
        const s = freshnessSweep(ctx.events, docsOf(rt, app), { application_id: app, scheduled_note_date: note, as_of: optDate(i, "as_of") ?? civilDate(ctx.now) }, ctx.actor);
        for (const d of s.docs) putDoc(rt, d, ctx);
        const existing = requestsOf(rt, app); const seq = sequence(rt, "req", "document_requests", i, "request_id"); const opened: string[] = [];
        for (const item of s.replacement_requests) { const o = openItem(rt, ctx, app, item, ctx.now, existing, seq); if (o.opened) opened.push(o.request.request_id); }
        return { application_id: app, scheduled_note_date: note, expiring: s.expiring, expired: s.expired, replacement_request_ids: opened };
      }
      if (op === "paystub_floor") { const app = appOf(i, ctx); const appDate = applicationDateOf(i, rt, app); if (!appDate) throw new RangeError("initial_application_date is required"); const g = paystubGate({ initial_application_date: appDate, paystubs: Array.isArray(i.paystubs) ? (i.paystubs as PaystubEvidence[]) : paystubsOf(docsOf(rt, app)) }); return { gate: "FNMA_B3_3_2_01_PAYSTUB_30D_GATE", ...g, amended_on: optDate(i, "amended_on"), rebased: false }; }
      if (op === "tax_year") { const app = appOf(i, ctx); const f = gateFacts("FNMA_B1_1_03_TAX_YEAR_GATE", i, ctx, rt, app); need(f as ToolInput, "application_date", "scheduled_disbursement_date"); const g = taxYearGate({ application_date: D(String(f.application_date)), scheduled_disbursement_date: D(String(f.scheduled_disbursement_date)), returns: f.returns as TaxReturnEvidence[], extension_evidence: f.extension_evidence === true, tax_liability_comparison_recorded: f.tax_liability_comparison_recorded === true, irs_no_transcript_response_recorded: f.irs_no_transcript_response_recorded === true, form_4506c_signed: f.form_4506c_signed === true }); return { gate: "FNMA_B1_1_03_TAX_YEAR_GATE", ...g }; }
      if (typeof i.doc_class === "string" && i.document_id === undefined) return computeFreshness({ doc_class: str(i, "doc_class"), document_date: optDate(i, "document_date"), scheduled_note_date: optDate(i, "scheduled_note_date"), as_of: optDate(i, "as_of") });
      const doc = docOf(rt, i); const fr = computeFreshness({ doc_class: doc.doc_class, document_date: doc.document_date, scheduled_note_date: noteDateOf(i, ctx, doc.application_id), as_of: optDate(i, "as_of") ?? civilDate(ctx.now) });
      putDoc(rt, { ...doc, freshness_basis: fr.basis, freshness_status: fr.status, expires_at: fr.expires_at }, ctx); return { document_id: doc.document_id, ...fr }; }),
    guardrails: [never("APPRAISAL_AGE_NOT_HERE", "22.1 timer table: FNMA_B4_1_2_04_APPRAISAL_12M and the 4-month update gates are 24.1's — 22.1 classifies and stores appraisal documents but never computes their age", (i) => str(i, "gate").startsWith("FNMA_B4_1_2_04"), "call 24.1's valuation gate"),
      never("DISASTER_EXCEPTION_NOT_HERE", "22.1: the natural-disaster exception (B2-3-05) is applied only by 24.1/23.3", (i) => flag(i, "apply_disaster_exception"), "this process only flags")] },
  // Link an intake to the open requests for its borrower/class(/qualifier); op=review applies the satisfaction guards (integrity passed, not expired against the note date, subject matches, paystub floor) →
  // `document_request.satisfied` (+ `condition.clear.proposed` for 23.3) or the request re-opened with the reason; the review is due +1 business_days_creditor from receipt.
  { name: "matchToRequests", kind: "write", handler: compute((i, ctx, rt) => {
      const doc = docOf(rt, i); const app = doc.application_id; const when = at(i, "at", ctx);
      const reqs = requestsOf(rt, app);
      if (i.op === "review") {
        const targets = reqs.filter((r) => (optStr(i, "request_id") ? r.request_id === str(i, "request_id") : r.received_document_id === doc.document_id || doc.request_ids.includes(r.request_id)) && ["received", "under_review", "open", "reminded"].includes(r.status));
        if (!targets.length) throw new RangeError(`no received request for document ${doc.document_id}`);
        let out!: ReturnType<typeof reviewRequest>[];
        rearmOthers(ctx, "SM_NEEDS_LIST_REVIEW_1BD", app, (p) => p.document_id !== doc.document_id, () => { out = targets.map((r) => reviewRequest(ctx.events, r, doc, { scheduled_note_date: noteDateOf(i, ctx, app), initial_application_date: applicationDateOf(i, rt, app), at: when }, ctx.actor)); });
        putRequests(rt, out.map((o) => o.request), ctx);
        if (out.some((o) => o.satisfied)) putDoc(rt, { ...doc, status: "linked" }, ctx);
        return { document_id: doc.document_id, reviews: out.map((o) => ({ request_id: o.request.request_id, status: o.request.status, satisfied: o.satisfied, reason: o.reason, condition_clear_proposal: o.condition_clear_proposal })), review_due: reviewDue(doc.received_at, calendarOf(i)) };
      }
      const m = matchToRequests(doc, reqs); putRequests(rt, m.matched, ctx);
      const next: DocumentRecord = { ...doc, request_ids: [...new Set([...doc.request_ids, ...m.matched.map((r) => r.request_id)])], status: m.matched.length && doc.status === "accepted" ? "linked" : doc.status }; putDoc(rt, next, ctx);
      return { document_id: doc.document_id, matched_request_ids: m.matched.map((r) => r.request_id), review_due: reviewDue(doc.received_at, calendarOf(i)), review_timer: "SM_NEEDS_LIST_REVIEW_1BD" }; }),
    guardrails: [never("ACCEPT_FAILED_DOCUMENT", "22.1 state machine guard: a request cannot be satisfied by a document whose integrity_status ≠ passed", (i) => i.op === "review" && flag(i, "accept_failed"), "the guard is a code path, not a prompt")] },
  // R6: requests are derived, never free-typed — (a) intake matrix at application.received, (b) DU verification messages by message id, (c) underwriter/QC/compliance conditions, (d) freshness replacements —
  // de-duplicated on (borrower, class, qualifier); the consolidated batch is queued until the LE is delivered when any item is a verifying document (T10).
  { name: "deriveNeedsList", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "source"); const app = appOf(i, ctx); const when = at(i, "at", ctx); const source = str(i, "source");
      let items: NeedsListItem[];
      if (source === "intake") { need(i, "borrower_id"); const appDate = applicationDateOf(i, rt, app); if (!appDate) throw new RangeError("initial_application_date is required"); items = intakeNeeds({ borrower_id: str(i, "borrower_id"), income_types: list<string>(i, "income_types"), asset_accounts: list<{ account_last4: string; institution: string }>(i, "asset_accounts"), transaction: (str(i, "transaction") || "refinance") as "purchase" | "refinance", employer: optStr(i, "employer"), initial_application_date: appDate, gift: flag(i, "gift") }); }
      else if (source === "du") items = list<{ borrower_id: string; condition_id: string; du_message_id: string; qualifier?: Record<string, unknown> }>(i, "conditions").map(duConditionNeeds);
      else items = list<NeedsListItem>(i, "items");
      if (!items.length) throw new RangeError("no needs-list items derived");
      const existing = requestsOf(rt, app); const seq = sequence(rt, "req", "document_requests", i, "request_id");
      const opened = items.map((item) => openItem(rt, ctx, app, item, when, existing, seq));
      const batch = needsListBatch(ctx.events, { batch_id: str(i, "batch_id") || `nl-${batchesOf(rt, app).length + 1}`, application_id: app, requests: existing, le_delivered: i.le_delivered === undefined ? leDelivered(ctx, app) : flag(i, "le_delivered"), at: when }, ctx.actor);
      putBatch(rt, batch, ctx);
      return { application_id: app, requests: opened.map((o) => ({ request_id: o.request.request_id, opened: o.opened, doc_class: o.request.doc_class, borrower_id: o.request.borrower_id, reason_code: o.request.reason_code, reason_text: o.request.reason_text, due_at: o.request.due_at, reminder_dates: o.request.reminder_dates, condition_id: o.request.condition_id })), batch_id: batch.batch_id, batch_status: batch.status, queued_reason: batch.queued_reason, released_after: batch.status === "queued" ? "disclosure.le.delivered" : null }; }),
    guardrails: [never("UNLINKED_NEEDS_LIST_ITEM", "22.1 AI design guardrail / R6: never a needs-list item that is not linked to a condition, an intake rule or a freshness rule", (i) => str(i, "source") === "manual" && list<Record<string, unknown>>(i, "items").some((x) => !x.reason_code && !x.condition_id), "reason code mandatory (ops console: manual request creation logs agent_decisions{decided_by=human})"),
      never("VERIFYING_DOC_BEFORE_LE", "CFPB TRID FAQ: creditors cannot require a consumer to provide verifying documents in order to receive a Loan Estimate; 21.2 gate", (i) => flag(i, "condition_le_on_documents"), "the LE is never conditioned on documents; the batch waits for disclosure.le.delivered")] },
  // The consolidated NTC_SM_NEEDS_LIST (op=reminder: NTC_SM_NEEDS_LIST_REMINDER at +2/+4; op=release: `disclosure.le.delivered` releases queued batches) through the Notice Registry — partner named as lender,
  // MLO of record and NMLSR ID, automation disclosure, human contact; waived/satisfied items never appear (T9). A queued batch is refused until the LE is delivered (T10).
  { name: "renderNeedsListNotice", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const when = at(i, "at", ctx);
      if (i.op === "release") { const rel = releaseQueuedBatches(ctx.events, batchesOf(rt, app), { application_id: app, delivered_at: at(i, "delivered_at", ctx) }, ctx.actor); for (const b of rel) putBatch(rt, b, ctx); return { application_id: app, released_batch_ids: rel.filter((b) => b.status === "released").map((b) => b.batch_id) }; }
      if (i.op === "reminder") {
        const asOf = optDate(i, "as_of") ?? civilDate(when); const reqs = requestsOf(rt, app); const sent: { request_id: string; sent_on: PlainDate[] }[] = []; let offer = false; const next: DocumentRequest[] = [];
        for (const r of reqs) { const s = sendReminders(ctx.events, r, asOf, ctx.actor); if (s.sent.length) { sent.push({ request_id: r.request_id, sent_on: s.sent }); next.push(s.request); } offer = offer || s.offer_human_agent; }
        putRequests(rt, next, ctx);
        if (!sent.length) return { application_id: app, reminded: [], notice_id: null, offer_human_agent: false };
        const svc = rt.notices; if (!svc) return { application_id: app, reminded: sent, notice_id: null, offer_human_agent: offer };
        const n = svc.render({ templateCode: "NTC_SM_NEEDS_LIST_REMINDER", recipients: recipientsOf(i), payload: needsListPayload(next, partyOf(i, ctx), { reminder_no: Math.max(...next.map((r) => r.reminder_count)) }), asOf });
        return { application_id: app, reminded: sent, notice_id: n.id, notice_status: n.status, offer_human_agent: offer };
      }
      need(i, "batch_id"); const batch = rt.store.require("needs_list_batches", str(i, "batch_id")).data as unknown as NeedsListBatch;
      if (batch.status === "queued") throw new CommandRefused("renderNeedsListNotice", "NEEDS_LIST_BEFORE_LE", "CFPB TRID FAQ (00a-fed §1.10); 22.1 R6: never before the LE has been delivered when the item is a verifying document", `batch ${batch.batch_id} is queued until disclosure.le.delivered`);
      const reqs = requestsOf(rt, app).filter((r) => batch.request_ids.includes(r.request_id));
      const payload = needsListPayload(reqs, partyOf(i, ctx));
      const svc = rt.notices; if (!svc) return { batch_id: batch.batch_id, notice_id: null, payload, items: (payload.items as unknown[]).length };
      const n = svc.render({ templateCode: "NTC_SM_NEEDS_LIST", recipients: recipientsOf(i), payload, asOf: optDate(i, "as_of") ?? civilDate(when) });
      putBatch(rt, { ...batch, notice_id: n.id }, ctx);
      return { batch_id: batch.batch_id, notice_id: n.id, notice_status: n.status, held_reason: n.heldReason ?? null, items: (payload.items as unknown[]).length, request_ids: reqs.map((r) => r.request_id) }; }),
    guardrails: [never("ONE_EMAIL_PER_ITEM", "22.1 R6: the consolidated NTC_SM_NEEDS_LIST is sent once per batch (never one e-mail per item)", (i) => flag(i, "per_item"), "render the batch"),
      never("BORROWER_TEXT_OUTSIDE_TEMPLATE", "baseline: borrower-facing text only from templates", (i) => typeof i.free_text === "string" && i.free_text !== "", "the reason lines come from the derived requests, the wrapper from the template")] },
  // Delivery through the Notice Registry: portal + e-mail when the E-SIGN consent covers needs-list notices, SMS only with TCPA consent (20.3), paper via print/mail otherwise; `needs_list.sent` once per batch.
  { name: "sendNotice", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "notice_id"); const svc = rt.notices; if (!svc) throw new RangeError("notice service is not wired");
      const n = await svc.send(str(i, "notice_id"), (i.channel_context as ChannelContext | undefined) ?? {});
      const channels = (n.channelDecision ?? []).filter((d) => !d.held).map((d) => d.channel);
      let batch_id: string | null = null;
      if (optStr(i, "batch_id")) { const app = appOf(i, ctx); const b = rt.store.require("needs_list_batches", str(i, "batch_id")).data as unknown as NeedsListBatch; const m = markNeedsListSent(ctx.events, b, requestsOf(rt, app), { notice_id: n.id, channels, at: at(i, "at", ctx) }, ctx.actor); putBatch(rt, m.batch, ctx); putRequests(rt, m.requests.filter((r) => b.request_ids.includes(r.request_id)), ctx); batch_id = b.batch_id; }
      return { notice_id: n.id, status: n.status, channels, batch_id }; }),
    guardrails: [never("SMS_WITHOUT_TCPA", "47 U.S.C. 227 / 47 CFR 64.1200; 22.1 AI design guardrail: never contact a borrower by SMS without TCPA consent (20.3)", (i) => (str(i, "channel") === "sms" || flag(i, "sms")) && !flag(i, "tcpa_consent"), "no TCPA consent on file"),
      never("NEEDS_LIST_BEFORE_LE", "CFPB TRID FAQ; 22.1 R6", (i) => flag(i, "batch_queued"), "the batch is queued until disclosure.le.delivered")] },
  // One request (a DU message, a condition, an intake/freshness/integrity rule) with its 5-day borrower clock (`document_request.opened` arms SM_NEEDS_LIST_BORROWER_RESPONSE_5); op=expire on denial/withdrawal; op=noia_evaluation at +10 hands 21.6 the recommendation.
  { name: "openRequest", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const when = at(i, "at", ctx);
      if (i.op === "expire") { need(i, "reason"); const out = expireRequests(ctx.events, requestsOf(rt, app), { application_id: app, reason: str(i, "reason") as "denied" | "withdrawn" | "condition_withdrawn", at: when, condition_id: optStr(i, "condition_id") }, ctx.actor); putRequests(rt, out, ctx); return { application_id: app, expired: out.filter((r) => r.status === "expired" || r.status === "cancelled").map((r) => r.request_id) }; }
      if (i.op === "noia_evaluation") { const rec = noiaRecommendation(requestsOf(rt, app), optDate(i, "as_of") ?? civilDate(when)); if (rec.recommend) ctx.events.append({ type: "needs_list.noia.recommended", applicationId: app, actor: ctx.actor, occurredAt: when, payload: { application_id: app, missing: rec.missing, hand_off: "21.6", response_period_days: rec.response_period_days, reg_b_clock: "REGB_1002_9_DECISION_30 (21.6 anchor; never extended here)" } }); return { application_id: app, ...rec }; }
      need(i, "borrower_id", "doc_class", "reason_code", "reason_text");
      const existing = requestsOf(rt, app);
      const r = openRequest(ctx.events, { request_id: str(i, "request_id") || `req-${rt.store.list("document_requests").length + 1}`, application_id: app, borrower_id: str(i, "borrower_id"), doc_class: str(i, "doc_class"), qualifier: obj(i, "qualifier"), reason_code: str(i, "reason_code"), reason_text: str(i, "reason_text"), condition_id: optStr(i, "condition_id"), requested_at: when, existing, ...(optStr(i, "time_zone") ? { tz: str(i, "time_zone") } : {}) }, ctx.actor);
      if (r.opened) putRequests(rt, [r.request], ctx);
      return { request_id: r.request.request_id, opened: r.opened, deduplicated_against: r.opened ? null : r.request.request_id, status: r.request.status, due_at: r.request.due_at, reminder_dates: r.request.reminder_dates, noia_evaluation_on: r.request.noia_evaluation_on, verifying_document: r.request.verifying_document, response_timer: "SM_NEEDS_LIST_BORROWER_RESPONSE_5" }; }),
    guardrails: [never("UNLINKED_NEEDS_LIST_ITEM", "22.1 AI design guardrail / R6: requests are derived, never free-typed", (i) => flag(i, "free_typed"), "cite the condition, DU message, intake rule or freshness rule"),
      never("BORROWER_CONTACT_FROM_DOCUMENT", "Selling Guide B3-3.1-04 (independence); 22.1 AI design guardrail: never use a phone number or e-mail from a borrower-supplied document to verify a source", (i) => flag(i, "contact_from_borrower_document"), "obtain the employer/institution contact independently (22.3)")] },
  // Waiver only through a DU validation outcome (op=du_validation: `validated` waives the component's paper requests for that borrower/employer with the submission number) or an owning-process rule; states that license processors route waivers through `licensed_specialist`.
  { name: "waiveRequest", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const when = at(i, "at", ctx);
      if (i.op === "du_validation") {
        need(i, "borrower_id", "component", "outcome", "submission_number");
        const r = waiveByDuValidation(ctx.events, requestsOf(rt, app), { application_id: app, borrower_id: str(i, "borrower_id"), component: str(i, "component") as "employment" | "income" | "assets", outcome: str(i, "outcome") as "validated" | "not_validated" | "unable_to_validate", submission_number: str(i, "submission_number"), employer: optStr(i, "employer"), at: when }, ctx.actor);
        putRequests(rt, r.waived, ctx);
        return { application_id: app, waived: r.waived.map((w) => ({ request_id: w.request_id, doc_class: w.doc_class, waived_by: w.waived_by, waiver_reference: w.waiver_reference })), outcome: str(i, "outcome") };
      }
      const r = requestOf(rt, i); need(i, "waived_by", "reference", "rule");
      const next = waiveRequest(ctx.events, r, { waived_by: str(i, "waived_by") as "du_validation" | "owning_process_rule", reference: str(i, "reference"), rule: str(i, "rule"), at: when }, ctx.actor); putRequests(rt, [next], ctx);
      return { request_id: next.request_id, status: next.status, waived_by: next.waived_by, waiver_reference: next.waiver_reference }; }),
    guardrails: [never("WAIVER_OUTSIDE_RULE", "22.1 AI design guardrail: never waive a Fannie Mae documentation requirement other than through a DU validation outcome or an owning-process rule", (i) => i.op !== "du_validation" && i.waived_by !== undefined && !["du_validation", "owning_process_rule"].includes(str(i, "waived_by")), "cite the DU submission or the owning process's rule"),
      needsRole("LICENSED_PROCESSOR_STATE", "31.1 jurisdiction_rules.processor_license_required: states that license third-party processors route document_request waivers through a licensed_specialist", (i) => flag(i, "processor_license_required"), ["licensed_specialist"], "a licensed specialist decides the waiver in this state")] },
  // A satisfied request linked to a condition → `condition.clear.proposed` with the evidence for 23.3 (which accepts or refuses; the condition's status is 23.3's).
  { name: "proposeConditionClear", kind: "write", handler: compute((i, ctx, rt) => {
      const r = requestOf(rt, i); const when = at(i, "at", ctx);
      const condition_id = optStr(i, "condition_id") ?? r.condition_id; if (!condition_id) throw new RangeError(`request ${r.request_id} is not linked to a condition`);
      const document_id = optStr(i, "document_id") ?? r.satisfied_by_document_id; if (!document_id) throw new RangeError(`request ${r.request_id} has no satisfying document`);
      const doc = rt.store.get("documents", document_id)?.data as unknown as DocumentRecord | undefined;
      if (doc && doc.integrity_status !== "passed") throw new RangeError(`document ${document_id} integrity_status ${doc.integrity_status}: only a passed document is evidence for a condition`);
      if (r.status !== "satisfied") throw new RangeError(`request ${r.request_id} is ${r.status}, not satisfied`);
      const e = ctx.events.append({ type: "condition.clear.proposed", applicationId: r.application_id, actor: ctx.actor, occurredAt: when, payload: { application_id: r.application_id, condition_id, request_id: r.request_id, document_id, evidence_document_ids: [document_id], proposed_by: ctx.actor.id, rule_set_version: RULE_SET_VERSION } });
      return { condition_id, request_id: r.request_id, document_id, event_id: e.id, owner: "23.3" }; }),
    guardrails: [never("ACCEPT_FAILED_DOCUMENT", "22.1 AI design guardrail: a failed document is never evidence", (i) => flag(i, "accept_failed"), "22.6 owns the review")] },
  // The agent_decisions row: {document_id | request_id, inputs (hashes, model versions, rule_set_version), classification, integrity, freshness, action, rationale, confidence, escalation_id?}; the human path logs decided_by=human.
  { name: "writeDecision", kind: "write", handler: compute((i, ctx) => {
      need(i, "action", "rationale"); const app = appOf(i, ctx);
      const rec = decisionRecord({ document_id: optStr(i, "document_id"), request_id: optStr(i, "request_id"), inputs: obj(i, "inputs"), classification: (i.classification as { class: string; confidence: number | null } | undefined) ?? null, integrity: (i.integrity as { checks: { check_type: string; result: string }[]; aggregate: DocumentRecord["integrity_status"] } | undefined) ?? null,
        freshness: (i.freshness as ReturnType<typeof computeFreshness> | undefined) ?? null, action: str(i, "action"), rationale: str(i, "rationale"), confidence: typeof i.confidence === "number" ? i.confidence : ctx.run?.confidence ?? null, escalation_id: optStr(i, "escalation_id"), model_version: str(i, "model_version") || ctx.run?.modelVersion || "n/a", prompt_version: str(i, "prompt_version") || ctx.run?.promptVersion || "n/a" });
      const subject = optStr(i, "document_id") ? { kind: "document", id: str(i, "document_id") } : optStr(i, "request_id") ? { kind: "document_request", id: str(i, "request_id") } : { kind: "application", id: app };
      ctx.decide({ agent: ctx.actor.kind === "agent" ? ctx.actor.id : AGENT.id, action: str(i, "action"), rationale: JSON.stringify(rec), ruleSetVersion: RULE_SET_VERSION, applicationId: app, subject, ...(optStr(i, "rule_code") ? { ruleCode: str(i, "rule_code") } : {}), ...(Array.isArray(i.evidence_document_ids) ? { evidenceDocumentIds: i.evidence_document_ids as string[] } : {}),
        confidence: rec.confidence as number | null, modelVersion: rec.model_version as string, promptVersion: rec.prompt_version as string, ...(ctx.actor.kind === "human" ? { approvedBy: ctx.actor.id, approvedRole: ctx.actor.role ?? "human" } : {}) });
      return { recorded: true, decided_by: ctx.actor.kind === "human" ? "human" : "agent", record: rec }; }) },
  // Escalations: underwriting_reviewer (sev 2, SLA 1 business_days_creditor) for integrity failed / a flagged sole-evidence document; human_agent on request or after the third unanswered reminder; licensed_specialist where jurisdiction_rules require it; officer only through 28.4.
  { name: "escalate", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const kind = (str(i, "kind") || "underwriting_reviewer") as EscalationKind;
      const when = at(i, "at", ctx); const uw = kind === "underwriting_reviewer";
      const e = rt.escalations.open({ kind, applicationId: app, ...(uw ? { severity: "sev-2" } : optStr(i, "severity") ? { severity: str(i, "severity") } : {}), payload: { reason: i.reason ?? null, document_id: optStr(i, "document_id"), request_id: optStr(i, "request_id"), ...(uw ? { sla: sla(when, calendarOf(i)) } : {}), ...obj(i, "payload") } }, ctx.actor);
      return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, severity: e.severity ?? null, sla: uw ? sla(when, calendarOf(i)) : null }; }),
    guardrails: [never("OFFICER_ONLY_VIA_28_4", "22.1 AI design: `officer` only through 28.4 (fraud self-report / SAR)", (i) => str(i, "kind") === "officer", "hand the confirmed-fraud path to 28.4"),
      never("UNKNOWN_ESCALATION_ROLE", "22.1 AI design: escalations go to underwriting_reviewer, human_agent, licensed_specialist or the fnma_portal_operator's portal task (28.2 file export)", (i) => i.kind !== undefined && !["underwriting_reviewer", "human_agent", "licensed_specialist", "human_portal_task"].includes(str(i, "kind")), "not a 22.1 escalation role")] },
]));

/** Retention transitions consumed from 30.2's `loan.funded` and 21.6's decision events (the tools above are the agent's; these are the platform hooks). */
export function applyRetentionOnFunded(rt: ToolRuntime, ctx: CommandContext, f: { application_id: string; funded_on: PlainDate; atr_evidence_document_ids: readonly string[]; esign_consent_document_ids?: readonly string[] }): DocumentRecord[] {
  const out = applyFundingRetention(ctx.events, docsOf(rt, f.application_id), f, ctx.actor); for (const d of out) putDoc(rt, d, ctx); return out;
}
export function applyRetentionOnWithdrawal(rt: ToolRuntime, ctx: CommandContext, f: { application_id: string; notified_on: PlainDate }): DocumentRecord[] {
  const out = applyWithdrawalRetention(ctx.events, docsOf(rt, f.application_id), f, ctx.actor); for (const d of out) putDoc(rt, d, ctx);
  putRequests(rt, expireRequests(ctx.events, requestsOf(rt, f.application_id), { application_id: f.application_id, reason: "withdrawn", at: ctx.now }, ctx.actor), ctx); return out;
}
export type { Extraction };
