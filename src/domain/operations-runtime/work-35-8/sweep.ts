/**
 * §35.8 — the sweep's two passes (src/runtime/app.ts Runtime.sweep):
 *   work.sweep     before the breach pass — (1) the day's reconciliation when none ran for the environment day (rule 10; the
 *                  receipt satisfies and re-arms SM_WORK_LOG_RECON_DAILY before the breach pass could breach it); (2) proposals
 *                  whose SM_WORK_APPROVAL_1BD clock breached one further servicer business day ago → `expired`, the item back
 *                  to `claimed`, `work.action.decided{decision: expired}` (edge cases).
 *   work.breaches  after the breach pass — the breach actions this process executes: (3) SM_WORK_ITEM_CLAIM_4H's handler
 *                  (timers-35-8.ts claimBreachHandler: the claim lapses, `claim_lapses + 1`, `work.item.claim_expired`, sev 3
 *                  ops_analyst on the third lapse of one item); (4) the age clocks (rows 2–3): per role, one escalation
 *                  naming the items whose clock breached, and for AGE_5BD one 35.7 `role.queue.unstaffed{role}`; then (5) the queue pass (rule 8: an item per new source —
 *                  including the escalations and breached clocks of every OTHER process this very sweep produced, so the queue
 *                  matches the console's after every sweep — and `source_closed` for a source that went away). This process's own
 *                  clocks (SM_WORK_*) and the escalations they open are the queue's bookkeeping about an item that already
 *                  exists, never a new source (items.ts isOwnBookkeeping): an item per breach per sweep would otherwise breed.
 * Each change set is one global unit of work whose commit writes the rows. Nothing here touches a section's clock: the
 * engine armed, satisfied and breached every row from the process's own events.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { EscalationService } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { addBusinessDays, servicer } from "../../../kernel/calendar/business.ts";
import { claimBreachHandler, BREACH_HANDLED_BY_35_8, AGE_BATCH_LIMIT } from "../timers-35-8.ts";
import { queuePass, getItem, type ItemDeps, type QueuePassReport } from "./items.ts";
import { reconRanOn } from "./recon.ts";
import type { WorkPorts } from "./ports.ts";
import * as ev from "./events.ts";
import { CLAIM_LAPSES_BEFORE_ESCALATION, PROCESS_35_8, type Row } from "./types.ts";

export interface WorkSweepReport { readonly at: string; readonly as_of_date: string; readonly recon_run_id: string | null; readonly recon_error: string | null; readonly proposals_expired: number; readonly line: string }
export interface WorkBreachReport { readonly at: string; readonly claims_lapsed: number; readonly claim_escalations: number; readonly age_escalations: number; readonly unstaffed_emitted: readonly string[]; readonly queue: QueuePassReport; readonly line: string }
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
    await rt.uow.run({}, async (ctx) => { for (const p of expired) ctx.events.append(ev.actionDecided(p.id, WORK_SWEEP_ACTOR, { decision: "expired", by: null, executed_action_id: null, code: "SM_WORK_APPROVAL_1BD" })); }, { clock: rt.clock, subjects: expired.flatMap((p) => [{ kind: "work_action", id: p.id }, ...(p.work_item_id ? [{ kind: "work_item", id: p.work_item_id }] : [])]), commit: async (q) => {
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
  // (4) the age clocks' breach actions (timer table rows 2–3; timers-35-8.ts): per role, one escalation naming the items whose clock breached since the last pass — sev 2 ops_analyst for AGE_2BD, sev 1 officer and one `role.queue.unstaffed{role}` (35.7's literal) for AGE_5BD; each item's own `aged` / `unstaffed` event names its clock, so a clock is handled once (0202/0203, indexed by item and kind)
  const unstaffed: string[] = [];
  let ageEscalations = 0;
  for (const [code, mark] of [["SM_WORK_ITEM_AGE_2BD", "aged"], ["SM_WORK_ITEM_AGE_5BD", "unstaffed"]] as const) {
    const rows = await rt.db.query<{ timer_id: string; item_id: string; required_role: string; loan_id: string | null; application_id: string | null }>(`SELECT t.id::text AS timer_id, i.id::text AS item_id, i.required_role, i.loan_id::text AS loan_id, i.application_id::text AS application_id FROM timers t JOIN work_items i ON i.id::text = t.subject_id WHERE t.code = $1 AND t.status = 'breached' AND t.subject_kind = 'work_item' AND NOT EXISTS (SELECT 1 FROM work_item_events e WHERE e.work_item_id = i.id AND e.kind = $2 AND e.reason = 'timer:' || t.id::text) ORDER BY t.breached_at, t.id`, [code, mark]);
    if (!rows.length) continue;
    const byRole = new Map<string, typeof rows>(); for (const r of rows) byRole.set(r.required_role, [...(byRole.get(r.required_role) ?? []), r]);
    const marks: ((q: Queryable) => Promise<void>)[] = []; let es: EscalationService | undefined;
    await rt.uow.run({}, async (ctx) => {
      es = new EscalationService(ctx.events, ctx.clock);
      for (const [role, batch] of byRole) {
        const itemIds = batch.slice(0, AGE_BATCH_LIMIT).map((r) => r.item_id); const timerIds = batch.slice(0, AGE_BATCH_LIMIT).map((r) => r.timer_id);
        const one = batch.length === 1 ? batch[0]! : null;   // one item: the escalation keys to its loan or application as the console does
        es.open({ kind: code === "SM_WORK_ITEM_AGE_2BD" ? "sev2" : "sev1", ownerRole: code === "SM_WORK_ITEM_AGE_2BD" ? "ops_analyst" : "officer", severity: code === "SM_WORK_ITEM_AGE_2BD" ? "2" : "1", slaTimerId: timerIds[0]!, ...(one?.loan_id ? { loanId: one.loan_id } : {}), ...(one?.application_id ? { applicationId: one.application_id } : {}),
          payload: { timer_code: code, timer_id: timerIds[0]!, timer_ids: timerIds, item_ids: itemIds, count: batch.length, role, breach: code === "SM_WORK_ITEM_AGE_2BD" ? "35.8 timer table row 2: an item needing a person has sat two business days" : "35.8 timer table row 3: five business days unworked — the queue is unstaffed for that role" } }, WORK_SWEEP_ACTOR);
        ageEscalations += 1;
        if (code === "SM_WORK_ITEM_AGE_5BD") { unstaffed.push(role); ctx.events.append(ev.roleQueueUnstaffed(WORK_SWEEP_ACTOR, { role, count: batch.length, item_ids: itemIds, timer_ids: timerIds, timer_id: timerIds[0] ?? null, environment: rt.environment })); }
        for (const r of batch) marks.push(async (q) => { await q.query(`INSERT INTO work_item_events (work_item_id, kind, reason, at) VALUES ($1, $2, $3, $4::timestamptz)`, [r.item_id, mark, `timer:${r.timer_id}`, nowIso]); });
      }
    }, { clock: rt.clock, commit: async (q) => { for (const fn of marks) await fn(q); for (const e of es?.list() ?? []) await rt.escalationRepo.save(e, q); } });
  }
  // (5) the queue pass — after the breach pass, so the escalations and breached clocks this sweep produced are items now (rule 8: "the queue refreshes every sweep")
  const queue = await queuePass(rt, nowIso, { ...(o.ports ? { ports: o.ports } : {}) });
  return { at: nowIso, claims_lapsed: lapsed, claim_escalations: escalated, unstaffed_emitted: unstaffed, age_escalations: ageEscalations, queue, line: `work breaches: claims_lapsed=${lapsed} claim_escalations=${escalated} age_escalations=${ageEscalations} unstaffed=[${unstaffed.join(",")}] opened=${queue.opened} closed=${queue.closed}` };
}
export { BREACH_HANDLED_BY_35_8 };
export type { ItemDeps };
