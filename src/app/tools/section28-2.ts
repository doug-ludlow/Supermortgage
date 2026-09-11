/**
 * §28.2 process-owned tools — bus tools for 28.2 defined with `defineTools("28.2", "qc-audit", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 28.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The post-closing profile of the `qc-audit` agent (spec "AI agent design"): buildCyclePopulation, drawRandomSample,
 * selectDiscretionary, computeScope, orderReverification, reconcileLiabilities, assessOccupancy, assessCollateral,
 * reviewClosingDocuments, matchDuFinalData, shadowReunderwrite, draftFinding (op=draft|release), evaluateRebuttal,
 * computeDefectRates, draftCycleReport (op=draft|issue|complete|vendor_review), draftArrearsNotice (op=draft|send),
 * parseLqcNotification (op=parse|open), buildLqcPackage (op=build|confirm_submission|resolve|close), draftNopdResponse,
 * draftSelfReport (op=confirm|draft|approve|submit), draftAppeal (op=draft|file|response|impasse|conclude_impasse|
 * management_escalation|management_decision|idr|pay), computeRepurchasePrice, trackRelief (op=open|track|confirm|lose),
 * openOperatorEscalation, openOfficerEscalation, writeDecision. Guardrails encode the paragraph: the agent never submits
 * anything to Fannie Mae (operator-only), never pays or accepts a remedy (partner officer), never contacts a borrower
 * except for a new 4506-C/8821 authorization through the app, never alters production or servicing records, never files
 * a self-report without the officer's confirmed_at, never treats the 36-payment count as relief without Fannie Mae's
 * report, never reads applicant_demographics. State lives in the entity store (`qc_cycles`, `qc_reviews`, `qc_findings`,
 * `qc_reverifications`, `fnma_qc_cases`, `qc_self_reports`, `remedy_ledger`, `rep_warrant_relief`, `qc_reports`);
 * events go through ../../domain/qc-hmda/ops-28-2.ts so the 28.2 timers arm and close.
 */
import { defineTools, compute, decision, never, needsRole, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { buildCyclePopulation, drawRandomSample, selectDiscretionary, selectCycle, selectEpd, computeScope, applyScope, orderReverification, recordReverification, reconcileLiabilities, assessOccupancy, assessCollateral, reviewClosingDocuments, matchDuFinalData, shadowReunderwrite, recordReunderwrite,
  draftFinding, releaseFinding, evaluateRebuttal, closeReview, confirmIneligibleAsDelivered, draftSelfReport, approveSelfReport, submitSelfReport, confirmComplianceBreach, computeDefectRates, draftCycleReport, issueCycleReport, issueQuarterlyTargetSection, completeCycle, recordVendorReview, cycleArrears, startArrearsTracking, draftArrearsNotice, sendArrearsNotice,
  parseLqcNotification, openFnmaCase, buildLqcPackage, operatorTaskFor, confirmSubmission, draftNopdResponse, resolveResolutionRequest, closeFnmaCase, receiveDemand, draftAppeal, fileAppeal, ingestAppealResponse, declareImpasse, concludeImpasse, fileManagementEscalation, recordManagementEscalationDecision, initiateIdr, payRemedy, computeRepurchasePrice, computePalAmount, remedyLadder,
  openReliefTracking, trackRelief, confirmReliefFromReport, loseRelief, referToFraud, qcAuditMayWrite28_2, FORBIDDEN_READS, RULE_SET_28_2,
  type FundedLoan, type QcCycle, type QcReview, type QcFinding, type QcSelfReport, type FnmaQcCase, type RemedyLedger, type ReliefTracking, type ScopeFacts, type Tradeline, type DiscretionarySignals, type DiscretionaryReason, type RebuttalOutcome, type FnmaCaseType, type AppealAttachment, type AppealStage, type Reverification, type ReverificationKind, type MonthRate, type VendorReviewResult, type PackageDocument, type DefectClass, type Deficiency, type PaymentHistoryRow, type ReliefReport, type CorrectiveAction } from "../../domain/qc-hmda/ops-28-2.ts";

type Rt = ToolRuntime; type Ctx = CommandContext; type Row = Record<string, unknown>;
/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`28.2 tool needs ${missing.join(", ")}`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));
const arr = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const at = (ctx: Ctx, i: ToolInput, k = "at"): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const put = (rt: Rt, ctx: Ctx, kind: string, id: string, data: object): Row => { if (!qcAuditMayWrite28_2(kind)) throw new RangeError(`the QC agent never writes ${kind} (production/servicing records are read-only for qc-audit)`); return rt.store.put(kind, id, data as Row, ctx.actor, ctx.now).data; };
const rowOf = <T>(rt: Rt, kind: string, id: string): T => { const r = rt.store.get(kind, id); if (!r) throw new RangeError(`no ${kind} ${id}`); return r.data as unknown as T; };
const cycleOf = (rt: Rt, i: ToolInput): QcCycle => rowOf<QcCycle>(rt, "qc_cycles", (need(i, "cycle_id"), str(i, "cycle_id")));
const reviewOf = (rt: Rt, i: ToolInput): QcReview => rowOf<QcReview>(rt, "qc_reviews", (need(i, "review_id"), str(i, "review_id")));
const findingOf = (rt: Rt, i: ToolInput): QcFinding => rowOf<QcFinding>(rt, "qc_findings", (need(i, "finding_id"), str(i, "finding_id")));
const caseOf = (rt: Rt, i: ToolInput): FnmaQcCase => rowOf<FnmaQcCase>(rt, "fnma_qc_cases", (need(i, "case_id"), str(i, "case_id")));
const ledgerOf = (rt: Rt, i: ToolInput): RemedyLedger => rowOf<RemedyLedger>(rt, "remedy_ledger", (need(i, "remedy_id"), str(i, "remedy_id")));
const selfReportOf = (rt: Rt, i: ToolInput): QcSelfReport => rowOf<QcSelfReport>(rt, "qc_self_reports", (need(i, "self_report_id"), str(i, "self_report_id")));
const reliefOf = (rt: Rt, i: ToolInput): ReliefTracking => rowOf<ReliefTracking>(rt, "rep_warrant_relief", (need(i, "relief_id"), str(i, "relief_id")));
const reviewsOfCycle = (rt: Rt, cycleId: string): QcReview[] => rt.store.list("qc_reviews", (d) => d.cycle_id === cycleId).map((r) => r.data as unknown as QcReview);
const timerHandle = (ctx: Ctx) => ({ byCode: (code: string) => ctx.timers.byCode(code), cancel: (id: string, reason: string, actor?: Actor) => ctx.timers.cancel(id, reason, actor) });
const saveReview = (rt: Rt, ctx: Ctx, r: QcReview): QcReview => put(rt, ctx, "qc_reviews", r.review_id, r) as unknown as QcReview;
const saveCase = (rt: Rt, ctx: Ctx, c: FnmaQcCase): FnmaQcCase => put(rt, ctx, "fnma_qc_cases", c.case_id, c) as unknown as FnmaQcCase;
const saveLedger = (rt: Rt, ctx: Ctx, l: RemedyLedger): RemedyLedger => put(rt, ctx, "remedy_ledger", l.remedy_id, l) as unknown as RemedyLedger;
const touchesProduction = (i: ToolInput): boolean => i.write_production === true || i.target_table === "applications" || i.target_table === "loans" || i.resubmit_production_casefile === true;
const readsDemographics = (i: ToolInput): boolean => i.include_demographics === true || (FORBIDDEN_READS as readonly string[]).some((t) => JSON.stringify(i).includes(t));
const NO_FNMA_SUBMISSION = never("AGENT_NEVER_SUBMITS_TO_FNMA", "28.2 guardrails: never submits anything to Fannie Mae (operator-only)", (i) => i.submit_to_fnma === true || i.op === "submit_via_agent", "every Loan Quality Connect upload, self-report, NOPD response and appeal is a human portal action by the fnma_portal_operator on the AI-prepared package");
const NO_PRODUCTION_WRITE = never("AGENT_NEVER_ALTERS_PRODUCTION", "28.2 guardrails: never alters production or servicing records", touchesProduction, "reverification results that matter for servicing go to servicing as escalations; a re-underwrite runs in shadow on a QC-purpose DU casefile copy (23.1)");
const NO_DEMOGRAPHICS = never("AGENT_NEVER_READS_DEMOGRAPHICS", "28.2 guardrails: never reads applicant_demographics", readsDemographics, "the QC agent's inputs never include applicant_demographics (28.1-T13 access log: zero reads)");
const NO_BORROWER_CONTACT = never("AGENT_NEVER_CONTACTS_BORROWER", "28.2 guardrails: never contacts a borrower about a post-closing review except for a required authorization (a new 4506-C/8821) through the app", (i) => i.contact_borrower === true && i.purpose !== "new_4506c_8821_authorization", "borrower contact only for a new 4506-C/8821 authorization through the app with a plain explanation");

export const TOOLS_28_2: readonly ToolDef[] = defineTools("28.2", "qc-audit", [
  // ---- rule 1–3: the monthly cycle ------------------------------------------------------------
  { name: "buildCyclePopulation", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "partner_id", "production_month", "frozen_on");
      const loans = arr<FundedLoan>(i, "loans").length ? arr<FundedLoan>(i, "loans") : rt.store.list("fundings", (d) => typeof d.disbursement_date === "string").map((r) => r.data as unknown as FundedLoan);
      const r = buildCyclePopulation(ctx.events, { partner_id: str(i, "partner_id"), production_month: str(i, "production_month"), loans, frozen_on: date(i, "frozen_on"), random_method: (i.random_method as "ten_percent" | "statistical" | undefined) ?? "ten_percent", statistical_params: (i.statistical_params as QcCycle["statistical_params"]) ?? null, at: at(ctx, i) });
      put(rt, ctx, "qc_cycles", r.cycle.cycle_id, r.cycle);
      return { cycle: r.cycle, population: r.population.map((l) => l.loan_id), event_id: r.event.id }; }), guardrails: [NO_DEMOGRAPHICS] },
  { name: "drawRandomSample", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "cycle_id", "population", "seed"); const cycle = cycleOf(rt, i);
      const d = drawRandomSample(arr<FundedLoan>(i, "population"), cycle.random_target, num(i, "seed"));
      put(rt, ctx, "qc_cycles", cycle.cycle_id, { random_draw: d.selected.map((l) => l.loan_id), random_seed: num(i, "seed"), strata: d.strata });
      return { selected: d.selected, strata: d.strata, every_stratum_represented: d.every_stratum_represented, random_target: cycle.random_target }; }), guardrails: [NO_DEMOGRAPHICS] },
  { name: "selectDiscretionary", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "cycle_id", "population", "seed"); const cycle = cycleOf(rt, i);
      const exclude = new Set(arr<string>(i, "exclude").length ? arr<string>(i, "exclude") : ((rt.store.get("qc_cycles", cycle.cycle_id)?.data.random_draw as string[] | undefined) ?? []));
      const disc = selectDiscretionary(arr<FundedLoan & { signals?: DiscretionarySignals }>(i, "population"), { exclude, seed: num(i, "seed") });
      if (i.op === "select") {
        const random = arr<FundedLoan>(i, "random"); const r = selectCycle(ctx.events, cycle, random, disc, { selected_on: date(i, "selected_on"), at: at(ctx, i) });
        put(rt, ctx, "qc_cycles", cycle.cycle_id, r.cycle); for (const rv of r.reviews) saveReview(rt, ctx, rv);
        return { cycle: r.cycle, reviews: r.reviews, discretionary: disc.map((d) => ({ loan_id: d.loan.loan_id, reasons: d.reasons })) };
      }
      if (i.op === "epd") { const r = selectEpd(ctx.events, ctx.events.all().filter((e) => e.type === "epd.flag.raised"), arr<FundedLoan>(i, "population"), { month_end: date(i, "month_end"), selected_on: date(i, "selected_on"), at: at(ctx, i) }); for (const rv of r.reviews) saveReview(rt, ctx, rv); return { reviews: r.reviews, event_id: r.event.id }; }
      return { discretionary: disc.map((d) => ({ loan_id: d.loan.loan_id, reasons: d.reasons as DiscretionaryReason[] })) }; }), guardrails: [NO_DEMOGRAPHICS] },
  // ---- rule 4–5: scope, reverification, reconciliation, assessments -----------------------------
  { name: "computeScope", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "facts"); const f = i.facts as ScopeFacts;
      if (typeof i.review_id === "string") { const r = applyScope(ctx.events, reviewOf(rt, i), f, at(ctx, i)); saveReview(rt, ctx, r.review); return { scope: r.scope, review: r.review }; }
      return { scope: computeScope(f) }; }), guardrails: [NO_DEMOGRAPHICS] },
  { name: "orderReverification", kind: "act", handler: compute((i, ctx, rt) => {
      const r = reviewOf(rt, i);
      if (i.op === "record") { need(i, "reverification_id", "result"); const rv = rowOf<Reverification>(rt, "qc_reverifications", str(i, "reverification_id")); const out = recordReverification(ctx.events, r, rv, { received_on: optDate(i, "received_on"), result: i.result as "consistent" | "variance" | "unable", detail: str(i, "detail") || undefined as unknown as string, at: at(ctx, i) }); put(rt, ctx, "qc_reverifications", rv.reverification_id, out.reverification); return out.reverification; }
      need(i, "kind", "source", "requested_on");
      const out = orderReverification(ctx.events, r, { kind: i.kind as ReverificationKind, source: str(i, "source"), requested_on: date(i, "requested_on"), fee_cents: big(i.fee_cents ?? 0), at: at(ctx, i) });
      put(rt, ctx, "qc_reverifications", out.reverification.reverification_id, out.reverification); return out.reverification; }),
    guardrails: [NO_BORROWER_CONTACT, NO_PRODUCTION_WRITE] },
  { name: "reconcileLiabilities", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "note_date", "refreshed_tradelines", "qualifying_income_monthly_cents", "underwritten_debts_monthly_cents");
      const r = reconcileLiabilities({ note_date: date(i, "note_date"), underwritten_tradelines: arr<Tradeline>(i, "underwritten_tradelines"), refreshed_tradelines: arr<Tradeline>(i, "refreshed_tradelines"), qualifying_income_monthly_cents: big(i.qualifying_income_monthly_cents), underwritten_debts_monthly_cents: big(i.underwritten_debts_monthly_cents) });
      if (typeof i.review_id === "string") saveReview(rt, ctx, { ...reviewOf(rt, i), reunderwrite_required: reviewOf(rt, i).reunderwrite_required || r.reunderwrite_required });
      return r; }), guardrails: [NO_PRODUCTION_WRITE] },
  { name: "assessOccupancy", kind: "act", handler: compute((i) => { need(i, "facts"); return assessOccupancy(i.facts as Parameters<typeof assessOccupancy>[0]); }), guardrails: [NO_PRODUCTION_WRITE] },
  { name: "assessCollateral", kind: "act", handler: compute((i) => { need(i, "facts"); return assessCollateral(i.facts as Parameters<typeof assessCollateral>[0]); }) },
  { name: "reviewClosingDocuments", kind: "act", handler: compute((i) => { need(i, "facts"); return reviewClosingDocuments(i.facts as Parameters<typeof reviewClosingDocuments>[0]); }) },
  { name: "matchDuFinalData", kind: "act", handler: compute((i) => { need(i, "du_final", "closed_loan"); return matchDuFinalData({ du_final: i.du_final as Record<string, string | number>, closed_loan: i.closed_loan as Record<string, string | number>, tolerances: (i.tolerances as Record<string, number> | undefined) ?? {} }); }) },
  { name: "shadowReunderwrite", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "review_id", "income_components", "variance", "monthly_debts_cents"); const r = reviewOf(rt, i);
      const v = i.variance as { component: string; annual_used_cents: unknown; annual_verified_cents: unknown };
      const s = shadowReunderwrite({ review_id: r.review_id, income_components: arr<{ name: string; monthly_cents: unknown; source: string }>(i, "income_components").map((c) => ({ name: c.name, monthly_cents: big(c.monthly_cents), source: c.source })), variance: { component: v.component, annual_used_cents: big(v.annual_used_cents), annual_verified_cents: big(v.annual_verified_cents) }, monthly_debts_cents: big(i.monthly_debts_cents), max_dti_pct: str(i, "max_dti_pct") || "50" });
      const out = recordReunderwrite(ctx.events, r, s, at(ctx, i)); saveReview(rt, ctx, out.review); return { ...s, review: out.review }; }),
    guardrails: [NO_PRODUCTION_WRITE, never("SHADOW_ONLY_NO_PRODUCTION_CASEFILE", "28.2 rule 5: re-submits to DU only through 23.1 as a QC-purpose casefile copy", (i) => i.resubmit_production_casefile === true, "a resubmission on the production casefile is not allowed after closing except to reflect closed-loan data")] },
  // ---- findings, rebuttals, review closure -----------------------------------------------------
  { name: "draftFinding", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "release") { const f = findingOf(rt, i); const out = releaseFinding(ctx.events, f, { released_on: date(i, "released_on"), actor: ctx.actor, at: at(ctx, i) }); put(rt, ctx, "qc_findings", f.finding_id, out.finding); saveReview(rt, ctx, { ...rowOf<QcReview>(rt, "qc_reviews", f.review_id), status: "findings_released", rebuttal_due_at: out.finding.rebuttal_due_on, initial_severity: out.finding.initial_severity }); return out.finding; }
      if (i.op === "refer_fraud") { const r = reviewOf(rt, i); return referToFraud(ctx.events, r, { indicators: arr<string>(i, "indicators"), at: at(ctx, i) }); }
      need(i, "review_id", "draft"); const r = reviewOf(rt, i); const out = draftFinding(ctx.events, r, i.draft as Parameters<typeof draftFinding>[2], at(ctx, i)); put(rt, ctx, "qc_findings", out.finding.finding_id, out.finding); return out.finding; }),
    guardrails: [needsRole("FINDING_SEV_LE_2_NEEDS_QC_OFFICER", "28.2: the qc_officer approves findings of severity ≤ 2", (i) => i.op === "release" && i.severity !== undefined && Number(i.severity) <= 2, ["qc_officer"], "a severity-1/2 finding is released only on the qc_officer's approval")] },
  { name: "evaluateRebuttal", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "finding_id", "outcome", "on"); const f = findingOf(rt, i);
      const out = evaluateRebuttal(ctx.events, f, { outcome: i.outcome as RebuttalOutcome, on: date(i, "on"), evidence_document_ids: arr<string>(i, "evidence_document_ids"), ...(i.final_severity !== undefined ? { final_severity: Number(i.final_severity) as 1 | 2 | 3 | 4 } : {}), at: at(ctx, i) });
      put(rt, ctx, "qc_findings", f.finding_id, out.finding); saveReview(rt, ctx, { ...rowOf<QcReview>(rt, "qc_reviews", f.review_id), final_severity: out.finding.final_severity }); return out.finding; }) },
  // ---- rule 6 / 11: rates, the monthly report, the cycle, the vendor re-review, arrears ----------
  { name: "computeDefectRates", kind: "act", handler: compute((i, _c, rt) => { need(i, "cycle_id"); return computeDefectRates(arr<QcReview>(i, "reviews").length ? arr<QcReview>(i, "reviews") : reviewsOfCycle(rt, str(i, "cycle_id")), str(i, "target_pct") || "3.0"); }) },
  { name: "draftCycleReport", kind: "act", handler: compute((i, ctx, rt) => {
      const cycle = cycleOf(rt, i); const reviews = arr<QcReview>(i, "reviews").length ? arr<QcReview>(i, "reviews") : reviewsOfCycle(rt, cycle.cycle_id);
      if (i.op === "close_review") { need(i, "review_id", "completed_on", "outcome"); const r = reviewOf(rt, i); const out = closeReview(ctx.events, r, { completed_on: date(i, "completed_on"), outcome: i.outcome as "no_defect" | "defect", initial_severity: i.initial_severity === undefined ? null : Number(i.initial_severity), final_severity: i.final_severity === undefined ? null : Number(i.final_severity), defect_class: (i.defect_class as DefectClass | undefined) ?? null, at: at(ctx, i) }); saveReview(rt, ctx, out.review); return out.review; }
      if (i.op === "issue") { need(i, "issued_on"); const rep = (rt.store.get("qc_reports", `${cycle.cycle_id}:post_closing_monthly`)?.data.report as ReturnType<typeof draftCycleReport> | undefined); if (!rep) throw new RangeError("draft the report before issuing it"); const out = issueCycleReport(ctx.events, cycle, rep, { issued_on: date(i, "issued_on"), actor: ctx.actor, at: at(ctx, i) }); put(rt, ctx, "qc_cycles", cycle.cycle_id, out.cycle); put(rt, ctx, "qc_reports", `${cycle.cycle_id}:post_closing_monthly`, { report: rep, issued_on: date(i, "issued_on"), signed_by: ctx.actor.id }); return out.cycle; }
      if (i.op === "quarterly") { need(i, "quarter_end", "highest_severity_rate_pct", "issued_on"); return issueQuarterlyTargetSection(ctx.events, { quarter_end: date(i, "quarter_end"), highest_severity_rate_pct: str(i, "highest_severity_rate_pct"), target_pct: str(i, "target_pct") || "3.0", issued_on: date(i, "issued_on"), actor: ctx.actor }); }
      if (i.op === "complete") { need(i, "completed_on", "management_ack_on"); const out = completeCycle(ctx.events, cycle, reviews, { completed_on: date(i, "completed_on"), management_ack_on: date(i, "management_ack_on"), at: at(ctx, i) }); put(rt, ctx, "qc_cycles", cycle.cycle_id, out.cycle); return { cycle: out.cycle, on_time: out.on_time }; }
      if (i.op === "vendor_review") { need(i, "reviewed_review_ids", "performed_by", "recorded_on"); const out = recordVendorReview(ctx.events, cycle, reviews, { reviewed_review_ids: arr<string>(i, "reviewed_review_ids"), performed_by: i.performed_by as "partner" | "sm" | "contractor", concurrence: arr<{ review_id: string; concurs: boolean }>(i, "concurrence"), recorded_on: date(i, "recorded_on"), actor: ctx.actor, at: at(ctx, i) }, timerHandle(ctx)); put(rt, ctx, "qc_reports", `${cycle.cycle_id}:vendor_review_monthly`, out.result); return out.result; }
      need(i, "today"); const vr = (rt.store.get("qc_reports", `${cycle.cycle_id}:vendor_review_monthly`)?.data as VendorReviewResult | undefined) ?? null;
      const report = draftCycleReport({ cycle, reviews, prior_months: arr<MonthRate>(i, "prior_months"), target_pct: str(i, "target_pct") || "3.0", vendor_review: vr, today: date(i, "today"), corrective_actions: arr<CorrectiveAction>(i, "corrective_actions") });
      put(rt, ctx, "qc_reports", `${cycle.cycle_id}:post_closing_monthly`, { report, drafted_at: ctx.now }); return report; }),
    guardrails: [needsRole("REPORT_SIGNATURE_NEEDS_QC_OFFICER", "28.2: the qc_officer signs reports", (i) => i.op === "issue" || i.op === "quarterly", ["qc_officer"], "the monthly post-closing report and the quarterly target-rate section are signed by the qc_officer"),
      needsRole("VENDOR_REVIEW_RECORDED_BY_PARTNER_OFFICER", "D1-1-02: the partner's 10% re-review may not be contracted out", (i) => i.op === "vendor_review", ["officer"], "SM cannot perform the partner's re-review in its place; the partner officer records it")] },
  { name: "draftArrearsNotice", kind: "act", handler: compute((i, ctx, rt) => {
      const cycle = cycleOf(rt, i);
      if (i.op === "track") { need(i, "breach_event_id"); const breach = ctx.events.all().find((e) => e.id === str(i, "breach_event_id")); if (!breach) throw new RangeError(`no event ${str(i, "breach_event_id")}`); const out = startArrearsTracking(ctx.events, cycle, breach, at(ctx, i)); put(rt, ctx, "qc_cycles", cycle.cycle_id, out.cycle); return out.cycle; }
      if (i.op === "send") { need(i, "sent_on", "notice_text", "recipient"); const out = sendArrearsNotice(ctx.events, cycle, { sent_on: date(i, "sent_on"), actor: ctx.actor, notice_text: str(i, "notice_text"), recipient: str(i, "recipient"), at: at(ctx, i) }); put(rt, ctx, "qc_cycles", cycle.cycle_id, out.cycle); return out.cycle; }
      need(i, "today", "recovery_plan", "partner_name", "recipient");
      const cycles = [cycle, ...arr<QcCycle>(i, "other_cycles")].filter((c) => cycleArrears(c, date(i, "today")).overdue);
      return { arrears: cycleArrears(cycle, date(i, "today")), draft: cycles.length ? draftArrearsNotice({ cycles, recovery_plan: str(i, "recovery_plan"), partner_name: str(i, "partner_name"), recipient: str(i, "recipient"), drafted_on: date(i, "today") }) : null }; }),
    guardrails: [needsRole("ARREARS_NOTICE_SENT_BY_PARTNER_OFFICER", "D1-3-01: the lender provides the written notice", (i) => i.op === "send", ["officer"], "the agent drafts the arrears notice; the partner officer sends it")] },
  // ---- D2-1: Loan Quality Connect --------------------------------------------------------------
  { name: "parseLqcNotification", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "subject", "body", "received_at");
      const parsed = parseLqcNotification({ subject: str(i, "subject"), body: str(i, "body"), received_at: str(i, "received_at") });
      if (i.op !== "open") return parsed;
      need(i, "loan_id", "application_id");
      const r = openFnmaCase(ctx.events, { loan_id: str(i, "loan_id"), application_id: str(i, "application_id"), fnma_loan_number: parsed.fnma_loan_number, case_type: (i.case_type as FnmaCaseType | undefined) ?? parsed.case_type, notified_at: parsed.notified_at, lqc_task_id: parsed.lqc_task_id, parent_case_id: (i.parent_case_id as string | undefined) ?? null, amount_cents: i.amount_cents === undefined ? null : big(i.amount_cents) }, rt.store.list("fnma_qc_cases").map((x) => x.data as unknown as FnmaQcCase));
      if (r.created) saveCase(rt, ctx, r.case); return { ...r.case, created: r.created }; }), guardrails: [NO_FNMA_SUBMISSION] },
  { name: "buildLqcPackage", kind: "act", handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i);
      if (i.op === "confirm_submission") { need(i, "submitted_at", "lqc_reference"); const out = confirmSubmission(ctx.events, c, { submitted_at: str(i, "submitted_at"), lqc_reference: str(i, "lqc_reference"), actor: ctx.actor, evidence_document_id: (i.evidence_document_id as string | undefined) ?? null }); return saveCase(rt, ctx, out.case); }
      if (i.op === "resolve") { need(i, "resolution", "on"); const out = resolveResolutionRequest(ctx.events, c, { resolution: i.resolution as "correction_accepted" | "alternative_remedy_agreed" | "appeal_1_filed", on: date(i, "on"), actor: ctx.actor, at: at(ctx, i) }); return saveCase(rt, ctx, out.case); }
      if (i.op === "close") { need(i, "outcome", "on"); const out = closeFnmaCase(ctx.events, c, { outcome: i.outcome as FnmaQcCase["outcome"] & string, on: date(i, "on"), at: at(ctx, i) }); return saveCase(rt, ctx, out.case); }
      need(i, "documents"); const out = buildLqcPackage(ctx.events, c, arr<PackageDocument>(i, "documents"), at(ctx, i)); saveCase(rt, ctx, out.case); return { case: out.case, package: out.package }; }),
    guardrails: [NO_FNMA_SUBMISSION, needsRole("LQC_SUBMISSION_IS_OPERATOR_ONLY", "28.2 guardrails: the fnma_portal_operator performs every Loan Quality Connect action", (i) => i.op === "confirm_submission", ["fnma_portal_operator"], "only the operator's confirmed submitted_at with an LQC reference satisfies FNMA_D2_1_LQC_RESPONSE_30 / NOPD_DOC_UPLOAD_30")] },
  { name: "draftNopdResponse", kind: "act", handler: compute((i, _c, rt) => { need(i, "case_id", "defect_text", "evidence"); return draftNopdResponse(caseOf(rt, i), { defect_text: str(i, "defect_text"), evidence: arr<{ document_id: string; source: string; kind: string }>(i, "evidence") }); }), guardrails: [NO_FNMA_SUBMISSION] },
  // ---- self-reports (D1-1-01, A3-2-01) ---------------------------------------------------------
  { name: "draftSelfReport", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "confirm") { need(i, "review_id", "confirmed_at", "initial_severity", "final_severity", "defect_class", "loan"); const r = reviewOf(rt, i); const out = confirmIneligibleAsDelivered(ctx.events, r, { confirmed_at: str(i, "confirmed_at"), actor: ctx.actor, sold_to_fnma: i.sold_to_fnma !== false, initial_severity: num(i, "initial_severity"), final_severity: num(i, "final_severity"), defect_class: i.defect_class as DefectClass, loan: i.loan as Parameters<typeof confirmIneligibleAsDelivered>[2]["loan"] }); saveReview(rt, ctx, out.review); if (out.self_report) put(rt, ctx, "qc_self_reports", out.self_report.self_report_id, out.self_report); return { review: out.review, self_report: out.self_report }; }
      if (i.op === "approve") { const sr = selfReportOf(rt, i); const out = approveSelfReport(ctx.events, sr, { actor: ctx.actor, at: at(ctx, i) }); return put(rt, ctx, "qc_self_reports", sr.self_report_id, out.self_report); }
      if (i.op === "submit") { need(i, "submitted_at", "lqc_reference"); const sr = selfReportOf(rt, i); const out = submitSelfReport(ctx.events, sr, { submitted_at: str(i, "submitted_at"), lqc_reference: str(i, "lqc_reference"), actor: ctx.actor }); saveCase(rt, ctx, out.response_case); return put(rt, ctx, "qc_self_reports", sr.self_report_id, { ...out.self_report, response_case_id: out.response_case.case_id }); }
      if (i.op === "compliance_breach") { need(i, "breach_id", "affected_loans", "prior_year_deliveries", "discovery_on", "description"); const out = confirmComplianceBreach(ctx.events, { breach_id: str(i, "breach_id"), loan_ids: arr<string>(i, "loan_ids"), application_id: (i.application_id as string | undefined) ?? ctx.applicationId ?? null, description: str(i, "description"), at: at(ctx, i), affected_loans: num(i, "affected_loans"), prior_year_deliveries: num(i, "prior_year_deliveries"), all_delivered_same_quarter: flag(i, "all_delivered_same_quarter"), delivery_quarter_end: optDate(i, "delivery_quarter_end"), discovery_on: date(i, "discovery_on"), could_warrant_repurchase: flag(i, "could_warrant_repurchase"), remedied_within_60: flag(i, "remedied_within_60") }); return { clock: out.clock, event_id: out.event?.id ?? null }; }
      need(i, "self_report_id", "synopsis", "deficiencies", "documents"); const sr = selfReportOf(rt, i); const out = draftSelfReport(ctx.events, sr, { synopsis: str(i, "synopsis"), deficiencies: arr<Deficiency>(i, "deficiencies"), documents: arr<string>(i, "documents"), at: at(ctx, i) }); put(rt, ctx, "qc_self_reports", sr.self_report_id, out.self_report); return { self_report: out.self_report, lqc_form: out.lqc_form }; }),
    guardrails: [NO_FNMA_SUBMISSION, never("SELF_REPORT_NEEDS_CONFIRMED_AT", "28.2 guardrails: never files a self-report without the officer's confirmed_at", (i) => i.op === "draft_without_confirmation" || (i.op === "submit" && i.confirmed_at === null), "the qc_officer's confirmed_at anchors D1-1-01; no draft or submission precedes it"),
      needsRole("INELIGIBLE_CONFIRMATION_NEEDS_QC_OFFICER", "28.2 rule 5: eligible_as_delivered=false requires the qc_officer to confirm", (i) => i.op === "confirm", ["qc_officer"], "the qc_officer's sustain decision is the D1-1-01 confirmation"),
      needsRole("SELF_REPORT_NEEDS_PARTNER_OFFICER", "28.2: the partner officer authorizes self-reports", (i) => i.op === "approve", ["officer"], "self-report authorization is the partner officer's"),
      needsRole("LQC_SUBMISSION_IS_OPERATOR_ONLY", "28.2 guardrails: the fnma_portal_operator performs every LQC action", (i) => i.op === "submit", ["fnma_portal_operator"], "only the operator's confirmed LQC submission satisfies FNMA_D1_1_01_QC_SELF_REPORT_30")] },
  // ---- A2-3.2: demands, appeals, payments ------------------------------------------------------
  { name: "draftAppeal", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "demand") { need(i, "case_id", "demand_received_on"); const c = caseOf(rt, i); const out = receiveDemand(ctx.events, c, { demand_received_on: date(i, "demand_received_on"), amount_cents: i.amount_cents === undefined || i.amount_cents === null ? null : big(i.amount_cents), at: at(ctx, i) }); return saveLedger(rt, ctx, out.ledger); }
      const l = ledgerOf(rt, i);
      switch (i.op ?? "draft") {
        case "draft": need(i, "stage", "grounds", "attachments"); return draftAppeal(l, { stage: i.stage as AppealStage, grounds: str(i, "grounds"), attachments: arr<AppealAttachment>(i, "attachments") });
        case "file": { need(i, "stage", "filed_on", "grounds", "attachments"); const out = fileAppeal(ctx.events, l, { stage: i.stage as AppealStage, filed_on: date(i, "filed_on"), attachments: arr<AppealAttachment>(i, "attachments"), grounds: str(i, "grounds"), actor: ctx.actor, at: at(ctx, i) }, timerHandle(ctx)); saveLedger(rt, ctx, out.ledger); return { ledger: out.ledger, suspended_timer_id: out.suspended_timer_id }; }
        case "response": { need(i, "stage", "outcome", "notified_on"); const out = ingestAppealResponse(ctx.events, l, { stage: i.stage as AppealStage, outcome: i.outcome as "granted" | "denied", notified_on: date(i, "notified_on"), at: at(ctx, i) }); saveLedger(rt, ctx, out.ledger); return { ledger: out.ledger, next: out.next }; }
        case "impasse": { need(i, "declared_on"); const out = declareImpasse(ctx.events, l, { declared_on: date(i, "declared_on"), actor: ctx.actor }); return saveLedger(rt, ctx, out.ledger); }
        case "conclude_impasse": { need(i, "outcome", "concluded_on"); const out = concludeImpasse(ctx.events, l, { outcome: i.outcome as "resolved" | "expired", concluded_on: date(i, "concluded_on") }); return saveLedger(rt, ctx, out.ledger); }
        case "management_escalation": { need(i, "filed_on"); const out = fileManagementEscalation(ctx.events, l, { filed_on: date(i, "filed_on"), actor: ctx.actor }); return saveLedger(rt, ctx, out.ledger); }
        case "management_decision": { need(i, "notified_on", "outcome"); const out = recordManagementEscalationDecision(ctx.events, l, { notified_on: date(i, "notified_on"), outcome: i.outcome as "upheld" | "withdrawn" }); return saveLedger(rt, ctx, out.ledger); }
        case "idr": { need(i, "initiated_on"); const out = initiateIdr(ctx.events, l, { initiated_on: date(i, "initiated_on"), actor: ctx.actor }); return saveLedger(rt, ctx, out.ledger); }
        case "pay": { need(i, "paid_at", "wire_ref", "amount_cents"); const out = payRemedy(ctx.events, l, { paid_at: str(i, "paid_at"), wire_ref: str(i, "wire_ref"), amount_cents: big(i.amount_cents), actor: ctx.actor, sm_indemnity_share_cents: i.sm_indemnity_share_cents === undefined ? null : big(i.sm_indemnity_share_cents) }); if (i.post_ledger === true) ctx.ledger.post(out.entry_set as unknown as Parameters<typeof ctx.ledger.post>[0], ctx.now); saveLedger(rt, ctx, out.ledger); return { ledger: out.ledger, entry_set: out.entry_set }; }
        case "ladder": return remedyLadder(l.demand_received_on, { appeal_1_filed_on: l.appeals.find((a) => a.stage === "appeal_1")?.filed_on, appeal_1_denied_on: l.appeals.find((a) => a.stage === "appeal_1" && a.outcome === "denied")?.responded_on ?? undefined, appeal_2_denied_on: l.appeals.find((a) => a.stage === "appeal_2" && a.outcome === "denied")?.responded_on ?? undefined, impasse_declared_on: l.impasse_declared_on ?? undefined, management_escalation_filed_on: l.management_escalation_filed_on ?? undefined });
        default: throw new RangeError(`draftAppeal op ${String(i.op)} is not one of demand/draft/file/response/impasse/conclude_impasse/management_escalation/management_decision/idr/pay/ladder`);
      } }),
    moneyFields: ["amount_cents", "sm_indemnity_share_cents"],
    guardrails: [NO_FNMA_SUBMISSION, never("APPEAL2_NEW_INFORMATION_REQUIRED", "A2-3.2-03: a second appeal only with new information", (i) => (i.op === "draft" || i.op === "file") && i.stage === "appeal_2" && !arr<AppealAttachment>(i, "attachments").some((a) => a.new_information === true), "the console refuses an appeal-2 draft without a \"new information\" attachment"),
      needsRole("REMEDY_PAYMENT_NEEDS_PARTNER_OFFICER", "28.2 guardrails: never pays or accepts a remedy (partner officer)", (i) => i.op === "pay", ["officer"], "only a partner officer decision satisfies FNMA_A2_3_2_01_REMEDY_PAYMENT_60"),
      needsRole("APPEAL_NEEDS_PARTNER_OFFICER", "28.2: the partner officer authorizes appeals, impasse, management escalation and IDR", (i) => ["file", "impasse", "management_escalation", "idr"].includes(String(i.op)), ["officer"], "appeals and repurchase alternatives are the partner's decisions")] },
  { name: "computeRepurchasePrice", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "pal") { need(i, "llpa_pct", "upb_cents"); return { pal_cents: computePalAmount(str(i, "llpa_pct"), big(i.upb_cents)), basis: "LLPA that should have been paid at purchase × UPB (llpa_tables version at the purchase date)" }; }
      need(i, "upb_cents", "note_rate_pct", "interest_from", "through");
      const price = computeRepurchasePrice({ upb_cents: big(i.upb_cents), note_rate_pct: str(i, "note_rate_pct"), interest_from: date(i, "interest_from"), through: date(i, "through"), expenses_cents: big(i.expenses_cents ?? 0), llpa_cents: big(i.llpa_cents ?? 0) });
      if (typeof i.remedy_id === "string") saveLedger(rt, ctx, { ...ledgerOf(rt, i), components: price, amount_cents: price.total_cents });
      return price; }), moneyFields: ["expenses_cents"] },
  // ---- rule 10: relief tracking ----------------------------------------------------------------
  { name: "trackRelief", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "open") { need(i, "application_id", "loan_id", "purchase_date", "first_payment_due"); const out = openReliefTracking(ctx.events, { application_id: str(i, "application_id"), loan_id: str(i, "loan_id"), purchase_date: date(i, "purchase_date"), first_payment_due: date(i, "first_payment_due"), at: at(ctx, i), purchased_event_id: (i.purchased_event_id as string | undefined) ?? null }); return put(rt, ctx, "rep_warrant_relief", out.row.relief_id, out.row); }
      const row = reliefOf(rt, i);
      if (i.op === "confirm") { need(i, "fnma_loan_number"); const out = confirmReliefFromReport(ctx.events, row, str(i, "fnma_loan_number"), (i.report as ReliefReport | undefined) ?? null, at(ctx, i)); return put(rt, ctx, "rep_warrant_relief", row.relief_id, out.row); }
      if (i.op === "lose") { need(i, "finding"); const out = loseRelief(ctx.events, row, { finding: str(i, "finding"), qc_case_id: (i.qc_case_id as string | undefined) ?? null, at: at(ctx, i) }); return put(rt, ctx, "rep_warrant_relief", row.relief_id, out.row); }
      need(i, "history", "as_of"); return put(rt, ctx, "rep_warrant_relief", row.relief_id, trackRelief(row, arr<PaymentHistoryRow>(i, "history"), date(i, "as_of"))); }),
    guardrails: [never("RELIEF_REPORT_REQUIRED", "28.2 guardrails: never treats the 36-payment count as relief without Fannie Mae's report", (i) => i.op === "confirm" && (i.report === undefined || i.report === null), "status = confirmed_by_fnma is set only from a parsed Fannie Mae relief report"), NO_PRODUCTION_WRITE] },
  // ---- escalations and the decision record -----------------------------------------------------
  { name: "openOperatorEscalation", kind: "act", handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); const task = operatorTaskFor(c, D(str(i, "today") || ctx.now.slice(0, 10)));
      const e = rt.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", loanId: c.loan_id, applicationId: c.application_id, caseId: c.case_id, severity: task.sla_business_days === 1 ? "sev2" : "sev3", payload: { ...task, deadline: task.deadline, policy_submit_by: task.policy_submit_by, lqc_task_id: c.lqc_task_id, file_name: c.package_file_name } }, ctx.actor);
      saveCase(rt, ctx, { ...c, operator_escalation_id: e.id }); return { escalation_id: e.id, owner_role: e.ownerRole, task }; }),
    guardrails: [never("PACKAGE_HASH_NOT_FROZEN", "28.2 rule 8 / T5: the package hash is frozen before the operator escalation", (i) => i.package_hash === null, "no operator task without a frozen package hash")] },
  { name: "openOfficerEscalation", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "reason", "decision_kind");
      const kind = str(i, "decision_kind"); const owner = ["self_report_authorization", "arrears_notice", "remedy_decision", "appeal", "repurchase_alternative", "payment"].includes(kind) ? "officer" : "qc_officer";
      const e = rt.escalations.open({ kind: owner === "officer" ? "officer" : "qc_officer", ownerRole: owner, ...(typeof i.loan_id === "string" ? { loanId: str(i, "loan_id") } : {}), ...(typeof i.application_id === "string" ? { applicationId: str(i, "application_id") } : {}), ...(typeof i.case_id === "string" ? { caseId: str(i, "case_id") } : {}), severity: str(i, "severity") || "sev2", payload: { decision_kind: kind, reason: str(i, "reason"), package: i.package ?? null, due_on: i.due_on ?? null } }, ctx.actor);
      return { escalation_id: e.id, owner_role: e.ownerRole, decision_kind: kind }; }) },
  { name: "writeDecision", kind: "write", handler: (i, ctx) => decision()({ ...i, rule_set_version: str(i, "rule_set_version") || RULE_SET_28_2 }, ctx), guardrails: [NO_DEMOGRAPHICS] },
]);
