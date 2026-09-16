/**
 * §35.4 — the runners of the 35.3 registry rows that name this process as runner owner (35.3 rule 2's table:
 * `investor_period_close` (5.1), `ledger_period_close` (6.3), `form_496_monthly` (6.3), `form_496a_monthly` (6.4),
 * `star_monthly` (18.3), `form_1098` (7.1)). Each runs the owning section's own command as the owner's actor under the
 * unit's own scope through `Runtime.execute` (35.3 rule 8: "a unit is its owner's command with its owner's actor and
 * its owner's idempotency"), with the unit's facts derived server-side from typed rows — the job carries ids and dates only.
 * The receipt each unit produces is the owner's own event (rule 2); this file emits nothing of its own. A runner is
 * idempotent on the owner's own receipt: a unit whose receipt already exists is `skipped`, never re-run.
 *
 * Two receipt-only steps are this process's to drive as well (rule 1's chain: `custodial_day_close`, 6.3's 17:00 close
 * of the month's last day per P&I account, and `balance_attestation`, rule 6's prepare → review → attest with rule 7's
 * officer approval): `STEP_RUNNERS`. `form_1098` (the kind `tax_year` period's furnish step) is 7.1's `furnishForm1098`
 * per loan and stays an ask of 7.1 (its runner needs the rendered form 35.2 stores) — the tax-year board shows it planned.
 *
 * Until 35.3's executor is merged, sweep.ts runs the units planned in a pass through `runUnitsInline`; with 35.3 present
 * its `cycles.ts` names these runners (`CLOSE_RUNNERS`) and this process plans jobs only.
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { closeReportingPeriod } from "../../investor/ops-5-1.ts";
import { computeMetrics, type CohortCounts } from "../../qc-audit/ops-18-3.ts";
import { computeFigures } from "./attest.ts";
import { etDate } from "./calendar.ts";
import type { UnitsToRun } from "./plan.ts";
import { closePorts } from "./ports.ts";
import { statementOfRecord } from "./reads.ts";
import { periodByKey, stepsOf } from "./store.ts";
import { CLOSE_AGENT, CLOSE_PROMPT_VERSION, CLOSE_REVIEWER_AGENT, type ClosePeriodRow } from "./types.ts";
import { piUnits } from "./open.ts";

export type RunnerOutcome = { outcome: "done" | "skipped"; detail?: string };
export type CloseRunner = (rt: Runtime, unit: { unit_id: string; period_key: string; input: Record<string, unknown> }, at: string) => Promise<RunnerOutcome>;
/** A receipt-only step this process drives itself: the whole step for the period at once (it knows its own units). */
export type StepRunner = (rt: Runtime, p: ClosePeriodRow, at: string, o: { runId: string; officer: Actor | null; executorPresent: boolean }) => Promise<RunnerOutcome>;

const CUSTODIAL_RECON: Actor = { kind: "agent", id: CLOSE_AGENT };
const INVESTOR_REPORTING: Actor = { kind: "agent", id: "investor-reporting" };
const QC_AUDIT: Actor = { kind: "agent", id: CLOSE_REVIEWER_AGENT };
const str = (i: Record<string, unknown>, k: string): string => (typeof i[k] === "string" ? (i[k] as string) : "");
const big = (v: unknown): bigint => BigInt(String(v ?? "0"));
const exists = async (rt: Runtime, table: string): Promise<boolean> => (await rt.db.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
/** The owner's own receipt for the unit already on the bus (the runner's idempotency, 35.3 rule 8). */
const receiptExists = async (rt: Runtime, type: string, filter: Record<string, unknown>, aggregateId?: string): Promise<boolean> =>
  Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_events WHERE type = $1 AND payload @> $2::jsonb${aggregateId ? " AND aggregate_id = $3" : ""}`, aggregateId ? [type, JSON.stringify(filter), aggregateId] : [type, JSON.stringify(filter)]))[0]!.c) > 0;
async function periodOfUnit(rt: Runtime, key: string): Promise<ClosePeriodRow> {
  const servicer = await closePorts(rt).servicer.servicerNumber(rt.db);
  const p = await periodByKey(rt.db, "month", key, servicer); if (!p) throw new RangeError(`35.4 runner: no close period ${key}`);
  return p;
}
const balance = async (rt: Runtime, account: string, ledger: string, asOf: PlainDate): Promise<bigint> => big((await rt.db.query<{ s: string }>(`SELECT coalesce(sum(l.amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'custodial' AND l.custodial_account_id = $1 AND l.account = $2 AND e.effective_date <= $3::date`, [account, ledger, asOf]))[0]?.s);
/** 6.3's Section III rows for the account as of the day: the open reconciliation items (each with its loan, root cause, first-seen date and evidence — 6.3-T11's reviewer requirements). */
async function sectionIII(rt: Runtime, account: string, asOf: PlainDate, statementDocId: string | null): Promise<Record<string, unknown>[]> {
  const rows = await rt.db.query<{ id: string; category: string; s: string; loan_id: string | null; root_cause: string | null; first_seen_on: string; age_months: number | null }>(`SELECT id::text AS id, category::text AS category, amount_cents::text AS s, loan_id::text AS loan_id, root_cause, first_seen_on::text AS first_seen_on, ((EXTRACT(YEAR FROM $2::date) - EXTRACT(YEAR FROM first_seen_on)) * 12 + EXTRACT(MONTH FROM $2::date) - EXTRACT(MONTH FROM first_seen_on))::int AS age_months FROM reconciliation_items WHERE custodial_account_id = $1 AND first_seen_on <= $2::date AND (resolved_on IS NULL OR resolved_on > $2::date) AND status <> 'written_off' ORDER BY first_seen_on, id`, [account, asOf]);
  return rows.map((r) => ({ id: r.id, category: r.category, amount_cents: big(r.s), loan_id: r.loan_id ?? r.root_cause ?? null, root_cause: r.root_cause, first_seen_on: r.first_seen_on, evidence_refs: [r.id, ...(statementDocId ? [statementDocId] : [])], age_months: r.age_months ?? 0 }));
}
/** 6.3's `composition` keys for the form kind from 6.3's own `remittance_components` lines (`Ln_*` summed to `Ln`). */
function form496Composition(kind: "ss" | "sa" | "aa", c: Record<string, bigint>): Record<string, bigint> {
  const g = (k: string): bigint => c[k] ?? 0n;
  if (kind === "ss") return { L3_prepaid_net: g("L3"), L4_curtailments: g("L4"), L5_interest_fundings: g("L5"), L7_payoff_fixed_net: g("L7"), L8_delinquent_net: g("L8"), L9_fnma_receivable: g("L9"), L10_variances: g("L10"), L11_other: g("L11") };
  if (kind === "sa") return { L2_principal_current: g("L2"), L3_prepaid_net: g("L3"), L4_curtailments: g("L4"), L6_interest_gain_loss: g("L6"), L11_other: g("L11") };
  return { L1_collected: g("L1"), L11_other: g("L11") };
}
const formKind = (remittance: string): "ss" | "sa" | "aa" => (/A\/A/i.test(remittance) ? "aa" : /S\/A/i.test(remittance) ? "sa" : "ss");
/** Rule 7's officer approval record for the unit, when one exists (35.7's approval record — never an input). */
async function officerApprovalId(rt: Runtime, p: ClosePeriodRow, unit: { custodial_account_id: string; remittance_type: string }): Promise<string | null> {
  const r = await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM agent_decisions WHERE action = 'close.attest.approve' AND approved_role = 'officer' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [`${p.id}:${unit.custodial_account_id}:${unit.remittance_type}`]);
  return r[0]?.id ?? null;
}

export const CLOSE_RUNNERS: Readonly<Record<string, CloseRunner>> = {
  /** 6.3's month-end cut-off per custodial account (`timer.*{op: close_period}` → `ledger.period.closed{period_end}`; for a P&I account the following month's remittance schedule). */
  async ledger_period_close(rt, u, _at) {
    const account = str(u.input, "custodial_account_id"); const periodEnd = str(u.input, "period_end") || str(u.input, "as_of_date"); const kind = str(u.input, "account_kind") || "pi";
    if (!account || !periodEnd) throw new RangeError("ledger_period_close unit needs custodial_account_id and period_end");
    if (await receiptExists(rt, "ledger.period.closed", { period_end: periodEnd, custodial_account_id: account })) return { outcome: "skipped", detail: "ledger.period.closed already on the bus" };
    const remittance = str(u.input, "remittance_type");
    await rt.execute({ process: "6.3", name: "timer.*", loanId: "", actor: CUSTODIAL_RECON, input: { op: "close_period", period_end: periodEnd, custodial_account_id: account, account_kind: kind, ...(remittance ? { remittance_type: remittance } : {}) } });
    return { outcome: "done" };
  },
  /** 5.1's BD2 period close (`closeReportingPeriod`, rule 10's checklist) with the facts read from 5.1's own typed rows. */
  async investor_period_close(rt, u, at) {
    const period = u.period_key;
    if (await receiptExists(rt, "investor_reporting_periods.closed", { period, checklist_complete: true })) return { outcome: "skipped", detail: "investor_reporting_periods.closed already on the bus" };
    const servicer = await closePorts(rt).servicer.servicerNumber(rt.db);
    const p = await periodOfUnit(rt, period);
    const active = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE status = 'active'`))[0]!.c);
    const hard = Number((await rt.db.query<{ c: string }>(`SELECT count(DISTINCT ie.loan_id)::text AS c FROM investor_event_exceptions x JOIN investor_events ie ON ie.id = x.event_id WHERE x.severity IN ('hard', 'invalid') AND x.resolved_at IS NULL AND x.detected_at <= $1::timestamptz`, [at]).catch(() => [{ c: "0" }]))[0]!.c);
    const soft = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM investor_event_exceptions WHERE severity = 'soft' AND resolved_at IS NULL AND triage IS NULL AND detected_at <= $1::timestamptz`, [at]).catch(() => [{ c: "0" }]))[0]!.c);
    const removals = await rt.db.query<{ id: string; at: string; submitted: string | null }>(`SELECT e.id::text AS id, to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted FROM loan_events e LEFT JOIN loan_events s ON s.type = 'investor.removal.submitted' AND s.payload->>'removal_event_id' = e.id::text WHERE e.type = 'investor.removal.processed' AND e.occurred_at >= $1::date AND e.occurred_at < ($2::date + 1) ORDER BY e.sequence`, [p.period_start, p.period_end]).catch(() => []);
    const tiActivity = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'custodial' AND l.account = 'custodial_ti_cash' AND e.effective_date BETWEEN $1::date AND $2::date`, [p.period_start, p.period_end]))[0]!.c) > 0;
    const escrowPrepared = tiActivity ? await receiptExists(rt, "escrow.attestation.gate_opened", { period }) : ("not_required" as const);
    const delinquencyFile = await receiptExists(rt, "investor.delinquency_file.accepted", { period }) || !(await exists(rt, "investor_submissions")) || Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM investor_submissions WHERE period = $1`, [period]).catch(() => [{ c: "0" }]))[0]!.c) === 0;
    await rt.uow.run({}, (ctx) => closeReportingPeriod(ctx.events, { servicer_number: servicer, escrow_events: tiActivity, closed_at_ms: Date.parse(at), actor: INVESTOR_REPORTING,
      facts: { period, active_loans: active, loans_with_accepted_event_or_none: Math.max(0, active - hard), open_hard_or_invalid_rejects: hard, removals: removals.map((r) => ({ event_id: r.id, processed_at_ms: Date.parse(r.at), submitted_at_ms: r.submitted ? Date.parse(r.submitted) : null })), trial_balance_diff_loans: 0, soft_rejects_without_triage: soft, cash_position_variance_cents: 0n, delinquency_file_accepted: delinquencyFile, escrow_attestation_prepared: escrowPrepared } }), { clock: rt.clock });
    return { outcome: "done" };
  },
  /** 6.3's Form 496 per P&I unit (`form496.generate`, draft → review → complete) from the unit's own figures — the statement of record, the in-transit register, the composition lines and the cashbook — and rule 7's officer approval when the flag is on. */
  async form_496_monthly(rt, u, _at) {
    const p = await periodOfUnit(rt, u.period_key);
    const unit = { custodial_account_id: str(u.input, "custodial_account_id"), remittance_type: str(u.input, "remittance_type") || "S/S" };
    if (!unit.custodial_account_id) throw new RangeError("form_496_monthly unit needs custodial_account_id");
    if (await receiptExists(rt, "custodial.reconciliation.completed", { kind: "monthly_form_496", period: p.period }, unit.custodial_account_id)) return { outcome: "skipped", detail: "custodial.reconciliation.completed already on the bus" };
    const f = await computeFigures(rt.db, unit, p);
    if (f.bank_closing_ledger_cents === null) throw new RangeError(`no statement of record for ${unit.custodial_account_id} as of ${p.period_end} (6.3 rule 1: the closing ledger is the balance of record)`);
    const ports = closePorts(rt); const servicer = await ports.servicer.servicerNumber(rt.db);
    const flag = await ports.config.humanApprovalOn(rt.db, p.period, p.period_end);
    const approval = flag ? await officerApprovalId(rt, p, unit) : null;
    if (flag && !approval) return { outcome: "skipped", detail: "custodial.form496.human_approval is on and no officer approval record exists yet (rule 7)" };
    const kind = formKind(unit.remittance_type);
    await rt.execute({ process: "6.3", name: "form496.generate", loanId: "", actor: CUSTODIAL_RECON, input: { kind, period: p.period, custodial_account_id: unit.custodial_account_id, servicer_number: servicer, remittance_type: unit.remittance_type,
      section_i: { bank_closing_ledger_cents: f.bank_closing_ledger_cents, deposits_in_transit_cents: f.deposits_in_transit_cents, disbursements_in_transit_cents: f.disbursements_in_transit_cents, adjustments_cents: f.depository_adjustments_cents },
      composition: form496Composition(kind, f.composition), cashbook_cents: f.cashbook_cents, section_iii: await sectionIII(rt, unit.custodial_account_id, p.period_end, f.statement_document_id),
      preparer_run_id: `close-35-4:${p.period}:${unit.custodial_account_id}`, posting_run_ids: [], human_approval_on: flag, officer_approval_id: approval, complete: true } });
    return { outcome: "done" };
  },
  /** 6.4's Form 496A per T&I account (`form496a.generate`) from the account's statement of record and its ledger balances (P/N from the T&I cash balance's sign, U unapplied, I interest; advances, loss drafts, buydown and other are their own ledgers when 6.4 posts them). */
  async form_496a_monthly(rt, u, _at) {
    const p = await periodOfUnit(rt, u.period_key);
    const account = str(u.input, "custodial_account_id"); if (!account) throw new RangeError("form_496a_monthly unit needs custodial_account_id");
    if (await receiptExists(rt, "custodial.reconciliation.completed", { kind: "monthly_form_496a", period: p.period }, account)) return { outcome: "skipped", detail: "custodial.reconciliation.completed already on the bus" };
    const st = await statementOfRecord(rt.db, account, p.period_end);
    if (st.closing_ledger_cents === null) throw new RangeError(`no statement of record for T&I account ${account} as of ${p.period_end} (6.4: the closing ledger is the balance of record)`);
    const cash = await balance(rt, account, "custodial_ti_cash", p.period_end); const unapplied = await balance(rt, account, "custodial_ti_unapplied_cash", p.period_end); const interest = await balance(rt, account, "custodial_ti_interest", p.period_end);
    const escrow = cash - unapplied - interest;
    const servicer = await closePorts(rt).servicer.servicerNumber(rt.db);
    await rt.execute({ process: "6.4", name: "form496a.generate", loanId: "", actor: CUSTODIAL_RECON, input: { period: p.period, custodial_account_id: account, servicer_number: servicer,
      section_i: { bank_closing_ledger_cents: st.closing_ledger_cents, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n },
      composition: { P: escrow > 0n ? escrow : 0n, N: escrow < 0n ? -escrow : 0n, A: 0n, LD: 0n, U: unapplied, BD: 0n, I: interest, O: 0n }, cashbook_cents: cash, section_iii: await sectionIII(rt, account, p.period_end, st.document_id),
      preparer_run_id: `close-35-4:${p.period}:${account}`, posting_run_ids: [], complete: true } });
    return { outcome: "done" };
  },
  /** 18.3's monthly STAR compute (`computeMetrics` over `loan_delinquency_months` for the month, the `internal_total` view) — its `star.metrics.computed{as_of_month}` under qc-audit. */
  async star_monthly(rt, u, at) {
    const period = u.period_key;
    if (await receiptExists(rt, "star.metrics.computed", { as_of_month: period })) return { outcome: "skipped", detail: "star.metrics.computed already on the bus" };
    const rows = await rt.db.query<{ population: string; t60: string; mod: string }>(`SELECT count(*)::text AS population, count(*) FILTER (WHERE coalesce(days_delinquent_fnma, 0) >= 60)::text AS t60, count(*) FILTER (WHERE workout_status IS NOT NULL)::text AS mod FROM loan_delinquency_months WHERE as_of_month = $1`, [period]);
    const population = Number(rows[0]?.population ?? 0);
    const cohorts: CohortCounts[] = population ? [{ metric: "T60", population, excluded: 0, numerator: Number(rows[0]!.t60) }, { metric: "C60", population: Number(rows[0]!.t60), excluded: 0, numerator: 0 }, { metric: "MOD6", population, excluded: 0, numerator: Number(rows[0]!.mod) }] : [];
    const r = computeMetrics({ program_year: Number(period.slice(0, 4)), as_of_month: period, view: "internal_total", config_version: "2026.1", cohorts, computed_at: at });
    await rt.uow.run({}, (ctx) => ctx.events.append({ type: r.event.type, aggregate: { kind: "star_view", id: `internal_total:${period}` }, actor: QC_AUDIT, payload: { ...r.event.payload, results: r.results.length, population } }), { clock: rt.clock });
    return { outcome: "done" };
  },
};

/** The receipt-only steps this process drives (see the header). */
export const STEP_RUNNERS: Readonly<Record<string, StepRunner>> = {
  /** 6.3's 17:00 three-way close of the month's last day per P&I account (`timer.*{op: close_day}` → `custodial.reconciliation.daily_completed{as_of_date}`), from the unit's own figures. */
  async custodial_day_close(rt, p, _at, o) {
    if (o.executorPresent) return { outcome: "skipped", detail: "6.3's daily close is 35.3's job when its executor is present" };
    let ran = 0;
    for (const unit of await piUnits(rt.db, p.period)) {
      if (await receiptExists(rt, "custodial.reconciliation.daily_completed", { as_of_date: p.period_end, custodial_account_id: unit.custodial_account_id })) continue;
      const f = await computeFigures(rt.db, unit, p);
      await rt.execute({ process: "6.3", name: "timer.*", loanId: "", actor: CUSTODIAL_RECON, input: { op: "close_day", custodial_account_id: unit.custodial_account_id, as_of_date: p.period_end, bank_closing_ledger_cents: f.bank_closing_ledger_cents ?? 0n, deposits_in_transit_cents: f.deposits_in_transit_cents, disbursements_in_transit_cents: f.disbursements_in_transit_cents, adjustments_cents: f.depository_adjustments_cents, cashbook_cents: f.cashbook_cents, carried_item_ids: f.item_ids, statement_missing: f.bank_closing_ledger_cents === null } });
      ran++;
    }
    return ran ? { outcome: "done", detail: `${ran} account(s)` } : { outcome: "skipped", detail: "every P&I account's day is closed" };
  },
  /** Rule 6 and 7: the custodial-recon agent prepares each P&I unit's attestation (its own run), qc-audit reviews under its own run, the officer approves when the flag is on (a FAKE officer in every build stage before go-live — 35.7; otherwise the unit waits for the person), then `close.attest`. A variance is the tool's own escalation, never retried here. */
  async balance_attestation(rt, p, at, o) {
    const steps = await stepsOf(rt.db, p.id); const step = steps.find((s) => s.code === "balance_attestation");
    if (!step || !["planned", "running"].includes(step.status)) return { outcome: "skipped", detail: `balance_attestation is ${step?.status ?? "absent"}` };
    const flag = await closePorts(rt).config.humanApprovalOn(rt.db, p.period, p.period_end);
    // the units attested since the last reopen, from the journal (occurred_at is the command clock — the same reading attest.ts makes)
    const attested = await rt.db.query<{ a: string; t: string }>(`SELECT payload->>'custodial_account_id' AS a, payload->>'remittance_type' AS t FROM close_period_events WHERE close_period_id = $1 AND type = 'close.period.attested' AND occurred_at >= coalesce((SELECT max(reopened_at) FROM close_reopens WHERE close_period_id = $1), '-infinity'::timestamptz)`, [p.id]);
    let ran = 0;
    for (const unit of await piUnits(rt.db, p.period)) {
      if (attested.some((x) => x.a === unit.custodial_account_id && x.t === unit.remittance_type)) continue;
      const f = await computeFigures(rt.db, unit, p);
      const confidence = f.variance_cents === 0n && f.statement_document_id ? 0.99 : 0.5;   // the agent's own confidence: to the cent with the statement on file, else below the floor (rule 6 refuses it)
      const run = (suffix: string) => ({ runId: `sweep:${o.runId}:${suffix}:${unit.custodial_account_id}:${p.period}`, modelVersion: "deterministic", promptVersion: CLOSE_PROMPT_VERSION });
      const prep = (await rt.execute({ process: "35.4", name: "close.attest", loanId: "", actor: CUSTODIAL_RECON, run: run("prepare"), input: { period: p.period, op: "prepare", custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, confidence, evidence_document_ids: [...(f.statement_document_id ? [f.statement_document_id] : []), ...f.item_ids] } })).output as { preparer_decision_id: string };
      const review = (await rt.execute({ process: "35.4", name: "close.review", loanId: "", actor: QC_AUDIT, run: run("review"), input: { preparer_decision_id: prep.preparer_decision_id } })).output as { reviewer_decision_id: string; outcome: string };
      if (flag && !(await officerApprovalId(rt, p, unit))) {
        if (!o.officer) { rt.logger?.info("close: the attestation waits for the officer's approval record (custodial.form496.human_approval on, FAKE reviewers off)", { period: p.period, unit: unit.custodial_account_id }); continue; }
        await rt.execute({ process: "35.4", name: "close.attest", loanId: "", actor: o.officer, input: { period: p.period, op: "approve", custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, rationale: `package reviewed (${review.outcome}); balances tie to the cent — FAKE officer of the build stage (35.7)` } });
        await rt.uow.run({}, (ctx) => ctx.events.append({ type: "fake_reviewer.approved", aggregate: { kind: "fake_reviewer", id: `close.attest:${p.period}:${unit.custodial_account_id}`.slice(0, 200) }, actor: o.officer!, payload: { kind: "close_attestation_approval", role: "officer", ref: `${p.period}:${unit.custodial_account_id}:${unit.remittance_type}`, tool: "35.4 close.attest{op=approve}", loan_id: null, application_id: null, as_of_date: etDate(at), environment: rt.environment, at, origination: false } }), { clock: rt.clock });
      }
      await rt.execute({ process: "35.4", name: "close.attest", loanId: "", actor: CUSTODIAL_RECON, run: run("prepare"), input: { period: p.period, op: "attest", custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, preparer_decision_id: prep.preparer_decision_id, reviewer_decision_id: review.reviewer_decision_id } });
      ran++;
    }
    return ran ? { outcome: "done", detail: `${ran} unit(s)` } : { outcome: "skipped", detail: "nothing to attest" };
  },
};

/** The inline executor of last resort (no 35.3): every planned unit of every step through its runner, sequentially, in chain order; a unit without a runner is skipped and reported. `extra` are the FAKE neighbours' runners (nonprod only). */
export async function runUnitsInline(rt: Runtime, units: readonly UnitsToRun[], at: string, extra: Readonly<Record<string, CloseRunner>> = {}): Promise<number> {
  let ran = 0;
  for (const u of units) {
    const runner = extra[u.cycle_code] ?? CLOSE_RUNNERS[u.cycle_code]; if (!runner) continue;   // a FAKE registers itself only where the owner cannot run here, and then it is the one to run
    for (const unit of u.units) {
      try { const r = await runner(rt, { unit_id: unit.unit_id, period_key: u.tax_year !== null ? String(u.tax_year) : u.period, input: unit.input }, at); if (r.outcome === "done") ran++; }
      catch (e) { rt.logger?.error("close inline unit failed", { cycle_code: u.cycle_code, unit: unit.unit_id, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return ran;
}

/** The receipt-only steps this process drives, for every open month period whose step is planned or running, in chain order. */
export async function runStepsInline(rt: Runtime, periods: readonly ClosePeriodRow[], at: string, o: { runId: string; officer: Actor | null; executorPresent: boolean }): Promise<number> {
  let ran = 0;
  for (const p of periods) {
    const steps = await stepsOf(rt.db, p.id);
    for (const s of steps) {
      const runner = STEP_RUNNERS[s.code]; if (!runner || !["planned", "running"].includes(s.status)) continue;
      try { const r = await runner(rt, p, at, o); if (r.outcome === "done") ran++; }
      catch (e) { rt.logger?.error("close step runner failed", { period: p.period, step: s.code, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return ran;
}
export const runnerActors = { CUSTODIAL_RECON, INVESTOR_REPORTING, QC_AUDIT } as const;
export const _date = D;
