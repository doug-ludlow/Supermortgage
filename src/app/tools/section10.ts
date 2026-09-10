/**
 * §10 tools — PMI administration (10.1–10.6). Tool strings are verbatim from
 * each process's Agents paragraph; guardrails encode the "cannot"/"never"
 * sentences and the human touchpoints. Agent: `pmi` throughout (10.3 names
 * no tools of its own — the sweep is a deterministic job).
 *
 * Events the registry timers wait on are emitted here (src/domain/pmi/timers.ts
 * lists the vocabulary): every termination/cancellation publishes the canonical
 * `mi.terminated` / `mi.cancelled` plus `mi.coverage.ended` (the R-F1…R-F6
 * pipeline start) and the sweep's `mi.auto_termination.resolved`; the notice
 * service's `notice.sent{template}` satisfies the notice clocks; the refund,
 * insurer-ack, escrow-line and LAR 89 events come from the 10.5/10.1 tools.
 */
import { defineTools, escalate, compute, never, needsRole, guard, noticeOps, ledgerPost, port, read, write, readWrite, log, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { servicer } from "../../kernel/calendar/business.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import type { AppliedInstallment } from "../../domain/boarding/delinquency.ts";
import { evaluateCancellation, setOriginalValueAllowed, smduLiabilityRelief, valueCheck, valuationExpired, premiumStopAnchor, type CancellationRequest, type PropertyClass } from "../../domain/pmi/cancellation.ts";
import { buildSchedule, armResetVersion, scheduledDateForPct, midpoint, type ScheduleVersion } from "../../domain/pmi/schedule.ts";
import { automaticTermination, rule78Applies, finalizationClocks, lpmiOptionsNoticeDue, type Lar89Code } from "../../domain/pmi/termination.ts";
import { unearnedEstimate, refundApplicationAllowed, reconcileInsurerRefund, returnedAchCheckDue, type RefundPlan } from "../../domain/pmi/refund.ts";
import { valuationDenialWindows } from "../../domain/pmi/denial.ts";
import { DENIAL_NEEDS_EVALUATION_ROW, RECOMPOSE_AFTER_NUMBER_CHANGE, caseNoeOpen_10_6, documentsDeliver_10_6 } from "../../domain/pmi/ops-10-6.ts";
import { sweepTermination, terminationActions, disclosureChannelAt, escrowMiLineRelease, nyPremiumGate, refundEscrowEvents, type TerminationActions } from "../../domain/pmi/ops.ts";
import { lar89ReportingFields } from "../../domain/pmi/ops-10-2.ts";
import { refuseLpmiBorrowerPayee } from "../../domain/pmi/ops-10-5.ts";
import { pmiTerminateOps_10_2, reviewHooks_10_2, investorEmitOps_10_2, scheduleRebuildOps_10_2 } from "./section10-2.ts";
import { escrowEventOp_10_5 } from "./section10-5.ts";
import { pmiTerminateOps_10_3 } from "./section10-3.ts";
import { disclosureComposeSendOps_10_4 } from "./section10-4.ts";
import { validateCancelRequest, openCancellationRequest, confirmWrittenRequest, advanceCase, cancelBasisOnRecord, smduEvaluate, feeIsTabulated } from "../../domain/pmi/ops-10-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optCents = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : cents(v));
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const A = "pmi";
const TABULATED_FEES = new Set([19000n, 45000n, 75000n]);
const DENIAL_REASONS = new Set(["LTV_ABOVE_THRESHOLD", "LTV_ABOVE_THRESHOLD_ORIGINAL", "LTV_ABOVE_THRESHOLD_CURRENT", "NOT_CURRENT", "PAYMENT_HISTORY_30_12M", "PAYMENT_HISTORY_60_24M", "VALUE_DECLINED_BELOW_ORIGINAL", "SEASONING_LT_24M", "SEASONING_LT_60M_LTV_GT_75", "SEASONING_INSUFFICIENT", "IMPROVEMENTS_NOT_SUBSTANTIATED", "PROPERTY_TYPE_70_RULE", "ASSUMPTION_HISTORY_LT_24M", "EVIDENCE_NOT_RECEIVED", "SUBORDINATE_LIEN_CERT_MISSING", "MI_NOT_BORROWER_PAID", "MI_NOT_ACTIVE", "REQUEST_NOT_FROM_AUTHORIZED_PARTY", "VALUATION_EXPIRED", "VALUE_DECLINED_OR_UNKNOWN", "VALUATION_REQUIRED"]);
const DEFER_WHITELIST = new Set(["NOT_CURRENT", "MIDPOINT_ONLY_PROPERTY", "ORIGINAL_VALUE_MISSING", "POLICY_NOT_ACTIVE"]);
const BPMI_PLANS = new Set(["bpmi_monthly", "bpmi_annual", "bpmi_single", "bpmi_split", "financed_single", "bpmi_single_financed"]);

function cancellationRequest(i: ToolInput): CancellationRequest {
  need(i, "received_on", "decision_on", "original_value_cents", "evaluation_upb_cents", "consummation");
  return {
    received_on: date(i, "received_on"), decision_on: date(i, "decision_on"), evidence_satisfied_on: optDate(i, "evidence_satisfied_on"),
    path: (str(i, "path") || "original_value") as "original_value" | "current_value", property_class: (str(i, "property_class") || "1u_principal_or_second") as PropertyClass, hpa_covered: i.hpa_covered !== false,
    original_value_cents: cents(i.original_value_cents), valuation_cents: optCents(i.valuation_cents), valuation_delivered_on: optDate(i, "valuation_delivered_on"),
    evaluation_upb_cents: cents(i.evaluation_upb_cents), threshold_reached_on: optDate(i, "threshold_reached_on"), installments: Array.isArray(i.installments) ? (i.installments as AppliedInstallment[]) : [],
    avm_cents: optCents(i.avm_cents), consummation: date(i, "consummation"), improvements_accepted: flag(i, "improvements_accepted"),
  };
}
function scheduleFrom(i: ToolInput): ScheduleVersion {
  need(i, "upb_cents", "annual_rate_pct", "term_months", "first_due");
  return buildSchedule({ upb_cents: cents(i.upb_cents), annual_rate: ratePercent(str(i, "annual_rate_pct")), term_months: num(i, "term_months"), first_due: date(i, "first_due"), ...(i.io_months !== undefined ? { io_months: num(i, "io_months") } : {}), ...(i.forborne_principal_cents !== undefined ? { forborne_principal_cents: cents(i.forborne_principal_cents) } : {}) }, (str(i, "kind") || "initial") as "initial" | "arm_reset" | "modification");
}
const overrides = (i: ToolInput): string[] => (Array.isArray(i.overrides) ? (i.overrides as unknown[]).map(String) : []);

let pmiRegistry: ReturnType<typeof loadOverriddenRegistry> | undefined;
/**
 * 10.1 R9 / 10.6 R1: the 30-day decision clock is re-anchored only by borrower-supplied evidence (fee, certification,
 * valuation) — the open HPA_4904B_DENIAL_NOTICE_30 instance is closed as re-anchored and a new one is armed from the
 * evidence event on the evidence date, so the timer history shows both anchors (10.6-T4). The offset stays the registry's.
 */
function reanchorDecisionClock(ctx: CommandContext, loanId: string, evidence: DomainEvent, evidenceDate: PlainDate): void {
  const open = ctx.timers.byCode("HPA_4904B_DENIAL_NOTICE_30").filter((t) => t.loanId === loanId && (t.status === "armed" || t.status === "breached"));
  if (!open.length) return;
  pmiRegistry ??= loadOverriddenRegistry();
  const def = pmiRegistry.get("HPA_4904B_DENIAL_NOTICE_30")!;
  for (const t of open) ctx.timers.cancel(t.id, `re-anchored on borrower evidence received ${evidenceDate} (12 U.S.C. 4904(b)(2)(ii))`, ctx.actor);
  ctx.timers.arm(def, { ...evidence, payload: { ...evidence.payload, received_at: evidenceDate } });
}

/**
 * R-F1 — the canonical loan event (`mi.cancelled` / `mi.terminated`, consumed by Sections 3 and 5) plus the §10
 * companions the registry clocks arm and close on: `mi.coverage.ended` (finalization start, R-F2…R-F6 clocks) and the
 * resolution events of the 0-day automatic-termination and NY premium gates.
 */
function emitCoverageEnded(ctx: CommandContext, loanId: string, a: TerminationActions, kind: "borrower" | "automatic_78" | "automatic_midpoint", i: ToolInput): void {
  const common = { effective: a.effective, effective_on: a.effective, premium_stop_from: a.premium_stop_from, lar89: a.lar89, termination_type: kind === "borrower" ? (a.lar89.code === "52" ? "borrower_current_value" : "borrower_original_value") : kind, escrowed: i.escrowed !== false };
  // The canonical event also carries Section 5.1's LAR 89 fields: FNMA_IRM_LAR89_PERIOD_END arms on `mi.*{lar89_action_code present}` anchored on `period_end_date` (10.2 R6).
  ctx.events.append({ type: a.event, loanId, actor: ctx.actor, payload: { ...common, ...lar89ReportingFields(a.effective, a.lar89.code) } });
  ctx.events.append({ type: "mi.coverage.ended", loanId, actor: ctx.actor, payload: { kind: a.event === "mi.cancelled" ? "cancelled" : "terminated", ...common } });
  ctx.events.append({ type: "mi.auto_termination.resolved", loanId, actor: ctx.actor, payload: { trigger: kind === "automatic_midpoint" ? "midpoint" : kind === "automatic_78" ? "scheduled_78" : "borrower", outcome: kind === "borrower" ? "not_applicable" : "terminated", effective: a.effective } });
  ctx.events.append({ type: "mi.ny_premium_gate.resolved", loanId, actor: ctx.actor, payload: { outcome: "terminated", effective: a.effective } });
}

// ---- shared definitions -------------------------------------------------------
const miInsurerCancel: Omit<ToolDef, "process" | "agent"> = { name: "mi_insurer.cancel", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "certificate", "effective_on"); const loanId = (i.loan_id as string | undefined) ?? ctx.loanId; const notifiedOn = str(i, "notified_on") || ctx.now.slice(0, 10);
    const r = await port(rt, "mi").requestCancellation(str(i, "certificate"), (str(i, "reason") || "borrower_request") as "borrower_request" | "automatic_78" | "midpoint" | "investor", str(i, "effective_on"), ctx.now);
    ctx.events.append({ type: "mi.insurer.cancel_notified", loanId, actor: ctx.actor, payload: { certificate: str(i, "certificate"), effective_on: str(i, "effective_on"), notified_on: notifiedOn, refund_payee: str(i, "refund_payee") || "servicer", request_id: r.requestId, status: r.status } });
    // 10.1 integration: ack = insurer confirmation (MGIC/Link, SFT, EDI) — the accepted request is the ack the 45-day / 2-BD clocks close on; a rejection is re-sent and escalated after 5 BD.
    if (r.status === "accepted") ctx.events.append({ type: "integration_messages.acked", loanId, actor: ctx.actor, payload: { kind: "insurer_cancel", request_id: r.requestId, certificate: str(i, "certificate"), acked_on: notifiedOn } });
    else ctx.events.append({ type: "integration_messages.rejected", loanId, actor: ctx.actor, payload: { kind: "insurer_cancel", certificate: str(i, "certificate"), message: r.message ?? null, resend_and_escalate_after: "5 business_days_servicer" } });
    return { ...r, notified_on: notifiedOn, refund_payee: str(i, "refund_payee") || "servicer" }; }),
  guardrails: [never("REFUND_PAYEE_SERVICER", "10.5 prerequisites: the cancellation notice names the servicer as refund payee for pass-through", (i) => str(i, "refund_payee") === "borrower", "the insurer refund routes through the T&I custodial account")] };
const interimAnalysis: Omit<ToolDef, "process" | "agent"> = { name: "escrow.interim_analysis.request", kind: "write", handler: compute((i, ctx) => { need(i, "loan_id", "effective_on"); const e = date(i, "effective_on"); const loanId = str(i, "loan_id");
    const r = escrowMiLineRelease({ E: e, mi_line_balance_cents: cents(i.mi_line_balance_cents), monthly_mi_deposit_cents: cents(i.monthly_mi_deposit_cents), old_payment_cents: cents(i.old_payment_cents), analysis_on: optDate(i, "analysis_on") });
    ctx.events.append({ type: "escrow.interim_analysis.requested", loanId, actor: ctx.actor, payload: { mi_line_closed_as_of: e, due: r.interim_analysis_due, min_30_gate_bypassed: true } });
    // R-F2 / 10.5 R6: with the analysis date the MI line is closed as of E, the interim analysis is complete and premium collection stops (HPA_4902E_STOP_PREMIUM_30 ∧ SM_MI_ESCROW_INTERIM_ANALYSIS_10BD).
    if (optDate(i, "analysis_on") !== null) {
      ctx.events.append({ type: "escrow.line.closed", loanId, actor: ctx.actor, payload: { line: "mi", as_of: e, balance_cents: r.surplus_cents } });
      ctx.events.append({ type: "escrow.analysis.completed", loanId, actor: ctx.actor, payload: { kind: "interim", analysis_on: r.analysis_on, surplus_cents: r.surplus_cents, surplus_refund_due: r.surplus_refund_due, new_payment_cents: r.new_payment_cents, new_payment_effective: r.new_payment_effective } });
      ctx.events.append({ type: "mi.premium.collection.stopped", loanId, actor: ctx.actor, payload: { as_of: e, mi_line_closed: true, new_payment_effective: r.new_payment_effective } });
    }
    return r; }) };
const investorEmit: Omit<ToolDef, "process" | "agent"> = { name: "investor_events.emit", kind: "act", handler: compute((i, ctx, rt) => { { const own = investorEmitOps_10_2(i, ctx, rt); if (own !== undefined) return own; } need(i, "loan_id"); const eventType = str(i, "event_type") || "mi_discontinuance";
    if (eventType === "mi_discontinuance") { need(i, "action_code", "action_date"); const code = str(i, "action_code"); if (!["51", "52", "53", "54"].includes(code)) throw new RangeError(`LAR 89 action code ${code} is not one of 51/52/53/54`);
      return ctx.events.append({ type: "investor_events.queued", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { type: "mi_discontinuance", event_family: "mi", event_type: "mi_discontinuance", legacy_record: 89, action_code: code, action_date: str(i, "action_date"), channel: "fnma-lsdu" } }); }
    if (eventType === "mi_data_correction") { need(i, "fields"); return ctx.events.append({ type: "investor_events.queued", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { type: "mi_data_correction", event_family: "mi", event_type: "mi_data_correction", fields: i.fields, smdu_evaluation_id: (i.smdu_evaluation_id as string | undefined) ?? null, channel: "fnma-smdu" } }); }
    throw new RangeError(`event_type ${eventType} is not one of mi_discontinuance/mi_data_correction`); }) };
const ledger: Omit<ToolDef, "process" | "agent"> = { name: "ledger.post", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { const r = ledgerPost()(i, ctx);
    // 10.1 outputs: the fee receipt is the borrower's evidence event — it opens FNMA_F102_VALUATION_FEE_GATE and ends SM_MI_FEE_WAIT_60.
    if (flag(i, "valuation_fee")) { const loanId = (i.loan_id as string | undefined) ?? ctx.loanId; const on = D(str(i, "received_on") || ctx.now.slice(0, 10));
      const ev = ctx.events.append({ type: "mi.evidence.received", loanId, actor: ctx.actor, payload: { kind: "fee", amount_cents: cents(i.fee_cents), received_on: on, received_at: on } });
      if (loanId) reanchorDecisionClock(ctx, loanId, ev, on); }
    return r; }),
  guardrails: [never("ONLY_TABULATED_FEE", "10.1 guardrail: cannot charge any fee other than the tabulated valuation fee (F-1-02)", (i) => flag(i, "valuation_fee") && !feeIsTabulated(cents(i.fee_cents), str(i, "valuation_kind") || null), "the fee receipt must be $190 BPO / $450 restricted appraisal / $750 2–4 unit appraisal"),
    never("FEES_NEVER_FROM_ESCROW", "10.1 ledger: valuation fees are never paid from escrow or added to the loan (MN §47.207 subd. 5)", (i) => flag(i, "valuation_fee") && /escrow|loan_principal/.test(str(i, "funding_account")), "fees clear through corporate clearing")] };
const documentsStore: Omit<ToolDef, "process" | "agent"> = { name: "documents.store", kind: "write", handler: write("documents", "document.stored") };
// 10.6 guardrail: the linked `mi_evaluations` row is read from the loan's record (`mi.evaluation.completed`, result ineligible), never inferred from a non-empty id (src/domain/pmi/ops-10-6.ts).
const DENIAL_NEEDS_EVALUATION = DENIAL_NEEDS_EVALUATION_ROW;
/** SMDU FAQ Q6: an AVM value quoted to the borrower carries the disclaimer — the agent attests it (`avm_disclaimer: true`) and the template checklist verifies the sentence. */
const AVM_DISCLAIMER = never("AVM_DISCLAIMER", "SMDU FAQ Q6: an AVM value shared with the borrower carries the disclaimer", (i) => { const p = rec(i.payload); return (optCents(p.avm_value_cents) !== null || p.valuation_kind === "avm") && p.avm_disclaimer !== true; }, "add the AVM disclaimer (payload avm_disclaimer: true; the template prints the sentence)");
const noticesAll: Omit<ToolDef, "process" | "agent"> = { name: "notices.*", kind: "act", handler: noticeOps("render_send"), guardrails: [DENIAL_NEEDS_EVALUATION, AVM_DISCLAIMER] };

// ---- 10.1 --------------------------------------------------------------------
const p101 = defineTools("10.1", A, [
  { name: "pmi.*", kind: "write", handler: compute((i, ctx, rt) => {
      switch (i.op ?? "list") {
        case "list": return rt.store.list("mi_policies").map((r) => r.data);
        case "get": return rt.store.get("mi_policies", str(i, "id"))?.data ?? null;
        // 10.1 inputs: the request (portal form / borrower-comms call / classified mail / confirmed SII) → `mi.cancel.requested` (the request clocks' trigger) and the `pmi_cancel` case.
        case "request": return openCancellationRequest(validateCancelRequest(i, rt.store.get("mi_policies", str(i, "loan_id"))?.data ?? null, ctx.now), { events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now, holder: rec(i.holder_config) });
        case "written_confirmation": return confirmWrittenRequest({ loan_id: str(i, "loan_id"), case_id: (i.case_id as string | undefined) ?? null, confirmed_on: optDate(i, "confirmed_on") ?? D(ctx.now.slice(0, 10)), document_id: (i.document_id as string | undefined) ?? null }, { events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now });
        case "evaluate": {
          const req = cancellationRequest(i); const d = evaluateCancellation(req); const loanId = (i.loan_id as string | undefined) ?? ctx.loanId; const ov = overrides(i);
          const id = str(i, "evaluation_id") || `eval-${loanId}-${req.decision_on}-${rt.store.list("mi_evaluations").length + 1}`;
          const row = { id, loan_id: loanId, case_id: (i.case_id as string | undefined) ?? null, evaluated_at: req.decision_on, path: req.path, basis_value_cents: req.path === "current_value" ? req.valuation_cents : req.original_value_cents, evaluation_upb_cents: req.evaluation_upb_cents, ltv_bps: d.ltv_bps, threshold_bps: d.threshold_bps, result: d.result, reasons: d.reasons, effective_on: d.effective_on, lar89_action_code: d.lar89_action_code, decision_due: d.decision_due, late30_12m: d.history.late30_12m, late60_24m: d.history.late60_24m, liability_relief: smduLiabilityRelief(ov), overrides: ov, smdu_evaluation_id: (i.smdu_evaluation_id as string | undefined) ?? null,
            // 10.6 R2 — the denial composes from this snapshot (grounds, days past due, valuation date, seasoning): the request anchors and the offending installments travel with the row.
            received_on: req.received_on, evidence_satisfied_on: req.evidence_satisfied_on, valuation_delivered_on: req.valuation_delivered_on, consummation: req.consummation, hpa_covered: req.hpa_covered, avm_cents: req.avm_cents, late_installments: d.history.offending };
          rt.store.put("mi_evaluations", id, row, ctx.actor, ctx.now);
          ctx.events.append({ type: "mi.evaluation.completed", loanId, actor: ctx.actor, payload: { evaluation_id: id, result: d.result, reasons: d.reasons, ltv_bps: d.ltv_bps, threshold_bps: d.threshold_bps, effective_on: d.effective_on, decision_due: d.decision_due, evaluated_at: req.decision_on, determined_at: req.decision_on, liability_relief: row.liability_relief, servicer_overridden: ov.length > 0, overrides: ov } });
          if (d.result === "eligible" || d.result === "ineligible") ctx.events.append({ type: "mi.case.decided", loanId, actor: ctx.actor, payload: { evaluation_id: id, decision: d.result, decided_on: req.decision_on, reasons: d.reasons } });
          if (d.result === "value_check_needed") ctx.events.append({ type: "mi.value_check_needed", loanId, actor: ctx.actor, payload: { evaluation_id: id, reasons: d.reasons, options: valueCheck(req.avm_cents, req.original_value_cents, req.property_class === "2_4u_principal" ? 2 : 1) } });
          return { evaluation_id: id, ...d };
        }
        case "value_check": { need(i, "original_value_cents"); return valueCheck(optCents(i.avm_cents), cents(i.original_value_cents), num(i, "units") || 1); }
        case "set_original_value": { need(i, "loan_id", "original_value_cents", "evidence_document_id"); const prior = rt.store.get("mi_policies", str(i, "loan_id"))?.data.original_value_cents ?? null; const recd = rt.store.put("mi_policies", str(i, "loan_id"), { original_value_cents: cents(i.original_value_cents), original_value_evidence: str(i, "evidence_document_id") }, ctx.actor, ctx.now);
          const payload = { original_value_cents: cents(i.original_value_cents), prior_original_value_cents: prior, evidence_document_id: str(i, "evidence_document_id") };
          ctx.events.append({ type: "mi.original_value.set", loanId: str(i, "loan_id"), actor: ctx.actor, payload });            // 10.2 SM_MI_ORIGINAL_VALUE_MISSING_60
          ctx.events.append({ type: "mi.original_value.corrected", loanId: str(i, "loan_id"), actor: ctx.actor, payload });      // 10.1 data model: no UPDATE without the evidence-backed event
          return recd.data; }
        case "cancel": {
          // 10.1 state machine: `cancellation_issued` runs 10.2's R-F1…R-F6 (notice, insurer cancel, LAR 89, escrow) and opens the 10.5 refund case.
          need(i, "loan_id"); const loanId = str(i, "loan_id");
          // The grant rests on the recorded decision: the stored `mi_evaluations` row of the eligible evaluation supplies the effective date and LAR 89 code (never the caller's object); a 10.6 human-review reversal grants as of the date the borrower originally qualified.
          const basis = cancelBasisOnRecord(i, ctx.events.byLoan(loanId)); if (!basis) throw new RangeError("cancel needs an eligible evaluation on the loan's record");
          const stored = basis.kind === "eligible_evaluation" ? rt.store.get("mi_evaluations", basis.evaluation_id!)?.data : undefined; if (basis.kind === "eligible_evaluation" && !stored) throw new RangeError(`no mi_evaluations row ${basis.evaluation_id}`);
          const ev = stored ?? rec(i.evaluation);
          const effective = stored ? D(String(stored.effective_on)) : (optDate(i, "effective_on") ?? D(String(ev.effective_on))); const code = (stored ? String(stored.lar89_action_code) : (str(i, "lar89_action_code") || String(ev.lar89_action_code ?? "51"))) as Lar89Code;
          const receivedOn = optDate(i, "received_on"); const stopFrom = receivedOn ? premiumStopAnchor(receivedOn, optDate(i, "evidence_satisfied_on")) : effective;
          const actions = terminationActions(loanId, finalizationClocks(effective, code, servicer, stopFrom), "borrower");
          emitCoverageEnded(ctx, loanId, actions, "borrower", i);
          rt.store.put("mi_policies", loanId, { status: "cancelled", terminated_on: effective, lar89_action_code: code, termination_type: code === "52" ? "borrower_current_value" : "borrower_original_value" }, ctx.actor, ctx.now);
          advanceCase(rt.store, loanId, { status: "cancellation_issued", decision: "eligible", cancellation_effective_date: effective, evaluation_id: basis.evaluation_id, cancel_basis: basis.kind }, ctx.actor, ctx.now);
          const refund = rt.store.put("mi_refunds", `refund-${loanId}-${effective}`, { loan_id: loanId, effective_date: effective, status: "estimated", leg: "insurer_unearned", evaluation_id: basis.evaluation_id }, ctx.actor, ctx.now);
          return { ...actions, refund_id: refund.id, evaluation_id: basis.evaluation_id, cancel_basis: basis.kind };
        }
        case "ny_gate": {
          // 10.2 NY overlay (N.Y. Ins. Law §6503(d); 10.2-Q2): at ≤ 75% of the original appraised value the borrower stops paying; the servicer carries the premium until 10.1 terminates.
          need(i, "loan_id", "upb_cents", "original_appraised_value_cents"); const loanId = str(i, "loan_id"); const snapshotOn = str(i, "snapshot_date") || ctx.now.slice(0, 10);
          const r = nyPremiumGate({ state: str(i, "state") || "NY", upb_cents: cents(i.upb_cents), original_appraised_value_cents: cents(i.original_appraised_value_cents), history_ok: i.history_ok === true, ...(i.fnma_eligible !== undefined ? { fnma_eligible: i.fnma_eligible === true } : {}) });
          if (!r.gate_open) return r;
          if (r.premium_borne_by === "servicer_corporate") {
            ctx.events.append({ type: "mi.premium.borne_by_servicer", loanId, actor: ctx.actor, payload: { ltv_bps: r.ltv_bps, snapshot_date: snapshotOn, premium_borne_by: r.premium_borne_by, reevaluate: r.reevaluate } });
            ctx.events.append({ type: "mi.ny_premium_gate.resolved", loanId, actor: ctx.actor, payload: { outcome: "premium_borne_by_servicer", snapshot_date: snapshotOn } });
            const esc = rt.escalations.open({ kind: "officer", loanId, payload: { record: "corporate premium carry", rule: "N.Y. Ins. Law §6503(d)", ltv_bps: r.ltv_bps, reevaluate: r.reevaluate } }, ctx.actor);
            return { ...r, escalation_id: esc.id };
          }
          return { ...r, next: "10.1 evaluation → pmi.* cancel (terminates; the gate resolves on `mi.coverage.ended`)" };
        }
        default: throw new RangeError(`pmi op ${String(i.op)} is not one of list/get/request/written_confirmation/evaluate/value_check/set_original_value/cancel/ny_gate`);
      } }),
    guardrails: [never("ORIGINAL_VALUE_NEEDS_EVIDENCE", "10.1 guardrail: cannot alter `original_value` without an evidence-backed `mi.data.corrected` event", (i) => i.op === "set_original_value" && !setOriginalValueAllowed((i.evidence_document_id as string | undefined) ?? null), "attach the evidence document"),
      never("HISTORY_NEEDS_EVIDENCE", "10.1 guardrail: payment-history counts and SMDU inputs change only with an evidence-backed `mi.data.corrected` event", (i) => overrides(i).length > 0 && !i.evidence_document_id, "overrides need evidence and void liability relief"),
      never("ONLY_TABULATED_FEE", "10.1 guardrail: cannot charge any fee other than the tabulated valuation fee", (i) => i.fee_cents !== undefined && !TABULATED_FEES.has(cents(i.fee_cents)), "fees are $190 BPO / $450 restricted appraisal / $750 2–4 unit appraisal"),
      never("REASONS_FROM_RULE_SET", "10.1 guardrail: cannot deny for reasons outside the rule set", (i) => Array.isArray(i.reasons) && (i.reasons as unknown[]).some((r) => !DENIAL_REASONS.has(String(r))), "reason codes come from mi_denial_reasons"),
      never("NO_SOLICITATION", "B-8.1-04: the servicer must not solicit a current-value termination", (i) => flag(i, "solicit_current_value"), "we evaluate a current-value request only when the borrower asks"),
      never("VALUATION_EXPIRED", "SMDU FAQ Q9 / FNMA_SMDU_VALUATION_VALID_120: a delivered valuation is valid 120 days; a later decision is refused pending a new order", (i) => i.op === "evaluate" && optCents(i.valuation_cents) !== null && valuationExpired(optDate(i, "valuation_delivered_on"), optDate(i, "decision_on")), "order a new valuation (the borrower re-pays the fee) before deciding"),
      guard("CANCEL_NEEDS_ELIGIBLE_EVALUATION", "10.1 state machine: only an `eligible` evaluation on the loan's record (`mi_evaluations` / `mi.evaluation.completed`) reaches `cancellation_issued`; the agent cannot cancel on a caller-supplied evaluation or date", (i, ctx) => i.op === "cancel" && cancelBasisOnRecord(i, ctx.events.byLoan((i.loan_id as string | undefined) ?? ctx.loanId ?? "")) === null ? "run pmi.* evaluate first and pass its evaluation_id (result `eligible`), or a 10.6 human-review reversal must be on record" : undefined)] },
  { name: "smdu.*", kind: "act", handler: compute(async (i, ctx, rt) => {
      switch (i.op) {
        // 10.1 integrations: SMDU 5xx/timeouts → retry with backoff for 4 hours, then `human_portal_task` at case day 15+ with the prepared data set; the HPA clock never moves (10.1-T8).
        case "evaluate": { need(i, "fnma_loan_number"); return smduEvaluate({ loan_id: (i.loan_id as string | undefined) ?? ctx.loanId ?? "", fnma_loan_number: str(i, "fnma_loan_number"), request_type: (str(i, "request_type") || "original_value") as "original_value" | "current_value" | "current_value_improvements", data_set: rec(i.data_set), overrides: overrides(i), received_on: optDate(i, "received_on"), case_id: (i.case_id as string | undefined) ?? null }, { smdu: port(rt, "smdu"), events: ctx.events, store: rt.store, escalations: rt.escalations, actor: ctx.actor, now: ctx.now }); }
        case "valuation.order": { need(i, "loan_id", "kind"); ctx.events.append({ type: "mi.valuation.ordered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { kind: str(i, "kind"), fee_cents: cents(i.fee_cents), ordered_on: ctx.now.slice(0, 10) } }); return { ordered: true, kind: str(i, "kind"), turnaround_days: 14, ordered_on: ctx.now.slice(0, 10) }; }
        case "valuation.delivered": { need(i, "loan_id"); const on = date(i, "delivered_on"); const w = valuationDenialWindows(on);   // appeal 60 days (FNMA_SMDU_VALUATION_APPEAL_60), validity 120 (FNMA_SMDU_VALUATION_VALID_120)
          const ev = ctx.events.append({ type: "mi.valuation.delivered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { delivered_at: on, kind: str(i, "kind") || "bpo_int_ext", value_cents: optCents(i.value_cents), valid_until: w.valid_until, appeal_by: w.appeal_by, request_received_on: str(i, "received_on") || null } });
          if (flag(i, "borrower_paid")) reanchorDecisionClock(ctx, str(i, "loan_id"), ev, on);   // a borrower-paid valuation is evidence (4904(b)(2)(ii)); the servicer's own AVM never re-anchors (10.6 R1)
          return { delivered_on: on, value_cents: optCents(i.value_cents), valid_until: w.valid_until, appeal_by: w.appeal_by }; }
        default: throw new RangeError(`smdu op ${String(i.op)} is not one of evaluate/valuation.order/valuation.delivered`);
      } }),
    guardrails: [never("ONLY_TABULATED_FEE", "10.1 guardrail: cannot charge any fee other than the tabulated valuation fee (F-1-02: BPO $190; restricted appraisal $450; 2–4 unit appraisal $750)", (i) => i.op === "valuation.order" && !feeIsTabulated(cents(i.fee_cents), str(i, "kind") || null), "the order carries the tabulated fee for its kind"),
      { code: "FNMA_F102_VALUATION_FEE_GATE", citation: "F-1-02: order the valuation only after the borrower's fee is received", refuse: (i, ctx) => {
        if (i.op !== "valuation.order") return undefined;
        const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
        const gate = ctx.timers.byCode("FNMA_F102_VALUATION_FEE_GATE").filter((t) => t.loanId === loanId);
        if (gate.length) return gate.some((t) => t.status === "satisfied" || t.status === "satisfied_late") ? undefined : "the fee must be posted first (FNMA_F102_VALUATION_FEE_GATE is open)";
        return flag(i, "fee_received") ? undefined : "the fee must be posted first";
      } }] },
  miInsurerCancel,
  { name: "notices.render/send", kind: "act", handler: noticeOps("render_send"), guardrails: [AVM_DISCLAIMER, DENIAL_NEEDS_EVALUATION] },
  interimAnalysis, ledger, investorEmit,
  { name: "case.*", kind: "write", handler: readWrite("cases", "case.written") },
  { name: "contacts.log", kind: "write", handler: log("contacts", "contact.logged") },
  documentsStore,
]);

// ---- 10.2 --------------------------------------------------------------------
const p102 = defineTools("10.2", A, [
  { name: "pmi.schedule.rebuild", kind: "write", handler: compute((i, ctx, rt) => { { const own = scheduleRebuildOps_10_2(i, ctx, rt); if (own !== undefined) return own; } need(i, "loan_id", "original_value_cents"); const ov = cents(i.original_value_cents);
      const v = i.prior_version !== undefined && i.change_n !== undefined ? armResetVersion(scheduleFrom(i.prior_version as ToolInput), num(i, "change_n"), ratePercent(str(i, "new_rate_pct")), num(i, "remaining_term")) : scheduleFrom(i);
      const d78 = scheduledDateForPct(v, ov, 78), d80 = scheduledDateForPct(v, ov, 80); const mp = midpoint(v.rows[0]!.due_date, v.rows.length);
      const applies = i.applicability ? rule78Applies(i.applicability as { consummation: PlainDate; units: number; occupancy_at_origination: "principal" | "second_home" | "investment" }) : i.rule_78_applies !== false;
      const plan = str(i, "premium_plan") || "bpmi_monthly";
      const recd = rt.store.put("mi_schedules", `${str(i, "loan_id")}-${v.kind}-${ctx.now}`, { loan_id: str(i, "loan_id"), basis: v.kind, derived_78_date: d78?.due_date ?? null, derived_80_date: d80?.due_date ?? null, derived_midpoint_date: mp.midpoint_termination_date, rows: v.rows.length }, ctx.actor, ctx.now);
      // Payload names the registry anchors: `scheduled_78_date` (HPA_4902B_AUTO_TERMINATE_0), `midpoint_termination_date` (HPA_4902C_MIDPOINT_TERMINATE_0, SM_MI_MIDPOINT_PREVIEW_90); `rule_78_applies`/`bpmi` narrow which clocks arm (10.2 R1; 4905(b)).
      ctx.events.append({ type: "mi.schedule.updated", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { schedule_id: recd.id, basis: v.kind, derived_78_date: d78?.due_date ?? null, scheduled_78_date: d78?.due_date ?? null, scheduled_80_date: d80?.due_date ?? null, midpoint_termination_date: mp.midpoint_termination_date, rule_78_applies: applies, bpmi: BPMI_PLANS.has(plan), premium_plan: plan } });
      return { schedule_id: recd.id, basis: v.kind, pi_cents: v.pi_cents, derived_78_date: d78?.due_date ?? null, derived_80_date: d80?.due_date ?? null, derived_midpoint_date: mp.midpoint_termination_date, rule_78_applies: applies }; }),
    guardrails: [never("NO_MANUAL_ROWS", "10.2 guardrail: cannot edit schedule rows manually", (i) => Array.isArray(i.rows), "schedules are built from terms only"),
      needsRole("VARIANCE_OVER_5_CENTS_TO_OFFICER", "10.2 guardrail: rebuild variances > $0.05 go to the officer with both schedules", (i) => { const v = cents(i.variance_cents); return (v > 5n || v < -5n) && flag(i, "activate"); }, ["officer"], "a version whose rebuilt row differs from the servicing system's by more than $0.05 is held for the officer (scheduleRebuildOps_10_2 opens the item with both schedules attached); only the officer activates it")] },
  { name: "pmi.terminate", kind: "act", handler: compute((i, ctx, rt) => { { const own = pmiTerminateOps_10_3(i, ctx, rt); if (own !== undefined) return own; } { const own = pmiTerminateOps_10_2(i, ctx, rt); if (own !== undefined) return own; } need(i, "loan_id", "scheduled_date"); const loanId = str(i, "loan_id"); const scheduled = date(i, "scheduled_date"); const kind = (str(i, "kind") || "automatic_78") as "automatic_78" | "automatic_midpoint";
      if (str(i, "premium_plan") === "lpmi") {
        // 12 U.S.C. 4905(c)(2): LPMI never cancels — the BPMI-equivalent date reached → options notice within 30 days; no refund, no LAR 89.
        ctx.events.append({ type: "mi.lpmi_equivalent_termination_date.reached", loanId, actor: ctx.actor, payload: { equivalent_termination_on: scheduled, notice: "NTC_HPA_4905C2_LPMI_OPTIONS", due: lpmiOptionsNoticeDue(scheduled) } });
        return { lpmi: true, cancellation: false, notice: "NTC_HPA_4905C2_LPMI_OPTIONS", due: lpmiOptionsNoticeDue(scheduled), lar89: null, refund: null };
      }
      const applies = i.applicability ? rule78Applies(i.applicability as { consummation: PlainDate; units: number; occupancy_at_origination: "principal" | "second_home" | "investment" }) : i.applies !== false;
      const r = sweepTermination({ loan_id: loanId, installments: Array.isArray(i.installments) ? (i.installments as AppliedInstallment[]) : [], scheduled_date: scheduled, applies, kind });
      const trigger = kind === "automatic_midpoint" ? "midpoint" : "scheduled_78";
      reviewHooks_10_2(ctx, rt, loanId, r, scheduled, Array.isArray(i.installments) ? (i.installments as AppliedInstallment[]) : [], kind);   // 10.2: cure → `loan.became_current` (HPA_4902B2_CURE_TERMINATE_1ST) before the termination is evented; `mi_terminations` row
      if (r.actions) { emitCoverageEnded(ctx, loanId, r.actions, kind, i); rt.store.put("mi_policies", loanId, { status: "terminated", auto_status: "terminated", terminated_on: r.actions.effective, lar89_action_code: r.actions.lar89.code, termination_type: kind }, ctx.actor, ctx.now);
        rt.store.put("mi_refunds", `refund-${loanId}-${r.actions.effective}`, { loan_id: loanId, effective_date: r.actions.effective, status: "estimated", leg: "insurer_unearned" }, ctx.actor, ctx.now); }
      else if (r.result.status === "deferred_not_current" && rt.store.get("mi_policies", loanId)?.data.auto_status !== "deferred_not_current") {   // state machine: `pending` → `deferred_not_current` once; a later review of a still-delinquent loan re-events nothing and never re-arms the 30-day notice clock (10.2-T3)
        ctx.events.append({ type: "mi.auto.deferred_not_current", loanId, actor: ctx.actor, payload: { grounds: r.result.grounds, scheduled_date: scheduled, notice: r.not_current_notice?.code ?? null, send_by: r.not_current_notice?.send_by ?? null, grounds_text: r.not_current_notice?.grounds_text ?? null } });
        ctx.events.append({ type: "mi.auto_termination.resolved", loanId, actor: ctx.actor, payload: { trigger, outcome: "deferred_not_current", scheduled_date: scheduled } });
        rt.store.put("mi_policies", loanId, { auto_status: "deferred_not_current", auto_deferred_since: scheduled }, ctx.actor, ctx.now);
      } else if (r.result.status === "not_applicable_midpoint_only") rt.store.put("mi_policies", loanId, { auto_status: "not_applicable_midpoint_only" }, ctx.actor, ctx.now);
      return r; }),
    guardrails: [never("REASON_WHITELIST", "10.2 guardrail: cannot delay a termination for value, seasoning or fee reasons", (i) => typeof i.defer_reason === "string" && !DEFER_WHITELIST.has(i.defer_reason), "deferral reasons are NOT_CURRENT / MIDPOINT_ONLY_PROPERTY / ORIGINAL_VALUE_MISSING / POLICY_NOT_ACTIVE"),
      never("NO_FEE_NO_VALUATION", "CFPB 2015-03: automatic termination never requires a valuation, a request or a fee", (i) => flag(i, "require_valuation") || cents(i.fee_cents) > 0n, "no fee, no valuation")] },
  noticesAll, interimAnalysis, investorEmit, miInsurerCancel, ledger,
]);

// ---- 10.4 --------------------------------------------------------------------
const p104 = defineTools("10.4", A, [
  { name: "notices.compose/send", kind: "act", handler: compute((i, ctx, rt) => disclosureComposeSendOps_10_4(i, ctx, rt)),
    guardrails: [never("CHECKLIST_BLOCKS_RELEASE", "10.4 guardrail: a failed checklist blocks release", (i) => flag(i, "checklist_failed"), "fix the merge data first"), never("NO_TEMPLATE_EDITS", "10.4 guardrail: no template edits at run time", (i) => typeof i.template_source === "string", "templates change only through the registry"), never("NEVER_SKIPPED", "10.4 guardrail: a loan lacking a schedule or original value gets the disclosure with 'contact us' text, never skipped", (i) => flag(i, "skip_disclosure"), "send with the contact-us text and log the exception")] },
  { name: "pmi.projection", kind: "read", handler: compute((i) => { need(i, "original_value_cents"); const v = scheduleFrom(i); const ov = cents(i.original_value_cents); const mp = midpoint(v.rows[0]!.due_date, v.rows.length);
      return { projected_80_date: scheduledDateForPct(v, ov, 80)?.due_date ?? null, projected_78_date: scheduledDateForPct(v, ov, 78)?.due_date ?? null, projected_midpoint_date: mp.midpoint_termination_date, pi_cents: v.pi_cents }; }) },
  { name: "consents.check", kind: "read", handler: compute((i) => disclosureChannelAt({ consent: (i.consent as { class: string; given_on: PlainDate; revoked_on: PlainDate | null } | null | undefined) ?? null, send_on: date(i, "send_on") })) },
  documentsStore,
]);

// ---- 10.5 --------------------------------------------------------------------
const refundPlan = (i: ToolInput): RefundPlan => { need(i, "plan", "premium_cents"); const k = str(i, "plan"); if (k === "monthly") return { kind: "monthly", premium_cents: cents(i.premium_cents), coverage_month_start: date(i, "coverage_month_start") }; if (k === "annual") return { kind: "annual", premium_cents: cents(i.premium_cents), anniversary_start: date(i, "anniversary_start") }; if (k === "single") return { kind: "single", premium_cents: cents(i.premium_cents), refund_pct: str(i, "refund_pct") || "0" }; throw new RangeError(`plan ${k} is not monthly/annual/single`); };
/** LL-2026-05: from Dec. 1, 2026 each refund deposit/disbursement is an escrow event due 03:00 ET the next Fannie business day (LL_2026_05_ESCROW_EVENT_3AM). */
function emitRefundPosted(ctx: CommandContext, loanId: string, leg: "deposit" | "disbursement", amount: bigint, postedOn: PlainDate, extra: Record<string, unknown> = {}): void {
  const ev = refundEscrowEvents({ posted_on: postedOn, legs: [{ kind: leg, amount_cents: amount }] });
  ctx.events.append({ type: "mi.refund.posted", loanId, actor: ctx.actor, payload: { leg, amount_cents: amount, posted_on: postedOn, escrow_event: ev.events.length > 0, accept_by_ms: ev.accept_by_ms, ...extra } });
}
const p105 = defineTools("10.5", A, [
  { name: "pmi.refund.estimate", kind: "write", handler: compute((i, ctx, rt) => { const e = date(i, "effective_on"); const est = unearnedEstimate(refundPlan(i), e); const ins = optCents(i.insurer_amount_cents); const recon = ins === null ? null : reconcileInsurerRefund(est, ins, flag(i, "unresolved_at_day_40"));
      // 10.5 inputs: `mi.terminated`/`mi.cancelled` → open `mi_refunds` with an estimate (append-only row per leg).
      if (i.loan_id) { const id = str(i, "refund_id") || `refund-${str(i, "loan_id")}-${e}`; const prior = rt.store.get("mi_refunds", id)?.data ?? {};
        rt.store.put("mi_refunds", id, { ...prior, loan_id: str(i, "loan_id"), effective_date: e, leg: str(i, "leg") || "insurer_unearned", estimate_cents: est, method: str(i, "plan") === "annual" ? "days_365" : str(i, "plan") === "monthly" ? "days_30" : "single_schedule", certificate: str(i, "certificate") || prior.certificate || null, status: prior.status === "received" || prior.status === "paid" ? prior.status : "awaiting_insurer", ...(recon ? { insurer_amount_cents: ins, variance_cents: recon.variance_cents } : {}) }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.refund.estimated", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { refund_id: id, estimate_cents: est, effective_on: e } });
        return { refund_id: id, estimate_cents: est, ...(recon ?? {}) }; }
      return { estimate_cents: est, ...(recon ?? {}) }; }) },
  { ...ledger, handler: (i, ctx, rt) => (i.op === "escrow_event" || i.op === "escrow_event_ack" ? escrowEventOp_10_5(i, ctx, rt) : ledger.handler(i, ctx, rt)) },   // 10.5 LL-2026-05 escrow-event leg (section10-5.ts)
  { name: "disbursements.issue", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => { need(i, "loan_id", "amount_cents", "rail"); const loanId = str(i, "loan_id"); const rail = str(i, "rail"); const payee = str(i, "payee") || "borrower"; const amount = cents(i.amount_cents); const on = optDate(i, "issued_on") ?? D(ctx.now.slice(0, 10));
      refuseLpmiBorrowerPayee(ctx, rt, { loan_id: loanId, plan: str(i, "plan"), payee, subject_id: (i.refund_id as string | undefined) ?? null });   // 10.5 guardrail on the policy of record (`mi_policies.premium_plan`), not only a volunteered `plan`
      // 10.5-T8 / failure handling: a returned ACH (R01–R04) → check within 5 BD; the reissue is recorded against the original.
      if (i.return_code) { need(i, "reissue_of", "returned_on"); ctx.events.append({ type: "disbursement.returned", loanId, actor: ctx.actor, payload: { disbursement_id: str(i, "reissue_of"), return_code: str(i, "return_code"), returned_on: date(i, "returned_on"), check_due_by: returnedAchCheckDue(date(i, "returned_on")) } }); }
      const id = str(i, "disbursement_id") || `disb-${loanId}-${rt.store.list("disbursements").length + 1}`;
      // Completion = the credit date for ACH (`status: credited`) or the mailing date for a check (`status: mailed`, `mailed_on`); a submitted item is not yet a refund paid.
      const status = str(i, "status") || (rail === "check" ? (i.mailed_on ? "mailed" : "submitted") : "submitted"); const completedOn = rail === "check" ? optDate(i, "mailed_on") : (status === "credited" ? (optDate(i, "credited_on") ?? on) : null);
      rt.store.put("disbursements", id, { loan_id: loanId, amount_cents: amount, rail, payee, status, corporate_advance: flag(i, "corporate_advance"), issued_on: on, completed_on: completedOn, refund_id: (i.refund_id as string | undefined) ?? null, reissue_of: (i.reissue_of as string | undefined) ?? null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "disbursement.issued", loanId, actor: ctx.actor, payload: { disbursement_id: id, amount_cents: amount, rail, payee, status, corporate_advance: flag(i, "corporate_advance"), issued_on: on, completed_on: completedOn } });
      const completed = completedOn !== null && (status === "credited" || status === "mailed");
      if (completed && payee === "borrower") {
        ctx.events.append({ type: "mi.refund.paid", loanId, actor: ctx.actor, payload: { disbursement_id: id, amount_cents: amount, rail, payee, paid_on: completedOn, corporate_advance: flag(i, "corporate_advance"), refund_id: (i.refund_id as string | undefined) ?? null } });
        emitRefundPosted(ctx, loanId, "disbursement", amount, completedOn!, { disbursement_id: id });
        if (i.refund_id) { const prior = rt.store.get("mi_refunds", str(i, "refund_id"))?.data ?? {}; rt.store.put("mi_refunds", str(i, "refund_id"), { ...prior, status: flag(i, "corporate_advance") ? "advanced_paid" : "paid", paid_at: completedOn, pay_channel: rail === "check" ? "check" : "ach_credit" }, ctx.actor, ctx.now); }
      }
      return { disbursement_id: id, issued: true, rail, status, completed, refund_paid_on: completed ? completedOn : null, satisfies_45_day_timer_on: rail === "check" ? "mailing date" : "credit date" }; }),
    guardrails: [never("NO_OFFSET_WITHOUT_ELECTION", "10.5 guardrail: cannot credit a refund to escrow/principal/fees without a post-E borrower election document", (i) => !refundApplicationAllowed((str(i, "target") || "borrower") as "borrower" | "late_charges" | "principal" | "escrow", optDate(i, "election_signed_on"), optDate(i, "effective_on") ?? D("2000-01-01")), "the refund is returned to the mortgagor"),
      never("NO_WITHHOLD_FOR_DELINQUENCY", "10.5 guardrail: cannot withhold a refund for delinquency", (i) => flag(i, "withhold_for_delinquency"), "delinquency never holds a refund"),
      needsRole("ADVANCE_OVER_5000_OFFICER", "10.5 guardrail: corporate advances above $5,000 need the officer", (i) => flag(i, "corporate_advance") && cents(i.amount_cents) > 500000n, ["officer"], "advance package: computation, insurer correspondence, timer status"),
      never("LPMI_NEVER_TO_BORROWER", "10.5 guardrail: LPMI refunds never go to the borrower (B-8.1-02)", (i) => str(i, "plan") === "lpmi" && (str(i, "payee") || "borrower") === "borrower", "LPMI refunds are corporate receipts")] },
  { name: "custodial.match", kind: "act", handler: compute((i, ctx, rt) => { need(i, "amount_cents"); const amt = cents(i.amount_cents); const receivedOn = optDate(i, "received_on") ?? D(ctx.now.slice(0, 10));
      // Section 6.4 match keys: insurer originator/certificate reference + amount; a credit identified by certificate or refund id matches with a variance, an unidentified amount goes to 6.5.
      const open = rt.store.list("mi_refunds", (d) => ["awaiting_insurer", "estimated", "advanced_paid"].includes(String(d.status)) && (!i.certificate || d.certificate === i.certificate) && (i.refund_id === undefined || d.id === i.refund_id));
      const exact = open.filter((r) => cents(r.data.estimate_cents) === amt).map((r) => r.id);
      const matched = exact.length ? exact : (i.refund_id !== undefined || i.certificate ? open.map((r) => r.id) : []);
      if (!matched.length) return { matched: false, route: "6.5 unidentified funds (5 BD research)" };
      // Section 6.4 match → `mi.insurer.refund_received` (HPA_4902F2_INSURER_REFUND_30; variance > $1.00 opens SM_MI_REFUND_VARIANCE_5BD) and the LL-2026-05 deposit event; a receipt after a day-40 advance is the recovery (R4).
      for (const id of matched) { const row = rt.store.get("mi_refunds", id)!.data; const estimate = cents(row.estimate_cents); const recon = reconcileInsurerRefund(estimate, amt, false); const loanId = String(row.loan_id);
        rt.store.put("mi_refunds", id, { ...row, status: row.status === "advanced_paid" ? "closed" : recon.status === "disputed" ? "disputed" : "received", insurer_amount_cents: amt, insurer_received_at: receivedOn, variance_cents: recon.variance_cents, ...(row.status === "advanced_paid" ? { recovered_at: receivedOn, reverse_advance: true } : {}) }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.insurer.refund_received", loanId, actor: ctx.actor, payload: { refund_id: id, amount_cents: amt, estimate_cents: estimate, variance_cents: recon.variance_cents, variance_exceeds_tolerance: recon.status === "disputed", received_at: receivedOn, received_on: receivedOn, pay_borrower_cents: recon.pay_borrower_cents } });
        emitRefundPosted(ctx, loanId, "deposit", amt, receivedOn, { refund_id: id, account: "custodial_ti_cash" }); }
      return { matched: true, refund_ids: matched, received_on: receivedOn }; }) },
  { name: "mi_insurer.refund_status", kind: "act", handler: compute(async (i, ctx, rt) => {
      if (i.op === "resolve_variance") { need(i, "loan_id", "refund_id", "resolution"); const prior = rt.store.get("mi_refunds", str(i, "refund_id"))?.data ?? {}; rt.store.put("mi_refunds", str(i, "refund_id"), { ...prior, status: "received", variance_resolution: str(i, "resolution") }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.refund.variance_resolved", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { refund_id: str(i, "refund_id"), resolution: str(i, "resolution"), corporate_expense_cents: optCents(i.corporate_expense_cents) } }); return { resolved: true, resolution: str(i, "resolution") }; }
      need(i, "since"); return { refunds: await port(rt, "mi").refunds(str(i, "since")) }; }) },
  interimAnalysis, noticesAll,
]);

// ---- 10.6 --------------------------------------------------------------------
const PARTIAL_GRANT = /partial(ly)? (grant|approv)|approved in part|conditionally approved|grant(ed)? in part/i;
const p106 = defineTools("10.6", A, [
  { name: "notices.*", kind: "act", handler: noticeOps("render_send"),
    guardrails: [DENIAL_NEEDS_EVALUATION, AVM_DISCLAIMER, RECOMPOSE_AFTER_NUMBER_CHANGE,
      never("DUE_DATE_FROM_TIMER_ENGINE", "10.6 guardrail: the due date is computed by the Timer Engine, not the agent", (i) => { const p = rec(i.payload); return ["due_on", "due_date", "deadline", "timer_due"].some((k) => i[k] !== undefined || p[k] !== undefined); }, "drop the due date from the command; HPA_4904B_DENIAL_NOTICE_30 / FNMA_B8104_DENIAL_NOTICE_30 carry it"),
      never("NO_PARTIAL_GRANT", "10.6 guardrail: the agent cannot \"soften\" a denial into a partial grant", (i) => { const p = rec(i.payload); return str(i, "template_code") === "NTC_HPA_4904B_DENIAL" && (p.partial_grant !== undefined || p.grant_effective_on !== undefined || [p.grounds_text, p.cure_text, p.valuation_text].some((t) => typeof t === "string" && PARTIAL_GRANT.test(t))); }, "a denial states the grounds and the cure; a grant goes through pmi.* cancel (10.1)")] },
  { name: "pmi.evaluation.get", kind: "read", handler: read("mi_evaluations") },
  // R4: the NoE from a denial dispute opens with the §4.1 `case.noe.opened` record (ack_required / receipt_date / std_assertion) so REGX_1024_35D_NOE_ACK_5 arms; the PMI case is linked (src/domain/pmi/ops-10-6.ts).
  { name: "case.noe.open", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "received_on", "pmi_case_id", "assertion"); return caseNoeOpen_10_6(i, ctx, rt); }) },
  { name: "smdu.valuation.appeal", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "valuation_id"); ctx.events.append({ type: "mi.valuation.appealed", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { valuation_id: str(i, "valuation_id") } }); return { appealed: true, extends_validity: false }; }),
    guardrails: [never("APPEAL_ONLY_WHEN_UNSUPPORTIVE", "SMDU FAQ Q20: appeals only when the valuation did not support termination", (i) => flag(i, "valuation_supported_termination"), "nothing to appeal"), never("AVM_NOT_APPEALABLE", "SMDU FAQ Q19: AVM values may not be appealed", (i) => str(i, "valuation_kind") === "avm", "the borrower may pay for a BPO or appraisal instead")] },
  // R4 / T8: with `human_review_id` the delivered document is the reviewer's outcome letter — its delivery closes the review (`mi.human_review.completed`, src/domain/pmi/ops-10-6.ts).
  { name: "documents.deliver", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "document_id"); return documentsDeliver_10_6(i, ctx, rt); }) },
]);

export const SECTION_10_TOOLS: readonly ToolDef[] = [...p101, ...p102, ...p104, ...p105, ...p106];
export const escalateOfficer = escalate("officer");
export const automaticTerminationTool = automaticTermination;
