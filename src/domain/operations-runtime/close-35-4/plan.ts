/**
 * §35.4 `close.plan` — every sweep: records the receipts the owning sections' own events supplied (rule 2 — never emitted
 * here; once per source_event_id, rule 11), plans the steps whose dependencies are met (rule 1: a step is `planned` only
 * when every dependency is completed or skipped, and now ≥ not_before; T15's predecessor gate), starts a planned step on
 * its first claim or receipt (`close.step.started` on the step's own subject — arming `SM_CLOSE_STEP_STALLED_2BD` from
 * started_at), completes it when received = expected (`close.step.completed` — the clock satisfied), labels a step whose
 * stall clock breached `stalled` (and names the period and step on the breach pass's escalation), marks a step whose every
 * unit died `failed`, and rolls an attested period up to `closed` once every remaining step is completed or skipped.
 * The steps this process runs itself — `balance_attestation` (close.attest) and `tax_year_close` (close.tax_year) — are
 * completed by their own commands; the pass only reports a `tax_year_close` step that is due.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { EscalationService } from "../../../app/escalations.ts";
import type { Actor, MemoryEventStore } from "../../../kernel/events/index.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import { monthChain, TAX_YEAR_STEPS, type StepDef } from "./chain.ts";
import { periodEndOf } from "./calendar.ts";
import { expectedCount, piUnits, predecessorAllows } from "./open.ts";
import type { PlannedUnit, ClosePorts } from "./ports.ts";
import { reportableLoans } from "./reads.ts";
import { journal, openPeriods, patchPeriod, patchStep, stepsOf } from "./store.ts";
import { periodAggregate, stepAggregate, type ClosePeriodRow, type CloseStepRow } from "./types.ts";

export interface PlanDeps { readonly q: Queryable; readonly events: MemoryEventStore; readonly now: string; readonly actor: Actor; readonly escalations: EscalationService; readonly ports: Required<ClosePorts>; readonly servicer: string; readonly plannedBy: string }
export interface UnitsToRun { readonly close_period_id: string; readonly step_id: string; readonly period: string; readonly period_end: PlainDate; readonly step: string; readonly cycle_code: string; readonly run_id: string; readonly units: readonly PlannedUnit[]; readonly tax_year: number | null }
export interface PlanReport { periods: number; receipts: number; planned: string[]; started: string[]; completed: string[]; stalled: string[]; failed: string[]; closed: string[]; tax_year_closes_due: number[]; units_to_run: UnitsToRun[] }

const DONE = new Set(["completed", "skipped", "pre_reopen"]);
const done = (s: CloseStepRow): boolean => DONE.has(s.status);
const isoOf = (v: string | null): string => v ?? "";

/** The units a cycle step plans — one per unit of its scope, ids and dates only (35.3 rule 8: no cents, no state). */
export async function unitsFor(q: Queryable, def: StepDef, p: ClosePeriodRow): Promise<PlannedUnit[]> {
  const base = { period_key: p.period, as_of_date: p.period_end, period_end: p.period_end };
  if (def.unit_scope === "global") return [{ unit_id: "global", input: base }];
  if (def.unit_scope === "per_loan") return (await reportableLoans(q, p.tax_year ?? Number(p.period.slice(0, 4)))).map((l) => ({ unit_id: l.loan_id, loan_id: l.loan_id, input: { ...base, tax_year: p.tax_year, loan_id: l.loan_id } }));
  if (def.code === "form496" || def.code === "balance_attestation") return (await piUnits(q, p.period)).map((u) => ({ unit_id: `${u.custodial_account_id}:${u.remittance_type}`, input: { ...base, custodial_account_id: u.custodial_account_id, remittance_type: u.remittance_type, account_kind: "pi" } }));
  const kinds = def.code === "form496a" ? ["ti"] : ["pi", "ti"];
  const rows = await q.query<{ id: string; kind: string; remittance_type: string | null }>(`SELECT id::text AS id, kind, remittance_type::text AS remittance_type FROM custodial_accounts WHERE kind = ANY($1::text[]) AND coalesce(status, 'active') NOT IN ('closed', 'planned') ORDER BY created_at, id`, [kinds]);
  return rows.map((a) => ({ unit_id: a.id, input: { ...base, custodial_account_id: a.id, account_kind: a.kind, remittance_type: a.remittance_type } }));
}

/** Rule 2: the receipts present on the bus for one step — the section's own events matching the type and filter, journaled once each. Returns the distinct units received. */
export async function recordReceipts(d: PlanDeps, p: ClosePeriodRow, s: CloseStepRow): Promise<{ received: number; new_receipts: number }> {
  if (!s.receipt_event_type || s.owner_process === "35.4") return { received: s.received, new_receipts: 0 };
  const since = s.receipts_from ?? `${p.period_start}T00:00:00.000Z`;
  const rows = await d.q.query<{ id: string; occurred_at: string; payload: Record<string, unknown>; loan_id: string | null }>(`SELECT id::text AS id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at, payload, loan_id::text AS loan_id FROM loan_events WHERE type = $1 AND payload @> $2::jsonb AND occurred_at >= $3::timestamptz ORDER BY sequence`, [s.receipt_event_type, JSON.stringify(s.receipt_filter), since]);
  let fresh = 0;
  for (const r of rows) {
    const unit = s.unit_scope === "per_custodial_account" ? String(r.payload["custodial_account_id"] ?? "global") : s.unit_scope === "per_loan" ? String(r.loan_id ?? r.payload["loan_id"] ?? "global") : "global";
    const id = await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.receipt.recorded", source_event_id: r.id, actor: d.actor, occurred_at: d.now, payload: { step: s.code, unit, event_type: s.receipt_event_type, event_occurred_at: r.occurred_at } });
    if (id) fresh++;
  }
  const c = await d.q.query<{ c: string }>(`SELECT count(DISTINCT payload->>'unit')::text AS c FROM close_period_events WHERE step_id = $1 AND type = 'close.receipt.recorded' AND (payload->>'event_occurred_at')::timestamptz >= $2::timestamptz`, [s.id, since]);
  const received = Number(c[0]?.c ?? 0);
  if (received !== s.received) await patchStep(d.q, s.id, { received }, d.now);
  return { received, new_receipts: fresh };
}

async function stallBreached(q: Queryable, subjectId: string): Promise<{ id: string } | null> {
  const r = await q.query<{ id: string; status: string }>(`SELECT id::text AS id, status::text AS status FROM timers WHERE code = 'SM_CLOSE_STEP_STALLED_2BD' AND subject_kind = 'close_period' AND subject_id = $1 AND status IN ('armed', 'breached') ORDER BY armed_at DESC LIMIT 1`, [subjectId]);
  return r[0]?.status === "breached" ? { id: r[0].id } : null;
}

/** One planning pass over every open period of the servicer, in one transaction (the caller holds 35.3's planner lock or the sweep lease; rule 11). */
export async function planPeriods(d: PlanDeps): Promise<PlanReport> {
  const report: PlanReport = { periods: 0, receipts: 0, planned: [], started: [], completed: [], stalled: [], failed: [], closed: [], tax_year_closes_due: [], units_to_run: [] };
  for (const p of await openPeriods(d.q, d.servicer)) {
    report.periods++;
    const defs = p.kind === "month" ? monthChain(p.period) : TAX_YEAR_STEPS;
    let steps = await stepsOf(d.q, p.id);
    for (const s of steps) { const r = await recordReceipts(d, p, s); report.receipts += r.new_receipts; }
    const gate = p.kind === "month" ? await predecessorAllows(d.q, p.period, d.servicer) : true;
    // up to three rounds: a completion in one round unblocks the next step in the same pass (a receipt that arrived while blocked completes the moment its dependencies do)
    for (let round = 0; round < 3; round++) {
      steps = await stepsOf(d.q, p.id);
      const byCode = new Map(steps.map((s) => [s.code, s]));
      let moved = false;
      for (const def of defs) {
        const s = byCode.get(def.code); if (!s || done(s)) continue;
        const period = { period: p.period, step: s.code, close_period_id: p.id, step_id: s.id };
        const complete = async (started: boolean): Promise<void> => {
          const startedAt = s.started_at ?? d.now;
          if (started && !s.started_at) d.events.append({ type: "close.step.started", aggregate: stepAggregate(p.servicer_number, p.period, s.code), actor: d.actor, payload: { ...period, started_at: startedAt } });
          d.events.append({ type: "close.step.completed", aggregate: stepAggregate(p.servicer_number, p.period, s.code), actor: d.actor, payload: { ...period, started_at: startedAt, completed_at: d.now, received: s.received, expected_receipts: s.expected_receipts } });
          await patchStep(d.q, s.id, { status: "completed", started_at: startedAt, completed_at: d.now }, d.now);
          await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.step.completed", actor: d.actor, occurred_at: d.now, payload: { ...period, received: s.received, expected_receipts: s.expected_receipts } });
          report.completed.push(`${p.period}:${s.code}`); moved = true;
        };
        if (s.status === "blocked") {
          const missing = def.depends_on.filter((c) => { const x = byCode.get(c); return x ? !done(x) : false; });
          if (missing.length || !gate || (s.not_before && s.not_before > d.now)) continue;
          if (def.owner_process === "35.4") { await patchStep(d.q, s.id, { status: "planned" }, d.now); await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.step.planned", actor: d.actor, occurred_at: d.now, payload: { ...period, units: [], own_unit: true } }); report.planned.push(`${p.period}:${s.code}`); moved = true; continue; }
          const units = def.cycle_code ? await unitsFor(d.q, def, p) : [];
          // a cycle step with no unit (no T&I account → form496a; no reportable loan) stays blocked for the officer's skip (edge cases) — never a phantom unit
          if (def.cycle_code && units.length === 0) continue;
          // receipts are counted per account (6.3's completion carries the account, not the remittance type), per loan, or once
          const expected = def.cycle_code ? (s.unit_scope === "per_custodial_account" ? new Set(units.map((u) => String(u.input["custodial_account_id"]))).size : units.length) : s.expected_receipts;
          let run_id: string | null = null;
          if (def.cycle_code) { const r = await d.ports.cycles.planUnits(d.q, { cycle_code: def.cycle_code, period_key: p.kind === "tax_year" ? String(p.tax_year) : p.period, as_of_date: p.period_end, planned_by: d.plannedBy, units }); run_id = r.run_id; report.units_to_run.push({ close_period_id: p.id, step_id: s.id, period: p.period, period_end: p.period_end, step: s.code, cycle_code: def.cycle_code, run_id, units, tax_year: p.tax_year }); }
          await patchStep(d.q, s.id, { status: "planned", cycle_run_id: run_id, expected_receipts: expected, attempts: s.attempts + 1 }, d.now);
          d.events.append({ type: "close.step.planned", aggregate: periodAggregate(p.servicer_number, p.period), actor: d.actor, payload: { ...period, cycle_code: def.cycle_code, cycle_run_id: run_id, units: units.map((u) => u.unit_id), expected_receipts: expected } });
          await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.step.planned", actor: d.actor, occurred_at: d.now, payload: { ...period, cycle_code: def.cycle_code, cycle_run_id: run_id, units: units.map((u) => u.unit_id), expected_receipts: expected } });
          report.planned.push(`${p.period}:${s.code}`); moved = true;
          if (s.received >= expected) await complete(false);   // a receipt that arrived before its step was planned: completed the moment its dependencies did, started_at = completed_at, no stall clock
          continue;
        }
        if (s.status === "planned") {
          if (def.owner_process === "35.4") { if (s.code === "tax_year_close" && p.tax_year === null) report.tax_year_closes_due.push(Number(p.period.slice(0, 4))); continue; }
          if (s.received >= s.expected_receipts) { await complete(false); continue; }
          const claimed = s.received > 0 ? d.now : s.cycle_run_id ? await d.ports.cycles.claimedAt(d.q, s.cycle_run_id) : null;
          if (!claimed) continue;
          d.events.append({ type: "close.step.started", aggregate: stepAggregate(p.servicer_number, p.period, s.code), actor: d.actor, payload: { ...period, started_at: claimed, cycle_run_id: s.cycle_run_id } });
          await patchStep(d.q, s.id, { status: "running", started_at: claimed }, d.now);
          await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.step.started", actor: d.actor, occurred_at: d.now, payload: { ...period, started_at: claimed } });
          report.started.push(`${p.period}:${s.code}`); moved = true;
          continue;
        }
        if (s.status === "running" || s.status === "stalled") {
          if (s.received >= s.expected_receipts) { await complete(false); continue; }
          if (s.status === "running") {
            const breached = await stallBreached(d.q, stepAggregate(p.servicer_number, p.period, s.code).id);
            if (breached) {
              await patchStep(d.q, s.id, { status: "stalled" }, d.now);
              await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.step.stalled", actor: d.actor, occurred_at: d.now, payload: { ...period, timer_id: breached.id } });
              d.events.append({ type: "close.step.stalled", aggregate: stepAggregate(p.servicer_number, p.period, s.code), actor: d.actor, payload: { ...period, timer_code: "SM_CLOSE_STEP_STALLED_2BD", timer_id: breached.id } });
              // the breach pass opened the ops_analyst escalation with the timer; the board's shape names the period and the step on it (this process's own escalation)
              await d.q.query(`UPDATE escalations SET payload = payload || $2::jsonb WHERE sla_timer_id = $1 AND status = 'open' AND NOT (payload ? 'step')`, [breached.id, JSON.stringify({ period: p.period, step: s.code, close_period_id: p.id, step_id: s.id })]);
              report.stalled.push(`${p.period}:${s.code}`); moved = true; continue;
            }
            if (s.cycle_run_id && (await d.ports.cycles.allDead(d.q, s.cycle_run_id))) {
              await patchStep(d.q, s.id, { status: "failed", last_error: "every unit dead (35.3 job.unit.dead)" }, d.now);
              await journal(d.q, { close_period_id: p.id, step_id: s.id, type: "close.step.failed", actor: d.actor, occurred_at: d.now, payload: { ...period, cycle_run_id: s.cycle_run_id } });
              d.escalations.open({ kind: "sev2", ownerRole: "ops_analyst", severity: "2", payload: { process: "35.4", reason: "close step failed: every 35.3 unit dead", period: p.period, step: s.code, cycle_run_id: s.cycle_run_id } }, d.actor);
              report.failed.push(`${p.period}:${s.code}`); moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }
    // the roll-up: an attested period closes once every remaining step is completed or skipped (state machine)
    steps = await stepsOf(d.q, p.id);
    if (p.status === "attested" && steps.every(done)) {
      await patchPeriod(d.q, p.id, { status: "closed", closed_at: d.now }, d.now);
      d.events.append({ type: "close.period.closed", aggregate: periodAggregate(p.servicer_number, p.period), actor: d.actor, payload: { close_period_id: p.id, period: p.period, kind: p.kind, closed_at: d.now } });
      await journal(d.q, { close_period_id: p.id, type: "close.period.closed", actor: d.actor, occurred_at: d.now, payload: { period: p.period } });
      report.closed.push(p.period);
    }
  }
  return report;
}
export const periodEndOfKey = periodEndOf;
export type { PlannedUnit };
export const nowIsoOf = isoOf;
