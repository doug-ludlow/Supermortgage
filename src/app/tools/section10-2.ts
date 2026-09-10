/**
 * §10.2 process-owned tools — additional bus tools for 10.2 defined with `defineTools("10.2", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section10.ts). Every tool string must be one
 * spec/registry/agents.json names for 10.2; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * Every tool string agents.json names for 10.2 (`pmi.schedule.rebuild`, `pmi.terminate`, `notices.*`,
 * `escrow.interim_analysis.request`, `investor_events.emit`, `mi_insurer.cancel`, `ledger.post`) is already bound in
 * ./section10.ts and the bus refuses a second definition of the same (process, name), so the 10.2 operations live here as
 * `op` extensions those handlers dispatch to first (`*_10_2(i, ctx, rt)` returns `undefined` for an op it does not own):
 *
 *   pmi.terminate         op `ltv_snapshot`     nightly LTV snapshot → `mi.ltv_snapshot` (NY_INS_6503D_STOP_PREMIUM_75) and the gate's resolution
 *                         op `missed_sweep`     the next sweep's self-check (10.2-T6) → `officer` sev-1 with the affected loan list
 *                         op `statement_check`  R-F2 premium stop: a statement with MI after the stop date is blocked (10.2-T8)
 *                         (review hook)         a deferred policy whose ledger shows the cure → `loan.became_current` (HPA_4902B2_CURE_TERMINATE_1ST) and the `mi_terminations` row
 *   investor_events.emit  op `lsdu_feedback`    LSDU feedback for the queued LAR 89 → `investor_events.accepted{event_type=mi.discontinuance}` (FNMA_IRM_LAR89_PERIOD_END) / rejected + portal task
 *                         op `lar89_status`     ack check at the bulk cutoff / period close (10.2-T7) → single-LAR-entry portal task
 *   pmi.schedule.rebuild  op `board`            boarding check: no evidenced original value → `mi.original_value.missing{boarded_at}` (SM_MI_ORIGINAL_VALUE_MISSING_60)
 */
import { cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { AppliedInstallment } from "../../domain/boarding/delinquency.ts";
import type { AutoResult } from "../../domain/pmi/termination.ts";
import type { TerminationActions } from "../../domain/pmi/ops.ts";
import { emitCureDetected, emitOriginalValueMissing, escalateMissedSweep, ingestLar89Feedback, lar89StatusCheck, runLtvSnapshot, statementPremiumStopCheck } from "../../domain/pmi/ops-10-2.ts";

export const TOOLS_10_2: readonly ToolDef[] = [];

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const policy = (rt: ToolRuntime, loanId: string): Record<string, unknown> => rt.store.get("mi_policies", loanId)?.data ?? {};

/** `pmi.terminate` ops 10.2 owns; `undefined` hands the call back to the sweep handler in ./section10.ts. */
export function pmiTerminateOps_10_2(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown | undefined {
  switch (i.op) {
    case "ltv_snapshot": {
      need(i, "loan_id", "upb_cents", "original_appraised_value_cents"); const loanId = str(i, "loan_id");
      const state = str(i, "state") || String(policy(rt, loanId).state ?? ""); if (!state) throw new RangeError("state is required (input or mi_policies.state)");
      const r = runLtvSnapshot(ctx, rt.escalations, loanId, { state, upb_cents: cents(i.upb_cents), original_appraised_value_cents: cents(i.original_appraised_value_cents), snapshot_date: optDate(i, "snapshot_date") ?? today(ctx), history_ok: flag(i, "history_ok"), ...(i.fnma_eligible !== undefined ? { fnma_eligible: i.fnma_eligible === true } : {}) });
      if (r.gate.premium_borne_by === "servicer_corporate") rt.store.put("mi_policies", loanId, { premium_borne_by: "servicer_corporate", ny_gate_snapshot_date: r.snapshot.snapshot_date, ny_gate_ltv_bps: r.snapshot.ltv_bps, ny_gate_escalation_id: r.escalation_id }, ctx.actor, ctx.now);
      return { ...r.gate, snapshot: r.snapshot, escalation_id: r.escalation_id, next: r.next };
    }
    case "missed_sweep": {
      // Policies with a scheduled 78% date (latest `mi_schedules` version per loan) and no sweep decision (`mi_policies.auto_status` still pending).
      const t = optDate(i, "today") ?? today(ctx);
      const latest = new Map<string, { scheduled_date: PlainDate; version: number }>();
      for (const s of rt.store.list("mi_schedules")) { const d = s.data.derived_78_date; if (typeof d !== "string") continue; const prev = latest.get(String(s.data.loan_id)); if (!prev || s.version > prev.version) latest.set(String(s.data.loan_id), { scheduled_date: D(d), version: s.version }); }
      const policies = [...latest].map(([loan_id, s]) => ({ loan_id, scheduled_date: s.scheduled_date, auto_status: String(policy(rt, loan_id).auto_status ?? "pending") }));
      return escalateMissedSweep(ctx, rt.escalations, { policies, last_sweep_on: optDate(i, "last_sweep_on"), today: t });
    }
    case "statement_check": {
      need(i, "loan_id", "installment_due"); const loanId = str(i, "loan_id");
      const ended = ctx.events.byLoan(loanId).filter((e) => e.type === "mi.coverage.ended"); const last = ended[ended.length - 1];
      if (!last) return { blocked: false, gate: "HPA_4902E_STOP_PREMIUM_30", premium_stop_by: null, alert: null, alert_id: null, gate_status: null, reason: "MI coverage has not ended on the loan" };
      const gate = ctx.timers.byCode("HPA_4902E_STOP_PREMIUM_30").filter((x) => x.loanId === loanId); const inst = gate[gate.length - 1];
      return statementPremiumStopCheck(ctx, rt.escalations, loanId, { installment_due: date(i, "installment_due"), effective: D(String(last.payload.effective)), premium_stop_from: D(String(last.payload.premium_stop_from ?? last.payload.effective)), includes_mi: flag(i, "includes_mi"), gate_status: inst?.status ?? null });
    }
    default: return undefined;
  }
}

/**
 * After the sweep/review computed its result and before the termination is evented: a deferred policy whose ledger shows
 * the cure emits `loan.became_current` (arming the cure clock the coming `mi.terminated` closes) and records
 * `became_current_on`; every termination gets its append-only `mi_terminations` row (data model).
 */
export function reviewHooks_10_2(ctx: CommandContext, rt: ToolRuntime, loanId: string, r: { result: AutoResult; actions: TerminationActions | null }, scheduled: PlainDate, installments: readonly AppliedInstallment[], kind: string): void {
  const cure = emitCureDetected(ctx, loanId, { result: r.result, scheduled_date: scheduled, installments });
  if (cure) rt.store.put("mi_policies", loanId, { became_current_on: cure.payload.became_current_on, cure_effective_on: cure.payload.effective_on }, ctx.actor, ctx.now);
  if (r.actions) {
    const schedules = rt.store.list("mi_schedules", (d) => d.loan_id === loanId); const basis = schedules[schedules.length - 1];
    rt.store.put("mi_terminations", `${loanId}-${r.actions.effective}`, { loan_id: loanId, type: kind, effective_date: r.actions.effective, basis_schedule_id: basis?.id ?? null, lar89_action_code: r.actions.lar89.code, became_current_on: cure ? cure.payload.became_current_on : null, created_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
  }
}

/** `investor_events.emit` ops 10.2 owns: LSDU feedback ingestion for the LAR 89 and the ack check. */
export function investorEmitOps_10_2(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown | undefined {
  switch (i.op) {
    case "lsdu_feedback": {
      need(i, "loan_id", "feedback"); const loanId = str(i, "loan_id");
      const eff = optDate(i, "effective") ?? (typeof policy(rt, loanId).terminated_on === "string" ? D(String(policy(rt, loanId).terminated_on)) : null);
      const r = ingestLar89Feedback(ctx, rt.escalations, loanId, i.feedback, eff);
      rt.store.put("investor_events", r.queued_event_id, { loan_id: loanId, legacy_record: 89, event_type: "mi.discontinuance", status: r.status, feedback_event_id: r.event.id, portal_task_id: r.portal_task_id, data_alignment_case_id: r.data_alignment_case_id }, ctx.actor, ctx.now);
      return { status: r.status, event_id: r.event.id, queued_event_id: r.queued_event_id, portal_task_id: r.portal_task_id, data_alignment_case_id: r.data_alignment_case_id };
    }
    case "lar89_status": {
      need(i, "loan_id"); const loanId = str(i, "loan_id");
      const eff = optDate(i, "effective") ?? (typeof policy(rt, loanId).terminated_on === "string" ? D(String(policy(rt, loanId).terminated_on)) : null);
      if (!eff) throw new RangeError("effective is required (input or mi_policies.terminated_on)");
      return lar89StatusCheck(ctx, rt.escalations, loanId, eff, rt.escalations.opened.filter((e) => e.loanId === loanId && e.status === "open"));
    }
    default: return undefined;
  }
}

/** `pmi.schedule.rebuild` op `board`: the boarding check — with an evidenced original value the schedule builds as usual; without one the 60-day clock and the boarding escalation open instead. */
export function scheduleRebuildOps_10_2(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown | undefined {
  if (i.op !== "board") return undefined;
  need(i, "loan_id", "boarded_at"); const loanId = str(i, "loan_id"); const plan = str(i, "premium_plan") || "bpmi_monthly";
  const present = i.original_value_cents !== undefined && i.original_value_cents !== null && i.original_value_cents !== "" && cents(i.original_value_cents) > 0n;
  rt.store.put("mi_policies", loanId, { status: "active", premium_plan: plan, boarded_at: date(i, "boarded_at"), original_value_cents: present ? cents(i.original_value_cents) : null, auto_status: "pending", ...(typeof i.state === "string" ? { state: i.state } : {}) }, ctx.actor, ctx.now);
  if (present) return undefined;   // the section handler builds the schedule from the same input
  const r = emitOriginalValueMissing(ctx, rt.escalations, loanId, { boarded_at: date(i, "boarded_at"), premium_plan: plan });
  return { schedule_id: null, basis: null, derived_78_date: null, reason: "ORIGINAL_VALUE_MISSING", escalation: "MI_ORIGINAL_VALUE_MISSING", escalation_id: r.escalation_id, sla_due: r.sla_due, timer: "SM_MI_ORIGINAL_VALUE_MISSING_60" };
}
