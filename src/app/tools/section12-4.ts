/**
 * §12.4 process-owned tools — additional bus tools for 12.4 defined with `defineTools("12.4", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section12.ts). Every tool string is one
 * spec/registry/agents.json names for 12.4; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * All nine 12.4 tool strings are already bound in ./section12.ts, so the 12.4 ops live here as the handlers those
 * entries call (thin shells over src/domain/lossmit/ops-12-4.ts, which owns the event vocabulary):
 *   forbearanceOps_12_4 — `workout_plan.*` op ∈ {term, schedule, payment, month_end_check, expiry_sweep, month_end, prescreen};
 *   contactsOps_12_4 — `contacts.*` (list / log → `contact.attempted{purpose}`; `qrpc_achieved=true` → `contact.qrpc.established` + the same-day pre-screen);
 *   exceptionRequestOps_12_4 — `exception_request.prepare` op ∈ {prepare (default), submit, decide};
 *   statusCodeOps_12_4 — `fnma.status_code.report` (default: the legacy 09 line unless `smdu.plan_cases=on`; op=ack: the 5.x acknowledgement → `investor.event.accepted{status_code}`);
 *   feesSuppressOps_12_4 — `fees.suppress` (default: suppress; op=lift: late charges from the default date only);
 *   emitTermCreate_12_4 — the initial-activation path's `workout_plan.term.create` (the gate rows arm on it).
 */
import { str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, endOfMonth, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { evaluateGate } from "../evaluators.ts";
import { forbearanceTermDates } from "../../domain/lossmit/plans.ts";
import type { RegxBasis } from "../../domain/lossmit/ops.ts";
import { createForbearanceTerm, buildSchedule, applyScheduledPayment, monthEndScheduleCheck, expirySweep, qrpcOnOutreach, preExpiryPrescreen, monthEndStatus, validateStatusCodeAck, ingestStatusCodeAck, prepareExceptionPackage, submitExceptionRequest, validateExceptionDecision, recordExceptionDecision, liftLateChargeSuppression, type ScheduleRow, type ActivePlan, type PrescreenFacts, type Emitter } from "../../domain/lossmit/ops-12-4.ts";

export const TOOLS_12_4: readonly ToolDef[] = [];

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const em = (ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const todayOf = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const optBool = (i: ToolInput, k: string): boolean | undefined => (typeof i[k] === "boolean" ? (i[k] as boolean) : undefined);
const asCents = (v: unknown): Cents => cents(v);
const scheduleKey = (planId: string, due: string): string => `${planId}:${due}`;
const scheduleRow = (d: Record<string, unknown>): ScheduleRow => ({ plan_id: String(d.plan_id), due_date: D(String(d.due_date)), expected_amount_cents: asCents(d.expected_amount_cents), received_amount_cents: asCents(d.received_amount_cents), received_at: (d.received_at as string | null | undefined) ?? null, status: d.status as ScheduleRow["status"], month_end: D(String(d.month_end)) });
const rowData = (r: ScheduleRow): Record<string, unknown> => ({ ...r, expected_amount_cents: r.expected_amount_cents.toString(), received_amount_cents: r.received_amount_cents.toString() });
const activePlans = (rt: ToolRuntime, loanId: string): ActivePlan[] => rt.store.list("workout_plans", (d) => d.loan_id === loanId && d.status === "active" && d.kind === "forbearance" && typeof d.term_start === "string" && typeof d.term_end === "string").map((r) => ({ plan_id: r.id, status: String(r.data.status), term_start: D(String(r.data.term_start)), term_end: D(String(r.data.term_end)), kind: "forbearance" }));
const prescreenFacts = (i: ToolInput, plan: Record<string, unknown> | undefined): PrescreenFacts => ({ hardship_resolved: flag(i, "hardship_resolved"), can_reinstate: flag(i, "can_reinstate"), can_afford_repayment: flag(i, "can_afford_repayment"), months_delinquent: num(i, "months_delinquent") || 0, deferral_eligible: optBool(i, "deferral_eligible") ?? null, cumulative_months: num(i, "cumulative_months") || Number(plan?.cumulative_months ?? 0), months_delinquent_at_next_start: num(i, "months_delinquent_at_next_start") || num(i, "months_delinquent") || 0, ...(num(i, "requested_months") ? { requested_months: num(i, "requested_months") } : {}), start_on: optDate(i, "start_on"), last_scheduled_payment_date: optDate(i, "last_scheduled_payment_date"), mbs: flag(i, "mbs") });
/** The four 12.4 gate rows (+ the 12.5 combined guard) re-evaluated on the term facts the event carries — the registry, not the handler, is the source of the caps. */
const GATES = ["12.4.incrementMax3Months", "12.4.cumulativeMax12Months", "12.4.projectedDelinquencyMax12Months", "12.5.combinedMax36Months"] as const;
const gateReport = (facts: Record<string, unknown>): Record<string, { open: boolean; reason?: string }> => { const out: Record<string, { open: boolean; reason?: string }> = {}; for (const g of GATES) out[g] = evaluateGate(g, facts); if (facts.mbs === true) out["12.4.termEndBeforeLastScheduledPayment"] = evaluateGate("12.4.termEndBeforeLastScheduledPayment", facts); return out; };

/** The initial activation in ./section12.ts: the term guards' trigger event, from the term the calculator chose. */
export function emitTermCreate_12_4(i: ToolInput, ctx: CommandContext, term: { months: number; capped_by: string[]; exception_required: boolean }, dates: { start: PlainDate; end: PlainDate }): void {
  const cumulative = num(i, "cumulative_months") || 0; const delinquent = num(i, "months_delinquent_at_start") || 0; const repay = num(i, "repayment_component_months") || 0;
  ctx.events.append({ type: "workout_plan.term.create", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { plan_id: str(i, "id") || `wp-${str(i, "loan_id")}-${dates.start}`, term_no: num(i, "term_no") || 1, kind: "forbearance", term_months: term.months, requested_months: num(i, "requested_months") || term.months, cumulative_months: cumulative, cumulative_months_after: cumulative + term.months, initial_start_date: str(i, "initial_start_date") || dates.start, months_delinquent_at_start: delinquent, projected_months_delinquent_at_term_end: delinquent + term.months, term_start: dates.start, term_end: dates.end, mbs: flag(i, "mbs"), last_scheduled_payment_date: str(i, "last_scheduled_payment_date") || null, forbearance_component: true, repayment_component_months: repay, combined_months: cumulative + term.months + repay, capped_by: [...term.capped_by], approved_by: flag(i, "fnma_exception_approved") ? "fnma_exception" : "agent", exception_request_id: str(i, "exception_request_id") || null, regx_short_term: cumulative + term.months <= 6, regx_basis: str(i, "regx_basis") || null } });
}

export function forbearanceOps_12_4(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const loanId = str(i, "loan_id"); const e = em(ctx);
  switch (i.op) {
    case "term": {
      need(i, "id", "start_on"); if (!num(i, "term_months") && !num(i, "requested_months")) throw new RangeError("term_months (explicit term) or requested_months (offer construction) is required");
      const plan = rt.store.get("workout_plans", str(i, "id")); const start = date(i, "start_on");
      const priorTerms = rt.store.list("workout_plan_terms", (d) => d.plan_id === str(i, "id"));
      const termNo = num(i, "term_no") || priorTerms.length + 1;
      const cumulative = i.cumulative_months === undefined ? priorTerms.reduce((s, t) => s + Number(t.data.months ?? 0), 0) : num(i, "cumulative_months");
      const initialStart = optDate(i, "initial_start_date") ?? (plan?.data.initial_start_date ? D(String(plan.data.initial_start_date)) : start);
      // LL-2026-01: the 12-month caps yield only to a recorded `fnma_exception_requests.decision=approved` (op=decide below), never to a flag alone.
      const exc = str(i, "exception_request_id") ? rt.store.get("fnma_exception_requests", str(i, "exception_request_id")) : undefined;
      const approved = exc?.data.decision === "approved";
      const t = createForbearanceTerm(e, { loan_id: loanId, plan_id: str(i, "id"), term_no: termNo, requested_months: num(i, "requested_months") || num(i, "term_months"), ...(num(i, "term_months") ? { term_months: num(i, "term_months") } : {}), cumulative_months: cumulative, months_delinquent_at_start: num(i, "months_delinquent_at_start") || 0, start_on: start, initial_start_date: initialStart, mbs: flag(i, "mbs") || Boolean(plan?.data.mbs), last_scheduled_payment_date: optDate(i, "last_scheduled_payment_date") ?? (plan?.data.last_scheduled_payment_date ? D(String(plan.data.last_scheduled_payment_date)) : null), repayment_component_months: num(i, "repayment_component_months") || 0, regx_basis: (i.regx_basis as RegxBasis | undefined) ?? null, exception_approved: approved, exception_request_id: exc?.id ?? null, disaster: flag(i, "disaster") || plan?.data.disaster === true });
      const gates = gateReport(t.events[0]!.payload as Record<string, unknown>);
      rt.store.put("workout_plan_terms", `${t.plan_id}-t${t.term_no}`, { plan_id: t.plan_id, term_no: t.term_no, term_start: t.term_start, term_end: t.term_end, months: t.months, approved_by: t.approved_by, regx_short_term: t.regx_short_term, regx_basis: t.regx_basis, exception_request_id: exc?.id ?? null, notice_id: str(i, "notice_id") || null }, ctx.actor, ctx.now);
      const rec = rt.store.put("workout_plans", t.plan_id, { loan_id: loanId, kind: "forbearance", plan_type: "forbearance", status: "active", term_no: t.term_no, term_start: t.term_start, term_end: t.term_end, current_term_end: t.term_end, months: t.months, cumulative_months: t.cumulative_months_after, initial_start_date: initialStart, delinquency_months_at_start: num(i, "months_delinquent_at_start") || 0, projected_delinquency_at_end: t.projected_months_delinquent_at_term_end, payment_mode: str(i, "payment_mode") || String(plan?.data.payment_mode ?? "suspended"), ...(i.reduced_amount_cents !== undefined ? { reduced_amount_cents: asCents(i.reduced_amount_cents).toString() } : {}), regx_short_term: t.regx_short_term, regx_basis: t.regx_basis, capped_by: [...t.computation.capped_by], mbs: flag(i, "mbs") || plan?.data.mbs === true, ...(str(i, "last_scheduled_payment_date") ? { last_scheduled_payment_date: str(i, "last_scheduled_payment_date") } : {}), late_charges_suppressed: true, preexpiry_outreach_begin_by: t.preexpiry_outreach_begin_by, exception_request_id: exc?.id ?? null, disaster: flag(i, "disaster") || plan?.data.disaster === true }, ctx.actor, ctx.now);
      return { ...rec.data, term: { term_no: t.term_no, months: t.months, term_start: t.term_start, term_end: t.term_end, approved_by: t.approved_by }, computation: t.computation, regx_short_term: t.regx_short_term, regx_basis: t.regx_basis, gates };
    }
    case "schedule": {
      need(i, "id"); const plan = rt.store.require("workout_plans", str(i, "id"));
      const mode = (str(i, "payment_mode") || String(plan.data.payment_mode ?? "suspended")) as "suspended" | "reduced";
      const amount = i.reduced_amount_cents !== undefined ? asCents(i.reduced_amount_cents) : plan.data.reduced_amount_cents !== undefined && plan.data.reduced_amount_cents !== null ? asCents(plan.data.reduced_amount_cents) : null;
      const s = buildSchedule(e, { loan_id: loanId, plan_id: plan.id, term_start: optDate(i, "term_start") ?? D(String(plan.data.term_start)), term_end: optDate(i, "term_end") ?? D(String(plan.data.term_end)), payment_mode: mode, reduced_amount_cents: amount });
      rt.store.put("workout_plans", plan.id, { payment_mode: mode, ...(amount !== null ? { reduced_amount_cents: amount.toString() } : {}) }, ctx.actor, ctx.now);
      for (const r of s.rows) rt.store.put("workout_plan_schedule", scheduleKey(plan.id, r.due_date), rowData(r), ctx.actor, ctx.now);
      return { plan_id: plan.id, payment_mode: mode, rows: s.rows.map(rowData) };
    }
    case "payment": {
      need(i, "id", "due_date", "amount_cents", "payment_id");
      const row = scheduleRow(rt.store.require("workout_plan_schedule", scheduleKey(str(i, "id"), str(i, "due_date"))).data);
      const r = applyScheduledPayment(e, { loan_id: loanId, row, amount_cents: asCents(i.amount_cents), payment_id: str(i, "payment_id"), received_at: str(i, "received_at") || ctx.now });
      rt.store.put("workout_plan_schedule", scheduleKey(row.plan_id, row.due_date), rowData(r.row), ctx.actor, ctx.now);
      return { ...rowData(r.row), met: r.row.status === "met" };
    }
    case "month_end_check": {
      need(i, "id", "mitigating_check_id"); const plan = rt.store.require("workout_plans", str(i, "id"));
      const rows = rt.store.list("workout_plan_schedule", (d) => d.plan_id === plan.id).map((r) => scheduleRow(r.data));
      const out = monthEndScheduleCheck(e, { loan_id: loanId, plan_start: D(String(plan.data.term_start ?? plan.data.initial_start_date)), rows, as_of: optDate(i, "as_of") ?? todayOf(ctx), mitigating_circumstances: flag(i, "mitigating_circumstances"), mitigating_check_id: str(i, "mitigating_check_id") });
      for (const r of out) rt.store.put("workout_plan_schedule", scheduleKey(r.row.plan_id, r.row.due_date), rowData(r.row), ctx.actor, ctx.now);
      rt.store.put("mitigating_circumstance_checks", str(i, "mitigating_check_id"), { loan_id: loanId, plan_id: plan.id, as_of: optDate(i, "as_of") ?? todayOf(ctx), mitigating_circumstances: flag(i, "mitigating_circumstances"), rows: out.map((r) => ({ due_date: r.row.due_date, status: r.row.status })) }, ctx.actor, ctx.now);
      return out.map((r) => ({ ...rowData(r.row), missed: r.missed, excused: r.excused, termination_review: r.termination_review, termination_notice: r.termination_notice, late_charges_from: r.late_charges_from }));
    }
    case "expiry_sweep": {
      const already = new Set(ctx.events.byLoan(loanId).filter((ev) => ev.type === "workout_plan.expiry_approaching").map((ev) => `${String(ev.payload.plan_id)}:${String(ev.payload.term_end)}`));
      return expirySweep(e, { loan_id: loanId, plans: activePlans(rt, loanId), as_of: optDate(i, "as_of") ?? todayOf(ctx), already_flagged: already }).map((ev) => ev.payload);
    }
    case "month_end": {
      const periodEnd = optDate(i, "period_end") ?? endOfMonth(todayOf(ctx)); const smdu = str(i, "smdu_plan_cases") === "on" ? "on" : "off";
      const existing = new Set(rt.store.list("smdu_plan_cases", (d) => d.loan_id === loanId).map((r) => String(r.data.plan_id)));
      const rows = monthEndStatus(e, { loan_id: loanId, plans: activePlans(rt, loanId), period_end: periodEnd, smdu_plan_cases: smdu, smdu_cases_existing: existing });
      for (const r of rows) if (r.smdu_case_created) { const c = rt.store.put("smdu_plan_cases", `smdu-${r.plan_id}`, { loan_id: loanId, plan_id: r.plan_id, workout: "forbearance", opened_period: r.period }, ctx.actor, ctx.now); rt.store.put("workout_plans", r.plan_id, { smdu_case_id: c.id }, ctx.actor, ctx.now); }
      return rows.map(({ event, ...r }) => ({ ...r, event_type: event?.type ?? null }));
    }
    case "prescreen": {
      need(i, "id"); const plan = rt.store.get("workout_plans", str(i, "id"));
      const r = preExpiryPrescreen(prescreenFacts(i, plan?.data)); const on = todayOf(ctx);
      ctx.events.append({ type: "workout_plan.prescreen.completed", loanId, actor: ctx.actor, payload: { plan_id: str(i, "id"), on, qrpc_contact_id: str(i, "qrpc_contact_id") || null, result: r.result, next_process: r.next_process, extension_months: r.extension_months } });
      return { ...r, on };
    }
    default: return undefined;
  }
}

export function contactsOps_12_4(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const loanId = str(i, "loan_id");
  if (i.op === "list") return rt.store.list("contacts").filter((r) => r.data.loan_id === loanId).map((r) => r.data);
  need(i, "loan_id", "mode", "purpose");
  const rec = rt.store.put("contacts", str(i, "id") || `ct-${loanId}-${ctx.now}`, { loan_id: loanId, mode: str(i, "mode"), purpose: str(i, "purpose"), direction: str(i, "direction") || "outbound", attempted_at: ctx.now, result: str(i, "result") || null, qrpc_achieved: flag(i, "qrpc_achieved") }, ctx.actor, ctx.now);
  ctx.events.append({ type: "contact.attempted", loanId, actor: ctx.actor, payload: { contact_id: rec.id, purpose: str(i, "purpose"), mode: str(i, "mode"), attempted_on: ctx.now.slice(0, 10), result: str(i, "result") || null } });
  if (!flag(i, "qrpc_achieved")) return rec.data;
  // D2-3.2-01: once QRPC is achieved the outreach cadence ends and the servicer determines hardship resolution, the borrower's intention and whether a complete BRP is needed — the rule 4 pre-screen runs the same day (T4).
  const plan = str(i, "plan_id") ? rt.store.get("workout_plans", str(i, "plan_id")) : rt.store.list("workout_plans", (d) => d.loan_id === loanId && d.status === "active" && d.kind === "forbearance").at(-1);
  const r = qrpcOnOutreach(em(ctx), { loan_id: loanId, plan_id: plan?.id ?? str(i, "plan_id"), contact_id: rec.id, purpose: str(i, "purpose"), intent: str(i, "intent") || "retain", brp_needed: flag(i, "brp_needed"), facts: prescreenFacts(i, plan?.data) });
  return { ...rec.data, qrpc_achieved: true, prescreen: r.prescreen };
}

export function exceptionRequestOps_12_4(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const loanId = str(i, "loan_id");
  if (i.op === "submit") {
    need(i, "loan_id", "id", "channel", "package_document_id"); const rec = rt.store.require("fnma_exception_requests", str(i, "id"));
    const r = submitExceptionRequest(em(ctx), { loan_id: loanId, exception_request_id: rec.id, channel: str(i, "channel"), package_document_id: str(i, "package_document_id"), requested_months: Number(rec.data.requested_months ?? num(i, "requested_months") ?? 0), submitted_on: optDate(i, "submitted_on") });
    return rt.store.put("fnma_exception_requests", rec.id, { status: "submitted", channel: str(i, "channel"), package_document_id: str(i, "package_document_id"), submitted_at: ctx.now, submitted_on: r.submitted_on, follow_up_by: r.follow_up_by, submitted_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now).data;
  }
  if (i.op === "decide") {
    need(i, "loan_id", "id"); const rec = rt.store.require("fnma_exception_requests", str(i, "id"));
    if (rec.data.status !== "submitted") throw new RangeError(`exception request ${rec.id} is ${String(rec.data.status)}, not submitted`);
    const d = validateExceptionDecision({ ...i, exception_request_id: rec.id }); recordExceptionDecision(em(ctx), loanId, d);
    return rt.store.put("fnma_exception_requests", rec.id, { status: "decided", decision: d.decision, decided_at: ctx.now, decided_on: d.decided_on, evidence_document_id: d.evidence_document_id, approved_months: d.approved_months }, ctx.actor, ctx.now).data;
  }
  need(i, "loan_id", "basis");
  const pkg = num(i, "requested_months") ? prepareExceptionPackage({ loan: (i.loan as Record<string, unknown> | undefined) ?? { loan_id: loanId }, hardship: str(i, "hardship") || str(i, "basis"), requested_months: num(i, "requested_months"), cumulative_months: num(i, "cumulative_months") || 0, months_delinquent_at_start: num(i, "months_delinquent_at_start") || 0, start_on: optDate(i, "start_on") ?? ctx.now.slice(0, 10) as PlainDate, prior_terms: rt.store.list("workout_plan_terms", (d) => d.plan_id === str(i, "plan_id")).map((t) => ({ term_no: Number(t.data.term_no), term_start: D(String(t.data.term_start)), term_end: D(String(t.data.term_end)), months: Number(t.data.months) })), last_scheduled_payment_date: optDate(i, "last_scheduled_payment_date"), mbs: flag(i, "mbs"), ...(str(i, "recommendation") ? { recommendation: str(i, "recommendation") } : {}) }) : null;
  const rec = rt.store.put("fnma_exception_requests", str(i, "id") || `exc-${loanId}`, { loan_id: loanId, kind: "forbearance_extension", basis: str(i, "basis"), status: "prepared", plan_id: str(i, "plan_id") || null, requested_months: num(i, "requested_months") || null, package: pkg, prepared_at: ctx.now }, ctx.actor, ctx.now);
  const esc = rt.escalations.open({ kind: "human_portal_task", loanId, ownerRole: str(i, "submit_via") === "officer" ? "officer" : "fnma_portal_operator", payload: { exception_request_id: rec.id, submit_via: str(i, "submit_via") || "fnma_portal_operator", package: pkg, template: "Forbearance Exception Request Template (LL-2026-01)" } }, ctx.actor);
  return { ...rec.data, escalation_id: esc.id, escalation_owner_role: esc.ownerRole };
}

export function statusCodeOps_12_4(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id");
  if (i.op === "ack") return ingestStatusCodeAck(em(ctx), validateStatusCodeAck({ ...i, loan_id: str(i, "loan_id") }));
  need(i, "status_code");
  const plan = str(i, "plan_id") ? rt.store.get("workout_plans", str(i, "plan_id")) : rt.store.list("workout_plans", (d) => d.loan_id === str(i, "loan_id") && d.kind === "forbearance").at(-1);
  // T10: with `smdu.plan_cases=on` the plan is an SMDU forbearance case — the legacy file stops carrying code 09 (Servicing Platform FAQ Q64).
  if (str(i, "status_code") === "09" && (str(i, "smdu_plan_cases") === "on" || Boolean(plan?.data.smdu_case_id))) throw new RangeError(`status code 09 is not reported in the legacy F-1-21 file for an SMDU forbearance case (smdu.plan_cases=on; case ${String(plan?.data.smdu_case_id ?? "pending")})`);
  return ctx.events.append({ type: "investor.status_code.reported", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { status_code: str(i, "status_code"), reason_code: str(i, "reason_code") || null, effective_date: str(i, "effective_date") || null, reporting_month: str(i, "reporting_month") || null, plan_id: plan?.id ?? null, file: "f121_legacy" } });
}

export function feesSuppressOps_12_4(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id"); const id = str(i, "id") || `sup-${str(i, "loan_id")}`;
  if (i.op === "lift") {
    need(i, "late_charges_from"); const rec = rt.store.require("fee_suppressions", id);
    const r = liftLateChargeSuppression({ suppressed_from: D(String(rec.data.from)), late_charges_from: date(i, "late_charges_from") });
    ctx.events.append({ type: "fees.late_charge.suppression_lifted", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { suppression_id: rec.id, suppressed_from: r.suppressed_from, suppressed_to: r.suppressed_to, late_charges_from: r.late_charges_from, retroactive_assessment: false } });
    return rt.store.put("fee_suppressions", rec.id, { to: r.suppressed_to, late_charges_from: r.late_charges_from, status: "lifted" }, ctx.actor, ctx.now).data;
  }
  const rec = rt.store.put("fee_suppressions", id, { loan_id: str(i, "loan_id"), kind: "late_charge", from: str(i, "from") || ctx.now.slice(0, 10), to: null, status: "active", reason: str(i, "reason") || "workout plan active", case_id: str(i, "case_id") || null }, ctx.actor, ctx.now);
  ctx.events.append({ type: "fees.late_charge.suppressed", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { suppression_id: rec.id, from: rec.data.from, reason: rec.data.reason } });
  return rec.data;
}
// `forbearanceTermDates` is re-exported for the section's `calendar.months` tool and the 12.4 tests.
export { forbearanceTermDates };
