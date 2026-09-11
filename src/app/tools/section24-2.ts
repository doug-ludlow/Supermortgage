/**
 * §24.2 process-owned tools — bus tools for 24.2 defined with `defineTools("24.2", "valuation", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 24.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `valuation` agent (spec "AI agent design", 24.2 half of the package): ingestReport, runUadCompliance, submitUcdp,
 * pollFindings, applyReviewChecklist, scanLanguage, requestCorrection (template-locked), prepareOverride (for the
 * operator), setValueUsed, buildCopyPackage, deliverNotice, recordWaiver, screenRov, prepareRovAnalysis, forwardRov
 * (template-locked), closeRov, runHpmlTests, writeDecision, fileEscalation. Behaviour: ingest → pre-check → UCDP →
 * review → copy within one business day → gates maintained until consummation. Guardrails encode the paragraph: never
 * alter a report (only the appraiser may revise); never decline an ROV, refer discrimination, or approve an override
 * alone; never set `value_used_cents` above the appraised value; never waive the 3-day timing without a dated borrower
 * statement; never deliver copies without a valid channel consent. State lives in the entity store (`appraisals`,
 * `ucdp_submissions`, `valuations`, `rov_requests`, `consents`); events go through ops-24-2.ts so the timers arm and close;
 * borrower-facing text only through the Notice Registry (rt.notices); UCDP through the `ucdp` runtime service (UcdpPort).
 */
import { defineTools, compute, decision, service, never, needsRole, str, num, flag, cents, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Recipient } from "../../notices/channel.ts";
import { preCheckReport, ucdpSubmitDue, reviewDue, routeUcdpResult, prepareOverride, cuReviewTier, enhancedReview, cuHighRiskReviewDue, scanLanguage, correctionRequestText, applyReviewChecklist, completionAt, valueUsed, ltv, copyPlan, providedOn, earliestConsummation, waiverDecision, buildCopyPackage, classifyValuation,
  screenRov, prepareRovAnalysis, rovCommunication, rovTurnTimeDue, rovOutcome, runHpmlTests, secondAppraisalPlan, notConsummatedPackage, dateOf, NO_CU_FLAGS, ROV_MAX_COMPARABLES,
  recordRevisionReceived, recordUcdpSubmitted, recordUcdpResult, recordCuScored, recordEnhancedReview, recordReviewCompleted, recordCorrectionRequested, recordBiasFlagged, recordValueUsedSet, recordCopyDelivered, recordWaiverRequested, recordCopyWaived, recordNotConsummated,
  recordRovRequested, recordRovScreened, recordRovForwarded, recordRovResponse, recordRovClosed, recordSecondAppraisalRequired,
  type UcdpPort, type UcdpSsr, type UcdpFinding, type Gse, type CuFlags, type AppraisalForm, type ReportPackage, type ChecklistInput, type ValuationRow, type ValuationKind, type RovRequestInput, type RovComparable, type CopyChannel, type CopyReceiptEvidence, type EventCtx, type ReviewStatus, type UcdpStatus } from "../../domain/property/ops-24-2.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`24.2 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("24.2 tool needs application_id (every 24.2 event carries it so the timers arm under origination context)"); return a; };
const ectx = (i: ToolInput, ctx: CommandContext): EventCtx => ({ application_id: appOf(i, ctx), loan_id: (i.loan_id as string | undefined) ?? (ctx.loanId || null), actor: ctx.actor, at: typeof i.at === "string" ? i.at : ctx.now });
const dateIn = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (typeof i[k] === "string" && i[k] !== "" ? D(str(i, k)) : null);
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const obj = <T extends object>(i: ToolInput, k: string): T => { const v = i[k]; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError(`24.2 tool needs ${k} {…}`); return v as T; };
const list = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`24.2 tool needs ${k}[]`); return v as T[]; };
const optList = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const ucdpOf = (rt: ToolRuntime): UcdpPort => service<UcdpPort>(rt, "ucdp");
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: Record<string, unknown>) => rt.store.put(kind, id, data, ctx.actor, ctx.now);
const appraisalRow = (rt: ToolRuntime, id: string): Record<string, unknown> => { const r = rt.store.get("appraisals", id); if (!r) throw new RangeError(`24.2: no appraisals row ${id} — ingestReport first`); return r.data; };
const cuFlags = (i: ToolInput, k = "cu_flags"): CuFlags => ({ ...NO_CU_FLAGS, ...((i[k] as Partial<CuFlags> | undefined) ?? {}) });
const noValueLanguage = (name: string) => never("APPRAISER_TEXT_TEMPLATE_LOCKED", "24.2 AI agent design: all appraiser-facing text comes from templates that cannot carry values, targets or comparables outside the ROV's ≤ 5", (i) => i.value_cents !== undefined || i.target_value_cents !== undefined || i.desired_value_cents !== undefined || i.free_text !== undefined || i.custom_message !== undefined, `${name} renders the locked template only — no value, target or free text reaches the appraiser (AIR)`);
const DEFAULT_ESCALATION: EscalationKind = "underwriting_reviewer";
/** Escalation kinds the paragraph names; `fnma_portal_operator` is the kernel's `human_portal_task` kind (owner role fnma_portal_operator). */
const KINDS: readonly EscalationKind[] = ["underwriting_reviewer", "human_portal_task", "officer", "human_agent"];
const kindIn = (i: ToolInput): EscalationKind => { const k = str(i, "kind"); const kind = (k === "fnma_portal_operator" ? "human_portal_task" : k) as EscalationKind; if (!KINDS.includes(kind)) throw new RangeError(`24.2 fileEscalation kind must be one of fnma_portal_operator, ${KINDS.join(", ")}`); return kind; };

export const TOOLS_24_2: readonly ToolDef[] = defineTools("24.2", "valuation", [
  // ---------------------------------------------------------------- R1 receipt and pre-check
  { name: "ingestReport", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "appraisal_id", "version_no", "package", "appraised_value_cents", "effective_date", "appraiser_party_id");
    const app = appOf(i, ctx); const pkg = obj<Omit<ReportPackage, "appraisal_id" | "application_id" | "version_no" | "received_at" | "effective_date">>(i, "package");
    const received_at = typeof i.received_at === "string" ? i.received_at : ctx.now; const version_no = num(i, "version_no"); const appraisal_id = str(i, "appraisal_id");
    const precheck = preCheckReport({ ...pkg, appraisal_id, application_id: app, version_no, received_at, effective_date: dateIn(i, "effective_date") });
    const prior = rt.store.list("appraisals", (d) => d.application_id === app && d.appraisal_id === appraisal_id && (d.version_no as number) < version_no);
    const doc_file_id = (i.doc_file_id as string | undefined) ?? (prior.map((p) => p.data.doc_file_id as string | null).find((x) => x) ?? null);
    const row = { appraisal_id, application_id: app, valuation_order_id: (i.valuation_order_id as string | undefined) ?? null, version_no, is_final_version: false, received_at, completion_at: null, effective_date: str(i, "effective_date"), appraiser_party_id: str(i, "appraiser_party_id"),
      form: pkg.form, uad_version: pkg.uad_version, appraised_value_cents: cents(i.appraised_value_cents), condition_rating: (i.condition_rating as string | undefined) ?? null, quality_rating: (i.quality_rating as string | undefined) ?? null, ucdp_status: "not_submitted" satisfies UcdpStatus, doc_file_id, cu_score: null, cu_flags: NO_CU_FLAGS, hard_stops: [],
      review_status: (precheck.ok ? "pending" : "rejected") satisfies ReviewStatus, bias_scan_result: null, value_used_cents: null, value_basis: null, rw_relief_property_value: false, hpml_second_appraisal: flag(i, "hpml_second_appraisal"), copy_required_by: null, copy_delivered_at: null, copy_receipt_evidence: null, precheck, transferred_from_lender: flag(i, "transferred_from_lender") };
    persist(rt, ctx, "appraisals", `${appraisal_id}:v${version_no}`, row);
    const valuation: ValuationRow = { valuation_id: `VAL-${appraisal_id}-v${version_no}`, application_id: app, kind: version_no > 1 ? "appraisal_revision" : "appraisal", source_document_id: (i.pdf_document_id as string | undefined) ?? `DOC-${appraisal_id}-v${version_no}`, developed_at: dateIn(i, "effective_date"), delivered_at: null, notice_id: null, excluded_reason: null };
    persist(rt, ctx, "valuations", valuation.valuation_id, valuation as unknown as Record<string, unknown>);
    const events = version_no > 1 ? [recordRevisionReceived(ctx.events, ectx(i, ctx), { appraisal_id, version_no, received_at, doc_file_id })] : [];
    return { precheck, appraisal: row, valuation, ucdp_submit_due: ucdpSubmitDue(dateOf(received_at)), resubmit_under_partner: row.transferred_from_lender, events: events.map((e) => e.type) };
  }), guardrails: [never("REPORT_NOT_ALTERABLE", "24.2 guardrails: never alter a report (only the appraiser may revise)", (i) => i.report_edits !== undefined || i.alter_report === true || i.edit_narrative !== undefined || i.replace_value_cents !== undefined, "the package is stored as received (hash-frozen); corrections go back to the appraiser through requestCorrection and arrive as a new version")] },
  { name: "runUadCompliance", kind: "act", handler: compute((i, ctx) => {
    need(i, "appraisal_id", "version_no", "uad_version");
    const uad = str(i, "uad_version"); const fatal = uad === "2.6" && D(ctx.now.slice(0, 10)) >= D("2026-11-02");
    const findings: string[] = [...(flag(i, "xml_valid") || i.xml_valid === undefined ? [] : ["UAD XML fails schema validation"]), ...(fatal ? ["UAD 2.6 is fatal for submissions on/after Nov 2, 2026 (FNM0391)"] : []), ...optList<string>(i, "api_findings")];
    return { appraisal_id: str(i, "appraisal_id"), version_no: num(i, "version_no"), uad_version: uad, pass: findings.length === 0, findings, api: "UAD Compliance API (pre-submission; six published test cases) [PARTIALLY VERIFIED]" };
  }) },
  { name: "submitUcdp", kind: "act", handler: compute(async (i, ctx, rt) => {
    need(i, "appraisal_id", "version_no", "package_hash");
    const appraisal_id = str(i, "appraisal_id"), version_no = num(i, "version_no"); const gses = (optList<Gse>(i, "gses").length ? optList<Gse>(i, "gses") : ["fnma", "fhlmc"]) as Gse[];
    const row = appraisalRow(rt, `${appraisal_id}:v${version_no}`); const ucdp = ucdpOf(rt); const submitted_at = ctx.now;
    let doc_file_id = (row.doc_file_id as string | null) ?? null;
    const results = [] as { gse: Gse; doc_file_id: string; api_correlation_id: string }[];
    for (const gse of gses) { const r = await ucdp.submit({ appraisal_id, version_no, gse, doc_file_id, submitted_at, package_hash: str(i, "package_hash") }); doc_file_id = r.doc_file_id; results.push({ gse, ...r }); persist(rt, ctx, "ucdp_submissions", `${appraisal_id}:v${version_no}:${gse}`, { submission_id: `${appraisal_id}:v${version_no}:${gse}`, appraisal_id, version_no, gse, doc_file_id: r.doc_file_id, submitted_at, status: "pending", api_correlation_id: r.api_correlation_id, override_request: null }); }
    persist(rt, ctx, "appraisals", `${appraisal_id}:v${version_no}`, { ...row, ucdp_status: "pending", doc_file_id, review_status: "ucdp_pending" });
    const e = recordUcdpSubmitted(ctx.events, ectx(i, ctx), { appraisal_id, version_no, gses, doc_file_id: doc_file_id!, submitted_at });
    return { appraisal_id, version_no, doc_file_id, submissions: results, both_gses: e.payload.both_gses, resubmission: version_no > 1 };
  }), guardrails: [never("DOC_FILE_ID_NOT_REUSABLE_ACROSS_LENDERS", "UCDP Overview: UCDP does not allow a lender to reuse a Document File ID created from another lender's UCDP submission", (i) => i.reuse_other_lender_doc_file_id === true || (typeof i.doc_file_id_source === "string" && i.doc_file_id_source !== "partner"), "a transferred appraisal is resubmitted under the partner; the original lender's Doc File ID is ignored")] },
  { name: "pollFindings", kind: "act", handler: compute(async (i, ctx, rt) => {
    need(i, "appraisal_id", "version_no");
    const appraisal_id = str(i, "appraisal_id"), version_no = num(i, "version_no"); const ucdp = ucdpOf(rt); const c = ectx(i, ctx);
    const ssrs: UcdpSsr[] = []; for (const gse of ["fnma", "fhlmc"] as const) { const s = await ucdp.findings(appraisal_id, version_no, gse); if (s) ssrs.push(s); }
    for (const s of ssrs) { recordUcdpResult(ctx.events, c, { appraisal_id, version_no, ssr: s }); const sub = rt.store.get("ucdp_submissions", `${appraisal_id}:v${version_no}:${s.gse}`); if (sub) persist(rt, ctx, "ucdp_submissions", `${appraisal_id}:v${version_no}:${s.gse}`, { ...sub.data, status: s.status, findings: s.findings, result_at: s.result_at }); }
    const routing = routeUcdpResult(ssrs); const fnma = routing.fnma;
    const cu = fnma ? { cu_score: fnma.cu_score, cu_flags: fnma.cu_flags, scored_at: fnma.result_at } : null;
    if (cu) recordCuScored(ctx.events, c, { appraisal_id, version_no, ...cu });
    const row = appraisalRow(rt, `${appraisal_id}:v${version_no}`);
    const review_status: ReviewStatus = routing.route === "successful" ? "in_review" : routing.route === "override_requested" ? "override_requested" : "ucdp_not_successful";
    persist(rt, ctx, "appraisals", `${appraisal_id}:v${version_no}`, { ...row, ucdp_status: routing.ucdp_status, doc_file_id: routing.doc_file_id ?? row.doc_file_id, cu_score: cu?.cu_score ?? null, cu_flags: cu?.cu_flags ?? NO_CU_FLAGS, hard_stops: [...routing.correctable_stops, ...routing.overridable_stops], review_status });
    const tier = cu ? cuReviewTier(cu.cu_score, cu.cu_flags) : null;
    return { appraisal_id, version_no, ssrs, routing: { route: routing.route, ucdp_status: routing.ucdp_status, doc_file_id: routing.doc_file_id, reason: routing.reason, overridable_stops: routing.overridable_stops, correctable_stops: routing.correctable_stops }, cu: cu ? { ...cu, ...tier, high_risk_review_due: tier?.enhanced_review_required ? cuHighRiskReviewDue(dateOf(cu.scored_at)) : null } : null, review_due: fnma ? reviewDue(dateOf(fnma.result_at)) : null };
  }) },
  // ---------------------------------------------------------------- R2/R3 review
  { name: "applyReviewChecklist", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "appraisal_id", "version_no", "checklist", "transaction_type");
    const appraisal_id = str(i, "appraisal_id"), version_no = num(i, "version_no"); const row = appraisalRow(rt, `${appraisal_id}:v${version_no}`); const c = ectx(i, ctx);
    const cl = obj<Omit<ChecklistInput, "fnma_ssr" | "cu_score" | "cu_flags" | "form">>(i, "checklist");
    const fnma_ssr = (i.fnma_ssr as UcdpSsr | undefined) ?? (row.ucdp_status === "successful" ? { gse: "fnma", status: "successful", doc_file_id: String(row.doc_file_id), findings: [], cu_score: row.cu_score as number | null, cu_flags: row.cu_flags as CuFlags, result_at: ctx.now, api_correlation_id: "store" } satisfies UcdpSsr : null);
    const r = applyReviewChecklist({ ...cl, fnma_ssr, cu_score: (row.cu_score as number | null) ?? null, cu_flags: row.cu_flags as CuFlags, form: row.form as AppraisalForm });
    const reviewed_at = typeof i.reviewed_at === "string" ? i.reviewed_at : ctx.now;
    let enhanced = null; if (r.cu.enhanced_review_required && Array.isArray(i.comparables)) { enhanced = enhancedReview({ appraisal_id, cu_score: row.cu_score as number, cu_flags: row.cu_flags as CuFlags, comparables: list<Parameters<typeof enhancedReview>[0]["comparables"][number]>(i, "comparables").map((x) => ({ ...x, adjusted_price_cents: cents(x.adjusted_price_cents) })), recorded_at: reviewed_at }); recordEnhancedReview(ctx.events, c, enhanced); persist(rt, ctx, "enhanced_reviews", `${appraisal_id}:v${version_no}`, enhanced as unknown as Record<string, unknown>); }
    if (r.fair_lending_record_required) { recordBiasFlagged(ctx.events, c, { appraisal_id, version_no, scan: r.bias_scan }); persist(rt, ctx, "fair_lending_records", `${appraisal_id}:v${version_no}`, { appraisal_id, version_no, scan: r.bias_scan, recorded_at: reviewed_at }); }
    const accepted = r.review_status === "accepted";
    const completion_at = accepted ? completionAt(String(row.received_at), reviewed_at) : null;
    const vu = accepted ? valueUsed({ transaction_type: str(i, "transaction_type") === "purchase" ? "purchase" : "refinance", appraised_value_cents: cents(row.appraised_value_cents), purchase_price_cents: optCents(i, "purchase_price_cents") }) : null;
    const plan = completion_at ? copyPlan({ completion_at, consummation_on: optDate(i, "consummation_on") }) : null;
    if (accepted) for (const p of rt.store.list("appraisals", (d) => d.appraisal_id === appraisal_id && d.application_id === row.application_id && d.is_final_version === true)) persist(rt, ctx, "appraisals", `${appraisal_id}:v${p.data.version_no}`, { ...p.data, is_final_version: false });
    persist(rt, ctx, "appraisals", `${appraisal_id}:v${version_no}`, { ...row, review_status: r.review_status, bias_scan_result: r.bias_scan, review_findings: { value_support: r.value_support, property_data: r.property_data }, completion_at, is_final_version: accepted, value_used_cents: vu?.value_used_cents ?? null, value_basis: vu?.value_basis ?? null, rw_relief_property_value: r.rw_relief_property_value && !enhanced, copy_required_by: plan?.copy_required_by ?? null });
    recordReviewCompleted(ctx.events, c, { appraisal_id, version_no, review_status: r.review_status, completion_at, is_final_version: accepted, ucdp_status: row.ucdp_status as UcdpStatus, doc_file_id: (row.doc_file_id as string | null) ?? null, rw_relief_property_value: r.rw_relief_property_value && !enhanced });
    if (vu) recordValueUsedSet(ctx.events, c, { appraisal_id, version_no, ...vu, appraised_value_cents: cents(row.appraised_value_cents) });
    return { ...r, rw_relief_property_value: r.rw_relief_property_value && !enhanced, completion_at, value_used: vu, ltv: vu && i.loan_amount_cents !== undefined ? ltv(cents(i.loan_amount_cents), vu.value_used_cents) : null, copy_plan: plan, enhanced_review: enhanced, is_final_version: accepted };
  }), guardrails: [never("REPORT_NOT_ALTERABLE", "24.2 guardrails: never alter a report", (i) => i.report_edits !== undefined || i.alter_report === true, "the review records findings; only the appraiser revises the report")] },
  { name: "scanLanguage", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "narrative");
    const scan = scanLanguage(str(i, "narrative"), optList<string>(i, "factual_support"));
    if (typeof i.appraisal_id === "string" && scan.severity !== "none") { recordBiasFlagged(ctx.events, ectx(i, ctx), { appraisal_id: str(i, "appraisal_id"), version_no: i.version_no === undefined ? 1 : num(i, "version_no"), scan }); persist(rt, ctx, "fair_lending_records", `${str(i, "appraisal_id")}:v${i.version_no === undefined ? 1 : num(i, "version_no")}`, { appraisal_id: str(i, "appraisal_id"), scan, recorded_at: ctx.now }); }
    return { ...scan, correction_required: scan.severity === "high" || scan.severity === "medium", reasoned_review_required: scan.severity === "low", officer_referral_candidate: scan.demographic_references.length > 0 };
  }), guardrails: [needsRole("DISCRIMINATION_REFERRAL_OFFICER", "24.2 guardrails: never refer discrimination alone", (i) => i.refer_discrimination === true || i.agency_referral === true, ["officer"], "suspected overt discrimination is referred to the agency by an officer (valuation.discrimination.referred); the agent opens the officer escalation with the scan and rationale")] },
  { name: "requestCorrection", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "appraisal_id", "version_no", "reason");
    const appraisal_id = str(i, "appraisal_id"), version_no = num(i, "version_no");
    const scan = (i.scan as ReturnType<typeof scanLanguage> | undefined) ?? { terms_hit: [], demographic_references: [], severity: "none" as const, factual_support: [], rule_set: "" };
    const text = correctionRequestText(scan, optList<UcdpFinding>(i, "stops"));
    const reason = str(i, "reason") as "bias_language" | "ucdp_stop" | "value_support";
    const row = rt.store.get("appraisals", `${appraisal_id}:v${version_no}`); if (row) persist(rt, ctx, "appraisals", `${appraisal_id}:v${version_no}`, { ...row.data, review_status: "correction_requested", value_used_cents: null, value_basis: null, is_final_version: false });
    const e = recordCorrectionRequested(ctx.events, ectx(i, ctx), { appraisal_id, version_no, text, reason });
    return { appraisal_id, version_no, template: "CR-24.2 v1", text, event: e.type, value_used_cents: null, awaiting: "corrected version from the appraiser (new version → ingestReport)" };
  }), guardrails: [noValueLanguage("requestCorrection"), never("REPORT_NOT_ALTERABLE", "24.2 guardrails: never alter a report (only the appraiser may revise)", (i) => i.apply_correction_inline === true || i.report_edits !== undefined, "the correction is requested from the appraiser; the platform never edits the report")] },
  { name: "prepareOverride", kind: "act", handler: compute((i) => {
    need(i, "finding", "reason_code", "evidence");
    return { ...prepareOverride(obj<UcdpFinding>(i, "finding"), { reason_code: str(i, "reason_code"), evidence: str(i, "evidence"), ...(typeof i.requested_by === "string" ? { requested_by: i.requested_by } : {}) }), queue: "fnma_portal_operator", channel: "UCDP UI (override requests are portal-only)" };
  }), guardrails: [needsRole("UCDP_OVERRIDE_APPROVAL_OPERATOR", "24.2 guardrails: never approve an override alone — UCDP overrides are UI-only (fnma_portal_operator)", (i) => i.approve === true || i.approved_at !== undefined, ["fnma_portal_operator"], "the agent prepares the reason code and justification; a fnma_portal_operator approves it in the UCDP UI"), never("UCDP_OVERRIDE_UI_ONLY", "UCDP Messaging Guide: overrides are requested in the UCDP UI by selecting a reason code", (i) => i.submit_via_api === true || i.submit_via_di === true, "there is no Direct Integration override path — the package goes to the operator queue")] },
  { name: "setValueUsed", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "appraisal_id", "version_no", "transaction_type", "appraised_value_cents");
    const appraisal_id = str(i, "appraisal_id"), version_no = num(i, "version_no");
    const vu = valueUsed({ transaction_type: str(i, "transaction_type") === "purchase" ? "purchase" : "refinance", appraised_value_cents: cents(i.appraised_value_cents), purchase_price_cents: optCents(i, "purchase_price_cents") });
    const row = rt.store.get("appraisals", `${appraisal_id}:v${version_no}`); if (row) { if (row.data.review_status !== "accepted") throw new RangeError("24.2: value_used_cents is set only on an accepted version (the value is not used until the corrected version is accepted)"); persist(rt, ctx, "appraisals", `${appraisal_id}:v${version_no}`, { ...row.data, ...vu }); }
    recordValueUsedSet(ctx.events, ectx(i, ctx), { appraisal_id, version_no, ...vu, appraised_value_cents: cents(i.appraised_value_cents) });
    return { ...vu, ltv: i.loan_amount_cents === undefined ? null : ltv(cents(i.loan_amount_cents), vu.value_used_cents), consumers: ["23.1 DU resubmission", "25.2 CD"] };
  }), guardrails: [never("VALUE_USED_ABOVE_APPRAISED", "24.2 guardrails: never set `value_used_cents` above the appraised value", (i) => i.value_used_cents !== undefined && i.appraised_value_cents !== undefined && cents(i.value_used_cents) > cents(i.appraised_value_cents), "value_used_cents = appraised value (refinance) or lower_of_two(appraised, purchase price) (purchase) — never more")] },
  // ---------------------------------------------------------------- R4/R8 Reg B copy engine
  { name: "buildCopyPackage", kind: "act", handler: compute((i, ctx, rt) => {
    const app = appOf(i, ctx); const c = ectx(i, ctx);
    const valuations = optList<ValuationRow>(i, "valuations").length ? optList<ValuationRow>(i, "valuations") : rt.store.list("valuations", (d) => d.application_id === app).map((r) => r.data as unknown as ValuationRow);
    for (const v of optList<{ valuation_id: string; kind: ValuationKind | "du_value_acceptance_message" | "internal_restatement" | "government_assessed_value"; source_document_id: string; developed_at: string }>(i, "add_valuations")) { const cls = classifyValuation(v.kind); const row: ValuationRow = { valuation_id: v.valuation_id, application_id: app, kind: (cls.is_valuation ? v.kind : "staff_value_document") as ValuationKind, source_document_id: v.source_document_id, developed_at: D(v.developed_at), delivered_at: null, notice_id: null, excluded_reason: cls.excluded_reason }; persist(rt, ctx, "valuations", row.valuation_id, row as unknown as Record<string, unknown>); valuations.push(row); }
    const hpml = flag(i, "hpml_appraisal_rules_apply");
    if (i.not_consummated && typeof i.not_consummated === "object") {
      const nc = obj<{ cause: "application.withdrawn" | "decision.issued" | "application.closed_incomplete" | "funding.cancelled"; decision_kind?: "denial" | "approved_not_accepted" | null; determination_at: string }>(i, "not_consummated");
      if (!nc.cause || !nc.determination_at) throw new RangeError("24.2 buildCopyPackage not_consummated needs cause and determination_at");
      const pkg = notConsummatedPackage({ determination_at: nc.determination_at, valuations, hpml_appraisal_rules_apply: hpml });
      recordNotConsummated(ctx.events, c, { cause: nc.cause, decision_kind: nc.decision_kind ?? null, determination_at: nc.determination_at, hpml_appraisal_rules_apply: hpml, copy_required_by: pkg.copy_required_by });
      return { ...pkg, cover_template: "NTC_REGB_1002_14_COPY_NOT_CONSUMMATED", channel: flag(i, "esign_consent_covers_disclosures") ? "electronic" : "mail", recipients_all_applicants: true };
    }
    need(i, "completion_at");
    const pkg = buildCopyPackage({ valuations, hpml_appraisal_rules_apply: hpml, first_version: i.first_version === undefined ? true : flag(i, "first_version"), esign_consent_covers_disclosures: flag(i, "esign_consent_covers_disclosures") });
    const plan = copyPlan({ completion_at: str(i, "completion_at"), consummation_on: optDate(i, "consummation_on") });
    persist(rt, ctx, "copy_packages", `PKG-${app}-${valuations.length}-${ctx.now}`, { ...pkg, plan, application_id: app });
    return { ...pkg, plan, hpml_copies_due_on: hpml && optDate(i, "consummation_on") ? runHpmlTests({ is_hpml: true, qm_type: "not_qm", loan_amount_cents: cents(i.loan_amount_cents ?? "100000000"), as_of: D(ctx.now.slice(0, 10)), assignment_type: "traditional", interior_visit: true, consummation_on: optDate(i, "consummation_on") }).copies_due_on : null };
  }) },
  { name: "deliverNotice", kind: "act", handler: compute(async (i, ctx, rt) => {
    need(i, "template_code", "payload", "recipients", "version", "channel");
    const svc = rt.notices; if (!svc) throw new PortUnavailable("notices");
    const c = ectx(i, ctx); const delivered_at = typeof i.delivered_at === "string" ? i.delivered_at : ctx.now; const copied_on = dateOf(delivered_at); const channel = str(i, "channel") as CopyChannel;
    const n = svc.render({ templateCode: str(i, "template_code"), ...(ctx.loanId ? { loanId: ctx.loanId } : {}), recipients: list<Recipient>(i, "recipients"), payload: obj<Record<string, unknown>>(i, "payload"), asOf: copied_on });
    const sent = await svc.send(n.id, (i.channel_context as Record<string, unknown> | undefined) ?? {});
    const provided_on = providedOn({ copied_on, channel, actual_receipt_on: optDate(i, "actual_receipt_on") });
    const valuation_ids = optList<string>(i, "valuation_ids");
    for (const id of valuation_ids) { const v = rt.store.get("valuations", id); if (v) persist(rt, ctx, "valuations", id, { ...v.data, delivered_at, notice_id: n.id }); }
    const appraisal_id = (i.appraisal_id as string | undefined) ?? null; const version = num(i, "version");
    if (appraisal_id) { const row = rt.store.get("appraisals", `${appraisal_id}:v${version}`); if (row) persist(rt, ctx, "appraisals", `${appraisal_id}:v${version}`, { ...row.data, copy_delivered_at: delivered_at, copy_receipt_evidence: (i.receipt_evidence as CopyReceiptEvidence | undefined) ?? null, copy_notice_id: n.id }); }
    const e = recordCopyDelivered(ctx.events, c, { appraisal_id, version, is_final_version: i.is_final_version === undefined ? true : flag(i, "is_final_version"), hpml: flag(i, "hpml"), channel, delivered_at, provided_on, receipt_evidence: (i.receipt_evidence as CopyReceiptEvidence | undefined) ?? null, notice_id: n.id, valuation_ids, not_consummated: flag(i, "not_consummated") });
    persist(rt, ctx, "disclosures", `DISC-${n.id}`, { kind: flag(i, "hpml") ? "hpml_appraisal_copy" : "valuation_copy", notice_id: n.id, template_code: n.templateCode, delivered_at, channel, receipt_evidence: (i.receipt_evidence as string | undefined) ?? null, application_id: c.application_id });
    const consummation_on = optDate(i, "consummation_on");
    return { notice_id: n.id, status: sent.status, template_code: n.templateCode, delivered_at, provided_on, earliest_consummation: earliestConsummation(provided_on), gate_open_for_scheduled: consummation_on ? earliestConsummation(provided_on) <= consummation_on : null, event: e.type, charge_cents: 0n };
  }), guardrails: [never("COPY_CHANNEL_CONSENT_REQUIRED", "24.2 guardrails: never deliver copies without a valid channel consent (E-SIGN; §1002.14(a)(5))", (i) => i.channel === "electronic" && i.esign_consent_verified !== true, "electronic delivery needs a verified E-SIGN consent covering disclosures (consents.kind = esign_disclosures); otherwise print/mail with the 3-business-day receipt assumption"), never("COPY_NO_CHARGE", "12 CFR 1002.14(a)(3); 1026.35(c)(6)(iii): no charge for providing a copy", (i) => i.charge_cents !== undefined && cents(i.charge_cents) > 0n, "no photocopy, postage or other cost may be charged for the copy")] },
  { name: "recordWaiver", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "appraisal_id", "statement_channel", "obtained_at", "consummation_on");
    const c = ectx(i, ctx); const appraisal_id = str(i, "appraisal_id"); const obtained_at = str(i, "obtained_at"); const consummation_on = dateIn(i, "consummation_on");
    const statement_channel = str(i, "statement_channel") as "oral_recorded" | "written" | "electronic";
    recordWaiverRequested(ctx.events, c, { appraisal_id, statement_channel, obtained_at, consummation_on });
    const d = waiverDecision({ obtained_on: dateOf(obtained_at), consummation_on });
    if (!d.accepted) return { accepted: false, reason: d.reason, latest_obtained_on: d.latest_obtained_on, copies_due_at_or_before: null, gate: "REGB_1002_14_APPRAISAL_COPY_3BD_GATE governs" };
    const consent_id = `CONSENT-WAIVER-${appraisal_id}-${dateOf(obtained_at)}`;
    persist(rt, ctx, "consents", consent_id, { kind: "regb_1002_14_timing_waiver", statement_channel, obtained_at, consummation_at_when_obtained: consummation_on, application_id: c.application_id, appraisal_id });
    recordCopyWaived(ctx.events, c, { appraisal_id, consent_id, obtained_at, consummation_on, copies_due_at_or_before: d.copies_due_at_or_before });
    return { accepted: true, consent_id, reason: d.reason, latest_obtained_on: d.latest_obtained_on, copies_due_at_or_before: d.copies_due_at_or_before, hpml_note: "an HPML appraisal copy has no waiver (§1026.35(c)(6)) — REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD still governs" };
  }), guardrails: [never("WAIVER_NEEDS_DATED_STATEMENT", "24.2 guardrails: never waive the 3-day timing without a dated borrower statement (comment 14(a)(1)-6: affirmative oral or written statement)", (i) => i.obtained_at === undefined || i.obtained_at === null || i.obtained_at === "" || i.statement_channel === undefined, "a waiver is recorded only from a dated borrower statement (oral_recorded | written | electronic) with the consummation date it was obtained against")] },
  // ---------------------------------------------------------------- R6 reconsideration of value
  { name: "screenRov", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "request");
    const c = ectx(i, ctx); const req = obj<RovRequestInput>(i, "request"); const request: RovRequestInput = { ...req, application_id: c.application_id, comparables: (req.comparables ?? []).map((x: RovComparable) => ({ ...x, sale_price_cents: cents(x.sale_price_cents) })) };
    const prior = i.prior_borrower_rovs_for_appraisal === undefined ? rt.store.list("rov_requests", (d) => d.appraisal_id === request.appraisal_id && d.requested_by === "borrower" && d.rov_id !== request.rov_id).length : num(i, "prior_borrower_rovs_for_appraisal");
    const consummated = flag(i, "consummated") || ctx.events.all().some((e) => e.type === "closing.consummated" && (e.applicationId === c.application_id || (e.payload as Record<string, unknown>).application_id === c.application_id));
    recordRovRequested(ctx.events, c, request);
    const screen = screenRov({ request, prior_borrower_rovs_for_appraisal: prior, consummated });
    let sme_escalation_id: string | null = null;
    if (screen.sme_required) sme_escalation_id = rt.escalations.open({ kind: "underwriting_reviewer", applicationId: c.application_id, ...(ctx.loanId ? { loanId: ctx.loanId } : {}), severity: "sla_1bd", payload: { rov_id: request.rov_id, appraisal_id: request.appraisal_id, role: "designated ROV subject-matter expert (B4-1.3-12)", decision_required: "forward | decline | forward_partial", analysis: i.analysis ?? null, screen_due_on: screen.screen_due_on } }, ctx.actor).id;
    persist(rt, ctx, "rov_requests", request.rov_id, { ...request, status: screen.screen_result === "complete" ? "sme_review" : "screened", screen_result: screen.screen_result, screen_reasons: screen.reasons, sme_escalation_id, sent_to_appraiser_at: null, turn_time_due_at: null, rejection_reason: screen.rejection_reason });
    recordRovScreened(ctx.events, c, { rov_id: request.rov_id, appraisal_id: request.appraisal_id, screen, screened_at: ctx.now, sme_escalation_id });
    return { ...screen, rov_id: request.rov_id, sme_escalation_id, appraiser_contacted: false };
  }), guardrails: [never("ROV_NOT_DECLINED_BY_AGENT", "24.2 guardrails: never decline an ROV alone", (i) => i.decline === true || i.sme_decision === "decline", "screening records complete/incomplete/duplicate/post-closing; a decline is the designated SME's decision (forwardRov / closeRov by underwriting_reviewer)")] },
  { name: "prepareRovAnalysis", kind: "act", handler: compute((i) => {
    need(i, "request", "subject_gla_sqft");
    const req = obj<RovRequestInput>(i, "request");
    return prepareRovAnalysis({ request: { ...req, comparables: (req.comparables ?? []).map((x: RovComparable) => ({ ...x, sale_price_cents: cents(x.sale_price_cents) })) }, subject_gla_sqft: num(i, "subject_gla_sqft"), appraisal_comparables: optList<{ address: string }>(i, "appraisal_comparables") });
  }), guardrails: [never("ROV_NOT_DECLINED_BY_AGENT", "24.2 guardrails: never decline an ROV alone", (i) => i.decline === true, "the analysis recommends; the SME decides")] },
  { name: "forwardRov", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "rov_id", "sme_decision", "sme_reviewer");
    const c = ectx(i, ctx); const rov_id = str(i, "rov_id"); const stored = rt.store.get("rov_requests", rov_id); const req = (i.request as RovRequestInput | undefined) ?? (stored?.data as unknown as RovRequestInput | undefined);
    if (!req) throw new RangeError(`24.2 forwardRov: no rov_requests row ${rov_id} — screenRov first`);
    const request: RovRequestInput = { ...req, comparables: (req.comparables ?? []).map((x: RovComparable) => ({ ...x, sale_price_cents: cents(x.sale_price_cents) })) };
    const sme_decision = str(i, "sme_decision") as "forward" | "forward_partial" | "decline";
    if (sme_decision === "decline") { persist(rt, ctx, "rov_requests", rov_id, { ...(stored?.data ?? request), status: "declined", sme_decision, sme_reviewer: str(i, "sme_reviewer"), sme_rationale: str(i, "rationale") }); return { rov_id, forwarded: false, sme_decision, appraiser_contacted: false }; }
    if (stored && stored.data.screen_result !== "complete") throw new RangeError(`24.2 forwardRov: ROV ${rov_id} screen_result is ${String(stored.data.screen_result)} — only a complete, first, pre-closing ROV is forwarded`);
    const sent_to_appraiser_at = typeof i.sent_to_appraiser_at === "string" ? i.sent_to_appraiser_at : ctx.now; const turn_time_due_at = rovTurnTimeDue(dateOf(sent_to_appraiser_at));
    const text = rovCommunication(request, turn_time_due_at);
    persist(rt, ctx, "rov_requests", rov_id, { ...(stored?.data ?? request), status: "awaiting_appraiser", sme_decision, sme_reviewer: str(i, "sme_reviewer"), sme_rationale: str(i, "rationale"), sent_to_appraiser_at, turn_time_due_at });
    recordRovForwarded(ctx.events, c, { rov_id, appraisal_id: request.appraisal_id, sme_decision, sme_reviewer: str(i, "sme_reviewer"), sent_to_appraiser_at, turn_time_due_at });
    return { rov_id, forwarded: true, sme_decision, sent_to_appraiser_at, turn_time_due_at, template: "ROV-24.2 v1", text, appraiser_contacted: true };
  }), guardrails: [noValueLanguage("forwardRov"), needsRole("ROV_DECLINE_IS_SME_DECISION", "24.2 guardrails: never decline an ROV alone — the designated SME (`underwriting_reviewer`) decides", (i) => i.sme_decision === "decline", ["underwriting_reviewer"], "a decline is recorded by the underwriting_reviewer on the AI-prepared analysis (open question 1)"), never("ROV_MAX_FIVE_COMPARABLES", "B4-1.3-12: additional data, information, or comparable properties (not to exceed five)", (i) => Array.isArray((i.request as { comparables?: unknown[] } | undefined)?.comparables) && ((i.request as { comparables: unknown[] }).comparables.length > ROV_MAX_COMPARABLES), "ask the borrower to choose; do not forward more than five")] },
  { name: "closeRov", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "rov_id", "appraisal_id", "original_value_cents");
    const c = ectx(i, ctx); const rov_id = str(i, "rov_id"), appraisal_id = str(i, "appraisal_id"); const stored = rt.store.get("rov_requests", rov_id);
    const revised_appraisal_id = (i.revised_appraisal_id as string | undefined) ?? null; const response_received_at = typeof i.response_received_at === "string" ? i.response_received_at : ctx.now;
    if (revised_appraisal_id) recordRovResponse(ctx.events, c, { rov_id, appraisal_id, revised_appraisal_id, response_received_at });
    const outcome = rovOutcome({ original_value_cents: cents(i.original_value_cents), revised_value_cents: optCents(i, "revised_value_cents"), declined: flag(i, "declined"), withdrawn: flag(i, "withdrawn") });
    const outcome_document_id = (i.outcome_document_id as string | undefined) ?? null;
    persist(rt, ctx, "rov_requests", rov_id, { ...(stored?.data ?? { rov_id, appraisal_id }), status: "closed", response_received_at: revised_appraisal_id ? response_received_at : null, revised_appraisal_id, outcome, outcome_document_id, closed_at: ctx.now });
    recordRovClosed(ctx.events, c, { rov_id, appraisal_id, outcome, outcome_document_id, closed_at: ctx.now });
    return { rov_id, outcome, revised_appraisal_id, outcome_document_id, retained_in_loan_file: true, closed_at: ctx.now };
  }), guardrails: [needsRole("ROV_DECLINE_IS_SME_DECISION", "24.2 guardrails: never decline an ROV alone", (i) => i.declined === true, ["underwriting_reviewer"], "a declined outcome is the designated SME's decision")] },
  // ---------------------------------------------------------------- R7 HPML tests
  { name: "runHpmlTests", kind: "act", handler: compute((i, ctx) => {
    need(i, "loan_amount_cents", "assignment_type");
    const flip = i.flip && typeof i.flip === "object" ? (() => { const f = obj<{ contract_date: string; seller_acquisition_date: string; contract_price_cents: unknown; seller_acquisition_price_cents: unknown; exemption_code?: string | null }>(i, "flip"); return { contract_date: D(f.contract_date), seller_acquisition_date: D(f.seller_acquisition_date), contract_price_cents: cents(f.contract_price_cents), seller_acquisition_price_cents: cents(f.seller_acquisition_price_cents), exemption_code: f.exemption_code ?? null }; })() : null;
    const t = runHpmlTests({ is_hpml: typeof i.is_hpml === "boolean" ? i.is_hpml : null, qm_type: (i.qm_type as "general_safe_harbor" | "general_rebuttable" | "not_qm" | undefined) ?? null, loan_amount_cents: cents(i.loan_amount_cents), as_of: D((typeof i.as_of === "string" ? i.as_of : ctx.now).slice(0, 10)), assignment_type: str(i, "assignment_type") as Parameters<typeof runHpmlTests>[0]["assignment_type"], interior_visit: i.interior_visit === undefined ? true : flag(i, "interior_visit"), consummation_on: optDate(i, "consummation_on"), flip, other_c2_exemption: (i.other_c2_exemption as string | undefined) ?? null });
    const plan = t.second_appraisal_required && Array.isArray(i.appraisal_fee_items) ? secondAppraisalPlan({ first_appraiser_party_id: str(i, "first_appraiser_party_id"), second_appraiser_party_id: (i.second_appraiser_party_id as string | undefined) ?? null, appraisal_fee_items: list<Parameters<typeof secondAppraisalPlan>[0]["appraisal_fee_items"][number]>(i, "appraisal_fee_items") }) : null;
    if (t.second_appraisal_required && typeof i.appraisal_id === "string") recordSecondAppraisalRequired(ctx.events, ectx(i, ctx), { appraisal_id: str(i, "appraisal_id"), flip: t.flip!, consummation_on: optDate(i, "consummation_on") });
    return { ...t, hpml_appraisal_rules_apply: t.apply.apply, second_appraisal_plan: plan };
  }), guardrails: [never("HPML_COPY_TIMING_NOT_WAIVABLE", "12 CFR 1026.35(c)(6)(ii)(A): no waiver provision for the HPML appraisal copy", (i) => i.waive_copy_timing === true || i.waiver === true, "HPML copies are due three business days before consummation regardless of any Reg B waiver"), never("HPML_SECOND_APPRAISAL_SINGLE_FEE", "12 CFR 1026.35(c)(4)(vi): the creditor may charge the consumer for only one of the appraisals", (i) => i.charge_both_appraisals === true, "only one appraisal fee may be borrower-paid (fee_items guard)")] },
  // ---------------------------------------------------------------- decisions and escalations
  { name: "writeDecision", kind: "write", handler: decision() },
  { name: "fileEscalation", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "kind", "reason");
    const kind = kindIn(i);
    const sla = kind === "officer" ? "5 business_days_creditor" : "1 business_days_creditor";
    const e = rt.escalations.open({ kind, ...(kind === "human_portal_task" ? { ownerRole: "fnma_portal_operator" } : {}), applicationId: appOf(i, ctx), ...(ctx.loanId ? { loanId: ctx.loanId } : {}), ...(typeof i.severity === "string" ? { severity: i.severity } : {}), payload: { reason: str(i, "reason"), justification: (i.justification as string | undefined) ?? null, reason_code: (i.reason_code as string | undefined) ?? null, appraisal_id: (i.appraisal_id as string | undefined) ?? null, override: i.override ?? null, sla, ...((i.payload as Record<string, unknown> | undefined) ?? {}) } }, ctx.actor);
    return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, sla, payload: e.payload };
  }), humanRoles: ["officer", "underwriting_reviewer", "fnma_portal_operator", "human_agent", "ops_analyst"],
    guardrails: [needsRole("DISCRIMINATION_REFERRAL_OFFICER", "24.2 guardrails: never refer discrimination alone", (i) => i.agency_referral === true, ["officer"], "the agent opens the officer escalation; the officer makes the agency referral (valuation.discrimination.referred)"), never("UCDP_OVERRIDE_NOT_APPROVED_BY_AGENT", "24.2 guardrails: never approve an override alone", (i) => i.approve_override === true, "the escalation carries the prepared reason code and justification; approval happens in the UCDP UI by the fnma_portal_operator")] },
]);
void DEFAULT_ESCALATION;
