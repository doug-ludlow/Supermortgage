/**
 * §22.3 process-owned tools — bus tools for 22.3 defined with `defineTools("22.3", "verification", defs)` from ../tools.ts.
 * Every tool string is one spec/registry/agents.json names for 22.3 (`buildDocumentationMatrix`, `orderVerificationReport`,
 * `submitIncomeCalculator`); src/app/tools.test.ts refuses the rest, so the AI-design paragraph's longer list
 * (`calculateIncome{type}`, `assessTrend`, `computeGrossUp`, `evaluateContinuance`, `runRegBCheck`, `scheduleVvoe`,
 * `sourceEmployerPhone`, `placeVvoeCall`, `recordVvoe`, `verifyBusinessExistence`, `prepareForm4506C`, `orderTranscript`,
 * `reconcileTranscript`, `draftWrittenEvaluation`, `buildAtrManifest`, `finalizeIncome`) is implemented as the `op` of the
 * three: the calculation family under `buildDocumentationMatrix`, the verification / VVOE / business / 4506-C / transcript
 * family under `orderVerificationReport`, the Income Calculator, override and written-evaluation family under
 * `submitIncomeCalculator`. Handlers are thin: the rules live in src/domain/verification/ops-22-3.ts; the store keeps
 * `application_income` (0057, versioned per source), `income_calculations`, `employment_verifications`,
 * `business_verifications`, `tax_transcript_requests` (migration 0080) and the in-flight `verifications`; the scheduled note
 * date is read from 26.x's `closing.scheduled` events (or the input). Guardrails encode the AI-design sentences: never
 * income above the Income Calculator result; never a borrower-supplied phone number for a VVOE; never a DU "not validated"
 * treated as a validation; never a haircut or exclusion because income is part-time, retirement, public assistance,
 * alimony/child support or age-related; never infer leave, pregnancy or family plans; never a `flagged` document as the
 * sole evidence; never sign or alter Form 4506-C/8821; never waive the VVOE, the 4506-C or the 3-year continuance; never
 * finalize after a closing move without re-running the windows. `underwriting_reviewer` when finalized income would
 * produce a denial/counteroffer (SLA 2 `business_days_creditor`) or transcript discrepancies suggest misrepresentation;
 * `licensed_specialist` where the state licenses underwriting activity; `human_agent` on request or when the employer
 * refuses an automated caller.
 */
import { defineTools, compute, never, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import { scheduledNoteDate } from "../../domain/verification/ops-22-1.ts";
import {
  AGENT, RULE_SET_VERSION, IncomeRuleRefused, PHONE_SOURCES, FORMULAS, assertUnderCalculatorCeiling, assessTrend, atrRecordTypes, buildDocumentationMatrix, businessVerificationWindow, calculateIncome, closeByGate, decisionRecord, evaluateContinuance, finalizeIncome, form4506cGate, grossUp,
  orderTranscript, reassessCloseBy, receiveTranscript, receiveVerification, recordCalculatorFindings, recordDuValidation, recordVvoe, regbCheck, scheduleVvoe, selectOfferOption, signAuthorization, submitIncomeCalculator, totalQualifying, transcriptPolicy, verifyBusinessExistence, vvoeAlternativeWindow, vvoeFromDuValidation, vvoeWindow,
  type AtrRecordType, type CalculateIncomeInput, type DeclaredSource, type DuValidationMessage, type FinalizeSource, type IncomeType, type OfferInput, type PhoneSource, type RegBFlag, type TaxTranscriptRequest, type VvoeInput, type VvoeMethod,
} from "../../domain/verification/ops-22-3.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && i[k] ? String(i[k]) : null);
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const list = <T,>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const calendarOf = (i: ToolInput): Calendar => (i.calendar as Calendar | undefined) ?? creditor;
/** The note date the windows run against: the input, else the latest `closing.scheduled`/`closing.rescheduled` of the application. */
const noteDateOf = (i: ToolInput, ctx: CommandContext, app: string): PlainDate => { const d = optDate(i, "note_date") ?? optDate(i, "scheduled_note_date") ?? scheduledNoteDate(ctx.events, app); if (!d) throw new RangeError("note_date is required (no closing.scheduled event for the application)"); return d; };
const requestOf = (rt: ToolRuntime, i: ToolInput): TaxTranscriptRequest => { need(i, "request_id"); return rt.store.require("tax_transcript_requests", str(i, "request_id")).data as unknown as TaxTranscriptRequest; };
const put = (rt: ToolRuntime, kind: string, id: string, data: object, ctx: CommandContext) => rt.store.put(kind, id, { ...data }, ctx.actor, ctx.now);
/** ops-22-3 refusals (IncomeRuleRefused) surface as CommandRefused with the same code and citation. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof IncomeRuleRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); throw e; } } }));
const UW_SLA_BD = 2;

export const TOOLS_22_3: readonly ToolDef[] = defineTools("22.3", "verification", refusing([
  // The calculation family: documentation matrix from the intake declaration → calculateIncome{type} → assessTrend / computeGrossUp / evaluateContinuance /
  // runRegBCheck → buildAtrManifest → finalizeIncome (the snapshot 23.1 / 23.3 / 22.5 / 23.4 consume).
  { name: "buildDocumentationMatrix", kind: "write", moneyFields: ["monthly_qualifying_cents", "factor"], handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const op = str(i, "op") || "matrix";
      switch (op) {
        case "matrix": {
          need(i, "sources"); const sources = list<DeclaredSource>(i, "sources");
          const r = buildDocumentationMatrix(ctx.events, { application_id: app, sources }, ctx.actor);
          for (const item of r.items) put(rt, "income_documentation_matrix", item.income_id, item, ctx);
          return { application_id: app, items: r.items, event: r.event.type }; }
        case "calculate": {
          need(i, "borrower_id", "income_id", "income_type", "inputs");
          const noteDate = optDate(i, "scheduled_note_date") ?? scheduledNoteDate(ctx.events, app);
          const r = calculateIncome(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), income_id: str(i, "income_id"), income_type: str(i, "income_type") as IncomeType, regb_flags: list<RegBFlag>(i, "regb_flags"), scheduled_note_date: noteDate, factor: (i.factor as string | number | null | undefined) ?? null,
            evidence_document_ids: list<string>(i, "evidence_document_ids"), flagged_document_ids: list<string>(i, "flagged_document_ids"), calculator_result_cents: optCents(i, "calculator_result_cents"), income_calculator_report_id: optStr(i, "income_calculator_report_id"), inputs: (i.inputs as Record<string, unknown>) }, ctx.actor);
          const calc_id = `${str(i, "income_id")}:${ctx.now}`;
          put(rt, "income_calculations", calc_id, { calc_id, income_id: str(i, "income_id"), formula_version: r.calculation.formula_version, inputs: r.calculation.inputs, steps: r.calculation.steps, result_cents: String(r.calculation.monthly_qualifying_cents), computed_at: ctx.now, agent_run_id: ctx.run?.runId ?? null, superseded_by: null }, ctx);
          const prev = rt.store.get("application_income", str(i, "income_id"));
          put(rt, "application_income", str(i, "income_id"), { id: str(i, "income_id"), application_id: app, application_borrower_id: str(i, "borrower_id"), version: Number(prev?.data.version ?? 0) + 1, income_type: r.calculation.income_type, calc_method: r.calculation.formula_version, inputs: r.calculation.inputs, trend: r.calculation.trend, stabilized_since: r.calculation.stabilized_since,
            monthly_qualifying_cents: String(r.calculation.monthly_qualifying_cents), nontaxable_cents: String(r.calculation.nontaxable_cents), gross_up_cents: String(r.calculation.gross_up_cents), continuance_basis: r.calculation.continuance_basis, continuance_end_date: r.calculation.continuance_end_date, regb_flags: list<RegBFlag>(i, "regb_flags"), regb_check: r.regb.regb_check,
            income_calculator_report_id: optStr(i, "income_calculator_report_id"), evidence_document_ids: list<string>(i, "evidence_document_ids"), used_for_qualifying: r.calculation.monthly_qualifying_cents > 0n || r.calculation.gross_up_cents > 0n, offset_only: r.calculation.inputs.offset_only === true, calculation_id: calc_id }, ctx);
          ctx.decide({ agent: AGENT.id, action: "income.calculate", rationale: JSON.stringify(decisionRecord(r.calculation, { income_id: str(i, "income_id"), regb_flags: list<RegBFlag>(i, "regb_flags"), regb_check: "pass", evidence_document_ids: list<string>(i, "evidence_document_ids"), du_validation_outcome: (str(i, "du_validation_outcome") || "not_submitted") as "not_submitted", calculator_report_id: optStr(i, "income_calculator_report_id"), atr_record_types: list<AtrRecordType>(i, "atr_record_types"), rationale: str(i, "rationale") || `formula ${r.calculation.formula_version}`, confidence: typeof i.confidence === "number" ? i.confidence : 1 })),
            ruleSetVersion: RULE_SET_VERSION, applicationId: app, subject: { kind: "application_income", id: str(i, "income_id") }, ruleCode: r.calculation.formula_version, evidenceDocumentIds: list<string>(i, "evidence_document_ids"), ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}) });
          return { income_id: str(i, "income_id"), calc_id, income_type: r.calculation.income_type, formula_version: r.calculation.formula_version, monthly_qualifying_cents: r.calculation.monthly_qualifying_cents, nontaxable_cents: r.calculation.nontaxable_cents, gross_up_cents: r.calculation.gross_up_cents, qualifying_cents: r.calculation.qualifying_cents, trend: r.calculation.trend, stabilized_since: r.calculation.stabilized_since,
            continuance_basis: r.calculation.continuance_basis, continuance_end_date: r.calculation.continuance_end_date, regb_check: r.regb.regb_check, reason: r.calculation.reason, reclassified_to: r.calculation.reclassified_to, steps: r.calculation.steps, event: r.event.type }; }
        case "trend": { need(i, "ytd_cents", "ytd_months", "prior_year_cents"); return assessTrend({ ytd_cents: cents(i.ytd_cents), ytd_months: num(i, "ytd_months"), prior_year_cents: cents(i.prior_year_cents), ...(i.stable_band_pct !== undefined ? { stable_band_pct: num(i, "stable_band_pct") } : {}) }); }
        case "gross_up": { need(i, "nontaxable_cents"); const g = grossUp(cents(i.nontaxable_cents)); return { nontaxable_cents: cents(i.nontaxable_cents), gross_up_cents: g, formula_version: FORMULAS.gross_up }; }
        case "continuance": {
          need(i, "income_id", "income_type"); const noteDate = noteDateOf(i, ctx, app);
          const r = evaluateContinuance(ctx.events, { application_id: app, income_id: str(i, "income_id"), income_type: str(i, "income_type") as IncomeType, note_date: noteDate, continuance_end_date: optDate(i, "continuance_end_date"), ...(i.continuance_basis ? { continuance_basis: str(i, "continuance_basis") as "documented_3y" } : {}), qualifying_cents: cents(i.qualifying_cents) }, ctx.actor);
          if (!r.pass) put(rt, "application_income", str(i, "income_id"), { id: str(i, "income_id"), used_for_qualifying: false, exclusion_reason: r.written_reason }, ctx);
          return { income_id: str(i, "income_id"), pass: r.pass, required_through: r.required_through, continuance_end_date: r.continuance_end_date, qualifying_cents: r.qualifying_cents, written_reason: r.written_reason }; }
        case "regb_check": { need(i, "income_type", "formula_version"); return regbCheck({ income_type: str(i, "income_type") as IncomeType, regb_flags: list<RegBFlag>(i, "regb_flags"), formula_version: str(i, "formula_version") as typeof FORMULAS.base_salary, factor: (i.factor as string | number | null | undefined) ?? null, exclusion_reason: optStr(i, "exclusion_reason") }); }
        case "atr_manifest": { need(i, "income_id"); const types = atrRecordTypes(list<{ doc_class: string }>(i, "evidence"), null); put(rt, "application_income", str(i, "income_id"), { id: str(i, "income_id"), atr_record_types: types }, ctx); return { income_id: str(i, "income_id"), atr_record_types: types, standard: "12 CFR 1026.43(c)(4)" }; }
        case "total": { need(i, "sources"); return totalQualifying(list(i, "sources")); }
        case "finalize": {
          need(i, "sources"); const scheduled = optDate(i, "scheduled_note_date") ?? scheduledNoteDate(ctx.events, app);
          const r = finalizeIncome(ctx.events, { application_id: app, sources: list<FinalizeSource>(i, "sources"), windows_run_for_note_date: optDate(i, "windows_run_for_note_date"), scheduled_note_date: scheduled }, ctx.actor);
          let escalation: string | null = null;
          if (flag(i, "would_deny_or_counteroffer")) escalation = rt.escalations.open({ kind: "underwriting_reviewer", applicationId: app, payload: { reason: "finalized income would produce a denial/counteroffer (21.6)", total_qualifying_cents: String(r.total_qualifying_cents), sla: `${UW_SLA_BD} business_days_creditor`, sla_due: addBusinessDays(D(ctx.now.slice(0, 10)), UW_SLA_BD, creditor) } }, ctx.actor).id;
          if (flag(i, "processor_license_required")) escalation = rt.escalations.open({ kind: "licensed_specialist", applicationId: app, payload: { reason: "state licenses underwriting activity (31.1): written income evaluation routed", total_qualifying_cents: String(r.total_qualifying_cents) } }, ctx.actor).id;
          return { application_id: app, total_qualifying_cents: r.total_qualifying_cents, atr_manifest: r.atr_manifest, event: r.event.type, escalation_id: escalation }; }
        default: throw new RangeError(`op ${JSON.stringify(op)} is not one of matrix/calculate/trend/gross_up/continuance/regb_check/atr_manifest/total/finalize`);
      } }),
    guardrails: [never("REGB_1002_6_B_NO_DISCOUNT", "12 CFR 1002.6(b)(2), (b)(5); 22.3 AI design: never apply a haircut or exclusion because income is part-time, retirement, public assistance, alimony/child support, or age-related", (i) => i.factor !== undefined && i.factor !== null && i.factor !== "" && Number(i.factor) < 1, "only the amount and probable continuance of income may vary; a factor below 1.0 discounts it"),
      never("CONTINUANCE_WAIVER", "B3-3.1-01; 22.3 AI design: never waive the 3-year continuance", (i) => flag(i, "waive_continuance"), "continuance is documented or the income is excluded with a written reason"),
      never("REGB_1002_6_B3_NO_INFERENCE", "12 CFR 1002.6(b)(3); 22.3 AI design: never infer leave, pregnancy or family plans", (i) => flag(i, "infer_leave") || flag(i, "infer_family_plans") || (i.inputs !== undefined && typeof i.inputs === "object" && i.inputs !== null && ("pregnancy" in (i.inputs as object) || "childbearing_plans" in (i.inputs as object))), "the agent asks the borrower only for the return date and employer confirmation; nothing is inferred from a pay gap or family status"),
      never("FINALIZE_AFTER_CLOSING_MOVE", "22.3 AI design: never finalize income after a closing move without re-running the windows", (i) => str(i, "op") === "finalize" && flag(i, "skip_window_rerun"), "the VVOE / business / Close by / 4506-C windows are recomputed for the new note date first")] },
  // The verification family: DU validation-service orders and reports, DU messages (validated / not validated, Close by Date), VVOE scheduling and records
  // (sourceEmployerPhone / placeVvoeCall / recordVvoe), business existence, Form 4506-C / 8821, transcript orders and reconciliation.
  { name: "orderVerificationReport", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const op = str(i, "op") || "order";
      switch (op) {
        case "order": {
          need(i, "borrower_id", "component", "supplier_code", "authorization_consent_id");
          const order_id = `${app}:${str(i, "borrower_id")}:${str(i, "component")}:${str(i, "supplier_code")}`;
          const e = ctx.events.append({ type: "verification.ordered", applicationId: app, actor: ctx.actor, payload: { order_id, borrower_id: str(i, "borrower_id"), component: str(i, "component"), supplier_code: str(i, "supplier_code"), report_type: str(i, "report_type") || "voie", authorization_consent_id: str(i, "authorization_consent_id"), ordered_at: at(i, "ordered_at", ctx), application_id: app } });
          put(rt, "verifications", order_id, { verification_id: order_id, application_id: app, borrower_id: str(i, "borrower_id"), component: str(i, "component"), supplier_code: str(i, "supplier_code"), distributor: optStr(i, "distributor"), authorization_consent_id: str(i, "authorization_consent_id"), status: "ordered", ordered_at: at(i, "ordered_at", ctx) }, ctx);
          return { order_id, status: "ordered", event: e.type, poll_after_minutes: 15, reorder_after_hours: 24, fallback: "Form 1005 / paper path" }; }
        case "receive": {
          need(i, "borrower_id", "kind", "supplier_code", "report_reference_id", "vendor_data_as_of", "report_document_id", "authorization_consent_id");
          const r = receiveVerification(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), kind: str(i, "kind") as "income", supplier_code: str(i, "supplier_code"), report_reference_id: str(i, "report_reference_id"), vendor_data_as_of: D(str(i, "vendor_data_as_of")), report_document_id: str(i, "report_document_id"), authorization_consent_id: str(i, "authorization_consent_id"), ...(i.verification_id ? { verification_id: str(i, "verification_id") } : {}) }, ctx.actor);
          put(rt, "verifications", r.verification_id, { verification_id: r.verification_id, application_id: app, borrower_id: str(i, "borrower_id"), component: str(i, "kind"), supplier_code: str(i, "supplier_code"), report_reference_id: str(i, "report_reference_id"), vendor_data_as_of: str(i, "vendor_data_as_of"), report_document_id: str(i, "report_document_id"), authorization_consent_id: str(i, "authorization_consent_id"), status: "received", du_validation_outcome: "not_submitted" }, ctx);
          return { verification_id: r.verification_id, kind: str(i, "kind"), report_reference_id: str(i, "report_reference_id"), du_submission_fields: { "DU:VerificationReportSupplierType": str(i, "supplier_code"), "DU:VerificationReportIdentifier": str(i, "report_reference_id") }, event: r.event.type }; }
        case "du_validation": {
          need(i, "borrower_id", "component", "outcome", "report_reference_id", "supplier_code");
          const m: DuValidationMessage = { application_id: app, borrower_id: str(i, "borrower_id"), component: str(i, "component") as "employment", outcome: str(i, "outcome") as "validated", report_reference_id: str(i, "report_reference_id"), supplier_code: str(i, "supplier_code"), employer_name: optStr(i, "employer_name"), close_by_date: optDate(i, "close_by_date"), documentation_required: list<string>(i, "documentation_required"), submission_number: optStr(i, "submission_number"), message_date: optDate(i, "message_date") ?? D(ctx.now.slice(0, 10)) };
          const r = recordDuValidation(ctx.events, m, ctx.actor);
          if (i.verification_id) put(rt, "verifications", str(i, "verification_id"), { du_validation_outcome: m.outcome, close_by_date: m.close_by_date }, ctx);
          const noteDate = optDate(i, "note_date") ?? scheduledNoteDate(ctx.events, app);
          const vvoe = r.validated && m.component === "employment" && noteDate && m.close_by_date ? vvoeFromDuValidation(ctx.events, { application_id: app, borrower_id: m.borrower_id, employer_name: m.employer_name ?? "", close_by_date: m.close_by_date, note_date: noteDate, report_reference_id: m.report_reference_id }, ctx.actor) : null;
          return { validated: r.validated, component: m.component, close_by_date: m.close_by_date, relief: r.relief, needs_list_items: r.validated ? [] : [...(m.documentation_required ?? [])], vvoe_satisfied_by_du: vvoe !== null, event: r.event.type }; }
        case "close_by_check": {
          need(i, "borrower_id", "close_by_date", "report_reference_id"); const scheduled = noteDateOf(i, ctx, app);
          const r = reassessCloseBy(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), close_by_date: D(str(i, "close_by_date")), scheduled_note_date: scheduled, report_reference_id: str(i, "report_reference_id"), calendar: calendarOf(i) }, ctx.actor);
          return { gate: closeByGate(D(str(i, "close_by_date")), scheduled), breached: r.breached, cure_options: r.cure_options, vvoe_window: r.vvoe_window, relief: r.relief, du_resubmission: r.breached }; }
        case "windows": {
          const noteDate = noteDateOf(i, ctx, app); const cal = calendarOf(i);
          return { note_date: noteDate, vvoe: vvoeWindow(noteDate, cal), alternative: vvoeAlternativeWindow(noteDate, cal), business: businessVerificationWindow(noteDate), vvoe_scheduled_for: addBusinessDays(noteDate, -2, cal) }; }
        case "schedule_vvoe": {
          need(i, "borrower_id"); const noteDate = noteDateOf(i, ctx, app);
          const r = scheduleVvoe(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), method: (str(i, "method") || "verbal_ai_voice") as VvoeMethod, note_date: noteDate, calendar: calendarOf(i), ...(i.vvoe_id ? { vvoe_id: str(i, "vvoe_id") } : {}) }, ctx.actor);
          put(rt, "employment_verifications", r.vvoe_id, { vvoe_id: r.vvoe_id, application_id: app, borrower_id: str(i, "borrower_id"), status: "scheduled", window_start: r.window.window_start, note_date_used: noteDate, scheduled_for: r.scheduled_for }, ctx);
          return { vvoe_id: r.vvoe_id, window_start: r.window.window_start, note_date: noteDate, scheduled_for: r.scheduled_for, disclosure: "automated system verifying employment on behalf of the partner", event: r.event.type }; }
        case "record_vvoe": {
          need(i, "borrower_id", "method", "employer_name", "contacted_at"); const noteDate = noteDateOf(i, ctx, app);
          if (flag(i, "employer_refused_automated_caller")) { const esc = rt.escalations.open({ kind: "human_agent", applicationId: app, payload: { reason: "employer refuses to speak to an automated caller; a human operator places the call", borrower_id: str(i, "borrower_id"), employer_name: str(i, "employer_name") } }, ctx.actor); return { escalation_id: esc.id, status: "human_operator_call_queued", alternatives: ["written_form_1005", "employer_email", "vendor_written"] }; }
          const r: VvoeInput = { application_id: app, borrower_id: str(i, "borrower_id"), income_ids: list<string>(i, "income_ids"), method: str(i, "method") as VvoeMethod, employer_name: str(i, "employer_name"), employer_phone: optStr(i, "employer_phone"), phone_source: optStr(i, "phone_source") as PhoneSource | null, phone_source_evidence_document_id: optStr(i, "phone_source_evidence_document_id"),
            contact_name: optStr(i, "contact_name"), contact_title: optStr(i, "contact_title"), verifier_identity: str(i, "verifier_identity") || ctx.run?.runId || `${ctx.actor.kind}:${ctx.actor.id}`, contacted_at: str(i, "contacted_at"), employment_status: (str(i, "employment_status") || "active") as "active", start_date_confirmed: optDate(i, "start_date_confirmed"), note_date: noteDate, calendar: calendarOf(i),
            recording_document_id: flag(i, "recording_consent_lawful") ? optStr(i, "recording_document_id") : null, transcript_document_id: optStr(i, "transcript_document_id"), ...(i.vvoe_id ? { vvoe_id: str(i, "vvoe_id") } : {}) };
          const v = recordVvoe(ctx.events, r, ctx.actor);
          put(rt, "employment_verifications", v.record.vvoe_id, { ...v.record, status: v.record.within_window ? "completed" : "expired" }, ctx);
          if (v.record.employment_status === "on_leave") return { ...v.record, switch_to: "B3-3.3-09 temporary leave rules (calculate with income_type=temporary_leave)", event: v.event.type };
          return { ...v.record, event: v.event.type, missed: v.missed?.type ?? null }; }
        case "verify_business": {
          need(i, "borrower_id", "business_name", "source", "source_reference", "verified_at", "evidence_document_id"); const noteDate = noteDateOf(i, ctx, app);
          const r = verifyBusinessExistence(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), business_name: str(i, "business_name"), source: str(i, "source") as "secretary_of_state", source_reference: str(i, "source_reference"), verified_at: D(str(i, "verified_at")), note_date_used: noteDate, evidence_document_id: str(i, "evidence_document_id"), ...(i.verification_id ? { verification_id: str(i, "verification_id") } : {}) }, ctx.actor);
          put(rt, "business_verifications", r.record.verification_id, r.record, ctx);
          return { ...r.record, event: r.event.type }; }
        case "prepare_4506c": {
          need(i, "borrower_id", "tax_years");
          const policy = transcriptPolicy({ returns_relied_upon: flag(i, "returns_relied_upon"), w2_1099_integrity_flagged: flag(i, "w2_1099_integrity_flagged"), tax_years: list<number>(i, "tax_years") });
          return { borrower_id: str(i, "borrower_id"), form: str(i, "form") || "4506c", third_party: "partner (lender of record)", fannie_mae_disclosure_authorization: true, prepared_by: "agent (the borrower signs)", esign: ["esign_2fa", "esign_kba", "esign_sso"], transcript_policy: policy }; }
        case "sign_4506c": {
          need(i, "borrower_id", "form", "signed_at", "signature_method", "tax_years");
          const r = signAuthorization(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), form: str(i, "form") as "4506c", signed_at: str(i, "signed_at"), signed_by: str(i, "signed_by") || "borrower", signature_method: str(i, "signature_method") as "esign_2fa", signature_audit_log_document_id: optStr(i, "signature_audit_log_document_id"), tax_years: list<number>(i, "tax_years"), transcript_types: list(i, "transcript_types"), fannie_mae_disclosure_authorized: flag(i, "fannie_mae_disclosure_authorized"), ...(i.request_id ? { request_id: str(i, "request_id") } : {}) }, ctx.actor);
          put(rt, "tax_transcript_requests", r.record.request_id, { ...r.record, fee_cents: String(r.record.fee_cents) }, ctx);
          return { request_id: r.record.request_id, valid_until: r.record.valid_until, status: r.record.status, retention_class: r.record.retention_class, event: r.event.type }; }
        case "gate_4506c": { need(i, "borrowers"); return form4506cGate(list(i, "borrowers"), optDate(i, "closing_on")); }
        case "order_transcript": {
          need(i, "request_id", "channel", "participant_id_masked"); const req = { ...requestOf(rt, i), fee_cents: 0n };
          const r = orderTranscript(ctx.events, req, { channel: str(i, "channel") as "ives_a2a", ordered_at: at(i, "ordered_at", ctx), participant_id_masked: str(i, "participant_id_masked") }, ctx.actor);
          put(rt, "tax_transcript_requests", r.record.request_id, { ...r.record, fee_cents: String(r.record.fee_cents) }, ctx);
          return { request_id: r.record.request_id, status: r.record.status, fee_cents: r.fee_cents, ledger_account: "third_party_costs", event: r.event.type }; }
        case "receive_transcript": {
          need(i, "request_id", "result"); const req = { ...requestOf(rt, i), fee_cents: cents(requestOf(rt, i).fee_cents) };
          const figures = list<{ tax_year: number; line: string; transcript_cents: string; return_cents: string }>(i, "figures").map((f) => ({ tax_year: f.tax_year, line: f.line, transcript_cents: cents(f.transcript_cents), return_cents: cents(f.return_cents) }));
          const r = receiveTranscript(ctx.events, req, { received_at: at(i, "received_at", ctx), result: str(i, "result") as "received", figures, rejection_code: optStr(i, "rejection_code") }, ctx.actor);
          put(rt, "tax_transcript_requests", r.record.request_id, { ...r.record, fee_cents: String(r.record.fee_cents) }, ctx);
          let escalation: string | null = null;
          if (r.discrepancies.length && flag(i, "suggests_misrepresentation")) escalation = rt.escalations.open({ kind: "underwriting_reviewer", applicationId: app, payload: { reason: "transcript discrepancies suggest misrepresentation (with 22.6)", request_id: req.request_id, discrepancies: r.discrepancies.length, sla: `${UW_SLA_BD} business_days_creditor` } }, ctx.actor).id;
          return { request_id: r.record.request_id, status: r.record.status, discrepancies: r.discrepancies.length, resolve_before: "income.finalized", escalation_id: escalation, qc_reuse: "D1-3-03: pre-closing transcripts are reusable in post-closing QC (28.2)", event: r.event.type }; }
        default: throw new RangeError(`op ${JSON.stringify(op)} is not one of order/receive/du_validation/close_by_check/windows/schedule_vvoe/record_vvoe/verify_business/prepare_4506c/sign_4506c/gate_4506c/order_transcript/receive_transcript`);
      } }),
    guardrails: [never("VVOE_BORROWER_PHONE", "B3-3.1-04: the lender must independently obtain a phone number for the employer; 22.3 AI design: never use a borrower-supplied phone number for a VVOE", (i) => str(i, "op") === "record_vvoe" && (flag(i, "phone_from_borrower_document") || (i.phone_source !== undefined && i.phone_source !== null && i.phone_source !== "" && !PHONE_SOURCES.includes(str(i, "phone_source") as PhoneSource))), `phone_source must be one of ${PHONE_SOURCES.join("/")} with stored evidence`),
      never("DU_NOT_VALIDATED_IS_NOT_VALIDATION", "B3-2-02; 22.3 AI design: never treat a DU 'not validated' as a validation", (i) => str(i, "op") === "du_validation" && str(i, "outcome") !== "validated" && flag(i, "treat_as_validated"), "the DU message's documentation list becomes needs-list items instead"),
      never("FORM_4506C_AGENT_SIGNATURE", "B3-3.1-02; IRS IVES; 22.3 AI design: never sign or alter Form 4506-C/8821 — the borrower signs, the agent prepares", (i) => str(i, "op") === "sign_4506c" && i.signed_by !== undefined && i.signed_by !== null && i.signed_by !== "" && str(i, "signed_by") !== "borrower" || flag(i, "alter_form"), "only the borrower's own signature with an IVES-grade audit log is accepted"),
      never("VVOE_WAIVER", "B3-3.1-04; 22.3 AI design: never waive the VVOE", (i) => flag(i, "waive_vvoe"), "a VVOE (or a DU employment validation honoured through its Close by Date) is required for each borrower using employment or self-employment income"),
      never("FORM_4506C_WAIVER", "B3-3.1-02; 22.3 AI design: never waive the 4506-C", (i) => flag(i, "waive_4506c"), "each qualifying borrower signs a 4506-C/8821 at or before closing unless all of that borrower's income is DU-validated")] },
  // Income Calculator (B3-3.1-03): submit → Findings Report → qualifying ≤ calculator result; manual overrides above the ceiling are refused; the written
  // self-employment evaluation (B3-3.5-01) is drafted as a document and routed to a `licensed_specialist` where the state licenses underwriting activity.
  { name: "submitIncomeCalculator", kind: "write", moneyFields: ["qualifying_cents", "agent_result_cents"], handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const op = str(i, "op") || "submit";
      switch (op) {
        case "submit": {
          need(i, "income_id", "borrower_id", "business_structure", "tax_years");
          const e = submitIncomeCalculator(ctx.events, { application_id: app, income_id: str(i, "income_id"), borrower_id: str(i, "borrower_id"), business_structure: str(i, "business_structure") as "schedule_c", tax_years: list<number>(i, "tax_years"), path: (str(i, "path") || "iframe") as "iframe" }, ctx.actor);
          return { income_id: str(i, "income_id"), submitted: true, path: e.payload.path, fee: "none (Fannie Mae charges no fee)", event: e.type }; }
        case "findings": {
          need(i, "income_id", "findings_report_id", "calculator_result_cents", "agent_result_cents");
          const r = recordCalculatorFindings(ctx.events, { application_id: app, income_id: str(i, "income_id"), findings_report_id: str(i, "findings_report_id"), calculator_result_cents: cents(i.calculator_result_cents), agent_result_cents: cents(i.agent_result_cents) }, ctx.actor);
          put(rt, "application_income", str(i, "income_id"), { id: str(i, "income_id"), income_calculator_report_id: r.income_calculator_report_id, monthly_qualifying_cents: String(r.qualifying_cents), calc_method: r.formula_version }, ctx);
          return { income_id: str(i, "income_id"), qualifying_cents: r.qualifying_cents, ceiling_applied: r.ceiling_applied, income_calculator_report_id: r.income_calculator_report_id, du_fields: r.du_fields, relief: "rep-and-warrant relief on the calculation only, not on data integrity", event: r.event.type }; }
        case "override": {
          need(i, "income_id", "qualifying_cents"); const ceiling = optCents(i, "calculator_result_cents") ?? (rt.store.get("income_calculator_findings", str(i, "income_id"))?.data.calculator_result_cents as bigint | undefined) ?? null;
          assertUnderCalculatorCeiling(cents(i.qualifying_cents), ceiling);
          need(i, "formula_version", "rationale");
          put(rt, "application_income", str(i, "income_id"), { id: str(i, "income_id"), monthly_qualifying_cents: String(cents(i.qualifying_cents)), calc_method: str(i, "formula_version"), manual_override: true }, ctx);
          ctx.decide({ agent: `${ctx.actor.kind}:${ctx.actor.id}`, action: "income.manual_override", rationale: str(i, "rationale"), ruleSetVersion: RULE_SET_VERSION, applicationId: app, subject: { kind: "application_income", id: str(i, "income_id") }, ruleCode: str(i, "formula_version") });
          return { income_id: str(i, "income_id"), qualifying_cents: cents(i.qualifying_cents), ceiling_cents: ceiling, formula_version: str(i, "formula_version") }; }
        case "written_evaluation": {
          need(i, "income_id", "borrower_id", "business_name", "analysis");
          const e = ctx.events.append({ type: "document.drafted", applicationId: app, actor: ctx.actor, payload: { doc_class: "explanation_letter", subclass: "se_written_evaluation", income_id: str(i, "income_id"), borrower_id: str(i, "borrower_id"), business_name: str(i, "business_name"), basis: "B3-3.5-01 written evaluation of the self-employed borrower's personal income including business income or loss", application_id: app } });
          const esc = flag(i, "processor_license_required") ? rt.escalations.open({ kind: "licensed_specialist", applicationId: app, payload: { reason: "jurisdiction_rules.processor_license_required (31.1): written income evaluation routed", income_id: str(i, "income_id") } }, ctx.actor).id : null;
          return { income_id: str(i, "income_id"), doc_class: "explanation_letter", subclass: "se_written_evaluation", escalation_id: esc, event: e.type }; }
        default: throw new RangeError(`op ${JSON.stringify(op)} is not one of submit/findings/override/written_evaluation`);
      } }),
    guardrails: [never("INCOME_CALCULATOR_CEILING", "B3-3.1-03: the amount of qualifying income used is not more than the amount calculated by Income Calculator; 22.3 AI design: never use income above the Income Calculator result", (i) => str(i, "op") === "override" && i.calculator_result_cents !== undefined && i.calculator_result_cents !== null && i.qualifying_cents !== undefined && cents(i.qualifying_cents) > cents(i.calculator_result_cents), "a manual override above the ceiling is rejected; the Findings Report governs")] },
]));
