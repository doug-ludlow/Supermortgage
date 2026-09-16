/**
 * §35.4 `close.open` — the period and its steps from rule 1's table, idempotent per (kind, period, servicer_number)
 * (rule 11): the first call writes the close_periods row, one close_period_steps row per step (`eod_cutoff` planned when
 * the predecessor period allows it — T15 — the rest `blocked`, each visible with its unmet dependencies from this moment),
 * journals and appends `close.period.opened` on the period aggregate (satisfying `SM_CLOSE_PERIOD_OPEN_BD1`, arming
 * `SM_CLOSE_ATTEST_BD5` from `period_end`); December also appends `close.tax_year.planned{tax_year, tax_year_end}` on the
 * global subject so `SM_TAX_YEAR_CLOSE_3BD` counts from 31 December. A second call returns the existing row, journals the
 * duplicate with its source_event_id, adds no step and logs no second `close.period.opened` (edge case 4).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { CommandContext } from "../../../app/commands.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import { periodEndOf, periodStartOf, priorPeriodOf, taxYearEnd, taxYearOf, isDecember } from "./calendar.ts";
import { monthChain, TAX_YEAR_STEPS, type StepDef } from "./chain.ts";
import { journal, periodByKey, stepOf, stepsOf, type JournalInput } from "./store.ts";
import { GLOBAL_AGG, PERIOD_RE, periodAggregate, type ClosePeriodRow } from "./types.ts";

export interface OpenInput { readonly period: string; readonly period_end?: PlainDate; readonly servicer_number: string; readonly source_event_id?: string | null }
export interface OpenResult { readonly period: ClosePeriodRow; readonly created: boolean; readonly steps: readonly { code: string; status: string }[] }

/** The counts the receipts are measured against, from typed rows (never entity JSON — 35.1). */
export async function expectedCount(q: Queryable, def: StepDef, p: { period: string; tax_year: number | null; counts?: TaxYearCounts }): Promise<number> {
  const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(sql, params))[0]?.c ?? 0);
  switch (def.expected) {
    case "one": return 1;
    case "pi_accounts": return Math.max(1, await n(`SELECT count(*)::text AS c FROM custodial_accounts WHERE kind = 'pi' AND coalesce(status, 'active') NOT IN ('closed', 'planned')`));
    case "ti_accounts": return await n(`SELECT count(*)::text AS c FROM custodial_accounts WHERE kind = 'ti' AND coalesce(status, 'active') NOT IN ('closed', 'planned')`);
    case "all_accounts": return Math.max(1, await n(`SELECT count(*)::text AS c FROM custodial_accounts WHERE kind IN ('pi', 'ti') AND coalesce(status, 'active') NOT IN ('closed', 'planned')`));
    case "pi_units": return Math.max(1, (await piUnits(q, p.period)).length);
    case "reportable_loans": return p.counts?.reportable_loans ?? 0;
    case "filed_loans": return p.counts?.filed_loans ?? 0;
    case "ioe_loans": return p.counts?.ioe_1099_loans ?? 0;
    case "ac_loans": return p.counts?.form_1099_ac_loans ?? 0;
  }
}
export interface TaxYearCounts { readonly reportable_loans: number; readonly filed_loans: number; readonly ioe_1099_loans: number; readonly form_1099_ac_loans: number }
/** One unit per (P&I account × remittance type): the account's own remittance type, widened by the remittance types 6.3 booked components for in the period (edge case: an account with two types). */
export async function piUnits(q: Queryable, period: string): Promise<{ custodial_account_id: string; remittance_type: string }[]> {
  const accounts = await q.query<{ id: string; remittance_type: string | null }>(`SELECT id::text AS id, remittance_type::text AS remittance_type FROM custodial_accounts WHERE kind = 'pi' AND coalesce(status, 'active') NOT IN ('closed', 'planned') ORDER BY created_at, id`);
  const out: { custodial_account_id: string; remittance_type: string }[] = [];
  for (const a of accounts) {
    const types = (await q.query<{ t: string }>(`SELECT DISTINCT remittance_type AS t FROM remittance_components WHERE custodial_account_id = $1 AND period = $2 ORDER BY t`, [a.id, period])).map((r) => r.t);
    for (const t of types.length ? types : [a.remittance_type ?? "S/S"]) out.push({ custodial_account_id: a.id, remittance_type: t });
  }
  return out;
}

/** T15 / rule 1: a period's steps are planned only while the predecessor is attested (or closed), or its `balance_attestation` completed — a period's `form496` may still be running. */
export async function predecessorAllows(q: Queryable, period: string, servicer: string): Promise<boolean> {
  const prior = await periodByKey(q, "month", priorPeriodOf(periodStartOf(period)), servicer);
  if (!prior) return true;
  if (prior.status === "attested" || prior.status === "closed") return true;
  const ba = await stepOf(q, prior.id, "balance_attestation");
  return ba?.status === "completed";
}

export async function openClosePeriod(ctx: CommandContext, i: OpenInput, opts: { kind?: "month" | "tax_year"; tax_year?: number; counts?: TaxYearCounts } = {}): Promise<OpenResult> {
  const q = ctx.q; if (!q) throw new RangeError("35.4 close.open runs inside a database command (PgUnitOfWork): no transaction on this context");
  const kind = opts.kind ?? "month";
  if (kind === "month" && !PERIOD_RE.test(i.period)) throw new RangeError("period is YYYY-MM");
  const now = ctx.now;
  const existing = await periodByKey(q, kind, i.period, i.servicer_number, true);
  if (existing) {
    await journal(q, { close_period_id: existing.id, type: "close.period.opened", actor: ctx.actor, occurred_at: now, payload: { duplicate: true, period: i.period, source_event_id: i.source_event_id ?? null } });
    const steps = (await stepsOf(q, existing.id)).map((s) => ({ code: s.code, status: s.status }));
    return { period: existing, created: false, steps };
  }
  const taxYear = kind === "tax_year" ? opts.tax_year ?? null : null;
  const period_start = kind === "month" ? periodStartOf(i.period) : `${taxYear}-01-01` as PlainDate;
  const period_end = kind === "month" ? (i.period_end ?? periodEndOf(i.period)) : taxYearEnd(taxYear!);
  if (kind === "month" && period_end !== periodEndOf(i.period)) throw new RangeError(`period_end ${period_end} is not the last day of ${i.period}`);
  const id = randomUUID();
  const opened = ctx.events.append({ type: "close.period.opened", aggregate: periodAggregate(i.servicer_number, i.period), actor: ctx.actor, payload: { close_period_id: id, kind, period: i.period, period_start, period_end, servicer_number: i.servicer_number, tax_year: taxYear, source_event_id: i.source_event_id ?? null } });
  await q.query(`INSERT INTO close_periods (id, kind, period, period_start, period_end, servicer_number, tax_year, status, opened_at, opened_by_event_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)`,
    [id, kind, i.period, period_start, period_end, i.servicer_number, taxYear, now, i.source_event_id ?? null]);
  const defs = kind === "month" ? monthChain(i.period) : TAX_YEAR_STEPS;
  const gate = kind === "month" ? await predecessorAllows(q, i.period, i.servicer_number) : true;
  const p = { period: i.period, period_end, tax_year: taxYear, ...(opts.counts ? { counts: opts.counts } : {}) };
  const steps: { code: string; status: string }[] = [];
  const entries: JournalInput[] = [];
  for (const d of defs) {
    const expected = await expectedCount(q, d, p);
    const planned = d.depends_on.length === 0 && gate && (d.not_before === null || d.not_before(p) <= now) && d.cycle_code === null && expected > 0;
    const skipped = kind === "tax_year" && expected === 0;
    const status = skipped ? "skipped" : planned ? "planned" : "blocked";
    const sid = randomUUID();
    await q.query(`INSERT INTO close_period_steps (id, close_period_id, code, owner_process, depends_on, cycle_code, unit_scope, not_before, owner_timer_code, receipt_event_type, receipt_filter, expected_receipts, status, skipped_reason, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $15)`,
      [sid, id, d.code, d.owner_process, [...d.depends_on], d.cycle_code, d.unit_scope, d.not_before ? d.not_before(p) : null, d.owner_timer_code, d.receipt_event_type, JSON.stringify(d.receipt_filter(p)), expected, status, skipped ? skipReason(d.code) : null, now]);
    steps.push({ code: d.code, status });
    if (planned) entries.push({ close_period_id: id, step_id: sid, type: "close.step.planned", actor: ctx.actor, occurred_at: now, payload: { step: d.code, units: [], receipt_only: true } });
    if (skipped) entries.push({ close_period_id: id, step_id: sid, type: "close.step.skipped", actor: { kind: "system", id: "close-planner" }, occurred_at: now, payload: { step: d.code, reason: skipReason(d.code), by: "system" } });
  }
  await journal(q, { close_period_id: id, type: "close.period.opened", source_event_id: null, actor: ctx.actor, occurred_at: now, payload: { period: i.period, period_end, servicer_number: i.servicer_number, event_id: opened.id, source_event_id: i.source_event_id ?? null, steps: steps.map((s) => s.code) } });
  for (const e of entries) await journal(q, e);
  for (const s of steps) if (s.status === "skipped") ctx.events.append({ type: "close.step.skipped", aggregate: periodAggregate(i.servicer_number, i.period), actor: { kind: "system", id: "close-planner" }, payload: { close_period_id: id, period: i.period, step: s.code, reason: skipReason(s.code), by: "system" } });
  if (kind === "month" && isDecember(i.period)) {
    const ty = taxYearOf(i.period);
    ctx.events.append({ type: "close.tax_year.planned", aggregate: GLOBAL_AGG, actor: ctx.actor, payload: { tax_year: ty, tax_year_end: taxYearEnd(ty), close_period_id: id, period: i.period, servicer_number: i.servicer_number } });
    await journal(q, { close_period_id: id, type: "close.tax_year.planned", actor: ctx.actor, occurred_at: now, payload: { tax_year: ty, tax_year_end: taxYearEnd(ty) } });
  }
  const period = (await periodByKey(q, kind, i.period, i.servicer_number))!;
  return { period, created: true, steps };
}
const skipReason = (code: string): string => (code.startsWith("form_1099_ac") ? "no_1099_ac_loans" : code.startsWith("form_1099_int") ? "no_1099_int_loans" : "no_reportable_loans");
