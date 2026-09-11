/**
 * §28.1 process-owned tools — bus tools for 28.1 defined with `defineTools("28.1", "qc-audit", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 28.1; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `qc-audit` prefunding profile (spec "AI agent design"): buildPopulation, planSample, selectLoans, openReview,
 * recomputeDuInputs, recomputeIncome, recomputeAssets, checkCollateral, checkMi, assessOccupancy, runComplianceSnapshot,
 * orderReverification, draftFinding, routeToOfficer, releaseFindings, evaluateRebuttal, closeReview (op=close |
 * cancel | consummation_breach | reverification_decision), computeMetrics (op=metrics | concurrence | sample_completion),
 * draftMonthlyReport (op=draft | sign | acknowledge | annual_audit), writeDecision. Guardrails encode the paragraph: the
 * agent never writes to production tables, never clears or opens a production condition directly, never contacts a
 * borrower except through an existing verification channel with a QC purpose disclosed, never uses
 * `applicant_demographics`, never suppresses a finding on volume or closing-date pressure, and never self-approves a
 * severity-1/2 finding; independence is enforced by identity (`agent_id = qc-audit`) — a production identity on a QC
 * write, or the QC identity on a production command, is refused and logged sev 2 to compliance-sentinel. State lives in
 * the entity store under the `qc_*` kinds only (`qc_sample_plans`, `qc_reviews`, `qc_findings`, `qc_reverifications`,
 * `qc_reports`, `qc_application_status`); events go through ops-28-1.ts so the timers arm and close.
 */
import { defineTools, compute, decision, never, needsRole, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { assertNoDemographics } from "../../domain/underwriting/ops-23-3.ts";
import { buildPopulation, planSample, selectLoan, recordSelectionRun, dailySelectionTick, openReview, completeReview, closeReview, cancelReview, consummatedWithOpenReview, deliveryGateFacts, recomputeDuInputs, recomputeIncome, checkVvoe, recomputeAssets, checkCollateral, checkMi, assessOccupancy, checkSsn, runComplianceSnapshot,
  orderReverification, receiveReverification, reverificationFollowUp, officerDecideReverification, draftFinding, requestFraudReferral, routeToOfficer, officerDecideFinding, releaseFindings, recordFindingResolution, recordRebuttal, evaluateRebuttal, rebuttalWindowExpired, correctFinding, resolveByDuResubmission,
  computeMetrics, sampleCompletion, correctiveActionPlan, draftMonthlyReport, signReport, acknowledgeReport, officerConcurrenceReview, issueAnnualAuditReport, annualAuditTick, decisionRecord28_1, findingModelInputs, qcPrefundingStatus, assertGateOpen, assertNotProductionCommand, PRODUCTION_COMMANDS, RULE_SET_VERSION_28_1, QC_AGENT_ID,
  type QcReview, type QcFinding, type QcReverification, type QcSamplePlan, type QcReport, type PopulationCandidate, type Stratum, type RiskFeatures, type ChecklistTest, type FindingDraft, type MonthlyMetrics, type OfficerStats, type Paystub, type Deposit, type GiftLetter, type EvidenceRef, type Severity, type ReviewOutcome, type ReverificationKind, type ReverificationResult, type CorrectiveActionPlan } from "../../domain/qc-hmda/ops-28-1.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`28.1 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("28.1 tool needs application_id (every application-scoped 28.1 event carries it so the timers arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const today = (i: ToolInput, ctx: CommandContext): PlainDate => (i.today ? dateIn(i, "today") : D(ctx.now.slice(0, 10)));
const obj = <T extends object>(i: ToolInput, k: string): T => { const v = i[k]; if (!v || typeof v !== "object") throw new RangeError(`28.1 tool needs ${k} {…}`); return v as T; };
const list = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`28.1 tool needs ${k}[]`); return v as T[]; };
const optList = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: object) => rt.store.put(kind, id, data as Record<string, unknown>, ctx.actor, ctx.now);
const stored = <T>(rt: ToolRuntime, kind: string, id: string): T => rt.store.require(kind, id).data as unknown as T;
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const cents = (v: unknown, name: string): bigint => { if (v === undefined || v === null || v === "") throw new RangeError(`28.1 tool needs ${name} (bigint cents)`); return typeof v === "bigint" ? v : BigInt(String(v)); };
const optCents = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v : BigInt(String(v)));
const reviewOf = (i: ToolInput, rt: ToolRuntime): QcReview => (i.review && typeof i.review === "object" ? (i.review as QcReview) : (need(i, "review_id"), stored<QcReview>(rt, "qc_reviews", str(i, "review_id"))));
const planOf = (i: ToolInput, rt: ToolRuntime): QcSamplePlan => (i.plan && typeof i.plan === "object" ? (i.plan as QcSamplePlan) : (need(i, "sample_plan_id"), stored<QcSamplePlan>(rt, "qc_sample_plans", str(i, "sample_plan_id"))));
const findingsOf = (i: ToolInput, rt: ToolRuntime, review_id: string): QcFinding[] => (Array.isArray(i.findings) ? (i.findings as QcFinding[]) : rt.store.list("qc_findings", (d) => d.review_id === review_id).map((r) => r.data as unknown as QcFinding));
const findingOf = (i: ToolInput, rt: ToolRuntime): QcFinding => (i.finding && typeof i.finding === "object" ? (i.finding as QcFinding) : (need(i, "finding_id"), stored<QcFinding>(rt, "qc_findings", str(i, "finding_id"))));
const saveReview = (rt: ToolRuntime, ctx: CommandContext, r: QcReview, findings: readonly QcFinding[] = []) => { persist(rt, ctx, "qc_reviews", r.review_id, r); persist(rt, ctx, "qc_application_status", r.application_id, { application_id: r.application_id, review_id: r.review_id, qc_prefunding_status: qcPrefundingStatus(r, findings) }); };
const saveFindings = (rt: ToolRuntime, ctx: CommandContext, fs: readonly QcFinding[]) => { for (const f of fs) persist(rt, ctx, "qc_findings", f.finding_id, f); };
const evidence = (i: ToolInput, k = "evidence_refs"): EvidenceRef[] => optList<EvidenceRef>(i, k);
const PRODUCTION_TABLES = /^(applications|application_[a-z_]+|conditions|decisions|credit_decisions|ctc_checklists|du_submissions|loans|loan_terms|ledger_entries|ledger_entry_sets|disclosures|closings|fundings)$/;
const DEMOGRAPHIC_INPUT = /^(race|ethnicity|sex|gender|age|date_of_birth|dob|marital_status|national_origin|religion|applicant_demographics|hmda_demographics)$/i;
const hasDemographics = (i: ToolInput): boolean => { try { assertNoDemographics(i); return false; } catch { return true; } };
const NO_DEMOGRAPHICS = (name: string) => never("APPLICANT_DEMOGRAPHICS_IN_QC_INPUT", "28.1 guardrails: the agent never uses `applicant_demographics` (the access log shows zero reads by `qc-audit`, T13)", (i) => Object.keys(i).some((k) => DEMOGRAPHIC_INPUT.test(k)) || hasDemographics(i), `${name}: a protected-class field reached the input`);
const NO_PRODUCTION_WRITE = never("QC_NEVER_WRITES_PRODUCTION_TABLES", "28.1 guardrails / integrations: the `qc-audit` agent reads every origination table through the replica role `qc_reader` and writes only to `qc_*`, `escalations`, `agent_decisions`, `loan_events`", (i) => typeof i.table === "string" && PRODUCTION_TABLES.test(i.table) && (i.op === "write" || i.changes !== undefined || i.data !== undefined), "a production table write reached a QC tool");
const NO_PRODUCTION_COMMAND = never("QC_NEVER_CALLS_PRODUCTION", "28.1 guardrails: never clears or opens a production condition directly — production reacts to `qc.finding.released` through 23.3 (`reopenCondition`, `decision.reopened`)", (i) => (typeof i.command === "string" && (PRODUCTION_COMMANDS as readonly string[]).includes(i.command)) || i.clear_condition === true || i.open_condition === true, "QC never calls production commands");
const NO_SUPPRESSION = never("NO_FINDING_SUPPRESSION", "28.1 guardrails: never suppresses a finding on volume or closing-date pressure (the closing-date feature is not an input to the finding model)", (i) => i.suppress_finding === true || i.closing_date_pressure === true || i.volume_pressure === true, "a suppression flag reached the finding tool");
const NO_SELF_APPROVAL = never("NO_SEV12_SELF_APPROVAL", "28.1 guardrails: never self-approves a severity-1/2 finding — every severity-1/2 finding goes to `officer_review` before release", (i) => i.self_approve === true || i.skip_officer === true, "the agent asked to bypass officer review");
const NO_HOLD_WAIVER = never("NO_HOLD_WAIVER", "28.1-Q5: a selected loan does not close until the review is terminal; the only release paths are `no_defect`, `defect_corrected`, or an officer's `unable_to_complete`", (i) => i.waive_hold === true || i.release_hold === true || i.schedule_pressure === true, "the hold is never lifted for schedule pressure");
const actorOr = (i: ToolInput, ctx: CommandContext): Actor => (i.actor && typeof i.actor === "object" ? (i.actor as Actor) : ctx.actor);

export const TOOLS_28_1: readonly ToolDef[] = defineTools("28.1", QC_AGENT_ID, [
  { name: "buildPopulation", kind: "read", handler: compute((i, ctx) => buildPopulation(list<PopulationCandidate>(i, "candidates").map((c) => ({ ...c, closing_scheduled_on: c.closing_scheduled_on ? D(String(c.closing_scheduled_on)) : null })), str(i, "run_at") || ctx.now)), guardrails: [NO_DEMOGRAPHICS("buildPopulation"), NO_PRODUCTION_WRITE] },
  { name: "planSample", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "partner_id", "period_month", "eligible_population", "forecast_closings_month");
    const r = planSample(ctx.events, { ...(typeof i.sample_plan_id === "string" ? { sample_plan_id: i.sample_plan_id } : {}), partner_id: str(i, "partner_id"), period_month: dateIn(i, "period_month"), eligible_population: num(i, "eligible_population"), forecast_closings_month: num(i, "forecast_closings_month"), strata: optList<Stratum>(i, "strata"), imposed_floor: i.imposed_floor === undefined ? 0 : num(i, "imposed_floor"), at: ctx.now, approved_by_qc_officer_at: (i.approved_by_qc_officer_at as string | undefined) ?? null }, ctx.actor);
    persist(rt, ctx, "qc_sample_plans", r.plan.sample_plan_id, r.plan);
    return r.plan;
  }), guardrails: [NO_PRODUCTION_WRITE] },
  { name: "selectLoans", kind: "act", handler: compute((i, ctx, rt) => {
    if (i.op === "tick") { need(i, "partner_id", "date", "time_zone"); return dailySelectionTick(ctx.events, { date: dateIn(i, "date"), partner_id: str(i, "partner_id"), time_zone: str(i, "time_zone") }); }
    const plan = planOf(i, rt); need(i, "candidates");
    const out: Record<string, unknown>[] = []; let selected = 0, random = 0;
    let remaining = i.random_target_remaining === undefined ? plan.random_target - plan.actuals.random_selected : num(i, "random_target_remaining");
    const expected = i.expected_remaining_population === undefined ? plan.eligible_population : num(i, "expected_remaining_population");
    for (const c of list<{ application_id: string; partner_id?: string; features: RiskFeatures; draw?: number; review_id?: string }>(i, "candidates")) {
      const r = selectLoan(ctx.events, { plan, application_id: c.application_id, ...(c.partner_id ? { partner_id: c.partner_id } : {}), features: c.features ?? {}, at: ctx.now, random_target_remaining: remaining, expected_remaining_population: expected, ...(typeof c.draw === "number" ? { draw: c.draw } : {}), ...(typeof i.seed === "string" ? { seed: i.seed } : {}), ...(c.review_id ? { review_id: c.review_id } : {}) }, ctx.actor);
      if (r.review) { saveReview(rt, ctx, r.review); selected++; if (r.basis === "random" || r.random_hit) { random++; remaining--; } }
      out.push({ application_id: c.application_id, selected: r.selected, basis: r.basis, probability: r.probability, draw: r.draw, random_hit: r.random_hit, reason_codes: r.triggers.map((t) => t.code), review_id: r.review?.review_id ?? null, review_type: r.review?.review_type ?? null, application_qc_status: r.application_qc_status });
    }
    const run = recordSelectionRun(ctx.events, plan, { selected, random_selected: random, reviewed: 0, at: ctx.now }, ctx.actor);
    persist(rt, ctx, "qc_sample_plans", plan.sample_plan_id, run.plan);
    return { selections: out, selected, random_selected: random, actuals: run.plan.actuals };
  }), guardrails: [NO_DEMOGRAPHICS("selectLoans"), NO_PRODUCTION_WRITE] },
  { name: "openReview", kind: "act", handler: compute((i, ctx, rt) => {
    const review = reviewOf(i, rt); need(i, "run");
    const r = openReview(ctx.events, rt.escalations, review, { run: obj(i, "run"), reviewer: actorOr(i, ctx), application_agent_runs: optList(i, "application_agent_runs"), at: ctx.now });
    saveReview(rt, ctx, r.review); return r.review;
  }), guardrails: [NO_DEMOGRAPHICS("openReview"), NO_PRODUCTION_WRITE, NO_PRODUCTION_COMMAND] },
  { name: "recomputeDuInputs", kind: "act", handler: compute((i) => { need(i, "du_request", "recomputed"); return recomputeDuInputs({ du_request: obj(i, "du_request"), recomputed: obj(i, "recomputed"), evidence_refs: evidence(i), du_request_date: i.du_request_date ? dateIn(i, "du_request_date") : null, monthly_debts_cents: optCents(i.monthly_debts_cents) }); }), guardrails: [NO_DEMOGRAPHICS("recomputeDuInputs"), NO_PRODUCTION_WRITE] },
  { name: "recomputeIncome", kind: "act", handler: compute((i, ctx) => {
    if (i.op === "vvoe") { need(i, "note_date"); return checkVvoe({ vvoe_on: i.vvoe_on ? dateIn(i, "vvoe_on") : null, note_date: dateIn(i, "note_date"), today: today(i, ctx), ...(typeof i.phone_independently_sourced === "boolean" ? { phone_independently_sourced: i.phone_independently_sourced } : {}), document_id: (i.document_id as string | undefined) ?? null }); }
    need(i, "paystubs", "underwriter_monthly_cents");
    return recomputeIncome({ paystubs: list<Paystub>(i, "paystubs").map((p) => ({ ...bigints(p, ["gross_period_cents"]), period_end: D(String(p.period_end)) })), w2_prior_year_cents: optCents(i.w2_prior_year_cents), w2_document_id: (i.w2_document_id as string | undefined) ?? null, underwriter_monthly_cents: cents(i.underwriter_monthly_cents, "underwriter_monthly_cents"), qualifying_income_cents: optCents(i.qualifying_income_cents), monthly_debts_cents: optCents(i.monthly_debts_cents), ...(typeof i.formula_id === "string" ? { formula_id: i.formula_id } : {}) });
  }), guardrails: [NO_DEMOGRAPHICS("recomputeIncome"), NO_PRODUCTION_WRITE] },
  { name: "recomputeAssets", kind: "act", handler: compute((i) => {
    need(i, "funds_to_close_cents", "verified_assets_cents", "monthly_qualifying_income_cents");
    const gift = i.gift && typeof i.gift === "object" ? bigints(i.gift as GiftLetter, ["amount_cents"]) : null;
    return recomputeAssets({ funds_to_close_cents: cents(i.funds_to_close_cents, "funds_to_close_cents"), verified_assets_cents: cents(i.verified_assets_cents, "verified_assets_cents"), monthly_qualifying_income_cents: cents(i.monthly_qualifying_income_cents, "monthly_qualifying_income_cents"), deposits: optList<Deposit>(i, "deposits").map((d) => ({ ...bigints(d, ["amount_cents"]), on: D(String(d.on)) })), gift, integrity_checks_pass: i.integrity_checks_pass !== false, reserves_required_cents: optCents(i.reserves_required_cents), evidence_refs: evidence(i) });
  }), guardrails: [NO_DEMOGRAPHICS("recomputeAssets"), NO_PRODUCTION_WRITE] },
  { name: "checkCollateral", kind: "act", handler: compute((i) => { need(i, "valuation_method", "note_date"); return checkCollateral({ valuation_method: str(i, "valuation_method") as never, offer_date: i.offer_date ? dateIn(i, "offer_date") : null, note_date: dateIn(i, "note_date"), cu_score: i.cu_score === undefined ? null : num(i, "cu_score"), unreconciled_cu_messages: i.unreconciled_cu_messages === undefined ? 0 : num(i, "unreconciled_cu_messages"), uad_3_6_required: flag(i, "uad_3_6_required"), uad_form: (i.uad_form as string | undefined) ?? null, evidence_refs: evidence(i) }); }), guardrails: [NO_PRODUCTION_WRITE] },
  { name: "checkMi", kind: "act", handler: compute((i) => { need(i, "ltv_x100", "term_months"); return checkMi({ ltv_x100: num(i, "ltv_x100"), term_months: num(i, "term_months"), coverage_pct: i.coverage_pct === undefined || i.coverage_pct === null ? null : num(i, "coverage_pct"), certificate_issued: flag(i, "certificate_issued"), program: (str(i, "program") || "standard") as "standard" | "homeready", evidence_refs: evidence(i) }); }), guardrails: [NO_PRODUCTION_WRITE] },
  { name: "assessOccupancy", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "declared");
    const r = assessOccupancy({ declared: str(i, "declared") as never, mailing_address_is_subject: flag(i, "mailing_address_is_subject"), insurance_form: (i.insurance_form as string | undefined) ?? null, other_reo_primary: flag(i, "other_reo_primary"), distance_to_work_miles: i.distance_to_work_miles === undefined ? null : num(i, "distance_to_work_miles"), evidence_refs: evidence(i) });
    if (r.finding && i.review_id) { const review = reviewOf(i, rt); const d = draftFinding(ctx.events, review, { ...r.finding, at: ctx.now }, ctx.actor); saveFindings(rt, ctx, [d.finding]); saveReview(rt, ctx, d.review, [d.finding]); requestFraudReferral(ctx.events, d.finding, ctx.now, ctx.actor); return { ...r, finding_id: d.finding.finding_id, fraud_referral: "28.4 openFraudCase" }; }
    return r;
  }), guardrails: [NO_DEMOGRAPHICS("assessOccupancy"), NO_PRODUCTION_WRITE] },
  { name: "runComplianceSnapshot", kind: "act", handler: compute((i, ctx) => {
    if (i.op === "ssn") return checkSsn({ borrowers: list(i, "borrowers") });
    need(i, "compliance_tests_current", "trid_clocks_ok", "regb_decision_timer_satisfied");
    return runComplianceSnapshot({ compliance_tests_current: flag(i, "compliance_tests_current"), trid_clocks_ok: flag(i, "trid_clocks_ok"), regb_decision_timer_satisfied: flag(i, "regb_decision_timer_satisfied"), ofac_rescreen_on: i.ofac_rescreen_on ? dateIn(i, "ofac_rescreen_on") : null, today: today(i, ctx), identity_result: (i.identity_result as "pass" | "fail" | undefined) ?? null, fraud_cases_open: i.fraud_cases_open === undefined ? 0 : num(i, "fraud_cases_open"), evidence_refs: evidence(i) });
  }), guardrails: [NO_DEMOGRAPHICS("runComplianceSnapshot"), NO_PRODUCTION_WRITE] },
  { name: "orderReverification", kind: "act", handler: compute((i, ctx, rt) => {
    const op = str(i, "op") || "order";
    if (op === "receive") { need(i, "reverification_id", "result"); const rev = stored<QcReverification>(rt, "qc_reverifications", str(i, "reverification_id")); const r = receiveReverification(ctx.events, rev, { at: ctx.now, result: str(i, "result") as ReverificationResult, variance: (i.variance as Record<string, unknown> | undefined) ?? null, document_id: (i.document_id as string | undefined) ?? null }, ctx.actor); persist(rt, ctx, "qc_reverifications", rev.reverification_id, r.reverification); return r.reverification; }
    if (op === "follow_up") { need(i, "reverification_id"); const rev = stored<QcReverification>(rt, "qc_reverifications", str(i, "reverification_id")); const r = reverificationFollowUp(ctx.events, rt.escalations, rev, { today: today(i, ctx), at: ctx.now }, ctx.actor); persist(rt, ctx, "qc_reverifications", rev.reverification_id, r.reverification); return { action: r.action, request_dates: r.reverification.request_dates, escalation_id: r.escalation?.id ?? null }; }
    const review = reviewOf(i, rt); need(i, "kind", "source");
    const r = orderReverification(ctx.events, review, { kind: str(i, "kind") as ReverificationKind, source: str(i, "source"), at: ctx.now, fee_cents: optCents(i.fee_cents) ?? 0n, ...(typeof i.reverification_id === "string" ? { reverification_id: i.reverification_id } : {}) }, ctx.actor);
    persist(rt, ctx, "qc_reverifications", r.reverification.reverification_id, r.reverification); saveReview(rt, ctx, r.review); return r.reverification;
  }), guardrails: [NO_PRODUCTION_WRITE, never("NO_BORROWER_CONTACT_OUTSIDE_VERIFICATION_CHANNEL", "28.1 guardrails: never contacts a borrower except through an existing verification channel with a QC purpose disclosed (no QC 're-interviews' without disclosure)", (i) => i.borrower_contact === true && !(i.existing_verification_channel === true && i.qc_purpose_disclosed === true), "borrower contact needs an existing verification channel and a disclosed QC purpose")] },
  { name: "draftFinding", kind: "act", handler: compute((i, ctx, rt) => {
    const review = reviewOf(i, rt); need(i, "category", "sub_category", "severity", "description", "guide_citation");
    const clean = findingModelInputs(i);
    const d = draftFinding(ctx.events, review, { category: str(clean, "category") as never, sub_category: str(clean, "sub_category"), severity: num(clean, "severity") as Severity, description: str(clean, "description"), observed_value: (clean.observed_value as string | undefined) ?? null, expected_value: (clean.expected_value as string | undefined) ?? null, guide_citation: str(clean, "guide_citation"), law_citation: (clean.law_citation as string | undefined) ?? null, is_compliance: clean.is_compliance === true, evidence_refs: evidence(clean), at: ctx.now, ...(typeof clean.finding_id === "string" ? { finding_id: clean.finding_id } : {}) }, ctx.actor);
    saveFindings(rt, ctx, [d.finding]); saveReview(rt, ctx, d.review, findingsOf({}, rt, review.review_id));
    const referral = requestFraudReferral(ctx.events, d.finding, ctx.now, ctx.actor);
    if (i.complete === true) { const c = completeReview(ctx.events, d.review, findingsOf({}, rt, review.review_id), ctx.now, ctx.actor); saveReview(rt, ctx, c.review, findingsOf({}, rt, review.review_id)); return { finding: d.finding, review: c.review, within_sla: c.within_sla, fraud_referral: referral !== null }; }
    return { finding: d.finding, review: d.review, fraud_referral: referral !== null };
  }), guardrails: [NO_DEMOGRAPHICS("draftFinding"), NO_PRODUCTION_WRITE, NO_SUPPRESSION] },
  { name: "routeToOfficer", kind: "act", handler: compute((i, ctx, rt) => {
    const review = reviewOf(i, rt); const findings = findingsOf(i, rt, review.review_id);
    if (i.op === "complete") { const c = completeReview(ctx.events, review, findings, ctx.now, ctx.actor); saveReview(rt, ctx, c.review, findings); return { review: c.review, within_sla: c.within_sla }; }
    if (i.op === "officer_decision") { const f = findingOf(i, rt); need(i, "decision", "rationale"); const r = officerDecideFinding(ctx.events, f, { decision: str(i, "decision") as "released" | "withdrawn", officer: actorOr(i, ctx), at: ctx.now, rationale: str(i, "rationale") }); saveFindings(rt, ctx, [r.finding]); return r.finding; }
    const r = routeToOfficer(ctx.events, rt.escalations, review, findings, { at: ctx.now, officer_sample: flag(i, "officer_sample") }, ctx.actor);
    saveReview(rt, ctx, r.review, findings); return { required: r.required, review: r.review, escalation_id: r.escalation?.id ?? null, sla_due: r.sla_due };
  }), guardrails: [NO_PRODUCTION_WRITE, NO_SELF_APPROVAL, needsRole("OFFICER_DECISION_NEEDS_QC_OFFICER", "28.1 rule 6: the `qc_officer` decides every severity-1/2 finding before release", (i) => i.op === "officer_decision" && !(i.actor && typeof i.actor === "object"), ["qc_officer"], "an officer decision is a human act")] },
  { name: "releaseFindings", kind: "act", handler: compute((i, ctx, rt) => {
    const review = reviewOf(i, rt); const findings = findingsOf(i, rt, review.review_id);
    if (i.op === "resolution") { const f = findingOf(i, rt); need(i, "resolution", "resolution_ref"); const r = recordFindingResolution(ctx.events, f, { resolution: str(i, "resolution") as never, resolution_ref: str(i, "resolution_ref"), at: ctx.now }, ctx.actor); saveFindings(rt, ctx, [r.finding]); return r.finding; }
    if (i.op === "correct") { const f = findingOf(i, rt); const r = correctFinding(ctx.events, f, { retest_evidence_refs: evidence(i, "retest_evidence_refs"), at: ctx.now, observed_value: (i.observed_value as string | undefined) ?? null }, ctx.actor); saveFindings(rt, ctx, [r.finding]); saveReview(rt, ctx, review, findingsOf({}, rt, review.review_id)); return r.finding; }
    if (i.op === "du_resubmission") { const f = findingOf(i, rt); need(i, "submission_id", "resubmitted_monthly_income_cents", "recomputed_monthly_income_cents"); const r = resolveByDuResubmission(ctx.events, f, { submission_id: str(i, "submission_id"), resubmitted_monthly_income_cents: cents(i.resubmitted_monthly_income_cents, "resubmitted_monthly_income_cents"), recomputed_monthly_income_cents: cents(i.recomputed_monthly_income_cents, "recomputed_monthly_income_cents"), at: ctx.now }, ctx.actor); saveFindings(rt, ctx, [r.finding]); return r.finding; }
    const r = releaseFindings(ctx.events, rt.escalations, review, findings, { at: ctx.now, actor: ctx.actor });
    saveFindings(rt, ctx, r.findings); saveReview(rt, ctx, r.review, findingsOf({}, rt, review.review_id));
    return { review: r.review, released: r.findings.map((f) => f.finding_id), application_qc_status: r.application_qc_status, gate: r.gate, events: r.events.map((e) => e.type) };
  }), guardrails: [NO_PRODUCTION_WRITE, NO_PRODUCTION_COMMAND, NO_SELF_APPROVAL, NO_SUPPRESSION] },
  { name: "evaluateRebuttal", kind: "act", handler: compute((i, ctx, rt) => {
    const f = findingOf(i, rt);
    if (i.op === "record") { need(i, "by_agent_run_id", "text"); const r = recordRebuttal(ctx.events, f, { by_agent_run_id: str(i, "by_agent_run_id"), text: str(i, "text"), evidence_refs: evidence(i), at: ctx.now }, actorOr(i, ctx)); saveFindings(rt, ctx, [r.finding]); return r.finding; }
    if (i.op === "window_expired") { const r = rebuttalWindowExpired(ctx.events, f, ctx.now, ctx.actor); saveFindings(rt, ctx, [r.finding]); return r.finding; }
    need(i, "accepted", "rationale");
    const r = evaluateRebuttal(ctx.events, f, { accepted: flag(i, "accepted"), rationale: str(i, "rationale"), at: ctx.now, new_document_integrity: (i.new_document_integrity as "pass" | "warn" | "fail" | undefined) ?? null }, ctx.actor);
    saveFindings(rt, ctx, [r.finding]); return r.finding;
  }), guardrails: [NO_PRODUCTION_WRITE, NO_SUPPRESSION] },
  { name: "closeReview", kind: "act", handler: compute((i, ctx, rt) => {
    const review = reviewOf(i, rt); const findings = findingsOf(i, rt, review.review_id);
    const op = str(i, "op") || "close";
    if (op === "cancel") { need(i, "reason"); const r = cancelReview(ctx.events, review, { reason: str(i, "reason") as never, at: ctx.now }, ctx.actor); saveReview(rt, ctx, r.review, findings); return r.review; }
    if (op === "consummation_breach") { need(i, "consummated_at"); const r = consummatedWithOpenReview(ctx.events, rt.escalations, review, { consummated_at: str(i, "consummated_at"), at: ctx.now }, ctx.actor); saveReview(rt, ctx, r.review, findings); return { breach: r.breach, review: r.review, escalation_ids: r.escalations.map((e) => e.id), delivery_gate: deliveryGateFacts(r.review, findings) }; }
    if (op === "reverification_decision") { need(i, "reverification_id", "decision", "rationale"); const rev = stored<QcReverification>(rt, "qc_reverifications", str(i, "reverification_id")); const r = officerDecideReverification(ctx.events, rt.escalations, review, findings, rev, { decision: str(i, "decision") as never, officer: actorOr(i, ctx), at: ctx.now, rationale: str(i, "rationale") }); persist(rt, ctx, "qc_reverifications", rev.reverification_id, r.reverification); saveReview(rt, ctx, r.review, findings); return { review: r.review, reverification: r.reverification }; }
    if (op === "gate") return { gate: assertGateOpen(review, findings, str(i, "command") || "clear_to_close"), application_qc_status: qcPrefundingStatus(review, findings), delivery_gate: deliveryGateFacts(review, findings) };
    need(i, "outcome");
    const r = closeReview(ctx.events, rt.escalations, review, findings, { outcome: str(i, "outcome") as ReviewOutcome, at: ctx.now, actor: actorOr(i, ctx), rationale: (i.rationale as string | undefined) ?? null });
    saveReview(rt, ctx, r.review, findings);
    return { review: r.review, application_qc_status: r.application_qc_status, gate: assertGateOpen(r.review, findings), events: r.events.map((e) => e.type) };
  }), guardrails: [NO_PRODUCTION_WRITE, NO_PRODUCTION_COMMAND, NO_HOLD_WAIVER, NO_SUPPRESSION, needsRole("UNABLE_TO_COMPLETE_NEEDS_QC_OFFICER", "28.1 state machine: `unable_to_complete` — the hold is released only by the `qc_officer`", (i) => i.outcome === "unable_to_complete" && !(i.actor && typeof i.actor === "object"), ["qc_officer"], "an agent cannot close a review unable_to_complete")] },
  { name: "computeMetrics", kind: "act", handler: compute((i, ctx, rt) => {
    const op = str(i, "op") || "metrics";
    if (op === "concurrence") { need(i, "partner_id", "period", "officer"); const r = officerConcurrenceReview(ctx.events, rt.escalations, { partner_id: str(i, "partner_id"), period: str(i, "period"), officer: obj<OfficerStats>(i, "officer"), ...(i.current_sample_rate !== undefined ? { current_sample_rate: num(i, "current_sample_rate") } : {}), at: ctx.now }, ctx.actor); return { concurrence_pct: r.concurrence_pct, below_floor: r.below_floor, next_month_sample_rate: r.next_month_sample_rate, escalation_id: r.escalation?.id ?? null }; }
    if (op === "sample_completion") { const plan = planOf(i, rt); const reviews = Array.isArray(i.reviews) ? (i.reviews as QcReview[]) : rt.store.list("qc_reviews", (d) => d.sample_plan_id === plan.sample_plan_id).map((r) => r.data as unknown as QcReview); const r = sampleCompletion(ctx.events, plan, reviews, ctx.now, ctx.actor); return { complete: r.complete, completion_date: r.completion_date, report_due: r.report_due, issue_target: r.issue_target }; }
    need(i, "period_month", "eligible_population");
    const reviews = Array.isArray(i.reviews) ? (i.reviews as QcReview[]) : rt.store.list("qc_reviews").map((r) => r.data as unknown as QcReview);
    const findings = Array.isArray(i.findings) ? (i.findings as QcFinding[]) : rt.store.list("qc_findings").map((r) => r.data as unknown as QcFinding);
    const m = computeMetrics({ period_month: dateIn(i, "period_month"), eligible_population: num(i, "eligible_population"), reviews, findings, officer: i.officer && typeof i.officer === "object" ? (i.officer as OfficerStats) : null });
    persist(rt, ctx, "qc_metrics", `prefunding:${m.period}`, m); return m;
  }), guardrails: [NO_DEMOGRAPHICS("computeMetrics"), NO_PRODUCTION_WRITE] },
  { name: "draftMonthlyReport", kind: "act", handler: compute((i, ctx, rt) => {
    const op = str(i, "op") || "draft";
    if (op === "sign") { need(i, "report_id"); const rep = stored<QcReport>(rt, "qc_reports", str(i, "report_id")); const r = signReport(ctx.events, rep, { officer: actorOr(i, ctx), at: ctx.now }); persist(rt, ctx, "qc_reports", rep.report_id, r.report); return r.report; }
    if (op === "acknowledge") { need(i, "report_id"); const rep = stored<QcReport>(rt, "qc_reports", str(i, "report_id")); const r = acknowledgeReport(ctx.events, rep, { officer: actorOr(i, ctx), at: ctx.now }); persist(rt, ctx, "qc_reports", rep.report_id, r.report); return r.report; }
    if (op === "annual_audit") { need(i, "partner_id", "year"); if (i.tick === true) annualAuditTick(ctx.events, { year: num(i, "year"), partner_id: str(i, "partner_id"), time_zone: str(i, "time_zone") || "America/New_York" }); const r = issueAnnualAuditReport(ctx.events, { partner_id: str(i, "partner_id"), year: num(i, "year"), performed_by: (str(i, "performed_by") || "sm_internal_audit") as never, findings: optList<string>(i, "audit_findings"), at: ctx.now, content_document_id: (i.content_document_id as string | undefined) ?? null }, ctx.actor); persist(rt, ctx, "qc_reports", r.report.report_id, r.report); return r.report; }
    if (op === "corrective_action") { need(i, "defect_code", "loans", "action", "owner", "expected_resolution", "due_date"); return correctiveActionPlan({ defect_code: str(i, "defect_code"), loans: num(i, "loans"), action: str(i, "action"), owner: str(i, "owner"), expected_resolution: str(i, "expected_resolution"), due_date: dateIn(i, "due_date") }); }
    const plan = planOf(i, rt); need(i, "partner_id", "current", "completion_date");
    const r = draftMonthlyReport(ctx.events, { ...(typeof i.report_id === "string" ? { report_id: i.report_id } : {}), partner_id: str(i, "partner_id"), plan, current: obj<MonthlyMetrics>(i, "current"), prior: optList<MonthlyMetrics>(i, "prior"), corrective_action_plans: optList<CorrectiveActionPlan>(i, "corrective_action_plans"), completion_date: dateIn(i, "completion_date"), at: ctx.now, content_document_id: (i.content_document_id as string | undefined) ?? null }, ctx.actor);
    persist(rt, ctx, "qc_reports", r.report.report_id, r.report); return r.report;
  }), guardrails: [NO_PRODUCTION_WRITE, needsRole("REPORT_SIGN_NEEDS_QC_OFFICER", "28.1 automation class (b): the `qc_officer` signs the monthly report; partner `officer` acknowledges", (i) => (i.op === "sign" || i.op === "acknowledge") && !(i.actor && typeof i.actor === "object"), ["qc_officer", "officer"], "signing / acknowledging is a human act")] },
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
    if (i.op === "record" || i.review_id || i.review) {
      const review = reviewOf(i, rt); need(i, "rationale", "confidence");
      const rec = decisionRecord28_1(review, { tests: optList<ChecklistTest>(i, "tests"), findings: findingsOf(i, rt, review.review_id), reverifications: optList<QcReverification>(i, "reverifications"), inputs: (i.inputs as Record<string, unknown> | undefined) ?? {}, rationale: str(i, "rationale"), confidence: num(i, "confidence"), officer_review: (i.officer_review as never) ?? null, model_version: (i.model_version as string | undefined) ?? null, prompt_version: (i.prompt_version as string | undefined) ?? null });
      persist(rt, ctx, "qc_decision_records", review.review_id, rec);
      ctx.decide({ agent: QC_AGENT_ID, action: "28.1 review decision", rationale: rec.rationale, ruleSetVersion: RULE_SET_VERSION_28_1, loanId: ctx.loanId, applicationId: review.application_id, subject: { kind: "qc_review", id: review.review_id }, ruleCode: "D1-2-01", evidenceDocumentIds: optList<ChecklistTest>(i, "tests").flatMap((t) => t.evidence_refs.map((e) => e.document_id)), confidence: rec.confidence, modelVersion: rec.model_version, promptVersion: rec.prompt_version });
      return rec;
    }
    return decision()(i, ctx);
  }), guardrails: [NO_DEMOGRAPHICS("writeDecision"), NO_PRODUCTION_WRITE], decision: () => null },
]);

/** The mirror guard the 28.1 harness applies to a QC identity reaching a production tool (T6): refuse and log sev 2 to compliance-sentinel. */
export const assertQcNotOnProductionCommand = assertNotProductionCommand;
export type { FindingDraft };
