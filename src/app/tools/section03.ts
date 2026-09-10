/**
 * §3 tools — escrow administration (3.1–3.9). Tool strings verbatim from each
 * process's Agents paragraph; guardrails encode "the agent cannot" sentences.
 */
import { defineTools, write, escalate, noticeOps, emit, compute, gate, needsRole, never, port, str, num, flag, cents, data, type ToolDef } from "../tools.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { project, decide, newPayment, cushion, anomalies, type ProjectedItem, type CushionInputs } from "../../domain/escrow/analysis.ts";
import { assembleAnnualStatement, reviewStatus, scheduleRefund, issueRefund, approveRefund, returnedRefund, creditToNewLoan, replanAfterReject, releaseApproval, advanceEntries, rateObservation, accrueDaily, initialStatementStatus, type StatementHistoryRow } from "../../domain/escrow/ops.ts";
import { buildPlan, lumpSum } from "../../domain/escrow/shortage.ts";
import { schedule, fundsCheck, type Bill, type Method } from "../../domain/escrow/disbursement.ts";
import { evaluateWaiver, type WaiverRequest } from "../../domain/escrow/waiver.ts";
import { exemption as ioeExemption, resolveRate, accrue } from "../../domain/escrow/interest.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { render } from "../../notices/render.ts";

const escrowEvent = { name: "emitEscrowEvent", kind: "act" as const, handler: emit("escrow."), guardrails: [never("ESCROW_EVENT_SHAPE", "3.7 rule 11: every escrow event carries the signed amount, balance after and sequence", (i) => { const p = (i.payload as Record<string, unknown> | undefined) ?? {}; return p.amount_cents === undefined || p.balance_cents === undefined || p.sequence === undefined; }, "escrow events need amount_cents, balance_cents and sequence")] };
const escalateTool = { name: "escalate", kind: "act" as const, handler: escalate("human_agent") };
const sendNotice = { name: "sendNotice", kind: "act" as const, handler: noticeOps("send") };
const renderStatement = { name: "renderStatement", kind: "act" as const, handler: noticeOps("render") };

const p31: ToolDef[] = defineTools("3.1", "escrow", [
  { name: "readBoardingFile", kind: "act", handler: compute((i) => initialStatementStatus({ settlement_date: D(str(i, "settlement_date")), boarded_on: D(str(i, "boarded_on")), originator_statement_delivered_on: i.originator_statement_delivered_on ? D(str(i, "originator_statement_delivered_on")) : null })) },
  { name: "runEscrowAnalysis", kind: "act", handler: compute((i) => { const p = project((i.items as ProjectedItem[]) ?? [], D(str(i, "year_start")), (i.cushion as CushionInputs) ?? {}, { biweekly: flag(i, "biweekly") }); const d = decide({ projection: p, projected_actual_cents: cents(i.projected_actual_cents), as_of: D(str(i, "as_of")), regx_days_delinquent: num(i, "regx_days_delinquent") || 0 }); return { projection: p, decision: d, payment: newPayment(p, d) }; }) },
  { name: "approveAnalysis", kind: "act", handler: compute((i, ctx, rt) => { const r = reviewStatus((i.anomalies as string[]) ?? []); if (r.status === "anomaly_review" && !flag(i, "reviewed")) throw new RangeError(`anomaly_review: ${r.decision_record.triggers.join(", ")}`); return rt.store.put("escrow_analyses", str(i, "analysis_id"), { status: "approved", approved_at: ctx.now, triggers: r.decision_record.triggers }, ctx.actor, ctx.now).data; }),
    guardrails: [never("ENGINE_OUTPUTS_IMMUTABLE", "3.1 guardrails: the agent cannot edit engine outputs; overrides only via escrow_line corrections with a documented source", (i) => i.changes !== undefined && Object.keys(i.changes).some((k) => ["base_payment_cents", "cushion_cents", "target_at_start_cents"].includes(k)), "engine outputs are not editable; correct the escrow line with a documented source"),
      gate("3.4.cushionCap", "REGX_1024_17C5_CUSHION_CAP_GATE"), gate("3.4.preaccrual", "REGX_1024_17C6_PREACCRUAL_GATE")] },
  renderStatement, sendNotice,
  { name: "openCase", kind: "write", handler: write("cases", "case.opened") },
  escalateTool, escrowEvent,
]);
const p32: ToolDef[] = defineTools("3.2", "escrow", [
  { name: "compareBillToPriorYear", kind: "act", handler: compute((i) => { const cur = cents(i.current_cents), prior = cents(i.prior_cents); const varPct = prior > 0n ? Number(((cur - prior) * 10_000n) / prior) / 100 : null; return { variance_pct: varPct, anomaly: varPct !== null && Math.abs(varPct) > 20, triggers: anomalies(cents(i.old_payment_cents), cents(i.new_payment_cents), { kind: "balanced" }, { bill_variance_gt_20: varPct !== null && Math.abs(varPct) > 20 }) }; }) },
  { name: "lookupParcel", kind: "act", handler: compute((i, _c, rt) => port(rt, "taxService").delinquencySearch(str(i, "parcel_id"))) },
  { name: "readPolicyDeclarations", kind: "act", handler: compute((i, _c, rt) => rt.store.get("insurance_policies", str(i, "policy_id"))?.data ?? null) },
]);
const p33: ToolDef[] = defineTools("3.3", "escrow", [
  { ...renderStatement, handler: compute((i) => assembleAnnualStatement({ year_start: D(str(i, "year_start")), year_end: D(str(i, "year_end")), approved_on: D(str(i, "approved_on")), new_payment_cents: cents(i.new_payment_cents), prior_escrow_portion_cents: cents(i.prior_escrow_portion_cents), history: (i.history as StatementHistoryRow[]) ?? [], decision_text: str(i, "decision_text"), low_point_explanation: (i.low_point_explanation as string[]) ?? [] })) },
  { name: "validateChecklist", kind: "act", handler: compute((i, _c, rt) => { const reg = rt.notices; if (!reg) throw new RangeError("notices not wired"); const v = reg.template(str(i, "template_code")); const version = (i.version as Parameters<typeof evaluateChecklist>[0] | undefined); if (!version) return { template: v.code, checked: false }; const payload = (i.payload as Record<string, unknown>) ?? {}; return evaluateChecklist(version, payload, render(version.source, payload)); }) },
  sendNotice,
]);
const p34: ToolDef[] = defineTools("3.4", "escrow", [
  { name: "validateCushion", kind: "act", handler: compute((i) => { const c = cushion(cents(i.annual_cents), (i.cushion as CushionInputs) ?? {}); return { ...c, cap_check_passed: c.cents <= c.cap_cents }; }) },
]);
const p35: ToolDef[] = defineTools("3.5", "escrow", [
  { name: "issueRefund", kind: "act", handler: compute((i, ctx, rt) => { const r = scheduleRefund(str(i, "loan_id") || ctx.loanId, cents(i.amount_cents), D(str(i, "due_on"))); for (const a of (i.approvals as { by: string }[] | undefined) ?? []) approveRefund(r, { kind: "human", id: a.by, role: "officer" }); issueRefund(r, D(ctx.now.slice(0, 10)), str(i, "check_no") || `CHK-${ctx.now}`); rt.store.put("refunds", `${r.loan_id}:${r.due_on}`, r as unknown as Record<string, unknown>, ctx.actor, ctx.now); return r; }),
    guardrails: [never("ENGINE_AMOUNT", "3.5 guardrails: the refund amount is engine-computed; the agent cannot reduce it", (i) => i.engine_amount_cents !== undefined && cents(i.amount_cents) < cents(i.engine_amount_cents), "refund below the engine-computed surplus"),
      never("PAYEE_IS_BORROWER", "3.5 guardrails: payee must be a borrower/confirmed successor", (i) => i.payee_kind !== undefined && !["borrower", "confirmed_successor"].includes(str(i, "payee_kind")) && !flag(i, "case_with_human_review"), "third-party payee without a case and human review"),
      needsRole("DUAL_APPROVAL", "3.5 guardrails: refunds > $25,000 or to a newly changed address require officer dual approval", (i) => (cents(i.amount_cents) > 2_500_000n || flag(i, "address_changed_recently")) && ((i.approvals as unknown[] | undefined)?.length ?? 0) < 2, ["officer"], "officer dual approval missing")] },
  { name: "verifyAddress", kind: "act", handler: compute((i) => { const a = data(i); return { verified: !!a.line1 && /^\d{5}/.test(String(a.zip ?? "")), address: a }; }) },
  { name: "reissueDisbursement", kind: "act", handler: compute((i, ctx, rt) => { const rec = rt.store.get("refunds", str(i, "refund_id")); if (!rec) throw new RangeError("no refund"); const r = rec.data as unknown as ReturnType<typeof scheduleRefund>; const out = returnedRefund(r, D(str(i, "returned_on")), D(str(i, "address_verified_on")), D(ctx.now.slice(0, 10))); rt.store.put("refunds", str(i, "refund_id"), r as unknown as Record<string, unknown>, ctx.actor, ctx.now); return out; }) },
  { name: "stopCheck", kind: "act", handler: compute((i, ctx, rt) => { ctx.events.append({ type: "escrow.refund.check_stopped", loanId: ctx.loanId, actor: ctx.actor, payload: { check_no: str(i, "check_no"), reason: str(i, "reason") } }); return rt.store.put("refund_checks", str(i, "check_no"), { status: "stopped", reason: str(i, "reason") }, ctx.actor, ctx.now).data; }) },
  { name: "recordConsent", kind: "write", handler: write("consents", "consent.recorded") },
  { name: "emitEscrowEvent", kind: "act", handler: compute((i, ctx, rt) => { const r = rt.store.get("refunds", str(i, "refund_id"))?.data as unknown as ReturnType<typeof scheduleRefund> | undefined; if (r && i.new_loan) return creditToNewLoan(r, i.consent as Parameters<typeof creditToNewLoan>[1], i.new_loan as Parameters<typeof creditToNewLoan>[2]); return escrowEvent.handler(i, ctx); }), guardrails: escrowEvent.guardrails },
  escalateTool,
]);
const p36: ToolDef[] = defineTools("3.6", "escrow", [
  { name: "createRepaymentPlan", kind: "act", handler: compute((i) => buildPlan((i.kind as "shortage" | "deficiency") ?? "shortage", cents(i.total_cents), D(str(i, "start")), { workout: flag(i, "workout"), ...(i.election_months !== undefined ? { election_months: num(i, "election_months") } : {}), ...(i.instrument_max_months !== undefined ? { instrument_max_months: num(i, "instrument_max_months") } : {}), ...(typeof i.state === "string" ? { state: i.state } : {}), ...(i.deficiency_installments !== undefined ? { deficiency_installments: num(i, "deficiency_installments") } : {}) })),
    guardrails: [never("MIN_12_MONTHS", "3.6 guardrails: no plan < 12 months for ≥-one-month shortages", (i) => i.kind !== "deficiency" && i.election_months !== undefined && num(i, "election_months") < 12, "shortage plans are ≥ 12 months"),
      never("DEFICIENCY_MIN_2", "3.6 guardrails: no deficiency plan < 2 installments", (i) => i.kind === "deficiency" && i.deficiency_installments !== undefined && num(i, "deficiency_installments") < 2, "deficiency plans are ≥ 2 installments"),
      never("NO_INTEREST_OR_FEES", "3.6 guardrails: no interest; no fees", (i) => cents(i.interest_cents) > 0n || cents(i.fee_cents) > 0n, "no interest or fees on escrow repayment"),
      gate("3.6.interimAnalysisBeforeDemand", "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE")] },
  { name: "recordBorrowerElection", kind: "write", handler: write("escrow_elections", "escrow.election.recorded"), guardrails: [never("EVIDENCED", "3.2 guardrails: borrower elections must be evidenced (recorded call, e-signed form)", (i) => !data(i).evidence_document_id && !data(i).recorded_call_id, "an election needs evidence")] },
  { name: "postEscrowLumpSum", kind: "act", handler: compute((i, ctx, rt) => { const rec = rt.store.get("escrow_repayment_plans", str(i, "plan_id")); if (!rec) throw new RangeError("no plan"); const plan = rec.data as unknown as Parameters<typeof lumpSum>[0]; const out = lumpSum(plan, cents(i.amount_cents), D(ctx.now.slice(0, 10))); ctx.events.append({ type: "escrow.lump_sum.received", loanId: ctx.loanId, actor: ctx.actor, payload: { plan_id: str(i, "plan_id"), amount_cents: String(cents(i.amount_cents)), paid: out.paid } }); return out; }) },
]);
const p37: ToolDef[] = defineTools("3.7", "escrow", [
  { name: "scheduleDisbursement", kind: "act", handler: compute((i) => { if (!i.bill) throw new RangeError("scheduleDisbursement needs bill {amount_cents, due_on, received_on, discount?}"); return schedule(i.bill as Bill, (i.method as Method) ?? "check", cents(i.escrow_balance_cents), cents(i.other_due_within_30_cents), i.capture !== false); }) },
  { name: "releaseDisbursement", kind: "act", handler: compute((i, ctx) => { const f = fundsCheck(cents(i.amount_cents), cents(i.escrow_balance_cents), cents(i.reserved_within_5bd_cents)); ctx.events.append({ type: "escrow.disbursement.released", loanId: ctx.loanId, actor: ctx.actor, payload: { amount_cents: String(cents(i.amount_cents)), advance_cents: String(f.advance_cents) } }); return { ...f, entries: advanceEntries(cents(i.amount_cents), f.advance_cents) }; }),
    guardrails: [needsRole("PAYEE_CHANGE_DUAL", "3.7 guardrails: payee remittance changes need validated evidence and officer dual approval when > $10,000 or a new payee", (i) => releaseApproval({ amount_cents: cents(i.amount_cents), payee_instruction_changed_on: i.payee_instruction_changed_on ? D(str(i, "payee_instruction_changed_on")) : null, release_on: D(str(i, "release_on") || "2000-01-01"), new_payee: flag(i, "new_payee") }).dual_approval_required && ((i.approvals as unknown[] | undefined)?.length ?? 0) < 2, ["officer"], "dual approval required"),
      never("NEVER_SKIP_LIEN_PAYMENT", "3.7 guardrails: the agent may not skip a lien-protecting payment", (i) => flag(i, "skip"), "lien-protecting payments are never skipped for lack of funds — advance"),
      never("LPI_GATE", "3.7 guardrails: LPI gate enforced by code", (i) => i.kind === "hazard" && flag(i, "lpi_gate_open") && !flag(i, "inability_documented"), "LPI gate: document the (k)(5)(ii)(A) inability before force-placing")] },
  { name: "postAdvance", kind: "act", handler: compute((i, ctx) => { const entries = advanceEntries(cents(i.amount_cents), cents(i.advance_cents)); ctx.events.append({ type: "escrow.advance.posted", loanId: ctx.loanId, actor: ctx.actor, payload: { advance_cents: String(cents(i.advance_cents)), cause: str(i, "cause") || "insufficient_funds", penalty_cause: str(i, "penalty_cause") || null } }); return { entries, servicer_error_flag: str(i, "penalty_cause") === "agent_delay" }; }) },
]);
const p38: ToolDef[] = defineTools("3.8", "escrow", [
  { name: "evaluateWaiver", kind: "act", handler: compute((i) => { if (!i.request) throw new RangeError("evaluateWaiver needs request (3.8 WaiverRequest)"); return evaluateWaiver(i.request as WaiverRequest); }) },
  { name: "approveWaiver", kind: "act", handler: compute((i, ctx, rt) => rt.store.put("escrow_waivers", str(i, "waiver_id"), { decision: "approved", effective_on: str(i, "effective_on"), approved_at: ctx.now }, ctx.actor, ctx.now).data),
    guardrails: [never("RULE_OUTCOMES_BINDING", "3.8 guardrails: rule outcomes are binding; the agent cannot approve when a gate fails", (i) => (i.evaluation as { decision?: string } | undefined)?.decision === "denied", "the evaluation denied the waiver; a state right (IL/MN) or counsel review is the only path"),
      gate("3.8.hpmlFiveYears", "REGZ_1026_35B3_HPML_ESCROW_5Y_GATE")] },
]);
const p39: ToolDef[] = defineTools("3.9", "escrow", [
  { name: "evaluateInterestEligibility", kind: "act", handler: compute((i) => { const ex = ioeExemption(i.facts as Parameters<typeof ioeExemption>[0]); return { eligible: ex === null, exemption: ex }; }) },
  { name: "verifyRate", kind: "act", handler: compute((i, ctx, rt) => { const r = rateObservation({ state: str(i, "state"), expected_on: D(str(i, "expected_on")), observed_pct: (i.observed_pct as string | null) ?? null, prior_verified_pct: str(i, "prior_verified_pct"), accrued_at_prior_cents: cents(i.accrued_at_prior_cents), base_cents: cents(i.base_cents), days: num(i, "days") || 0 }); if (r.escalation) rt.escalations.open({ kind: "sev2", loanId: ctx.loanId, payload: { reason: `rate observation missing for ${str(i, "state")}` } }, ctx.actor); else ctx.events.append({ type: "jurisdiction.rate_observation.verified", actor: ctx.actor, payload: { state: str(i, "state"), rate_pct: r.rate_in_effect_pct } }); return r; }),
    guardrails: [never("VERIFIED_ONLY", "3.9 guardrails: rates only from verified observations; the agent cannot lower a statutory minimum", (i) => i.observed_pct !== undefined && i.observed_pct !== null && i.statutory_min_pct !== undefined && Number(i.observed_pct) < Number(i.statutory_min_pct), "below the statutory minimum")] },
  { name: "postInterestCredit", kind: "act", handler: compute((i, ctx) => { const amt = i.balances ? accrueDaily(i.balances as bigint[], str(i, "rate_pct")) : accrue(cents(i.avg_daily_balance_cents), resolveRate({ state: str(i, "state"), origination_date: D(str(i, "origination_date") || "2020-01-01") }, (i.obs as Record<string, string>) ?? {}), num(i, "days") || 0); ctx.events.append({ type: "escrow.interest.credited", loanId: ctx.loanId, actor: ctx.actor, payload: { amount_cents: String(amt), credited_on: ctx.now.slice(0, 10) } }); return { credited_cents: amt, ledger: [{ dr: "escrow_interest_expense", cr: "loan.escrow", amount_cents: amt }] }; }),
    guardrails: [never("NO_FEES", "3.9 guardrails: no fees", (i) => cents(i.fee_cents) > 0n, "no fees for escrow administration")] },
  { name: "prorateInterest", kind: "act", handler: compute((i) => ({ prorated_cents: accrue(cents(i.avg_daily_balance_cents), str(i, "rate_pct"), num(i, "days") || 0), posted_before_refund: true })) },
]);

export const SECTION_03_TOOLS: readonly ToolDef[] = [...p31, ...p32, ...p33, ...p34, ...p35, ...p36, ...p37, ...p38, ...p39];
