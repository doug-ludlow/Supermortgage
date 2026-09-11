/**
 * §23.3 process-owned tools — bus tools for 23.3 defined with `defineTools("23.3", "underwriter", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 23.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `underwriter` profile (spec "AI agent design"): assessRisk, issueConditionalApproval, renderApprovalLetter,
 * evaluateClearance, clearCondition (op=clear|waive), reopenCondition, runCtcChecklist (op=ptd|ctc|ptf|reopen|supersede),
 * issueClearToClose, evaluateReliefLedger (op=evaluate|lose_employment|payment_history), prepareAdverseDecision
 * (op=prepare|review|hand_off|counteroffer_expiry), writeDecision, openEscalation. Guardrails encode the paragraph:
 * never issue CTC with a failing checklist item; never clear a DU verification condition without evidence meeting DU's
 * level; never waive a Fannie Mae eligibility item; never issue a denial, counteroffer or NOIA without
 * `underwriting_reviewer`; never use protected-class data or proxies in the assessment; never state DU, a score cutoff
 * or "internal standards" as a reason; never alter the reasons after reviewer approval. State lives in the entity store
 * (`credit_decisions`, `application_decisions` — 21.6's file, `conditions` — 23.2's rows, `condition_clearances`,
 * `ctc_checklists`, `rep_warrant_relief`, `adverse_decisions`); events go through ops-23-3.ts so the gates arm and close.
 */
import { defineTools, compute, escalate, decision, never, needsRole, str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { DecisionFile } from "../../domain/application/ops-21-6.ts";
import type { Condition, Investigation23, RestructureProposal } from "../../domain/underwriting/ops-23-2.ts";
import { assessRisk, validUntil, conditionalApprovalGuard, issueConditionalApproval, approvalLetterPayload, evaluateClearance, clearCondition, waiveCondition, reopenCondition, markConditionWaiting, ptdStatus, recordPtdCleared, ptfStatus, recordPtfCleared, runCtcChecklist, issueClearToClose, ctcGate, ptdClearedGate, reopenDecision, supersedeDecision, validityExpired,
  prepareAdverseDecision, reviewAdverseDecision, handOffToRegB, counterofferExpiry, expireCounterofferProposal, evaluateReliefLedger, recordReliefLedger, loseEmploymentRelief, openPaymentHistoryRelief, decisionRecord23_3, prefundingReviewStatus, assertNoDemographics,
  type RiskInput, type RiskAssessment, type CreditDecision, type EvidenceDoc, type ClearanceEvaluation, type QcHold, type CtcFacts, type CtcChecklist, type PrefundingReviewStatus, type ReopenCause, type AdverseDecisionRecord, type AdverseReason, type ReliefFacts, type ReliefEntry, type PtfRequirement, type ReviewerAction, type LetterInput } from "../../domain/underwriting/ops-23-3.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`23.3 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("23.3 tool needs application_id (every 23.3 event carries it so the gates arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] ? D(str(i, k)) : null);
const today = (i: ToolInput, ctx: CommandContext): PlainDate => (i.today ? dateIn(i, "today") : D(ctx.now.slice(0, 10)));
const obj = <T extends object>(i: ToolInput, k: string): T => { const v = i[k]; if (!v || typeof v !== "object") throw new RangeError(`23.3 tool needs ${k} {…}`); return v as T; };
const list = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`23.3 tool needs ${k}[]`); return v as T[]; };
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: object) => rt.store.put(kind, id, data as Record<string, unknown>, ctx.actor, ctx.now);
const stored = <T>(rt: ToolRuntime, kind: string, id: string): T => rt.store.require(kind, id).data as unknown as T;
const decisionOf = (i: ToolInput, rt: ToolRuntime): CreditDecision => (i.decision && typeof i.decision === "object" ? (i.decision as CreditDecision) : (need(i, "decision_id"), stored<CreditDecision>(rt, "credit_decisions", str(i, "decision_id"))));
const conditionOf = (i: ToolInput, rt: ToolRuntime): Condition => (i.condition && typeof i.condition === "object" ? (i.condition as Condition) : (need(i, "condition_id"), stored<Condition>(rt, "conditions", str(i, "condition_id"))));
const conditionsOf = (i: ToolInput, rt: ToolRuntime, application_id: string): Condition[] => (Array.isArray(i.conditions) ? (i.conditions as Condition[]) : rt.store.list("conditions", (d) => d.application_id === application_id).map((r) => r.data as unknown as Condition));
const fileOf = (i: ToolInput, rt: ToolRuntime, application_id: string): DecisionFile => (i.file && typeof i.file === "object" ? (i.file as DecisionFile) : stored<DecisionFile>(rt, "application_decisions", application_id));
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const saveConditions = (rt: ToolRuntime, ctx: CommandContext, cs: readonly Condition[]) => { for (const c of cs) persist(rt, ctx, "conditions", c.condition_id, c); };
const DEMOGRAPHIC_INPUT = /^(race|ethnicity|sex|gender|age|date_of_birth|dob|marital_status|national_origin|religion|applicant_demographics|hmda_demographics)$/i;
const hasDemographics = (i: ToolInput): boolean => { try { assertNoDemographics(i); return false; } catch { return true; } };
const NO_DEMOGRAPHICS = (name: string) => never("PROTECTED_CLASS_DATA_IN_ASSESSMENT", "23.3 guardrails: never use protected-class data or proxies in the assessment (demographics live in `applicant_demographics` with access logging and are not readable by the agent)", (i) => Object.keys(i).some((k) => DEMOGRAPHIC_INPUT.test(k)) || hasDemographics(i), `${name}: a protected-class field reached the input — the agent never reads applicant_demographics`);

export const TOOLS_23_3: readonly ToolDef[] = defineTools("23.3", "underwriter", [
  { name: "assessRisk", kind: "act", handler: compute((i, ctx, rt) => {
    const r = obj<RiskInput>(i, "risk_input");
    const capacity = bigints(r.capacity, ["residual_income_cents"]), capital = bigints(r.capital, ["funds_to_close_cents"]);
    const assessment = assessRisk({ ...r, capacity, capital });
    if (i.decision_id) persist(rt, ctx, "risk_assessments", str(i, "decision_id"), { application_id: appOf(i, ctx), decision_id: str(i, "decision_id"), ...assessment });
    return assessment;
  }), guardrails: [NO_DEMOGRAPHICS("assessRisk"), never("LAYERING_NEVER_OVERRIDES_APPROVE_ELIGIBLE", "23.3 rule 1 / 23.3-Q1: layering never overrides an Approve/Eligible under the partner's policy (no overlays by default)", (i) => i.overlay_decline === true || i.decline_on_layering === true, "layering is recorded and monitored (31.2), never used to decline an Approve/Eligible loan; any overlay must be written into rule_sets")] },
  { name: "issueConditionalApproval", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); need(i, "decision_id", "validity", "guard", "rationale");
    const validity = obj<{ credit_expires_at: string; lock_expires_at?: string | null; valuation_expires_at?: string | null; du_close_by_date?: string | null }>(i, "validity");
    const guard = obj<{ policy_outcome: string; qm_facts: Record<string, unknown>; is_hoepa: boolean | null; is_state_high_cost: boolean | null; open_red_flag_investigations: number }>(i, "guard");
    const risk = (i.risk_assessment as RiskAssessment | undefined) ?? (i.decision_id ? (rt.store.get("risk_assessments", str(i, "decision_id"))?.data as unknown as RiskAssessment | undefined) : undefined);
    if (!risk) throw new RangeError("23.3 tool needs risk_assessment (assessRisk first)");
    const conditions = conditionsOf(i, rt, application_id);
    const r = issueConditionalApproval(ctx.events, rt.escalations, { decision_id: str(i, "decision_id"), file: fileOf(i, rt, application_id), guard: { policy_outcome: guard.policy_outcome as never, qm_facts: guard.qm_facts ?? {}, is_hoepa: guard.is_hoepa ?? null, is_state_high_cost: guard.is_state_high_cost ?? null, open_red_flag_investigations: Number(guard.open_red_flag_investigations ?? 0) },
      validity: { credit_expires_at: D(validity.credit_expires_at), lock_expires_at: validity.lock_expires_at ? D(validity.lock_expires_at) : null, valuation_expires_at: validity.valuation_expires_at ? D(validity.valuation_expires_at) : null, du_close_by_date: validity.du_close_by_date ? D(validity.du_close_by_date) : null },
      risk_assessment: risk, inputs: obj(i, "inputs"), du_submission_id: (i.du_submission_id as string | undefined) ?? null, interpretation_id: (i.interpretation_id as string | undefined) ?? null, conditions, evidence_document_ids: Array.isArray(i.evidence_document_ids) ? (i.evidence_document_ids as string[]) : [],
      rationale: str(i, "rationale"), confidence: i.confidence === undefined ? 0.9 : num(i, "confidence"), model_version: str(i, "model_version") || "underwriter-2026.09", prompt_version: str(i, "prompt_version") || "23.3-v1", at: ctx.now, issued_on: today(i, ctx) }, ctx.actor);
    persist(rt, ctx, "credit_decisions", r.decision.decision_id, r.decision); persist(rt, ctx, "application_decisions", application_id, r.file);
    return { decision: r.decision, valid_until: r.decision.valid_until, validity_component: r.decision.validity_component, conditions_listed: r.decision.conditions_snapshot.length, events: r.events.map((e) => e.type) };
  }), guardrails: [NO_DEMOGRAPHICS("issueConditionalApproval"), never("APPROVAL_NEEDS_PROCEED_AND_QM", "23.3 rule 2: conditional approval only when `policy_outcome = proceed` and 23.4's preliminary result is `qm` / not high-cost", (i) => !!i.guard && typeof i.guard === "object" && ((i.guard as { policy_outcome?: string }).policy_outcome !== undefined && (i.guard as { policy_outcome?: string }).policy_outcome !== "proceed"), "a restructure_required / decline_candidate outcome routes to prepareAdverseDecision, never to an approval")] },
  { name: "renderApprovalLetter", kind: "act", handler: async (i, ctx, rt) => {
    const d = decisionOf(i, rt); need(i, "letter");
    const l = obj<Record<string, unknown>>(i, "letter"); const terms = bigints((l.terms as Record<string, unknown> | undefined) ?? {}, ["loan_amount_cents"]);
    const payload = approvalLetterPayload(d, { ...(l as unknown as LetterInput), terms: terms as unknown as LetterInput["terms"], notice_date: today(i, ctx) });
    const svc = rt.notices; if (!svc) throw new RangeError("23.3 renderApprovalLetter needs the Notice Registry (rt.notices)");
    const n = svc.render({ templateCode: "NTC_REGB_1002_9_APPROVAL", loanId: ctx.loanId, recipients: list(i, "recipients"), payload, asOf: today(i, ctx) });
    const sent = i.send === false ? n : await svc.send(n.id, (i.channel_context as Record<string, unknown> | undefined) ?? {});
    persist(rt, ctx, "credit_decisions", d.decision_id, { ...d, notice_id: n.id });
    return { notice_id: n.id, template: "NTC_REGB_1002_9_APPROVAL", sent: i.send !== false, status: (sent as { status?: string }).status ?? null, conditions_listed: payload.conditions_count, valid_until: d.valid_until };
  }, guardrails: [never("APPROVAL_LETTER_IN_PARTNER_NAME", "23.3 capacity: the conditional-approval letter is issued in the partner's name; SM never represents itself as the creditor", (i) => !!i.letter && typeof i.letter === "object" && /supermortgage|\bSM\b/i.test(String((i.letter as { creditor_name?: string }).creditor_name ?? "")), "creditor_name must be the partner"),
    never("NO_DU_OUTPUT_TO_BORROWER", "23.2 guardrail: never present DU output to the borrower", (i) => Array.isArray(i.extra_conditions) && (i.extra_conditions as string[]).some((t) => /\bDU\b|Desktop Underwriter|Refer with Caution/i.test(t)), "conditions are rendered from the SM borrower-facing wording only")] },
  { name: "evaluateClearance", kind: "act", handler: compute((i, ctx, rt) => {
    const cond = conditionOf(i, rt); need(i, "note_date");
    const evidence = list<EvidenceDoc>(i, "evidence").map((e) => ({ ...e, document_date: e.document_date ? D(String(e.document_date)) : null }));
    const du = i.du_used ? bigints(obj(i, "du_used"), ["qualifying_income_cents", "funds_to_verify_cents", "reserves_required_cents"]) : null;
    const ver = i.verified ? bigints(obj(i, "verified"), ["income_cents", "assets_cents", "reserves_cents"]) : null;
    const validated = i.validated ? obj<{ component: "income" | "employment" | "assets"; close_by_date: string | null }>(i, "validated") : null;
    const ev = evaluateClearance(cond, evidence, { note_date: dateIn(i, "note_date"), du_used: du as never, verified: ver as never, validated: validated ? { component: validated.component, close_by_date: validated.close_by_date ? D(validated.close_by_date) : null } : null });
    persist(rt, ctx, "clearance_evaluations", `${cond.condition_id}:${ctx.now}`, { ...ev, application_id: cond.application_id, evaluated_at: ctx.now });
    if (ev.outcome === "satisfied_pending_review" && cond.status !== "satisfied_pending_review") persist(rt, ctx, "conditions", cond.condition_id, { ...cond, status: "satisfied_pending_review", clear_evidence_document_ids: ev.evidence_document_ids });
    return ev;
  }) },
  { name: "clearCondition", kind: "act", handler: compute((i, ctx, rt) => {
    const cond = conditionOf(i, rt);
    if (i.op === "waive") {
      need(i, "reason");
      const r = waiveCondition(ctx.events, cond, { reason: str(i, "reason"), at: ctx.now }, ctx.actor);
      saveConditions(rt, ctx, [r.condition]); return { condition: r.condition, waived: true, event: r.event.type };
    }
    const ev = (i.evaluation as ClearanceEvaluation | undefined) ?? (i.evaluation_id ? stored<ClearanceEvaluation>(rt, "clearance_evaluations", str(i, "evaluation_id")) : null);
    if (!ev) throw new RangeError("23.3 clearCondition needs evaluation (evaluateClearance's result) or evaluation_id");
    const r = clearCondition(ctx.events, cond, ev, { at: ctx.now, closing_date: optDate(i, "closing_date"), notes: (i.notes as string | undefined) ?? null, qc_sample_flag: flag(i, "qc_sample_flag") }, ctx.actor);
    saveConditions(rt, ctx, [r.condition]); persist(rt, ctx, "condition_clearances", r.clearance.clearance_id, r.clearance);
    return { condition: r.condition, clearance: r.clearance, event: r.event.type };
  }), guardrails: [never("CLEAR_WITHOUT_EVIDENCE_AT_DU_LEVEL", "23.3 guardrails: never clear a DU verification condition without evidence meeting DU's documentation level (B3-2-04)", (i) => i.op !== "waive" && !!i.evaluation && typeof i.evaluation === "object" && (i.evaluation as { outcome?: string }).outcome === "insufficient", "the clearance evaluation found no evidence of the template's kinds"),
    never("WAIVER_NOT_PERMITTED_ELIGIBILITY", "23.3 guardrails: never waive a Fannie Mae eligibility item", (i) => i.op === "waive" && !!i.condition && typeof i.condition === "object" && ["program", "compliance", "project", "property"].includes(String((i.condition as { category?: string }).category)), "eligibility items are resolved, never waived (A2-2-04)"),
    needsRole("WAIVER_NEEDS_UNDERWRITING_REVIEWER", "23.3 automation class (b): condition waivers require `underwriting_reviewer`", (i) => i.op === "waive", ["underwriting_reviewer"], "a waiver is the reviewer's own act with a recorded reason"),
    never("QC_OFFICER_CANNOT_CLEAR", "23.3 rule 3: `qc_officer` never clears production conditions (independence)", (i) => i.op !== "waive" && i.as_role === "qc_officer", "QC may reopen, never clear")] },
  { name: "reopenCondition", kind: "act", handler: compute((i, ctx, rt) => {
    // op=waiting: the lifecycle step `open` → `waiting_borrower` (needs-list item sent) | `waiting_third_party` (vendor order) — spec "Condition lifecycle"; 32.5 §1 renders it (docs/ux/BACKEND-DELTAS.md)
    if (i.op === "waiting") { const cond = conditionOf(i, rt); need(i, "on"); const r = markConditionWaiting(ctx.events, cond, { on: str(i, "on") as "borrower" | "third_party", reason: str(i, "reason") || (str(i, "on") === "borrower" ? "needs-list item sent to the borrower" : "vendor order placed"), at: str(i, "at") || ctx.now }, ctx.actor); saveConditions(rt, ctx, [r.condition]); return { condition: r.condition, event: r.event.type }; }
    const cond = conditionOf(i, rt); need(i, "reason");
    const r = reopenCondition(ctx.events, cond, { reason: str(i, "reason"), at: ctx.now }, ctx.actor);
    saveConditions(rt, ctx, [r.condition]); return { condition: r.condition, event: r.event.type };
  }) },
  { name: "runCtcChecklist", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); const op = str(i, "op") || "ctc";
    const conditions = conditionsOf(i, rt, application_id);
    if (op === "ptd") {
      const investigations = Array.isArray(i.investigations) ? (i.investigations as Investigation23[]) : rt.store.list("investigations", (d) => d.application_id === application_id).map((r) => r.data as unknown as Investigation23);
      const holds = Array.isArray(i.qc_holds) ? (i.qc_holds as QcHold[]) : [];
      const s = ptdStatus(conditions, investigations, holds);
      const gate = ptdClearedGate({ ptd_cleared: s.cleared, blocking_codes: s.blocking_codes, final_match_gate_open: i.final_match_gate_open === undefined ? true : flag(i, "final_match_gate_open"), command: str(i, "command") || "issueCD" });
      const event = s.cleared && i.record !== false ? recordPtdCleared(ctx.events, application_id, s, ctx.now, ctx.actor) : null;
      return { ...s, gate, event: event?.type ?? null };
    }
    if (op === "ptf") {
      const d = decisionOf(i, rt); const s = ptfStatus(conditions, (i.facts as Partial<Record<PtfRequirement, boolean>> | undefined) ?? {});
      if (!s.cleared || i.record === false) return { ...s, event: null };
      const r = recordPtfCleared(ctx.events, d, s, ctx.now, ctx.actor); persist(rt, ctx, "credit_decisions", d.decision_id, r.decision);
      return { ...s, decision: r.decision, event: r.event.type };
    }
    if (op === "reopen") {
      const d = decisionOf(i, rt); need(i, "cause");
      const r = reopenDecision(ctx.events, rt.escalations, d, { cause: str(i, "cause") as ReopenCause, at: ctx.now, today: today(i, ctx), consummation_date: optDate(i, "consummation_date"), detail: (i.detail as Record<string, unknown> | undefined) ?? {} }, ctx.actor);
      persist(rt, ctx, "credit_decisions", d.decision_id, r.decision);
      return { decision: r.decision, escalation_id: r.escalation.id, sla: r.sla, sla_due_on: r.sla_due_on, gate: ctcGate({ ctc_issued: false, checklist_passed: false, decision_status: "reopened", command: "consummate" }), event: r.event.type };
    }
    if (op === "supersede") {
      const d = decisionOf(i, rt); need(i, "by_decision_id");
      const r = supersedeDecision(ctx.events, d, str(i, "by_decision_id"), ctx.now, ctx.actor); persist(rt, ctx, "credit_decisions", d.decision_id, r.decision); return { decision: r.decision, event: r.event.type };
    }
    if (op === "validity") { const d = decisionOf(i, rt); return validityExpired(d, today(i, ctx)); }
    const d = decisionOf(i, rt);
    const review: PrefundingReviewStatus | null | undefined = i.prefunding_review_status === undefined ? (i.derive_prefunding_status === true ? prefundingReviewStatus(ctx.events.all().filter((e) => e.applicationId === application_id)) : undefined) : (i.prefunding_review_status as PrefundingReviewStatus | null);
    const c = runCtcChecklist({ application_id, decision_id: d.decision_id, evaluated_at: ctx.now, facts: (i.facts as CtcFacts | undefined) ?? {}, ...(review !== undefined ? { prefunding_review_status: review } : {}), waived_by: i.waived_by ? (i.waived_by as Actor) : ctx.actor.kind === "human" ? ctx.actor : null });
    persist(rt, ctx, "ctc_checklists", c.checklist_id, c);
    return c;
  }), guardrails: [needsRole("CTC_WAIVER_NEEDS_UNDERWRITING_REVIEWER", "23.3 rule 5: `waived` checklist items require `underwriting_reviewer`", (i) => !!i.facts && typeof i.facts === "object" && Object.values(i.facts as Record<string, { status?: string }>).some((f) => f && f.status === "waived"), ["underwriting_reviewer"], "a waived CTC item is the reviewer's act"),
    needsRole("REOPEN_NEAR_CLOSING_NEEDS_REVIEWER", "23.3 state machine: transitions out of `reopened` inside 3 business_days_creditor of consummation are the `underwriting_reviewer`'s", (i) => i.op === "reissue_near_closing", ["underwriting_reviewer"], "re-issue near closing is a human act")] },
  { name: "issueClearToClose", kind: "act", handler: compute((i, ctx, rt) => {
    const d = decisionOf(i, rt);
    const c = (i.checklist as CtcChecklist | undefined) ?? (i.checklist_id ? stored<CtcChecklist>(rt, "ctc_checklists", str(i, "checklist_id")) : null);
    if (!c) throw new RangeError("23.3 issueClearToClose needs checklist (runCtcChecklist's result) or checklist_id");
    const r = issueClearToClose(ctx.events, d, c, ctx.now, ctx.actor); persist(rt, ctx, "credit_decisions", d.decision_id, r.decision);
    return { decision: r.decision, ctc_at: r.decision.ctc_at, checklist_id: c.checklist_id, gate: ctcGate({ ctc_issued: true, checklist_passed: true, decision_status: r.decision.status, command: "consummate" }), event: r.event.type };
  }), guardrails: [never("CTC_CHECKLIST_FAILING", "23.3 guardrails: never issue CTC with a failing checklist item", (i) => !!i.checklist && typeof i.checklist === "object" && (i.checklist as { passed?: boolean }).passed === false, "every item must be pass / n/a (or waived by underwriting_reviewer) before clear_to_close.issued"),
    never("CTC_WITH_OPEN_PREFUNDING_HOLD", "D1-2-01 / 28.1: a selected loan is held from CTC until the prefunding review closes", (i) => i.prefunding_hold_open === true, "SM_QC_PREFUNDING_HOLD is open")] },
  { name: "evaluateReliefLedger", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); const op = str(i, "op") || "evaluate";
    if (op === "payment_history") {
      need(i, "loan_id", "purchase_date", "first_payment_due");
      const r = openPaymentHistoryRelief(ctx.events, { application_id, loan_id: str(i, "loan_id"), purchase_date: dateIn(i, "purchase_date"), first_payment_due: dateIn(i, "first_payment_due"), at: ctx.now }, ctx.actor);
      persist(rt, ctx, "rep_warrant_relief", r.entry.relief_id, r.entry); return { entry: r.entry, target_date: r.entry.target_date, event: r.event.type };
    }
    if (op === "lose_employment") {
      need(i, "borrower_id", "report_reference_id", "scheduled_note_date");
      const entry = (i.entry as ReliefEntry | undefined) ?? stored<ReliefEntry>(rt, "rep_warrant_relief", `rwr:${application_id}:employment_validated`);
      const r = loseEmploymentRelief(ctx.events, entry, { borrower_id: str(i, "borrower_id"), report_reference_id: str(i, "report_reference_id"), scheduled_note_date: dateIn(i, "scheduled_note_date"), at: ctx.now }, ctx.actor);
      persist(rt, ctx, "rep_warrant_relief", r.entry.relief_id, r.entry); saveConditions(rt, ctx, [r.condition]);
      return { entry: r.entry, condition: r.condition, events: r.events.map((e) => e.type) };
    }
    const f = obj<ReliefFacts>(i, "facts"); need(i, "stage", "as_of");
    const facts: ReliefFacts = { ...f, income_calculator: f.income_calculator ? bigints(f.income_calculator, ["qualifying_income_cents", "tool_income_cents"]) : null };
    const c = { application_id, stage: str(i, "stage") as "ctc" | "funding", closing_date: optDate(i, "closing_date"), as_of: dateIn(i, "as_of"), evaluated_at: ctx.now };
    const entries = evaluateReliefLedger(facts, c); for (const e of entries) persist(rt, ctx, "rep_warrant_relief", e.relief_id, e);
    const event = i.record === false ? null : recordReliefLedger(ctx.events, entries, c, ctx.actor);
    return { entries, event: event?.type ?? null };
  }), guardrails: [never("RELIEF_CONFIRMED_ONLY_BY_FNMA", "A2-3.2-02: 'Fannie Mae will provide lenders with reports listing those loans that met the eligibility requirements for relief' — confirmation comes from 28.2/30.4, never from the agent", (i) => i.status === "confirmed_by_fnma" || i.confirm === true, "the agent evaluates eligibility; `confirmed_by_fnma` is written only from Fannie Mae's relief report")] },
  { name: "prepareAdverseDecision", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); const op = str(i, "op") || "prepare";
    if (op === "counteroffer_expiry") {
      need(i, "sent_on"); const x = counterofferExpiry({ sent_on: dateIn(i, "sent_on"), combined_notice: i.combined_notice !== false });
      const p = i.proposal ? (i.proposal as RestructureProposal) : i.proposal_id ? stored<RestructureProposal>(rt, "restructure_proposals", str(i, "proposal_id")) : null;
      const r = p && today(i, ctx) >= x.expires_on ? expireCounterofferProposal(ctx.events, p, ctx.now, ctx.actor) : null;
      if (r) persist(rt, ctx, "restructure_proposals", r.proposal.proposal_id, r.proposal);
      return { ...x, proposal_status: r?.proposal.status ?? p?.status ?? null, event: r?.event.type ?? null };
    }
    if (op === "review") {
      need(i, "decision_id", "action"); const rec = stored<AdverseDecisionRecord>(rt, "adverse_decisions", str(i, "decision_id"));
      const r = reviewAdverseDecision(ctx.events, rt.escalations, rec, { action: str(i, "action") as Exclude<ReviewerAction, null>, reviewer: ctx.actor, at: ctx.now, notes: (i.notes as string | undefined) ?? null, ...(Array.isArray(i.reasons) ? { reasons: i.reasons as AdverseReason[] } : {}) });
      persist(rt, ctx, "adverse_decisions", rec.decision_id, r.record); return { record: r.record, reviewer_action: r.record.reviewer_action, event: r.event.type };
    }
    if (op === "hand_off") {
      need(i, "decision_id"); const rec = stored<AdverseDecisionRecord>(rt, "adverse_decisions", str(i, "decision_id"));
      const r = handOffToRegB(ctx.events, rt.escalations, fileOf(i, rt, application_id), rec, ctx.now, ctx.actor);
      persist(rt, ctx, "adverse_decisions", rec.decision_id, r.record); persist(rt, ctx, "application_decisions", application_id, r.file);
      return { record: r.record, decision: r.decision, events: r.events.map((e) => e.type) };
    }
    need(i, "decision_id", "kind", "reasons", "inputs_hash", "rationale", "sla_due_on");
    const terms = i.counteroffer_terms ? bigints(obj(i, "counteroffer_terms"), ["loan_amount_cents"]) : null;
    const r = prepareAdverseDecision(ctx.events, rt.escalations, { decision_id: str(i, "decision_id"), application_id, kind: str(i, "kind") as "denial" | "counteroffer", reasons: list<AdverseReason>(i, "reasons"), counteroffer_terms: terms as never, du_recommendation: (i.du_recommendation as never) ?? null, inputs_hash: str(i, "inputs_hash"),
      model_version: str(i, "model_version") || "underwriter-2026.09", prompt_version: str(i, "prompt_version") || "23.3-v1", rationale: str(i, "rationale"), confidence: i.confidence === undefined ? 0.9 : num(i, "confidence"), at: ctx.now, sla_due_on: dateIn(i, "sla_due_on") }, ctx.actor);
    persist(rt, ctx, "adverse_decisions", r.record.decision_id, r.record);
    return { record: r.record, reviewer_action: null, regb_invoked: false, escalation_id: r.escalation.id, event: r.event.type };
  }), guardrails: [NO_DEMOGRAPHICS("prepareAdverseDecision"),
    never("REASON_TEXT_NOT_PERMISSIBLE", "23.3 guardrails / §1002.9(b)(2): never state DU, a score cutoff or \"internal standards\" as a reason", (i) => Array.isArray(i.reasons) && (i.reasons as { text?: string }[]).some((r) => /\bDU\b|Desktop Underwriter|Refer with Caution|Approve\/Ineligible|internal (standards|policies)|score cutoff/i.test(String(r?.text ?? ""))), "reasons are specific facts (\"debt-to-income ratio of 53.32% exceeds the 50% maximum\"), never the DU recommendation"),
    needsRole("ADVERSE_NEEDS_UNDERWRITING_REVIEWER", "23.3 guardrails: never issue a denial, counteroffer or NOIA without `underwriting_reviewer`", (i) => i.op === "review", ["underwriting_reviewer"], "the reviewer approves, modifies or rejects the prepared record"),
    never("REASONS_FROZEN_AFTER_APPROVAL", "23.3 guardrails: never alter the reasons after reviewer approval", (i) => i.op === "hand_off" && Array.isArray(i.reasons), "the handed-off record carries the reviewer-approved reasons unchanged")] },
  { name: "writeDecision", kind: "act", handler: compute((i, ctx, rt) => {
    if (i.record_only === true || i.decision_id === undefined) return decision()(i, ctx);
    const d = i.adverse === true ? stored<AdverseDecisionRecord>(rt, "adverse_decisions", str(i, "decision_id")) : decisionOf(i, rt);
    const rec = decisionRecord23_3(d, { du: (i.du as never) ?? { casefile_id: null, submission_number: null, recommendation: null, policy_generation: null, findings_hash: null }, evidence: Array.isArray(i.evidence) ? (i.evidence as never) : [], notice_id: (i.notice_id as string | undefined) ?? null });
    persist(rt, ctx, "agent_decision_records", rec.decision_id, rec);
    ctx.decide({ agent: ctx.actor.id, action: str(i, "action") || `23.3 ${rec.kind}`, rationale: rec.rationale, ruleSetVersion: `fnma.selling@${rec.rule_set_versions["fnma.selling"]}; regb@${rec.rule_set_versions.regb}`, loanId: ctx.loanId, subject: { kind: "decision", id: rec.decision_id }, evidenceDocumentIds: rec.evidence.map((e) => e.document_id), confidence: rec.confidence });
    return rec;
  }), guardrails: [NO_DEMOGRAPHICS("writeDecision")] },
  { name: "openEscalation", kind: "act", handler: escalate("underwriting_reviewer"), guardrails: [needsRole("ESCALATION_COMPLETION_IS_HUMAN", "23.3 escalations: the reviewer (or `officer` on auto-escalation) completes the work item", (i) => i.op === "complete", ["underwriting_reviewer", "officer", "qc_officer", "licensed_specialist"], "an agent opens escalations; a human closes them")] },
]);
