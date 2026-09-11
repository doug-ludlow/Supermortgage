/**
 * §3 tools — escrow administration (3.1–3.9). Tool strings verbatim from each
 * process's Agents paragraph; guardrails encode "the agent cannot" sentences.
 * Facts the guardrails and registry gates need (the engine's cap / pre-accrual
 * checks, the approved surplus, the interim analysis, the verified rate) are
 * read from the engine's own `loan_events` / store records, never from the
 * caller's input — the agent cannot attest its own gate.
 */
import { defineTools, write, escalate, noticeOps, emit, compute, guard, never, port, str, num, flag, cents, data, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { assertGate } from "../evaluators.ts";
import { requireDualControl } from "../roles.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { TimerDef } from "../../kernel/timers/registry.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import type { Notice } from "../../notices/service.ts";
import { project, decide, newPayment, cushion, anomalies, type ProjectedItem, type CushionInputs, type Decision, type Projection } from "../../domain/escrow/analysis.ts";
import { reviewStatus, scheduleRefund, issueRefund, approveRefund, refundNeedsDualApproval, returnedRefund, creditToNewLoan, releaseApproval, advanceEntries, rateObservation, accrueDaily, initialStatementStatus, recordStatementSent, type StatementType } from "../../domain/escrow/ops.ts";
import { readBoardingFile as readBoardingFile31 } from "../../domain/escrow/ops-3-1.ts";
import { renderAnnualStatement_3_3 } from "./section3-3.ts";
import { beginAnalysisComputation, recordCushionCheck, checkFromProjection } from "../../domain/escrow/ops-3-4.ts";
import type { Plan } from "../../domain/escrow/shortage.ts";
import { assertAnalysisApprovalGates36 } from "./section3-6.ts";
import { settleFinalDisbursements, finalDisbursementHold, payoffRefundCents, inFlight } from "../../domain/escrow/ops-3-5.ts";
import { schedule, fundsCheck, hazardDecision, leadHonored, LEAD_DAYS, type Bill, type Method } from "../../domain/escrow/disbursement.ts";
import { evaluateWaiver, revocation, type WaiverRequest } from "../../domain/escrow/waiver.ts";
import { recordWaiverRequest, recordWaiverEvaluation, recordWaiverDenial } from "../../domain/escrow/ops-3-8.ts";
import { exemptionOn as ioeExemptionOn, resolveRate, accrue, statutoryMinimumPct, nextCreditingDate, pmiTerminationRecompute, STATES as IOE_STATES, type LoanFacts } from "../../domain/escrow/interest.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { render } from "../../notices/render.ts";

// ---- shared helpers ----------------------------------------------------------------------------------------------
/** Approvals arrive as actors (kind/id/role) recorded by the ops console; the handler never mints a role for them. */
const approvers = (i: ToolInput): Actor[] => ((i.approvals as unknown[] | undefined) ?? []).filter((a): a is Actor => !!a && typeof a === "object" && typeof (a as Actor).kind === "string" && typeof (a as Actor).id === "string");
/** Dual control (roles.ts): two distinct officers among the recorded approvers plus the executing actor. */
const dualControlHolds = (i: ToolInput, ctx: CommandContext, what: string): boolean => { try { requireDualControl([...approvers(i), ctx.actor], "officer", what); return true; } catch { return false; } };
const today = (ctx: CommandContext) => D(ctx.now.slice(0, 10));
/** The loan's own facts of one event type, in store order. */
const loanEvents = (ctx: CommandContext, type: string): readonly DomainEvent[] => ctx.events.ofType(type).filter((e) => e.loanId === ctx.loanId);
const latest = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
let registryCache: ReturnType<typeof loadOverriddenRegistry> | null = null;
/** A registry definition (with the §3 overrides) for a row a tool arms explicitly — a code the spec gives two triggers. */
const registryDef = (code: string): TimerDef => { registryCache ??= loadOverriddenRegistry(); const d = registryCache.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };
/** Escrow statement templates whose send is the `escrow.statement.sent` fact the 3.1/3.3 timers are satisfied by; the (f)(5) notice travels the same path (REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL). */
const STATEMENT_TEMPLATES: Record<string, StatementType> = { NTC_REGX_1024_17G_INITIAL_ESCROW_STMT: "initial", NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT: "annual", NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR: "short_year_transfer", NTC_REGX_1024_17I4_SHORT_YEAR_RESET: "short_year_reset", NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY: "post_exemption_history", NTC_REGX_1024_17F_SHORTAGE: "shortage_notice" };
/** The computation year that starts on `yearStart` ends the day before its anniversary. */
const yearEndFrom = (yearStart: PlainDate): PlainDate => addDays(addMonths(yearStart, 12), -1);
/** Analysis types whose approval starts a computation year (3.2 inputs; 3.3 "reset_computation_year"). */
const STARTS_COMPUTATION_YEAR = new Set(["initial", "annual", "transfer_in", "reinstatement"]);

/** The engine's analysis record runEscrowAnalysis stores and approveAnalysis / issueRefund read back (never the caller's copy). */
interface AnalysisRecord {
  readonly analysis_id: string; readonly analysis_type: string; readonly as_of: PlainDate; readonly year_start: PlainDate; readonly computation_year_end: PlainDate; readonly next_computation_year_end: PlainDate;
  readonly regx_days_delinquent: number; readonly reset: boolean; readonly short_year_end: PlainDate | null; readonly decision: Decision; readonly cushion: CushionInputs;
  readonly projection: Pick<Projection, "base_payment_cents" | "target_at_start_cents" | "required_start_cents" | "cushion_cents" | "cushion_source" | "cap_cents" | "cap_ok" | "preaccrual_ok">; readonly payment: ReturnType<typeof newPayment>;
  readonly anomalies: string[]; status: "computed" | "anomaly_review" | "approved"; approved_at?: string; surplus_cents?: bigint; triggers?: string[];
}
const surplusOf = (d: Decision): bigint => (d.kind === "refund" || d.kind === "credit" || d.kind === "retain" ? d.surplus_cents : 0n);
/** The engine's `escrow.analysis.completed` fact for an analysis id on this loan — the source of the 3.4 gate facts. */
const completedAnalysis = (i: ToolInput, ctx: CommandContext): DomainEvent | undefined => latest(loanEvents(ctx, "escrow.analysis.completed").filter((e) => p(e).analysis_id === str(i, "analysis_id")));
/** A registry gate evaluated on the engine's completed-analysis fact, not on caller-supplied facts. */
const analysisGate = (ref: string, citation: string, factKey: string, eventKey: string) =>
  guard(ref, citation, (i, ctx) => { const e = completedAnalysis(i, ctx); if (!e) return undefined; try { assertGate(ref, { [factKey]: p(e)[eventKey] === true }); return undefined; } catch (err) { return (err as Error).message; } });

const escrowEvent = { name: "emitEscrowEvent", kind: "act" as const, handler: compute((i, ctx) => {
  if (str(i, "type") !== "escrow.account.closed") return emit("escrow.")(i, ctx);
  // 3.8 closure ("escrow event to balance 0"): the closure date anchors ESC_WAIVER_REFUND_30 (registry trigger) and the 3.8 branch of the 3.3 code REGX_1024_17I4_SHORT_YEAR_RESET_60 (armed here: one code, two triggers).
  const payload = (i.payload as Record<string, unknown> | undefined) ?? {}; const closedOn = typeof payload.closed_on === "string" ? D(payload.closed_on) : today(ctx);
  const ev = ctx.events.append({ type: "escrow.account.closed", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { ...payload, closed_on: closedOn, short_year_end: closedOn, short_year_reset: true } });
  ctx.timers.arm(registryDef("REGX_1024_17I4_SHORT_YEAR_RESET_60"), ev);
  return ev;
}), guardrails: [never("ESCROW_EVENT_SHAPE", "3.7 rule 11: every escrow event carries the signed amount, balance after and sequence", (i) => { const p = (i.payload as Record<string, unknown> | undefined) ?? {}; return p.amount_cents === undefined || p.balance_cents === undefined || p.sequence === undefined; }, "escrow events need amount_cents, balance_cents and sequence")] };
const escalateTool = { name: "escalate", kind: "act" as const, handler: escalate("human_agent") };
const sendNotice = { name: "sendNotice", kind: "act" as const, handler: compute(async (i, ctx, rt) => {
  // `sendNotice{notice_id}` sends a statement `renderStatement` rendered in this command; `sendNotice{template_code, recipients, payload}` renders and sends in one command (the registry's notices live in the unit of work — 32.8 delta)
  const n = (await (str(i, "notice_id") ? noticeOps("send") : noticeOps("render_send"))(i, ctx, rt)) as Notice;
  const statementType = STATEMENT_TEMPLATES[n.templateCode];
  if (statementType && n.status === "sent") {
    const sentOn = D((n.sentAt ?? ctx.now).slice(0, 10));
    // (f)(5): the statement's item (vi) explains a shortage/deficiency (rendered from the decision — ops.decisionText), or the (f)(5) notice itself is sent.
    const shortageExplained = flag(i, "shortage_explained") || n.templateCode === "NTC_REGX_1024_17F_SHORTAGE" || /has a (shortage|deficiency) of/i.test(String(n.payload.decision_text ?? ""));
    const periodEnd = [n.payload.period_end, n.payload.year_end].find((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) as string | undefined;   // the statement's period end (3.3 rule 6: the next post-exemption history starts after it)
    const statedAmount = n.payload.new_payment_cents; const statedOn = n.payload.new_payment_effective_on;   // the statement's item (i) figure and its effective date, when the template states them (2.3 rule 5 / 32.8-T6)
    recordStatementSent(ctx.events, { loan_id: n.loanId ?? ctx.loanId, template: n.templateCode, statement_type: statementType, sent_on: sentOn, due_on: i.due_on ? D(str(i, "due_on")) : sentOn, actor: ctx.actor, shortage_explained: shortageExplained, history_to: periodEnd ? D(periodEnd) : null,
      stated_payment: (typeof statedAmount === "bigint" || (typeof statedAmount === "string" && /^\d+$/.test(statedAmount))) && typeof statedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(statedOn) ? { amount_cents: cents(statedAmount), effective_on: D(statedOn) } : null });
  }
  return n;
}) };
const renderStatement = { name: "renderStatement", kind: "act" as const, handler: noticeOps("render") };

const p31: ToolDef[] = defineTools("3.1", "escrow", [
  // 3.1 inputs (ops-3-1 readBoardingFile): the boarding-file evidence check appends the fact that closes ESC_BOARDING_EVIDENCE_CHECK_5BD — `escrow.initial_statement.evidence_verified`, or `.required{reason=settlement}` (arms REGX_1024_17G_INITIAL_STMT_45 on `settlement_date`) / `{reason=transfer_in}` after §1.6's `escrow.terms.changed_at_transfer` (REGX_1024_17E_TRANSFER_INITIAL_STMT_60); a 45-day window already lapsed at boarding is recorded breached now and opens the rule-1 `qc_finding` case against the originator.
  { name: "readBoardingFile", kind: "act", handler: compute((i, ctx, rt) => {
    const r = readBoardingFile31(ctx.events, { loan_id: ctx.loanId, boarded_on: D(str(i, "boarded_on") || ctx.now.slice(0, 10)), settlement_date: i.settlement_date ? D(str(i, "settlement_date")) : null, evidence: i.originator_statement_delivered_on ? { document_id: str(i, "evidence_document_id"), delivered_on: D(str(i, "originator_statement_delivered_on")) } : null }, ctx.actor);
    if (r.qc_finding) write("cases", "case.opened")({ id: `qc-finding:${ctx.loanId}:initial_statement`, data: { case_type: "qc_finding", loan_id: ctx.loanId, reason: r.qc_finding, against: "originator", rule_ref: "§1024.17(g)(1)", timer: r.timer?.code ?? null } }, ctx, rt);
    if (r.kind === "settlement" && r.timer?.breached_at_boarding) ctx.timers.evaluate(ctx.now);
    return { kind: r.kind, status: r.status, timer: r.timer, qc_finding: r.qc_finding, event_type: r.event.type, ...(r.kind === "settlement" ? { send_by: r.send_by } : {}), ...(r.kind === "transfer_in" ? { computation_year_start: r.computation_year_start } : {}) };
  }) },
  { name: "runEscrowAnalysis", kind: "act", handler: compute((i, ctx, rt) => {
    const yearStart = D(str(i, "year_start")); const asOf = D(str(i, "as_of")); const analysisType = str(i, "analysis_type") || "annual"; const analysisId = str(i, "analysis_id") || `EA-${ctx.loanId}-${asOf}`;
    const cu = (i.cushion as CushionInputs) ?? {}; const delinquent = num(i, "regx_days_delinquent") || 0;
    // 3.4 Inputs: "Every `escrow.analysis.computing` event — the cushion module is called inside the engine" (arms REGX_1024_17C5_CUSHION_CAP_GATE / REGX_1024_17C6_PREACCRUAL_GATE; 3.6's workout spread gate on reason=workout).
    beginAnalysisComputation(ctx.events, { loan_id: ctx.loanId, analysis_id: analysisId, analysis_type: analysisType, as_of: asOf, year_start: yearStart, ...(flag(i, "workout") ? { workout: true } : {}), actor: ctx.actor });
    const pr = project((i.items as ProjectedItem[]) ?? [], yearStart, cu, { biweekly: flag(i, "biweekly") });
    const d = decide({ projection: pr, projected_actual_cents: cents(i.projected_actual_cents), as_of: asOf, regx_days_delinquent: delinquent, ...(i.instrument_shortage_max_months !== undefined ? { instrument_shortage_max_months: num(i, "instrument_shortage_max_months") } : {}), ...(flag(i, "workout") ? { workout: true } : {}) });
    const payment = newPayment(pr, d); const reset = flag(i, "reset"); const shortYearEnd = reset ? (i.short_year_end ? D(str(i, "short_year_end")) : addDays(yearStart, -1)) : null;
    // 3.2 R10 anomaly triggers and the 3.4 invariants are the engine's; they gate approveAnalysis from the stored record / completed event.
    const oldPay = cents(i.old_payment_cents); const flags = { missing_penalty_date: flag(i, "missing_penalty_date"), pmi_without_termination: flag(i, "pmi_without_termination"), bill_variance_gt_20: flag(i, "bill_variance_gt_20") };
    // 3.4 Outputs: the cushion module's `escrow.cushion.validated` (carrying cap_check_passed / preaccrual_check_passed — the gates' satisfiers) and `escrow.cushion.cap_failed` (with reason) loan_events; its reasons are the 3.4 anomaly triggers.
    const cushionCheck = recordCushionCheck(ctx.events, checkFromProjection(pr, { loan_id: ctx.loanId, analysis_id: analysisId, source: "engine", cushion_months: cushion(pr.annual_for_cushion_cents, cu).months, actor: ctx.actor }));
    const triggers = [...anomalies(oldPay > 0n ? oldPay : payment.payment_cents, payment.payment_cents, d, flags), ...cushionCheck.reasons];   // payment-change triggers need the prior payment
    const rec: AnalysisRecord = { analysis_id: analysisId, analysis_type: analysisType, as_of: asOf, year_start: yearStart, computation_year_end: addDays(yearStart, -1), next_computation_year_end: yearEndFrom(yearStart), regx_days_delinquent: delinquent, reset, short_year_end: shortYearEnd, decision: d, cushion: cu,
      projection: { base_payment_cents: pr.base_payment_cents, target_at_start_cents: pr.target_at_start_cents, required_start_cents: pr.required_start_cents, cushion_cents: pr.cushion_cents, cushion_source: pr.cushion_source, cap_cents: pr.cap_cents, cap_ok: pr.cap_ok, preaccrual_ok: pr.preaccrual_ok }, payment, anomalies: triggers, status: reviewStatus(triggers).status };
    rt.store.put("escrow_analyses", analysisId, rec as unknown as Record<string, unknown>, ctx.actor, ctx.now);
    // REGX_1024_17C3_ANNUAL_ANALYSIS_0 / _LEAD_45 / ESC_LUMPSUM_REANALYSIS_10BD are satisfied by `escrow.analysis.completed`; LEAD_45 (recurring) re-arms from `next_computation_year_end` — the end of the year this analysis projects.
    ctx.events.append({ type: "escrow.analysis.completed", loanId: ctx.loanId, actor: ctx.actor, payload: { analysis_id: analysisId, analysis_type: analysisType, as_of: asOf, decision: d.kind, base_payment_cents: String(pr.base_payment_cents), target_at_start_cents: String(pr.target_at_start_cents), cap_ok: pr.cap_ok, preaccrual_ok: pr.preaccrual_ok, anomalies: triggers, reset, next_computation_year_end: rec.next_computation_year_end } });
    return { analysis_id: analysisId, projection: pr, decision: d, payment, anomalies: triggers, status: rec.status };
  }) },
  { name: "approveAnalysis", kind: "act", handler: compute((i, ctx, rt) => {
    const analysisId = str(i, "analysis_id"); const rec = rt.store.get("escrow_analyses", analysisId); if (!rec) throw new RangeError(`no computed analysis ${analysisId}: runEscrowAnalysis first`);
    const a = rec.data as unknown as AnalysisRecord;
    const triggers = [...new Set([...a.anomalies, ...((i.anomalies as string[] | undefined) ?? [])])];
    const r = reviewStatus(triggers); if (r.status === "anomaly_review" && !flag(i, "reviewed")) throw new RangeError(`anomaly_review: ${r.decision_record.triggers.join(", ")}`);
    const d = a.decision; const surplus = surplusOf(d); const current = a.regx_days_delinquent <= 30; const startsYear = STARTS_COMPUTATION_YEAR.has(a.analysis_type) || a.reset;
    // 3.6 timer table: REGX_1024_17F3 / 17F4 / FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60 gates are "satisfied by analysis approval; breach: approval refused" — asserted on the engine's decision (GateClosed refuses the approval) before the approved fact closes them.
    assertAnalysisApprovalGates36(ctx, analysisId, d, a.projection.base_payment_cents);
    // Arms REGX_1024_17F2_SURPLUS_REFUND_30 (3.5: decision=refund is "surplus ≥ $50 and borrower current", anchored on as_of), REGX_1024_17I_ANNUAL_STMT_30 (3.3: analysis_type=annual, anchored on computation_year_end), REGX_1024_17I4_SHORT_YEAR_RESET_60 (reset=true, short_year_end) and REGX_1024_17C3_ANNUAL_ANALYSIS_0 (starts_computation_year, next_computation_year_end).
    ctx.events.append({ type: "escrow.analysis.approved", loanId: ctx.loanId, actor: ctx.actor, payload: { analysis_id: analysisId, analysis_type: a.analysis_type, as_of: a.as_of, decision: d.kind, surplus_cents: String(surplus), borrower_current: current, computation_year_end: a.computation_year_end, next_computation_year_end: a.next_computation_year_end, starts_computation_year: startsYear, reset: a.reset, short_year_end: a.short_year_end, triggers } });
    // 3.2 timer table: `escrow.account.established` arms the recurring REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45 and REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL — the initial / transfer-in analysis is the account's establishment on this platform.
    if (a.analysis_type === "initial" || a.analysis_type === "transfer_in") ctx.events.append({ type: "escrow.account.established", loanId: ctx.loanId, actor: ctx.actor, payload: { reason: a.analysis_type, established_at: a.as_of, computation_year_start: a.year_start, next_computation_year_end: a.next_computation_year_end, analysis_id: analysisId } });
    return rt.store.put("escrow_analyses", analysisId, { status: "approved", approved_at: ctx.now, surplus_cents: surplus, borrower_current: current, triggers }, ctx.actor, ctx.now).data;
  }),
    decision: (i, _o, ctx) => ({ action: "escrow.analysis.approved", rationale: str(i, "rationale") || `analysis ${str(i, "analysis_id")} approved by ${ctx.actor.kind}:${ctx.actor.id}${flag(i, "reviewed") ? " after anomaly review" : ""}`, subject: { kind: "escrow_analysis", id: str(i, "analysis_id") } }),
    guardrails: [never("ENGINE_OUTPUTS_IMMUTABLE", "3.1 guardrails: the agent cannot edit engine outputs; overrides only via escrow_line corrections with a documented source", (i) => i.changes !== undefined && Object.keys(i.changes).some((k) => ["base_payment_cents", "cushion_cents", "target_at_start_cents"].includes(k)), "engine outputs are not editable; correct the escrow line with a documented source"),
      guard("ENGINE_ANALYSIS_REQUIRED", "3.2 guardrails: the engine is deterministic TypeScript; the agent approves the engine's analysis, not its own", (i, ctx) => (completedAnalysis(i, ctx) ? undefined : `no engine analysis ${str(i, "analysis_id") || "(analysis_id missing)"} on this loan: runEscrowAnalysis first`)),
      analysisGate("3.4.cushionCap", "REGX_1024_17C5_CUSHION_CAP_GATE", "cap_check_passed", "cap_ok"), analysisGate("3.4.preaccrual", "REGX_1024_17C6_PREACCRUAL_GATE", "preaccrual_check_passed", "preaccrual_ok")] },
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
  // 3.3 renderStatement: the state machine's `due` step — the (i)(2) exemption test over the engine's facts records the hold (REGX_1024_17I_ANNUAL_STMT_30 satisfier) or assembles the statement; ./section3-3.ts.
  { ...renderStatement, handler: renderAnnualStatement_3_3 },
  { name: "validateChecklist", kind: "act", handler: compute((i, _c, rt) => { const reg = rt.notices; if (!reg) throw new RangeError("notices not wired"); const v = reg.template(str(i, "template_code")); const version = (i.version as Parameters<typeof evaluateChecklist>[0] | undefined); if (!version) return { template: v.code, checked: false }; const payload = (i.payload as Record<string, unknown>) ?? {}; return evaluateChecklist(version, payload, render(version.source, payload)); }) },
  sendNotice,
]);
/** 3.4 open question 1 default: 2 months, "with a hardship-lowering tool" — a lower cushion is a policy override recorded in agent_decisions. */
const DEFAULT_CUSHION_MONTHS = 2;
const requestedCushionMonths = (i: ToolInput): number | undefined => { const m = (i.cushion as CushionInputs | undefined)?.policy_months; return typeof m === "number" ? m : undefined; };
const p34: ToolDef[] = defineTools("3.4", "escrow", [
  { name: "validateCushion", kind: "act", handler: compute((i, ctx) => {
    const cu = (i.cushion as CushionInputs) ?? {}; const months = requestedCushionMonths(i); const items = (i.items as ProjectedItem[] | undefined) ?? []; const loanId = str(i, "loan_id") || ctx.loanId;
    // With the boarding file's projected lines the whole module runs (rules 2–5: cap, aggregate low point, pre-accrual); with only the annual figure the cushion arithmetic alone (rules 1–2).
    if (items.length && !str(i, "year_start")) throw new RangeError("year_start is required to project the boarding file's items");
    const pr = items.length ? project(items, D(str(i, "year_start")), cu, { biweekly: flag(i, "biweekly") }) : null;
    if (!pr && cents(i.annual_cents) <= 0n) throw new RangeError("annual_cents (or projected items with year_start) is required to validate a cushion");
    const c = cushion(pr ? pr.annual_for_cushion_cents : cents(i.annual_cents), cu);
    // 3.4 Outputs / ESC_INHERITED_CUSHION_CHECK_10BD: the validator's `escrow.cushion.validated` (and `escrow.cushion.cap_failed` with reason) loan_events.
    const check = recordCushionCheck(ctx.events, pr ? checkFromProjection(pr, { loan_id: loanId, analysis_id: str(i, "analysis_id") || null, source: "boarding_validator", cushion_months: c.months, actor: ctx.actor })
      : { loan_id: loanId, analysis_id: str(i, "analysis_id") || null, source: "boarding_validator", cushion_months: c.months, cushion_cents: c.cents, cushion_cap_source: c.source, cushion_cap_cents: c.cap_cents, lowest_target_cents: null, cap_check_passed: c.cents <= c.cap_cents, preaccrual_check_passed: null, actor: ctx.actor });
    // Rule 8 (inherited cushion at transfer-in): a transferor target implying a cushion above the cap is a surplus the `transfer_in` analysis recomputes and handles under (f).
    const transferor = i.transferor_target_cents !== undefined ? cents(i.transferor_target_cents) : null;
    const inherited = pr && transferor !== null ? { transferor_target_cents: transferor, implied_cushion_cents: transferor - pr.required_start_cents, over_cap: transferor - pr.required_start_cents > pr.cap_cents, transfer_in_analysis_required: transferor - pr.required_start_cents > pr.cap_cents } : null;
    // The spec's setCushionPolicy(loan_id, months, reason) is not a tool the agents manifest lists for 3.4, so the override travels with the validation: the decision record below carries the reason.
    return { ...c, cap_check_passed: !check.reasons.includes("cushion_cap_failed"), preaccrual_check_passed: pr ? pr.preaccrual_ok : null,
      lowest_target_cents: pr ? pr.targets.reduce((a, b) => (b < a ? b : a)) : null, reasons: check.reasons, event_type: check.cap_failed ? check.cap_failed.type : check.validated.type, inherited,
      policy_override: months !== undefined && months < DEFAULT_CUSHION_MONTHS ? { months, reason: str(i, "reason"), basis: "§1024.17(c) permits a lower or no cushion; 3.4 agent design (hardship request)" } : null };
  }),
    decision: (i, out) => { const o = out as { cents: bigint; months: number; cap_cents: bigint; policy_override: { months: number; reason: string } | null }; return o.policy_override ? { action: "cushion.override", rationale: o.policy_override.reason, ruleCode: "3.4 agent design: policy override ≤ cap, recorded in agent_decisions", ...(str(i, "loan_id") ? { subject: { kind: "loan", id: str(i, "loan_id") } } : {}) } : { action: "cushion.validated", rationale: `cushion ${o.months} months = ${o.cents} cents (cap ${o.cap_cents})` }; },
    guardrails: [never("OVERRIDE_NEEDS_REASON", "3.4 agent design: the agent may lower the cushion for a loan only via a policy override recorded in agent_decisions (e.g., hardship request)", (i) => { const m = requestedCushionMonths(i); return m !== undefined && m < DEFAULT_CUSHION_MONTHS && !str(i, "reason"); }, "a cushion below the 2-month policy needs a recorded reason (hardship request, borrower letter …)"),
      never("NO_DISCRETION_OVER_CAP", "3.4 agent design: no discretion over the cap — setCushionPolicy months ≤ cap (1/6 of annual = 2 months)", (i) => { const m = requestedCushionMonths(i); return m !== undefined && m > DEFAULT_CUSHION_MONTHS; }, "the cushion cannot exceed 1/6 of annual disbursements (§1024.17(c)(5))")] },
]);
/** The engine-computed refund amount for a kind: the approved analysis's surplus (surplus_refund) or the closure's refund (waiver_refund); null when no engine figure exists on the loan. */
const engineRefundCents = (i: ToolInput, ctx: CommandContext): { kind: string; engine: bigint | null; source: string } => {
  const kind = str(i, "kind") || "surplus_refund";
  if (kind === "surplus_refund") { const id = str(i, "analysis_id"); const e = latest(loanEvents(ctx, "escrow.analysis.approved").filter((x) => (!id || p(x).analysis_id === id) && p(x).decision === "refund")); return { kind, engine: e ? BigInt(String(p(e).surplus_cents ?? "0")) : null, source: "escrow.analysis.approved.surplus_cents" }; }
  if (kind === "waiver_refund") { const e = latest(loanEvents(ctx, "escrow.account.closed")); const v = e ? p(e).refund_cents : undefined; return { kind, engine: v === undefined || v === null ? null : BigInt(String(v)), source: "escrow.account.closed.refund_cents" }; }
  // 3.5 rule 1: a payoff refund is the escrow balance after the payoff posting less every in-flight item that was paid (ops-3-5.ts); the caller's engine_amount_cents only when no balance is stated.
  if (kind === "payoff_refund" && i.escrow_balance_after_payoff_cents !== undefined) { try { return { kind, engine: payoffRefundCents(cents(i.escrow_balance_after_payoff_cents), inFlight(i.in_flight)), source: "escrow_balance_after_payoff_cents − paid in-flight disbursements" }; } catch (e) { return { kind, engine: null, source: (e as Error).message }; } }
  return { kind, engine: i.engine_amount_cents !== undefined ? cents(i.engine_amount_cents) : null, source: "engine_amount_cents" };
};
/** The payoff posting date for a 3.5 payoff refund: the caller's `payoff_date`, else the loan's latest `loan.paid_in_full` (16.2 `payoff_date`; `posted_on`/`event_on` from older emitters), else today. */
const payoffPostedOn = (i: ToolInput, ctx: CommandContext): PlainDate => { const e = latest(loanEvents(ctx, "loan.paid_in_full")); const d = str(i, "payoff_date") || String(e ? p(e).payoff_date ?? p(e).posted_on ?? p(e).event_on ?? "" : ""); return /^\d{4}-\d{2}-\d{2}/.test(d) ? D(d.slice(0, 10)) : today(ctx); };
const p35: ToolDef[] = defineTools("3.5", "escrow", [
  { name: "issueRefund", kind: "act", handler: compute((i, ctx, rt) => {
    const r = scheduleRefund(str(i, "loan_id") || ctx.loanId, cents(i.amount_cents), D(str(i, "due_on") || ctx.now.slice(0, 10)));
    for (const a of approvers(i)) approveRefund(r, a);   // approveRefund accepts only distinct human officers — no role is minted here
    // ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD: a payoff refund settles the in-flight tax/insurance items first (3.5 rule 1) — `escrow.final_disbursements.settled` is the gate's satisfying fact (ops-3-5.ts).
    if (str(i, "kind") === "payoff_refund") settleFinalDisbursements(ctx.events, { loan_id: r.loan_id, payoff_date: payoffPostedOn(i, ctx), today: today(ctx), escrow_balance_after_payoff_cents: i.escrow_balance_after_payoff_cents !== undefined ? cents(i.escrow_balance_after_payoff_cents) : r.amount_cents, in_flight: inFlight(i.in_flight), actor: ctx.actor });
    issueRefund(r, today(ctx), str(i, "check_no") || `CHK-${ctx.now}`);
    rt.store.put("refunds", `${r.loan_id}:${r.due_on}`, r as unknown as Record<string, unknown>, ctx.actor, ctx.now);
    // REGX_1024_17F2_SURPLUS_REFUND_30 / REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD / ESC_WAIVER_REFUND_30 are satisfied by `disbursement.issued{kind}`.
    ctx.events.append({ type: "disbursement.issued", loanId: r.loan_id, actor: ctx.actor, payload: { kind: str(i, "kind") || "surplus_refund", amount_cents: String(r.amount_cents), method: str(i, "method") || "check", payee_kind: str(i, "payee_kind"), check_no: r.check_no ?? null, issued_on: r.issued_on ?? null, due_on: r.due_on, analysis_id: str(i, "analysis_id") || null, approvals: r.approvals } });
    return r;
  }),
    guardrails: [
      // ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD breach column: "refund waits for settlement of in-flight items but never beyond the 20-BD deadline".
      guard("FINAL_DISBURSEMENTS_UNSETTLED", "3.5 timer table ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD: a payoff refund waits for the release or cancellation of in-flight tax/insurance disbursements, never beyond the 20-BD deadline", (i, ctx) => {
        if (str(i, "kind") !== "payoff_refund") return undefined;
        try { const h = finalDisbursementHold({ payoff_date: payoffPostedOn(i, ctx), today: today(ctx), in_flight: inFlight(i.in_flight) }); return h.refund_may_issue ? undefined : `in-flight disbursements ${h.unsettled.join(", ")} are not released or cancelled: the refund waits (gate opens ${h.gate_opens_on}; must issue by ${h.must_issue_by})`; } catch (e) { return (e as Error).message; }
      }),
      guard("ENGINE_AMOUNT", "3.5 guardrails: the refund amount is engine-computed; the agent cannot reduce it", (i, ctx) => {
        const { kind, engine, source } = engineRefundCents(i, ctx); const amount = cents(i.amount_cents);
        if (engine === null) return kind === "surplus_refund" ? "no approved refund decision on this loan: a surplus refund is the engine's `escrow.analysis.approved` surplus (approveAnalysis first)" : kind === "waiver_refund" ? "no `escrow.account.closed` with the engine's refund on this loan" : undefined;
        return amount === engine ? undefined : `refund ${amount} cents is not the engine-computed ${engine} cents (${source})`;
      }),
      never("PAYEE_IS_BORROWER", "3.5 guardrails: payee must be a borrower/confirmed successor (no third-party payees without a case and human review)", (i) => !["borrower", "confirmed_successor"].includes(str(i, "payee_kind")) && !(flag(i, "case_with_human_review") && !!str(i, "case_id")), "payee_kind must be borrower or confirmed_successor; a third-party payee needs a case (case_id) and human review"),
      guard("DUAL_APPROVAL", "3.5 guardrails: refunds > $25,000 or to a newly changed address require officer dual approval", (i, ctx) => (refundNeedsDualApproval(cents(i.amount_cents), flag(i, "address_changed_recently")) && !dualControlHolds(i, ctx, "refund > $25,000 or to a newly changed address") ? "officer dual approval missing: two distinct officer approvers (human, role officer) are required" : undefined)),
      // STATE_IOE_PAYOFF_PRORATE_0 breach column: "refund command blocked until posted" — a payoff/closure refund on an interest-on-escrow loan waits for the prorated credit (3.9 rule 5).
      guard("IOE_PRORATE_FIRST", "3.9 timer table STATE_IOE_PAYOFF_PRORATE_0: post accrued interest before the refund", (i, ctx) => { const kind = str(i, "kind"); const ioe = flag(i, "interest_on_escrow") || IOE_STATES.has(str(i, "state")); return (kind === "payoff_refund" || kind === "waiver_refund") && ioe && !loanEvents(ctx, "escrow.interest.credited").some((e) => p(e).prorated === true) ? "prorated interest-on-escrow credit not posted: prorateInterest before the refund (3.9 rule 5)" : undefined; })] },
  { name: "verifyAddress", kind: "act", handler: compute((i) => { const a = data(i); return { verified: !!a.line1 && /^\d{5}/.test(String(a.zip ?? "")), address: a }; }) },
  { name: "reissueDisbursement", kind: "act", handler: compute((i, ctx, rt) => { const rec = rt.store.get("refunds", str(i, "refund_id")); if (!rec) throw new RangeError("no refund"); const r = rec.data as unknown as ReturnType<typeof scheduleRefund>; const out = returnedRefund(r, D(str(i, "returned_on")), D(str(i, "address_verified_on")), today(ctx)); rt.store.put("refunds", str(i, "refund_id"), r as unknown as Record<string, unknown>, ctx.actor, ctx.now); return out; }) },
  { name: "stopCheck", kind: "act", handler: compute((i, ctx, rt) => { ctx.events.append({ type: "escrow.refund.check_stopped", loanId: ctx.loanId, actor: ctx.actor, payload: { check_no: str(i, "check_no"), reason: str(i, "reason") } }); return rt.store.put("refund_checks", str(i, "check_no"), { status: "stopped", reason: str(i, "reason") }, ctx.actor, ctx.now).data; }) },
  { name: "recordConsent", kind: "write", handler: write("consents", "consent.recorded") },
  { name: "emitEscrowEvent", kind: "act", handler: compute((i, ctx, rt) => {
    const r = rt.store.get("refunds", str(i, "refund_id"))?.data as unknown as ReturnType<typeof scheduleRefund> | undefined;
    if (r && i.new_loan) {
      const c = creditToNewLoan(r, i.consent as Parameters<typeof creditToNewLoan>[1], i.new_loan as Parameters<typeof creditToNewLoan>[2]);
      // REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD: "`disbursement.issued` (kind payoff_refund) or `escrow.credit_to_new_loan.posted`" — the credit is the payoff-refund disbursement with method credit_to_new_loan (3.5 data model).
      ctx.events.append({ type: "escrow.credit_to_new_loan.posted", loanId: r.loan_id, actor: ctx.actor, payload: { new_loan_id: (i.new_loan as { id: string }).id, amount_cents: String(r.amount_cents), posts_on: c.posts_on } });
      ctx.events.append({ type: "disbursement.issued", loanId: r.loan_id, actor: ctx.actor, payload: { kind: "payoff_refund", method: "credit_to_new_loan", amount_cents: String(r.amount_cents), payee_kind: "borrower", issued_on: c.posts_on, new_loan_id: (i.new_loan as { id: string }).id } });
      return c;
    }
    return escrowEvent.handler(i, ctx, rt);
  }), guardrails: escrowEvent.guardrails },
  escalateTool,
]);
// 3.6 (createRepaymentPlan / recordBorrowerElection / postEscrowLumpSum) lives in ./section3-6.ts (TOOLS_3_6, spread by ./index.ts): the plan, election and lump-sum ops append the facts the 3.6 timer rows arm on, and approveAnalysis above asserts the 3.6 gate rows ("analysis approval") through its assertAnalysisApprovalGates36.
// 3.7 (scheduleDisbursement / releaseDisbursement / postAdvance) lives in ./section3-7.ts (TOOLS_3_7, spread by ./index.ts): the bill, release, rail-status, escrow-event, attestation and non-escrow ops all append the facts the 3.7 timer rows arm on.

// ---- 3.8 waiver gates: facts derived from the rule-engine request, never from caller-supplied verdicts ----------------
const waiverRequest = (i: ToolInput): WaiverRequest | null => (i.request && typeof i.request === "object" ? (i.request as WaiverRequest) : null);
const linesToWaive = (i: ToolInput): string[] => (Array.isArray(i.waived_line_types) ? (i.waived_line_types as string[]) : ["tax", "hazard", "flood", "mi"]);
const waiverFacts = (r: WaiverRequest, i: ToolInput, ctx: CommandContext): Record<string, unknown> => ({
  hpml: r.hpml, consummation_date: r.consummation_date ?? "", today: today(ctx),
  ltv_bps: r.original_property_value_cents && r.original_property_value_cents > 0n ? Number((r.upb_cents * 10_000n) / r.original_property_value_cents) : 0, regx_days_delinquent: r.regx_days_delinquent,
  flood_escrow_mandatory: r.flood_escrow_mandatory, has_flood_line: linesToWaive(i).includes("flood"), borrower_paid_mi_monthly: r.monthly_mi_line && linesToWaive(i).includes("mi"),
});
/** A registry gate evaluated on facts derived from the request; `when` limits it to the requests the row applies to. */
const waiverGate = (ref: string, citation: string, when: (r: WaiverRequest) => boolean = () => true) =>
  guard(ref, citation, (i, ctx) => { const r = waiverRequest(i); if (!r || !when(r)) return undefined; try { assertGate(ref, waiverFacts(r, i, ctx)); return undefined; } catch (e) { return (e as Error).message; } });

const p38: ToolDef[] = defineTools("3.8", "escrow", [
  // The evaluation on a case (waiver_id) records the case opened (`escrow.waiver.requested`, ESC_WAIVER_DECISION_SLA_10BD from the request date), the engine run with its gate inputs (`escrow.waiver.evaluating`) and — rule outcomes being binding — the engine's denial as the decision (`escrow.waiver.decided`, rule 3). Without a waiver_id it is the engine alone.
  { name: "evaluateWaiver", kind: "act", handler: compute((i, ctx) => {
    const r = waiverRequest(i); if (!r) throw new RangeError("evaluateWaiver needs request (3.8 WaiverRequest)");
    const waiverId = str(i, "waiver_id");
    if (waiverId) recordWaiverRequest(ctx.events, { loan_id: ctx.loanId, waiver_id: waiverId, request: r }, ctx.actor);
    const { decision } = recordWaiverEvaluation(ctx.events, { loan_id: ctx.loanId, waiver_id: waiverId || null, request: r, waived_line_types: linesToWaive(i), evaluated_on: today(ctx) }, ctx.actor);
    if (waiverId && decision.decision === "denied") recordWaiverDenial(ctx.events, { loan_id: ctx.loanId, waiver_id: waiverId, decision, decided_on: today(ctx) }, ctx.actor);
    return decision;
  }) },
  { name: "approveWaiver", kind: "act", handler: compute((i, ctx, rt) => {
    const r = waiverRequest(i); if (!r) throw new RangeError("approveWaiver needs request (3.8 WaiverRequest) — the rule engine decides, not the caller");
    // The guardrails refused a denial before this runs; the stored decision is the engine's, dated from the approval (rule 2), not the input's. The case and the evaluation are recorded first (the SLA row and the evaluation gates the decision below closes).
    if (str(i, "waiver_id")) recordWaiverRequest(ctx.events, { loan_id: ctx.loanId, waiver_id: str(i, "waiver_id"), request: r }, ctx.actor);
    const d = recordWaiverEvaluation(ctx.events, { loan_id: ctx.loanId, waiver_id: str(i, "waiver_id") || null, request: r, waived_line_types: linesToWaive(i), evaluated_on: today(ctx) }, ctx.actor).decision;
    const waived = linesToWaive(i).filter((l) => !d.lines_kept.includes(l));
    const rec = rt.store.put("escrow_waivers", str(i, "waiver_id"), { decision: d.decision, scope: d.lines_kept.length ? "partial" : "full", waived_line_types: waived, lines_kept: d.lines_kept, kept_reasons: d.kept_reasons, effective_on: d.effective_on, state_right_applied: d.state_right_applied, overridden_fnma_reasons: d.reasons, basis: "B-1-01; 12 CFR 1026.35(b)(3); 12 CFR 22.5", approved_at: ctx.now, decided_at: ctx.now, requested_on: r.requested_on }, ctx.actor, ctx.now).data;
    ctx.events.append({ type: "escrow.waiver.decided", loanId: ctx.loanId, actor: ctx.actor, payload: { waiver_id: str(i, "waiver_id"), decision: d.decision, decided_on: today(ctx), effective_on: d.effective_on, lines_kept: d.lines_kept, state_right_applied: d.state_right_applied } });
    return rec;
  }),
    guardrails: [guard("RULE_OUTCOMES_BINDING", "3.8 guardrails: rule outcomes are binding; the agent cannot approve when a gate fails", (i, ctx) => { const r = waiverRequest(i); if (!r) return "approveWaiver needs the rule-engine request (3.8 WaiverRequest); a caller-supplied verdict is not evidence"; const d = evaluateWaiver(r, today(ctx)); return d.decision === "denied" ? `the rule engine denied the waiver (${d.reasons.join(", ")}); a state right (IL/MN) covers only the Fannie Mae tests, and counsel review is the only other path` : undefined; }),
      waiverGate("3.8.hpmlFiveYears", "REGZ_1026_35B3_HPML_ESCROW_5Y_GATE"),
      waiverGate("3.8.hpmlLtvAndCurrent", "REGZ_1026_35B3_HPML_LTV_GATE", (r) => r.hpml),
      waiverGate("3.8.floodEscrowMandatory", "FLOOD_12CFR22_5_ESCROW_GATE"),
      waiverGate("3.8.miMonthlyEscrowRequired", "FNMA_B101_MI_MONTHLY_ESCROW_GATE")] },
]);

// ---- 3.9: the rate in effect is resolved from the jurisdiction rule and the latest verified observation on the bus, never from a caller-supplied rate ----
const ioeFacts = (i: ToolInput): LoanFacts => ({
  state: str(i, "state"), origination_date: D(str(i, "origination_date") || "2020-01-01"),
  ...(typeof i.origination_ltv_pct === "string" ? { origination_ltv_pct: i.origination_ltv_pct } : {}), ...(i.pmi_active !== undefined ? { pmi_active: flag(i, "pmi_active") } : {}), ...(i.escrow_imposed_for_default !== undefined ? { escrow_imposed_for_default: flag(i, "escrow_imposed_for_default") } : {}),
  ...(i.pmi_terminated_on ? { pmi_terminated_on: D(str(i, "pmi_terminated_on")) } : {}), ...(i.tax_annual_cents !== undefined ? { tax_annual_cents: cents(i.tax_annual_cents) } : {}), ...(i.total_annual_cents !== undefined ? { total_annual_cents: cents(i.total_annual_cents) } : {}),
});
/** The latest `jurisdiction.rate_observation.verified` for the state (verifyRate) as the observation resolveRate consumes — CT deposit index, WI DFI publication, MA/VT/RI policy rate. */
const verifiedObservation = (ctx: CommandContext, state: string): Parameters<typeof resolveRate>[1] => { const e = latest(ctx.events.ofType("jurisdiction.rate_observation.verified").filter((x) => p(x).state === state)); const v = e ? String(p(e).rate_pct) : undefined; return v === undefined ? {} : { index_pct: v, published_pct: v, policy_rate_pct: v }; };
const rateInEffect = (i: ToolInput, ctx: CommandContext): string => resolveRate(ioeFacts(i), verifiedObservation(ctx, str(i, "state")));
/** Fixed statutory rates a raw observation can never undercut (NY 2%, MN 3%); CT's observation is the deposit index that resolveRate floors at 1.5%. */
const FIXED_RATE_PCT: Record<string, number> = { NY: 2, MN: 3 };
const ioeLedger = (amt: bigint) => [{ dr: "escrow_interest_expense", cr: "loan.escrow", amount_cents: amt, rule_ref: "3.9 rule 4" }];
const ELIGIBLE = guard("ELIGIBLE", "3.9 rule 1: eligibility from loan data (state, property/entity scope, exemptions)", (i, ctx) => { const ex = ioeExemptionOn(ioeFacts(i), i.as_of ? D(str(i, "as_of")) : today(ctx)); return ex ? `not eligible for interest on escrow: ${ex}` : undefined; });
const VERIFIED_ONLY = guard("VERIFIED_ONLY", "3.9 guardrails: rates only from verified observations; the agent cannot lower a statutory minimum", (i, ctx) => {
  if (i.rate_pct === undefined || i.rate_pct === null) return undefined;
  const f = ioeFacts(i); const min = statutoryMinimumPct(f); if (Number(i.rate_pct) < Number(min)) return `rate ${String(i.rate_pct)}% is below the ${f.state} statutory minimum ${min}%`;
  const inEffect = rateInEffect(i, ctx); return Number(i.rate_pct) === Number(inEffect) ? undefined : `rate ${String(i.rate_pct)}% is not the verified rate in effect for ${f.state} (${inEffect}%): rates come from verified observations, not the caller`;
});
const NO_FEES = never("NO_FEES", "3.9 guardrails: no fees", (i) => cents(i.fee_cents) > 0n, "no fees for escrow administration");
const p39: ToolDef[] = defineTools("3.9", "escrow", [
  { name: "evaluateInterestEligibility", kind: "act", handler: compute((i, ctx) => {
    if (!i.facts) throw new RangeError("evaluateInterestEligibility needs facts {state, origination_date, …}");
    const f = i.facts as LoanFacts; const asOf = i.as_of ? D(str(i, "as_of")) : today(ctx); const ex = ioeExemptionOn(f, asOf);
    // 3.9 edge case: RI PMI cancellation — recompute on `pmi.terminated`; accrual starts the day after the termination.
    return { eligible: ex === null, exemption: ex, as_of: asOf, ...(f.pmi_terminated_on ? { pmi_termination: pmiTerminationRecompute(f, f.pmi_terminated_on) } : {}) };
  }) },
  { name: "verifyRate", kind: "act", handler: compute((i, ctx, rt) => { const r = rateObservation({ state: str(i, "state"), expected_on: D(str(i, "expected_on")), observed_pct: (i.observed_pct as string | null) ?? null, prior_verified_pct: str(i, "prior_verified_pct"), accrued_at_prior_cents: cents(i.accrued_at_prior_cents), base_cents: cents(i.base_cents), days: num(i, "days") || 0 }); if (r.escalation) rt.escalations.open({ kind: "sev2", loanId: ctx.loanId, payload: { reason: `rate observation missing for ${str(i, "state")}` } }, ctx.actor); else ctx.events.append({ type: "jurisdiction.rate_observation.verified", actor: ctx.actor, payload: { state: str(i, "state"), rate_pct: r.rate_in_effect_pct, expected_on: str(i, "expected_on"), verified_on: today(ctx) } }); return r; }),
    guardrails: [never("VERIFIED_ONLY", "3.9 guardrails: rates only from verified observations; the agent cannot lower a statutory minimum", (i) => { if (i.observed_pct === undefined || i.observed_pct === null) return false; const min = i.statutory_min_pct !== undefined ? Number(i.statutory_min_pct) : FIXED_RATE_PCT[str(i, "state")]; return min !== undefined && Number(i.observed_pct) < min; }, "below the statutory minimum")] },
  { name: "postInterestCredit", kind: "act", handler: compute((i, ctx) => {
    const state = str(i, "state"); const rate = rateInEffect(i, ctx); const creditedOn = i.credited_on ? D(str(i, "credited_on")) : today(ctx);
    const balances = Array.isArray(i.balances) ? (i.balances as bigint[]) : null; const days = balances ? balances.length : num(i, "days") || 0;
    const amt = balances ? accrueDaily(balances, rate) : accrue(cents(i.avg_daily_balance_cents), rate, days);
    // STATE_IOE_ACCRUAL_DAILY: the accrual rows for the days credited (daily summary); then the credit (3.9 rule 4: Dr escrow_interest_expense / Cr escrow, "Interest on Escrow" deposit event via 3.7).
    ctx.events.append({ type: "escrow.interest.accrued", loanId: ctx.loanId, actor: ctx.actor, payload: { state, rate_pct: rate, days, accrued_cents: String(amt), basis: balances ? "daily" : "average_daily", through: creditedOn } });
    ctx.events.append({ type: "escrow.interest.credited", loanId: ctx.loanId, actor: ctx.actor, payload: { state, amount_cents: String(amt), rate_pct: rate, days, credited_on: creditedOn, prorated: false } });
    return { credited_cents: amt, rate_pct: rate, days, credited_on: creditedOn, scheduled_crediting_date: nextCreditingDate(state, creditedOn), ledger: ioeLedger(amt), escrow_event: { item: "Interest on Escrow", amount_cents: amt } };
  }),
    guardrails: [NO_FEES, ELIGIBLE, VERIFIED_ONLY] },
  { name: "prorateInterest", kind: "act", handler: compute((i, ctx) => {
    const state = str(i, "state"); const rate = rateInEffect(i, ctx); const days = num(i, "days") || 0; const on = i.event_on ? D(str(i, "event_on")) : today(ctx);
    const amt = accrue(cents(i.avg_daily_balance_cents), rate, days);
    // 3.9 rule 5 / STATE_IOE_PAYOFF_PRORATE_0: accrued-to-date interest is posted before the refund/transfer; `posted_before_refund` is a fact of the loan's events, not a constant.
    const refundIssued = loanEvents(ctx, "disbursement.issued").some((e) => p(e).kind === "payoff_refund" || p(e).kind === "waiver_refund");
    ctx.events.append({ type: "escrow.interest.prorated", loanId: ctx.loanId, actor: ctx.actor, payload: { state, amount_cents: String(amt), rate_pct: rate, days, event: str(i, "event") || "loan.paid_in_full", event_on: on } });
    ctx.events.append({ type: "escrow.interest.credited", loanId: ctx.loanId, actor: ctx.actor, payload: { state, amount_cents: String(amt), rate_pct: rate, days, credited_on: on, prorated: true } });
    return { prorated_cents: amt, rate_pct: rate, days, credited_on: on, posted_before_refund: !refundIssued, ledger: ioeLedger(amt), escrow_event: { item: "Interest on Escrow", amount_cents: amt } };
  }),
    guardrails: [NO_FEES, ELIGIBLE, VERIFIED_ONLY] },
]);

export const SECTION_03_TOOLS: readonly ToolDef[] = [...p31, ...p32, ...p33, ...p34, ...p35, ...p38, ...p39];
