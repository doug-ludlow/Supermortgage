/**
 * §35.8 — the sweep's two passes (src/runtime/app.ts Runtime.sweep):
 *   work.sweep     before the breach pass — (1) the day's reconciliation when none ran for the environment day (rule 10; the
 *                  receipt satisfies and re-arms SM_WORK_LOG_RECON_DAILY before the breach pass could breach it); (2) proposals
 *                  whose SM_WORK_APPROVAL_1BD clock breached one further servicer business day ago → `expired`, the item back
 *                  to `claimed`, `work.action.decided{decision: expired}` (edge cases).
 *   work.breaches  after the breach pass — the breach actions this process executes: (3) SM_WORK_ITEM_CLAIM_4H's handler
 *                  (timers-35-8.ts claimBreachHandler: the claim lapses, `claim_lapses + 1`, `work.item.claim_expired`, sev 3
 *                  ops_analyst on the third lapse of one item); (4) SM_WORK_ITEM_AGE_5BD breached → 35.7's
 *                  `role.queue.unstaffed{role}` once per breach; then (5) the queue pass (rule 8: an item per new source —
 *                  including the escalations and breached clocks this very sweep produced, so the queue matches the console's
 *                  after every sweep — and `source_closed` for a source that went away).
 * Each change set is one global unit of work whose commit writes the rows. Nothing here touches a section's clock: the
 * engine armed, satisfied and breached every row from the process's own events.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { EscalationService } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { addBusinessDays, servicer } from "../../../kernel/calendar/business.ts";
import { claimBreachHandler, BREACH_HANDLED_BY_35_8 } from "../timers-35-8.ts";
import { queuePass, getItem, type ItemDeps, type QueuePassReport } from "./items.ts";
import { reconRanOn } from "./recon.ts";
import type { WorkPorts } from "./ports.ts";
import * as ev from "./events.ts";
import { CLAIM_LAPSES_BEFORE_ESCALATION, PROCESS_35_8, type Row } from "./types.ts";

export interface WorkSweepReport { readonly at: string; readonly as_of_date: string; readonly recon_run_id: string | null; readonly recon_error: string | null; readonly proposals_expired: number; readonly line: string }
export interface WorkBreachReport { readonly at: string; readonly claims_lapsed: number; readonly claim_escalations: number; readonly unstaffed_emitted: readonly string[]; readonly queue: QueuePassReport; readonly line: string }
export const WORK_SWEEP_ACTOR: Actor = { kind: "system", id: "work-35-8" };
const ET = "America/New_York";

export async function workSweepPass(rt: Runtime, nowIso: string = rt.clock.now(), o: { runId?: string | null; ports?: WorkPorts; recon?: boolean } = {}): Promise<WorkSweepReport> {
  const asOf = wallClock(Date.parse(nowIso), ET).date;
  // (1) the day's reconciliation — the tool on the bus with the sweep's system actor (its own global unit of work)
  let reconRunId: string | null = null; let reconError: string | null = null;
  if (o.recon !== false && !(await reconRanOn(rt.db, asOf))) {
    try { const r = await rt.execute({ process: PROCESS_35_8, name: "work.log.recon", loanId: "", actor: WORK_SWEEP_ACTOR, input: { as_of_date: asOf } }); reconRunId = String((r.output as Row)["run_id"] ?? ""); }
    catch (e) { reconError = e instanceof Error ? e.message : String(e); rt.logger?.error("work.log.recon failed", { at: nowIso, error: e }); }
  }
  // (2) proposals unattended one further business day after SM_WORK_APPROVAL_1BD breached → expired
  const stale = await rt.db.query<{ id: string; work_item_id: string | null; breached_at: string }>(`SELECT a.id::text AS id, a.work_item_id::text AS work_item_id, t.breached_at::text AS breached_at FROM work_actions a JOIN timers t ON t.subject_kind = 'work_action' AND t.subject_id = a.id::text AND t.code = 'SM_WORK_APPROVAL_1BD' AND t.status = 'breached' WHERE a.status = 'proposed'`);
  const expired = stale.filter((p) => { const breachedOn = wallClock(Date.parse(p.breached_at), ET).date; return addBusinessDays(breachedOn, 1, servicer) <= asOf; });
  if (expired.length) {
    await rt.uow.run({}, async (ctx) => { for (const p of expired) ctx.events.append(ev.actionDecided(p.id, WORK_SWEEP_ACTOR, { decision: "expired", by: null, executed_action_id: null, code: "SM_WORK_APPROVAL_1BD" })); }, { clock: rt.clock, commit: async (q) => {
      for (const p of expired) {
        await q.query(`UPDATE work_actions SET status = 'expired', refusal_code = 'SM_WORK_APPROVAL_1BD' WHERE id = $1 AND status = 'proposed'`, [p.id]);
        if (p.work_item_id) { await q.query(`UPDATE work_items SET status = 'claimed', updated_at = $2::timestamptz WHERE id = $1 AND status = 'waiting_approval'`, [p.work_item_id, nowIso]); await q.query(`INSERT INTO work_item_events (work_item_id, kind, reason, at) VALUES ($1, 'claimed', $2, $3::timestamptz)`, [p.work_item_id, `proposal ${p.id} expired`, nowIso]); }
      }
    } });
  }
  const line = `work ${asOf}: recon=${reconRunId ? "ran" : reconError ? "failed" : "done"} proposals_expired=${expired.length}`;
  return { at: nowIso, as_of_date: asOf, recon_run_id: reconRunId, recon_error: reconError, proposals_expired: expired.length, line };
}

export async function workBreachPass(rt: Runtime, nowIso: string = rt.clock.now(), o: { ports?: WorkPorts } = {}): Promise<WorkBreachReport> {
  // (3) the claim clock's breach action (timer table row 1): the breached SM_WORK_ITEM_CLAIM_4H rows not yet handled (the handler's item event names the timer)
  const breached = await rt.db.query<{ timer_id: string; item_id: string; armed_at: string }>(`SELECT t.id::text AS timer_id, t.subject_id AS item_id, t.armed_at::text AS armed_at FROM timers t WHERE t.code = 'SM_WORK_ITEM_CLAIM_4H' AND t.status = 'breached' AND t.subject_kind = 'work_item' AND NOT EXISTS (SELECT 1 FROM work_item_events e WHERE e.work_item_id::text = t.subject_id AND e.kind = 'claim_expired' AND e.reason = 'timer:' || t.id::text) ORDER BY t.breached_at`);
  let lapsed = 0; let escalated = 0;
  if (breached.length) {
    const writes: ((q: Queryable) => Promise<void>)[] = []; let es: EscalationService | undefined;
    await rt.uow.run({}, async (ctx) => {
      es = new EscalationService(ctx.events, ctx.clock);
      for (const b of breached) {
        const it = await getItem(ctx.q!, b.item_id); if (!it) continue;
        const dcn = claimBreachHandler({ item_id: it.id, claim_lapses: it.claim_lapses, status: it.status, claimed_by: it.claimed_by, claimed_at: it.claimed_at, timer_armed_at: b.armed_at, timer_id: b.timer_id }, CLAIM_LAPSES_BEFORE_ESCALATION);
        // the handler's receipt lands even when the claim was already released (a newer claim has its own clock), so the row is handled once
        writes.push(async (q) => { await q.query(`INSERT INTO work_item_events (work_item_id, kind, staff_user_id, role, reason, at) VALUES ($1, 'claim_expired', $2, $3, $4, $5::timestamptz)`, [it.id, dcn.lapse ? it.claimed_by : null, null, `timer:${b.timer_id}`, nowIso]); });
        if (!dcn.lapse) continue;
        lapsed += 1;
        writes.push(async (q) => { await q.query(`UPDATE work_items SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, claim_lapses = $2, updated_at = $3::timestamptz WHERE id = $1`, [it.id, dcn.lapses_after, nowIso]); });
        ctx.events.append(ev.itemClaimExpired(it.id, WORK_SWEEP_ACTOR, { lapses: dcn.lapses_after, was_claimed_by: it.claimed_by, timer_id: b.timer_id }));
        if (dcn.escalate) { escalated += 1; es.open({ kind: "sev3", ownerRole: "ops_analyst", ...(it.loan_id ? { loanId: it.loan_id } : {}), ...(it.application_id ? { applicationId: it.application_id } : {}), severity: "3", slaTimerId: b.timer_id, payload: { timer_code: "SM_WORK_ITEM_CLAIM_4H", timer_id: b.timer_id, work_item_id: it.id, claim_lapses: dcn.lapses_after, breach: "35.8 timer table row 1: the third lapse of one item" } }, WORK_SWEEP_ACTOR); }
      }
    }, { clock: rt.clock, commit: async (q) => { for (const fn of writes) await fn(q); for (const e of es?.list() ?? []) await rt.escalationRepo.save(e, q); } });
  }
  // (4) SM_WORK_ITEM_AGE_5BD breached → role.queue.unstaffed{role} (35.7's literal) once per breached clock
  const aged = await rt.db.query<{ timer_id: string; item_id: string }>(`SELECT t.id::text AS timer_id, t.subject_id AS item_id FROM timers t WHERE t.code = 'SM_WORK_ITEM_AGE_5BD' AND t.status = 'breached' AND t.subject_kind = 'work_item' AND NOT EXISTS (SELECT 1 FROM loan_events e WHERE e.type = 'role.queue.unstaffed' AND e.payload->>'timer_id' = t.id::text)`);
  const unstaffed: string[] = [];
  if (aged.length) {
    await rt.uow.run({}, async (ctx) => {
      for (const a of aged) { const it = await getItem(ctx.q!, a.item_id); if (!it) continue; unstaffed.push(it.required_role); ctx.events.append(ev.roleQueueUnstaffed(WORK_SWEEP_ACTOR, { role: it.required_role, item_id: it.id, timer_id: a.timer_id, environment: rt.environment })); }
    }, { clock: rt.clock });
  }
  // (5) the queue pass — after the breach pass, so the escalations and breached clocks this sweep produced are items now (rule 8: "the queue refreshes every sweep")
  const queue = await queuePass(rt, nowIso, { ...(o.ports ? { ports: o.ports } : {}) });
  return { at: nowIso, claims_lapsed: lapsed, claim_escalations: escalated, unstaffed_emitted: unstaffed, queue, line: `work breaches: claims_lapsed=${lapsed} claim_escalations=${escalated} unstaffed=[${unstaffed.join(",")}] opened=${queue.opened} closed=${queue.closed}` };
}
export { BREACH_HANDLED_BY_35_8 };
export type { ItemDeps };
