/**
 * §35.3 rule 5 — "The last unit elects the receipt, exactly once." One global unit of work per election: the run row is
 * taken FOR UPDATE (the executor and the planner serialize on it), an existing `cycle_receipts` row ends the election with
 * nothing appended, otherwise the cycle's receipt literal (the owning agent's) and `cycle.run.completed` (ops-steward's,
 * satisfying SM_CYCLE_RUN_STALLED_1D on the `cycle_run` aggregate) are appended, the receipt row is inserted under its
 * unique `run_id` (RECEIPT_ONCE — the key is the invariant, the row lock the ordering), the run goes `completed` and the
 * registry row records its last receipt. The counters on the receipt are derived from the jobs' statuses: `units_dead`
 * counts the dead and abandoned units (open question 3: a receipt with `units_dead > 0` and the abandoned unit ids is
 * evidence the cycle ran and what it did not do).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Runtime } from "../../../runtime/app.ts";
import { EV, OPS_STEWARD, OWN_RECEIPT_CYCLES, defOf, periodEnd } from "./cycles.ts";

export interface ReceiptResult { readonly receipt_id: string; readonly run_id: string; readonly cycle_code: string; readonly period_key: string; readonly units_total: number; readonly units_done: number; readonly units_dead: number; readonly units_skipped: number; readonly outcomes_sha256: string; readonly emitted_by: string; }

export const outcomesSha256 = (triples: readonly { unit_id: string; status: string; decision_id: string | null }[]): string => createHash("sha256").update(JSON.stringify(triples.map((t) => [t.unit_id, t.status, t.decision_id]))).digest("hex");

export async function emitReceipt(rt: Runtime, runId: string, emittedBy: string): Promise<ReceiptResult | null> {
  let out: ReceiptResult | null = null;
  await rt.uow.run({}, async (ctx) => {
    const q = ctx.q!;
    const [run] = await q.query<{ id: string; cycle_code: string; period_key: string; as_of_date: string; units_total: number; status: string }>(`SELECT id, cycle_code, period_key, as_of_date::text AS as_of_date, units_total, status FROM cycle_runs WHERE id = $1 FOR UPDATE`, [runId]);
    if (!run || run.status === "cancelled") return;
    if ((await q.query(`SELECT 1 FROM cycle_receipts WHERE run_id = $1`, [runId])).length) return;
    const jobs = await q.query<{ unit_id: string; status: string; decision_id: string | null }>(`SELECT unit_id, status, decision_id FROM jobs WHERE run_id = $1 ORDER BY unit_id`, [runId]);
    const done = jobs.filter((j) => j.status === "done").length;
    const abandoned = jobs.filter((j) => j.status === "abandoned").map((j) => j.unit_id);
    const dead = jobs.filter((j) => j.status === "dead").length + abandoned.length;
    const skipped = jobs.filter((j) => j.status === "skipped").length;
    const sha = outcomesSha256(jobs);
    const def = defOf(rt.cycles.defs, run.cycle_code);
    const receiptId = randomUUID();
    const aggregate = { kind: "cycle_run", id: runId };
    const payload = { run_id: runId, cycle_code: run.cycle_code, period_key: run.period_key, as_of_date: run.as_of_date, period_end: periodEnd(run.period_key), units_total: run.units_total, units_done: done, units_dead: dead, units_skipped: skipped, outcomes_sha256: sha, abandoned_unit_ids: abandoned, emitted_by: emittedBy };
    // the cycle's own receipt literal (rule 2's column) as the owning agent; a cycle whose receipt its owner emits (35.1, 35.2, 35.7, 35.12, the sweep-body passes) gets `cycle.run.completed` only
    const receiptEv = def && !OWN_RECEIPT_CYCLES.has(run.cycle_code) ? ctx.events.append({ type: def.receipt_event, aggregate, actor: { kind: "agent", id: def.owner_agent }, payload }) : null;
    const generic = ctx.events.append({ type: EV.run_completed, aggregate, actor: OPS_STEWARD, payload: { ...payload, receipt_id: receiptId, completed_at: ctx.clock.now() } });
    await q.query(`INSERT INTO cycle_receipts (id, run_id, cycle_code, period_key, as_of_date, units_total, units_done, units_dead, units_skipped, outcomes_sha256, receipt_event_id, generic_event_id, emitted_by) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [receiptId, runId, run.cycle_code, run.period_key, run.as_of_date, run.units_total, done, dead, skipped, sha, receiptEv?.id ?? null, generic.id, emittedBy]);
    await q.query(`UPDATE cycle_runs SET status = 'completed', completed_at = $2, receipt_id = $3 WHERE id = $1`, [runId, ctx.clock.now(), receiptId]);
    await q.query(`UPDATE cycle_registry SET last_period_key = $2, last_run_id = $3, last_receipt_at = $4, overdue_since = NULL, updated_at = $4 WHERE cycle_code = $1`, [run.cycle_code, run.period_key, runId, ctx.clock.now()]);
    out = { receipt_id: receiptId, run_id: runId, cycle_code: run.cycle_code, period_key: run.period_key, units_total: run.units_total, units_done: done, units_dead: dead, units_skipped: skipped, outcomes_sha256: sha, emitted_by: emittedBy };
  }, { clock: rt.clock });
  return out;
}
