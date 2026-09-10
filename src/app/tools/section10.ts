/**
 * §10 tools — PMI administration (10.1–10.6). Tool strings are verbatim from
 * each process's Agents paragraph; guardrails encode the "cannot"/"never"
 * sentences and the human touchpoints. Agent: `pmi` throughout (10.3 names
 * no tools of its own — the sweep is a deterministic job).
 */
import { defineTools, escalate, compute, never, needsRole, noticeOps, ledgerPost, port, read, write, readWrite, log, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import type { AppliedInstallment } from "../../domain/boarding/delinquency.ts";
import { evaluateCancellation, setOriginalValueAllowed, smduLiabilityRelief, valueCheck, valuationValidUntil, type CancellationRequest, type PropertyClass } from "../../domain/pmi/cancellation.ts";
import { buildSchedule, armResetVersion, scheduledDateForPct, midpoint, type ScheduleVersion } from "../../domain/pmi/schedule.ts";
import { automaticTermination, rule78Applies } from "../../domain/pmi/termination.ts";
import { unearnedEstimate, refundApplicationAllowed, reconcileInsurerRefund, type RefundPlan } from "../../domain/pmi/refund.ts";
import { denialSendAllowed, noeAckDue } from "../../domain/pmi/denial.ts";
import { sweepTermination, disclosureChannelAt, escrowMiLineRelease } from "../../domain/pmi/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const A = "pmi";
const TABULATED_FEES = new Set([19000n, 45000n, 75000n]);
const DENIAL_REASONS = new Set(["LTV_ABOVE_THRESHOLD", "LTV_ABOVE_THRESHOLD_ORIGINAL", "LTV_ABOVE_THRESHOLD_CURRENT", "NOT_CURRENT", "PAYMENT_HISTORY_30_12M", "PAYMENT_HISTORY_60_24M", "VALUE_DECLINED_BELOW_ORIGINAL", "SEASONING_LT_24M", "SEASONING_LT_60M_LTV_GT_75", "SEASONING_INSUFFICIENT", "IMPROVEMENTS_NOT_SUBSTANTIATED", "PROPERTY_TYPE_70_RULE", "ASSUMPTION_HISTORY_LT_24M", "EVIDENCE_NOT_RECEIVED", "SUBORDINATE_LIEN_CERT_MISSING", "MI_NOT_BORROWER_PAID", "MI_NOT_ACTIVE", "REQUEST_NOT_FROM_AUTHORIZED_PARTY"]);
const DEFER_WHITELIST = new Set(["NOT_CURRENT", "MIDPOINT_ONLY_PROPERTY", "ORIGINAL_VALUE_MISSING", "POLICY_NOT_ACTIVE"]);

function cancellationRequest(i: ToolInput): CancellationRequest {
  need(i, "received_on", "decision_on", "original_value_cents", "evaluation_upb_cents", "consummation");
  return {
    received_on: date(i, "received_on"), decision_on: date(i, "decision_on"), evidence_satisfied_on: optDate(i, "evidence_satisfied_on"),
    path: (str(i, "path") || "original_value") as "original_value" | "current_value", property_class: (str(i, "property_class") || "1u_principal_or_second") as PropertyClass, hpa_covered: i.hpa_covered !== false,
    original_value_cents: cents(i.original_value_cents), valuation_cents: i.valuation_cents === undefined || i.valuation_cents === null ? null : cents(i.valuation_cents), valuation_delivered_on: optDate(i, "valuation_delivered_on"),
    evaluation_upb_cents: cents(i.evaluation_upb_cents), threshold_reached_on: optDate(i, "threshold_reached_on"), installments: Array.isArray(i.installments) ? (i.installments as AppliedInstallment[]) : [],
    avm_cents: i.avm_cents === undefined || i.avm_cents === null ? null : cents(i.avm_cents), consummation: date(i, "consummation"), improvements_accepted: flag(i, "improvements_accepted"),
  };
}
function scheduleFrom(i: ToolInput): ScheduleVersion {
  need(i, "upb_cents", "annual_rate_pct", "term_months", "first_due");
  return buildSchedule({ upb_cents: cents(i.upb_cents), annual_rate: ratePercent(str(i, "annual_rate_pct")), term_months: num(i, "term_months"), first_due: date(i, "first_due"), ...(i.io_months !== undefined ? { io_months: num(i, "io_months") } : {}), ...(i.forborne_principal_cents !== undefined ? { forborne_principal_cents: cents(i.forborne_principal_cents) } : {}) }, (str(i, "kind") || "initial") as "initial" | "arm_reset" | "modification");
}

// ---- shared definitions -------------------------------------------------------
const miInsurerCancel: Omit<ToolDef, "process" | "agent"> = { name: "mi_insurer.cancel", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "certificate", "effective_on"); const r = await port(rt, "mi").requestCancellation(str(i, "certificate"), (str(i, "reason") || "borrower_request") as "borrower_request" | "automatic_78" | "midpoint" | "investor", str(i, "effective_on"), ctx.now);
    ctx.events.append({ type: "mi.insurer.cancel_notified", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { certificate: str(i, "certificate"), effective_on: str(i, "effective_on"), refund_payee: str(i, "refund_payee") || "servicer" } }); return { ...r, refund_payee: str(i, "refund_payee") || "servicer" }; }),
  guardrails: [never("REFUND_PAYEE_SERVICER", "10.5 prerequisites: the cancellation notice names the servicer as refund payee for pass-through", (i) => str(i, "refund_payee") === "borrower", "the insurer refund routes through the T&I custodial account")] };
const interimAnalysis: Omit<ToolDef, "process" | "agent"> = { name: "escrow.interim_analysis.request", kind: "write", handler: compute((i, ctx) => { need(i, "loan_id", "effective_on"); const e = date(i, "effective_on"); const r = escrowMiLineRelease({ E: e, mi_line_balance_cents: cents(i.mi_line_balance_cents), monthly_mi_deposit_cents: cents(i.monthly_mi_deposit_cents), old_payment_cents: cents(i.old_payment_cents) });
    ctx.events.append({ type: "escrow.interim_analysis.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { mi_line_closed_as_of: e, due: r.interim_analysis_due, min_30_gate_bypassed: true } }); return r; }) };
const investorEmit: Omit<ToolDef, "process" | "agent"> = { name: "investor_events.emit", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "action_code", "action_date"); const code = str(i, "action_code"); if (!["51", "52", "53", "54"].includes(code)) throw new RangeError(`LAR 89 action code ${code} is not one of 51/52/53/54`);
    return ctx.events.append({ type: "investor_events.emitted", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { event_family: "mi", event_type: "mi_discontinuance", legacy_record: 89, action_code: code, action_date: str(i, "action_date") } }); }) };
const ledger: Omit<ToolDef, "process" | "agent"> = { name: "ledger.post", kind: "write", moneyFields: ["amount_cents"], handler: ledgerPost(),
  guardrails: [never("FEES_NEVER_FROM_ESCROW", "10.1 ledger: valuation fees are never paid from escrow or added to the loan (MN §47.207 subd. 5)", (i) => flag(i, "valuation_fee") && /escrow|loan_principal/.test(str(i, "funding_account")), "fees clear through corporate clearing")] };
const documentsStore: Omit<ToolDef, "process" | "agent"> = { name: "documents.store", kind: "write", handler: write("documents", "document.stored") };
const noticesAll: Omit<ToolDef, "process" | "agent"> = { name: "notices.*", kind: "act", handler: noticeOps("render_send"),
  guardrails: [never("DENIAL_NEEDS_EVALUATION", "10.6 guardrail: the denial cannot issue without a linked `mi_evaluations` row", (i) => str(i, "template_code") === "NTC_HPA_4904B_DENIAL" && !denialSendAllowed((i.evaluation_id as string | undefined) ?? null), "link the evaluation row first")] };

// ---- 10.1 --------------------------------------------------------------------
const p101 = defineTools("10.1", A, [
  { name: "pmi.*", kind: "write", handler: compute((i, ctx, rt) => {
      switch (i.op ?? "list") {
        case "list": return rt.store.list("mi_policies").map((r) => r.data);
        case "get": return rt.store.get("mi_policies", str(i, "id"))?.data ?? null;
        case "evaluate": { const d = evaluateCancellation(cancellationRequest(i)); ctx.events.append({ type: "mi.evaluation.completed", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { result: d.result, reasons: d.reasons, ltv_bps: d.ltv_bps, liability_relief: smduLiabilityRelief(Array.isArray(i.overrides) ? (i.overrides as string[]) : []) } }); return d; }
        case "value_check": { need(i, "original_value_cents"); return valueCheck(i.avm_cents === undefined || i.avm_cents === null ? null : cents(i.avm_cents), cents(i.original_value_cents), num(i, "units") || 1); }
        case "set_original_value": { need(i, "loan_id", "original_value_cents", "evidence_document_id"); const rec = rt.store.put("mi_policies", str(i, "loan_id"), { original_value_cents: cents(i.original_value_cents), original_value_evidence: str(i, "evidence_document_id") }, ctx.actor, ctx.now); ctx.events.append({ type: "mi.original_value.corrected", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { evidence_document_id: str(i, "evidence_document_id") } }); return rec.data; }
        case "cancel": { need(i, "loan_id", "effective_on"); ctx.events.append({ type: "mi.cancelled", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { effective_on: str(i, "effective_on"), lar89_action_code: str(i, "lar89_action_code") || "51" } }); return { event: "mi.cancelled", effective_on: str(i, "effective_on") }; }
        default: throw new RangeError(`pmi op ${String(i.op)} is not one of list/get/evaluate/value_check/set_original_value/cancel`);
      } }),
    guardrails: [never("ORIGINAL_VALUE_NEEDS_EVIDENCE", "10.1 guardrail: cannot alter `original_value` without an evidence-backed `mi.data.corrected` event", (i) => i.op === "set_original_value" && !setOriginalValueAllowed((i.evidence_document_id as string | undefined) ?? null), "attach the evidence document"),
      never("HISTORY_NEEDS_EVIDENCE", "10.1 guardrail: payment-history counts and SMDU inputs change only with an evidence-backed `mi.data.corrected` event", (i) => Array.isArray(i.overrides) && (i.overrides as unknown[]).length > 0 && !i.evidence_document_id, "overrides need evidence and void liability relief"),
      never("ONLY_TABULATED_FEE", "10.1 guardrail: cannot charge any fee other than the tabulated valuation fee", (i) => i.fee_cents !== undefined && !TABULATED_FEES.has(cents(i.fee_cents)), "fees are $190 BPO / $450 restricted appraisal / $750 2–4 unit appraisal"),
      never("REASONS_FROM_RULE_SET", "10.1 guardrail: cannot deny for reasons outside the rule set", (i) => Array.isArray(i.reasons) && (i.reasons as unknown[]).some((r) => !DENIAL_REASONS.has(String(r))), "reason codes come from mi_denial_reasons"),
      never("NO_SOLICITATION", "B-8.1-04: the servicer must not solicit a current-value termination", (i) => flag(i, "solicit_current_value"), "we evaluate a current-value request only when the borrower asks")] },
  { name: "smdu.*", kind: "act", handler: compute(async (i, ctx, rt) => {
      switch (i.op) {
        case "evaluate": { need(i, "fnma_loan_number"); const c = await port(rt, "smdu").createCase(str(i, "fnma_loan_number"), "mi_termination", { request_type: str(i, "request_type") || "original_value", ...((i.data_set as Record<string, unknown> | undefined) ?? {}) }); const d = await port(rt, "smdu").decision(c.caseId); ctx.events.append({ type: "mi.smdu.evaluated", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { smdu_evaluation_id: c.caseId } }); return { smdu_evaluation_id: c.caseId, decision: d }; }
        case "valuation.order": { need(i, "loan_id", "kind"); ctx.events.append({ type: "mi.valuation.ordered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { kind: str(i, "kind"), fee_cents: cents(i.fee_cents) } }); return { ordered: true, kind: str(i, "kind"), turnaround_days: 14 }; }
        case "valuation.delivered": { const on = date(i, "delivered_on"); return { valid_until: valuationValidUntil(on), appeal_by: valuationValidUntil(on) }; }
        default: throw new RangeError(`smdu op ${String(i.op)} is not one of evaluate/valuation.order/valuation.delivered`);
      } }),
    guardrails: [never("FNMA_F102_VALUATION_FEE_GATE", "F-1-02: order the valuation only after the borrower's fee is received", (i) => i.op === "valuation.order" && !flag(i, "fee_received"), "the fee must be posted first")] },
  miInsurerCancel,
  { name: "notices.render/send", kind: "act", handler: noticeOps("render_send"), guardrails: [never("AVM_DISCLAIMER", "SMDU FAQ Q6: an AVM value shared with the borrower carries the disclaimer", (i) => { const p = (i.payload as Record<string, unknown> | undefined) ?? {}; return p.avm_value_cents !== undefined && p.avm_value_cents !== null && p.avm_disclaimer === false; }, "add the AVM disclaimer")] },
  interimAnalysis, ledger, investorEmit,
  { name: "case.*", kind: "write", handler: readWrite("cases", "case.written") },
  { name: "contacts.log", kind: "write", handler: log("contacts", "contact.logged") },
  documentsStore,
]);

// ---- 10.2 --------------------------------------------------------------------
const p102 = defineTools("10.2", A, [
  { name: "pmi.schedule.rebuild", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "original_value_cents"); const ov = cents(i.original_value_cents);
      const v = i.prior_version !== undefined && i.change_n !== undefined ? armResetVersion(scheduleFrom(i.prior_version as ToolInput), num(i, "change_n"), ratePercent(str(i, "new_rate_pct")), num(i, "remaining_term")) : scheduleFrom(i);
      const d78 = scheduledDateForPct(v, ov, 78), d80 = scheduledDateForPct(v, ov, 80); const mp = midpoint(v.rows[0]!.due_date, v.rows.length);
      const rec = rt.store.put("mi_schedules", `${str(i, "loan_id")}-${v.kind}-${ctx.now}`, { loan_id: str(i, "loan_id"), basis: v.kind, derived_78_date: d78?.due_date ?? null, derived_80_date: d80?.due_date ?? null, derived_midpoint_date: mp.midpoint_termination_date, rows: v.rows.length }, ctx.actor, ctx.now);
      ctx.events.append({ type: "mi.schedule.updated", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { schedule_id: rec.id, basis: v.kind, derived_78_date: d78?.due_date ?? null } }); return { schedule_id: rec.id, basis: v.kind, pi_cents: v.pi_cents, derived_78_date: d78?.due_date ?? null, derived_80_date: d80?.due_date ?? null, derived_midpoint_date: mp.midpoint_termination_date }; }),
    guardrails: [never("NO_MANUAL_ROWS", "10.2 guardrail: cannot edit schedule rows manually", (i) => Array.isArray(i.rows), "schedules are built from terms only"),
      never("VARIANCE_OVER_5_CENTS_TO_OFFICER", "10.2 guardrail: rebuild variances > $0.05 go to the officer with both schedules", (i) => { const v = cents(i.variance_cents); return (v > 5n || v < -5n) && !flag(i, "officer_escalated"); }, "escalate the variance with both schedules attached")] },
  { name: "pmi.terminate", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "scheduled_date"); const applies = i.applicability ? rule78Applies(i.applicability as { consummation: PlainDate; units: number; occupancy_at_origination: "principal" | "second_home" | "investment" }) : i.applies !== false;
      const r = sweepTermination({ loan_id: str(i, "loan_id"), installments: Array.isArray(i.installments) ? (i.installments as AppliedInstallment[]) : [], scheduled_date: date(i, "scheduled_date"), applies, kind: (str(i, "kind") || "automatic_78") as "automatic_78" | "automatic_midpoint" });
      if (r.actions) ctx.events.append({ type: r.actions.event, loanId: str(i, "loan_id"), actor: ctx.actor, payload: { effective: r.actions.effective, lar89: r.actions.lar89 } });
      else if (r.result.status === "deferred_not_current") ctx.events.append({ type: "mi.auto.deferred_not_current", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { grounds: r.result.grounds } });
      return r; }),
    guardrails: [never("REASON_WHITELIST", "10.2 guardrail: cannot delay a termination for value, seasoning or fee reasons", (i) => typeof i.defer_reason === "string" && !DEFER_WHITELIST.has(i.defer_reason), "deferral reasons are NOT_CURRENT / MIDPOINT_ONLY_PROPERTY / ORIGINAL_VALUE_MISSING / POLICY_NOT_ACTIVE"),
      never("NO_FEE_NO_VALUATION", "CFPB 2015-03: automatic termination never requires a valuation, a request or a fee", (i) => flag(i, "require_valuation") || cents(i.fee_cents) > 0n, "no fee, no valuation")] },
  noticesAll, interimAnalysis, investorEmit, miInsurerCancel, ledger,
]);

// ---- 10.4 --------------------------------------------------------------------
const p104 = defineTools("10.4", A, [
  { name: "notices.compose/send", kind: "act", handler: noticeOps("render_send"),
    guardrails: [never("CHECKLIST_BLOCKS_RELEASE", "10.4 guardrail: a failed checklist blocks release", (i) => flag(i, "checklist_failed"), "fix the merge data first"), never("NO_TEMPLATE_EDITS", "10.4 guardrail: no template edits at run time", (i) => typeof i.template_source === "string", "templates change only through the registry"), never("NEVER_SKIPPED", "10.4 guardrail: a loan lacking a schedule or original value gets the disclosure with 'contact us' text, never skipped", (i) => flag(i, "skip_disclosure"), "send with the contact-us text and log the exception")] },
  { name: "pmi.projection", kind: "read", handler: compute((i) => { need(i, "original_value_cents"); const v = scheduleFrom(i); const ov = cents(i.original_value_cents); const mp = midpoint(v.rows[0]!.due_date, v.rows.length);
      return { projected_80_date: scheduledDateForPct(v, ov, 80)?.due_date ?? null, projected_78_date: scheduledDateForPct(v, ov, 78)?.due_date ?? null, projected_midpoint_date: mp.midpoint_termination_date, pi_cents: v.pi_cents }; }) },
  { name: "consents.check", kind: "read", handler: compute((i) => disclosureChannelAt({ consent: (i.consent as { class: string; given_on: PlainDate; revoked_on: PlainDate | null } | null | undefined) ?? null, send_on: date(i, "send_on") })) },
  documentsStore,
]);

// ---- 10.5 --------------------------------------------------------------------
const refundPlan = (i: ToolInput): RefundPlan => { need(i, "plan", "premium_cents"); const k = str(i, "plan"); if (k === "monthly") return { kind: "monthly", premium_cents: cents(i.premium_cents), coverage_month_start: date(i, "coverage_month_start") }; if (k === "annual") return { kind: "annual", premium_cents: cents(i.premium_cents), anniversary_start: date(i, "anniversary_start") }; if (k === "single") return { kind: "single", premium_cents: cents(i.premium_cents), refund_pct: str(i, "refund_pct") || "0" }; throw new RangeError(`plan ${k} is not monthly/annual/single`); };
const p105 = defineTools("10.5", A, [
  { name: "pmi.refund.estimate", kind: "read", handler: compute((i) => { const e = date(i, "effective_on"); const est = unearnedEstimate(refundPlan(i), e); const ins = i.insurer_amount_cents === undefined ? null : cents(i.insurer_amount_cents); return { estimate_cents: est, ...(ins === null ? {} : reconcileInsurerRefund(est, ins, flag(i, "unresolved_at_day_40"))) }; }) },
  ledger,
  { name: "disbursements.issue", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { need(i, "loan_id", "amount_cents", "rail"); ctx.events.append({ type: "disbursement.issued", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), rail: str(i, "rail"), payee: str(i, "payee") || "borrower", corporate_advance: flag(i, "corporate_advance") } }); return { issued: true, rail: str(i, "rail"), satisfies_45_day_timer_on: str(i, "rail") === "check" ? "mailing date" : "credit date" }; }),
    guardrails: [never("NO_OFFSET_WITHOUT_ELECTION", "10.5 guardrail: cannot credit a refund to escrow/principal/fees without a post-E borrower election document", (i) => !refundApplicationAllowed((str(i, "target") || "borrower") as "borrower" | "late_charges" | "principal" | "escrow", optDate(i, "election_signed_on"), optDate(i, "effective_on") ?? D("2000-01-01")), "the refund is returned to the mortgagor"),
      never("NO_WITHHOLD_FOR_DELINQUENCY", "10.5 guardrail: cannot withhold a refund for delinquency", (i) => flag(i, "withhold_for_delinquency"), "delinquency never holds a refund"),
      needsRole("ADVANCE_OVER_5000_OFFICER", "10.5 guardrail: corporate advances above $5,000 need the officer", (i) => flag(i, "corporate_advance") && cents(i.amount_cents) > 500000n, ["officer"], "advance package: computation, insurer correspondence, timer status"),
      never("LPMI_NEVER_TO_BORROWER", "10.5 guardrail: LPMI refunds never go to the borrower (B-8.1-02)", (i) => str(i, "plan") === "lpmi" && (str(i, "payee") || "borrower") === "borrower", "LPMI refunds are corporate receipts")] },
  { name: "custodial.match", kind: "read", handler: compute((i, _c, rt) => { need(i, "amount_cents"); const amt = cents(i.amount_cents); const hits = rt.store.list("mi_refunds", (d) => d.status === "awaiting_insurer" && cents(d.estimate_cents) === amt && (!i.certificate || d.certificate === i.certificate)).map((r) => r.id);
      return hits.length ? { matched: true, refund_ids: hits } : { matched: false, route: "6.5 unidentified funds (5 BD research)" }; }) },
  { name: "mi_insurer.refund_status", kind: "act", handler: compute(async (i, _c, rt) => { need(i, "since"); return { refunds: await port(rt, "mi").refunds(str(i, "since")) }; }) },
  interimAnalysis, noticesAll,
]);

// ---- 10.6 --------------------------------------------------------------------
const p106 = defineTools("10.6", A, [
  noticesAll,
  { name: "pmi.evaluation.get", kind: "read", handler: read("mi_evaluations") },
  { name: "case.noe.open", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "received_on"); const on = date(i, "received_on"); const rec = rt.store.put("cases", str(i, "id") || `noe-${str(i, "loan_id")}-${on}`, { loan_id: str(i, "loan_id"), case_type: "noe", received_on: on, ack_due: noeAckDue(on), pmi_case_id: (i.pmi_case_id as string | undefined) ?? null, status: "open" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "case.noe.opened", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { case_id: rec.id, ack_due: noeAckDue(on) } }); return rec.data; }) },
  { name: "smdu.valuation.appeal", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "valuation_id"); ctx.events.append({ type: "mi.valuation.appealed", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { valuation_id: str(i, "valuation_id") } }); return { appealed: true, extends_validity: false }; }),
    guardrails: [never("APPEAL_ONLY_WHEN_UNSUPPORTIVE", "SMDU FAQ Q20: appeals only when the valuation did not support termination", (i) => flag(i, "valuation_supported_termination"), "nothing to appeal"), never("AVM_NOT_APPEALABLE", "SMDU FAQ Q19: AVM values may not be appealed", (i) => str(i, "valuation_kind") === "avm", "the borrower may pay for a BPO or appraisal instead")] },
  { name: "documents.deliver", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "document_id"); ctx.events.append({ type: "document.delivered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { document_id: str(i, "document_id"), channel: str(i, "channel") || "secure_edelivery" } }); return { delivered: true, channel: str(i, "channel") || "secure_edelivery" }; }) },
]);

export const SECTION_10_TOOLS: readonly ToolDef[] = [...p101, ...p102, ...p104, ...p105, ...p106];
export const escalateOfficer = escalate("officer");
export const automaticTerminationTool = automaticTermination;
