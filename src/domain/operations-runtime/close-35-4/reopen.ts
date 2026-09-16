/**
 * §35.4 `close.reopen` — rule 9. An agent proposes (`op: propose` — a decision, no state change); only an `officer`
 * reopens, with a reason and the triggering event (a restated statement, a reversal, a 5.1 correction). The reopen resets
 * to `blocked` the changed step and every step downstream of it in the dependency graph except the final steps — `lar`,
 * `period_close` and `metro2_snapshot` are Fannie Mae's and the bureaus' record of the period (IRM 4-08; C-4.1-01) and are
 * relabelled `pre_reopen`, still satisfying dependencies. The original attestation row is never edited; the re-attestation
 * is a new row with `supersedes_attestation_id` (attest.ts). A reopen from `closed` also opens a `compliance` escalation.
 * A period whose successor is `attested` cannot be reopened (SUCCESSOR_ATTESTED_NO_REOPEN).
 */
import { randomUUID } from "node:crypto";
import type { CommandContext } from "../../../app/commands.ts";
import { PortUnavailable, str, type ToolInput, type ToolRuntime } from "../../../app/tools.ts";
import { hasRole } from "../../../app/roles.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { addMonths } from "../../../kernel/calendar/date.ts";
import { downstreamOf, FINAL_STEPS, monthChain } from "./chain.ts";
import { periodKeyOf, periodStartOf } from "./calendar.ts";
import { closePorts } from "./ports.ts";
import { isStep, journal, patchPeriod, patchStep, periodByKey, periodOf, stepsOf, writeCloseDecision } from "./store.ts";
import { CloseRefused, periodAggregate, type StepCode } from "./types.ts";

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };

export async function reopenTool(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const q = ctx.q; if (!q) throw new RangeError("35.4 tools run inside a database command (PgUnitOfWork): no transaction on this context");
  const runtime = runtimeOf(rt); const servicer = await closePorts(runtime).servicer.servicerNumber(q);
  const period = str(i, "period"); if (!period) throw new RangeError("period (YYYY-MM) is required");
  const reason = str(i, "reason"); if (!reason) throw new RangeError("reason is required");
  const trigger = str(i, "trigger_event_id") || null;
  const op = str(i, "op") || "reopen";
  const p = await periodOf(q, { period }, servicer, true); if (!p) throw new RangeError(`no close period ${period}`);
  const changed = (str(i, "changed_step") || "custodial_day_close");
  if (!isStep(changed)) throw new RangeError(`changed_step ${changed} is not a step`);
  const defs = monthChain(p.period);
  const reset = [changed, ...downstreamOf(defs, changed)].filter((c) => !FINAL_STEPS.includes(c));
  const subject = { kind: "close_period", id: p.id };
  if (op === "propose") {
    const id = await writeCloseDecision(ctx, { action: "close.reopen.propose", subject, record: { period: p.period, servicer_number: servicer, action: "propose_reopen", reason, trigger_event_id: trigger, changed_step: changed, steps_to_reset: reset, steps_kept: FINAL_STEPS, proposed_by: `${ctx.actor.kind}:${ctx.actor.id}` }, rationale: `proposal: reopen ${p.period} — ${reason} (an officer decides; no state change)` });
    return { proposal_decision_id: id, period: p.period, status: p.status, steps_to_reset: reset, steps_kept: FINAL_STEPS, changed: false };
  }
  if (op !== "reopen") throw new RangeError("close.reopen op is propose | reopen");
  if (!hasRole(ctx.actor, ["officer"])) throw new CloseRefused("OFFICER_REOPEN_ONLY", "35.4 rule 9: 'Only an officer reopens'", `${ctx.actor.kind}:${ctx.actor.id} may propose, never reopen`);
  if (p.status !== "attested" && p.status !== "closed") throw new CloseRefused("PERIOD_NOT_REOPENABLE", "35.4 state machine: 'attested or closed —(close.reopen by an officer …)→ reopened'", `period ${p.period} is ${p.status}`);
  const successor = await periodByKey(q, "month", periodKeyOf(addMonths(periodStartOf(p.period), 1)), servicer);
  if (successor && (successor.status === "attested" || successor.status === "closed")) throw new CloseRefused("SUCCESSOR_ATTESTED_NO_REOPEN", "35.4 rule 9: 'A period whose successor is attested cannot be reopened (the correction is the successor's Section III item, 6.3 retro-corrections)'", `${successor.period} is ${successor.status}; the correction is its Section III item`);
  const steps = await stepsOf(q, p.id);
  const resetDone: StepCode[] = []; const kept: StepCode[] = [];
  for (const s of steps) {
    if (reset.includes(s.code) && s.status !== "skipped") {   // rule 9 resets what was completed; a skipped step (the officer's decision) stays skipped
      await patchStep(q, s.id, { status: "blocked", received: 0, started_at: null, completed_at: null, cycle_run_id: null, receipts_from: ctx.now, skipped_reason: null, last_error: null }, ctx.now);
      await journal(q, { close_period_id: p.id, step_id: s.id, type: "close.step.reset", actor: ctx.actor, occurred_at: ctx.now, payload: { period: p.period, step: s.code, reason, prior_status: s.status } });
      resetDone.push(s.code);
    } else if (FINAL_STEPS.includes(s.code)) {
      if (s.status === "completed") await patchStep(q, s.id, { status: "pre_reopen" }, ctx.now);
      kept.push(s.code);
    }
  }
  const keptOrdered = FINAL_STEPS.filter((c) => kept.includes(c));
  const resetOrdered = reset.filter((c) => resetDone.includes(c));
  const decisionId = await writeCloseDecision(ctx, { action: "close.reopen", subject, record: { period: p.period, servicer_number: servicer, action: "reopen", reason, trigger_event_id: trigger, changed_step: changed, prior_status: p.status, steps_reset: resetOrdered, steps_kept: keptOrdered, approved_by: ctx.actor.id }, rationale: `reopened ${p.period} by officer ${ctx.actor.id}: ${reason}; reset ${resetOrdered.join(", ")}; kept ${keptOrdered.join(", ")} as pre_reopen`, approvedBy: ctx.actor });
  let escalationId: string | null = null;
  if (p.status === "closed") { const e = rt.escalations.open({ kind: "sev2", ownerRole: "compliance", severity: "2", payload: { process: "35.4", period: p.period, reason: "reopen from closed: the package may already be with the partner", reopen_reason: reason, trigger_event_id: trigger } }, ctx.actor); escalationId = e.id; }
  const reopenId = randomUUID();
  await q.query(`INSERT INTO close_reopens (id, close_period_id, reason, trigger_event_id, requested_by, approved_by_decision_id, prior_status, steps_reset, steps_kept, compliance_escalation_id, reopened_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[], $9::text[], $10, $11)`,
    [reopenId, p.id, reason, trigger, JSON.stringify(ctx.actor), decisionId, p.status, resetOrdered, keptOrdered, escalationId, ctx.now]);
  await patchPeriod(q, p.id, { status: "reopened", reopen_count: p.reopen_count + 1, current_reopen_id: reopenId }, ctx.now);
  ctx.events.append({ type: "close.period.reopened", aggregate: periodAggregate(servicer, p.period), actor: ctx.actor, payload: { close_period_id: p.id, period: p.period, reopen_id: reopenId, by: ctx.actor.id, reason, trigger_event_id: trigger, prior_status: p.status, steps_reset: resetOrdered, steps_kept: keptOrdered, compliance_escalation_id: escalationId } });
  await journal(q, { close_period_id: p.id, type: "close.period.reopened", actor: ctx.actor, occurred_at: ctx.now, payload: { reopen_id: reopenId, by: ctx.actor.id, reason, trigger_event_id: trigger, steps_reset: resetOrdered, steps_kept: keptOrdered } });
  return { reopen_id: reopenId, period: p.period, status: "reopened", prior_status: p.status, steps_reset: resetOrdered, steps_kept: keptOrdered, compliance_escalation_id: escalationId, decision_id: decisionId };
}
