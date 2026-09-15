/**
 * §35.5 — the installment schedule (`loan_installments`, `installment_schedule_runs`), rule set `cashiering.schedule.v1`.
 *
 *   projectSchedule(input)            rule 2, pure: row k interest = round_half_up(U_k × rate_bps ÷ 12,000,000), principal = P&I − interest,
 *                                     U_{k+1} = U_k − principal, escrow = 3.6's effective portion; the final row absorbs the rounding
 *                                     (principal = U_n, pi = interest_n + U_n). `maturity_variance_cents` = the UPB left at maturity
 *                                     before the final row absorbs it: 0 when |L| < P&I (rounding), else L — 1.1's HF-005 exception.
 *   projectBoarding(ctx, facts, deps) rule 1, inside the boarding transaction (both paths): HF-005 (`levelPayment` on the original
 *                                     terms vs the tape/CD P&I, > 1¢ → SCHEDULE_REQUIRED), zero rows → SCHEDULE_REQUIRED, the run and
 *                                     the rows, `installment.schedule.written` (satisfies SM_INSTALLMENT_SCHEDULE_AT_BOARD_0 — armed
 *                                     explicitly on the transfer path by timers-35-5.ts armServicingSideClocks), the decision record.
 *   persistBoardingSchedule(q, …)     the typed rows in the same transaction (the commit hook on the fund path; the batch's db.tx on the
 *                                     transfer path): the decision, the run row, the rows (INSERT … ON CONFLICT on the primary key).
 *   reprojectSchedule(…)              rule 3 for `installments.reproject`: every `due` row with due_date ≥ effective_from replaced from the
 *                                     expected UPB (the first replaced row's upb_before), satisfied/prepaid rows kept; a satisfied row on or
 *                                     after the effective date → SATISFIED_ROW_FROZEN; `installment.schedule.reprojected` satisfies
 *                                     SM_INSTALLMENT_REPROJECT_1BD; the rows land through the command's deferred write.
 *   satisfyInstallments / restoreInstallments   the status moves 2.1's `payment.posted` / `payment.reversed` drive (the unit of 35.5 rule 6
 *                                     calls them in 2.1's transaction; the events are the caller's).
 *   registerReprojectionReactor(rt)   after any commit carrying a `loan_terms.*` event on a loan, run `installments.reproject` on the bus.
 *
 * Money is bigint cents; dates are PlainDate; every event type here is a string literal (tools/lint-emission.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import type { PgDecisionRepository, DecisionInput } from "../../infra/db/decisions.ts";
import { CommandRefused, type CommandContext } from "../../app/commands.ts";
import { EscalationService } from "../../app/escalations.ts";
import { str, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import type { Actor, Clock, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { levelPayment, ratePercent, absDiff, type Cents } from "../../kernel/money/cents.ts";
import type { Runtime } from "../../runtime/app.ts";
import { armServicingSideClocks } from "./timers-35-5.ts";

export const CASHIERING_AGENT: Actor = { kind: "agent", id: "cashiering" };
export const RULE_SET_SCHEDULE = "cashiering.schedule.v1";
export const PROMPT_VERSION_35_5 = "35.5-v1";
export const MODEL_VERSION_DETERMINISTIC = "deterministic";
/** Event literals this file emits (and the boarding trigger it reads). */
export const SCHEDULE_WRITTEN = "installment.schedule.written";
export const SCHEDULE_REPROJECTED = "installment.schedule.reprojected";
const LOAN_BOARDED = "loan.boarded";
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const s = (v: Cents): string => v.toString();
const monthsBetween = (a: PlainDate, b: PlainDate): number => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
/** pct string × scale, rounded ("6.125" × 10,000 → 61250; "5.00" × 1000 → 5000). */
export const pctScaled = (pct: string, scale: number): number => Math.round(Number(pct) * scale);

// ---------------------------------------------------------------- the loan's terms (moved from src/runtime/servicing.ts; re-exported there)
export interface LoanTerms { readonly pi_cents: Cents; readonly escrow_payment_cents: Cents; readonly note_rate_bps: number; readonly late_charge_pct: string; readonly late_charge_grace_days: number; readonly late_charge_max_cents: Cents | null; readonly escrowed: boolean; readonly escrow_version: { escrow_payment_cents: Cents; effective_from: PlainDate; step_down_on: PlainDate | null; step_down_to_cents: Cents | null } | null; }
/** The escrow portion of the installment due on `due`: the 3.6 loan_terms version from its effective date (and the step-down after the plan) else the boarded terms. */
export function escrowPortionOn(terms: Pick<LoanTerms, "escrow_payment_cents" | "escrow_version">, due: PlainDate): Cents {
  const v = terms.escrow_version;
  if (v && due >= v.effective_from) { if (v.step_down_on && due >= v.step_down_on && v.step_down_to_cents !== null) return v.step_down_to_cents; return v.escrow_payment_cents; }
  return terms.escrow_payment_cents;
}
/** The 3.6 `loan_terms` version in the entity store (escrow_payment_cents + effective date + step-down), as servicing.ts reads it. */
export function escrowVersionFrom(lt: Record<string, unknown> | undefined): LoanTerms["escrow_version"] {
  return lt && lt.escrow_payment_cents !== undefined && typeof lt.escrow_payment_effective_from === "string" ? { escrow_payment_cents: c(lt.escrow_payment_cents), effective_from: D(lt.escrow_payment_effective_from), step_down_on: typeof lt.escrow_step_down_on === "string" ? D(lt.escrow_step_down_on) : null, step_down_to_cents: lt.escrow_step_down_to_cents !== undefined ? c(lt.escrow_step_down_to_cents) : null } : null;
}

// ---------------------------------------------------------------- rule 2: the arithmetic
export interface ScheduleInput {
  /** Opening UPB of the first row (the tape's UPB as of the LPI; the note amount at fund; the expected UPB at a reprojection). */
  readonly upb_start_cents: Cents;
  readonly first_due: PlainDate;
  /** Sequence of the first row (1 = the first payment date). */
  readonly first_sequence: number;
  readonly maturity_date: PlainDate;
  readonly pi_cents: Cents;
  /** loan_terms.note_rate_bps: pct × 10,000 (6.125% = 61250). */
  readonly rate_bps: number;
  readonly escrow: (due: PlainDate) => Cents;
}
export interface ScheduleRow {
  readonly sequence: number; readonly due_date: PlainDate; readonly upb_before_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly pi_cents: Cents;
  readonly escrow_cents: Cents; readonly upb_after_cents: Cents; readonly rate_bps: number; readonly absorbs_rounding: boolean;
}
export interface ScheduleProjection { readonly rows: readonly ScheduleRow[]; readonly total_interest_cents: Cents; readonly total_principal_cents: Cents; readonly maturity_variance_cents: Cents; }

/** Monthly interest on `upb` at `rate_bps` (pct × 10,000): round_half_up(U × rate ÷ 12) as bigint cents — 2.1 rule 5 / F-1-09. */
export function monthlyInterestBps(upb: Cents, rateBps: number): Cents { return divRound(upb * BigInt(rateBps), 12_000_000n, "HALF_UP"); }

/** Rule 2. Zero rows when `first_due` is after `maturity_date` (the caller refuses the board). */
export function projectSchedule(i: ScheduleInput): ScheduleProjection {
  const rows: ScheduleRow[] = [];
  if (i.first_due > i.maturity_date) return { rows, total_interest_cents: 0n, total_principal_cents: 0n, maturity_variance_cents: 0n };
  const n = monthsBetween(i.first_due, i.maturity_date) + 1;
  let upb = i.upb_start_cents; let totalInterest = 0n; let totalPrincipal = 0n; let variance = 0n;
  for (let k = 0; k < n; k++) {
    const due = addMonths(i.first_due, k);
    const last = k === n - 1;
    const interest = upb > 0n ? monthlyInterestBps(upb, i.rate_bps) : 0n;
    let principal = i.pi_cents - interest; let pi = i.pi_cents; let absorbs = false;
    if (last) {
      // L = the UPB left at maturity before the final row absorbs it: rounding when |L| < P&I, else the tape does not amortize (HF-005's exception)
      const left = upb - principal;
      variance = absDiff(left, 0n) < i.pi_cents ? 0n : left;
      principal = upb; pi = interest + upb; absorbs = true;
    } else if (principal >= upb) {
      // the loan pays off before maturity (a P&I above the level payment): this row takes the remaining UPB, the rows after carry nothing
      principal = upb; pi = interest + upb; absorbs = true;
    }
    const after = upb - principal;
    rows.push({ sequence: i.first_sequence + k, due_date: due, upb_before_cents: upb, interest_cents: interest, principal_cents: principal, pi_cents: pi, escrow_cents: i.escrow(due), upb_after_cents: after, rate_bps: i.rate_bps, absorbs_rounding: absorbs });
    totalInterest += interest; totalPrincipal += principal; upb = after;
  }
  return { rows, total_interest_cents: totalInterest, total_principal_cents: totalPrincipal, maturity_variance_cents: variance };
}

/** HF-005 / OB-003 re-assertion: the level payment on the original terms against the tape's or the CD's P&I (tolerance 1¢). */
export function levelPaymentCheck(originalUpb: Cents | null, noteRatePct: string, originalTermMonths: number | null, piCents: Cents): { level_payment_cents: Cents | null; diff_cents: Cents | null; ok: boolean } {
  if (originalUpb === null || originalTermMonths === null || originalTermMonths <= 0) return { level_payment_cents: null, diff_cents: null, ok: true };
  const level = levelPayment(originalUpb, ratePercent(noteRatePct), originalTermMonths);
  const diff = absDiff(level, piCents);
  return { level_payment_cents: level, diff_cents: diff, ok: diff <= 1n };
}

/** sha256 over the rows as written (sequence, due, the money columns, the rate). */
export function scheduleSha256(rows: readonly ScheduleRow[]): string {
  const h = createHash("sha256");
  for (const r of rows) h.update(`${r.sequence}|${r.due_date}|${r.upb_before_cents}|${r.interest_cents}|${r.principal_cents}|${r.pi_cents}|${r.escrow_cents}|${r.upb_after_cents}|${r.rate_bps}|${r.absorbs_rounding ? 1 : 0}\n`);
  return h.digest("hex");
}

// ---------------------------------------------------------------- rule 1: the schedule inside the boarding transaction
/** What the boarding path knows about the loan when `loan.boarded` is appended (the tape's fields; 30.2's mapped rows). */
export interface BoardingScheduleFacts {
  readonly loan_id: string;
  readonly source: "fund" | "transfer";
  /** null on the fund path: `loan_terms` v1 is inserted by the `before` hook; `persistBoardingSchedule` resolves the latest row. */
  readonly terms_id: string | null;
  /** The boarded UPB: the tape's UPB as of the LPI; the note amount at fund. */
  readonly upb_cents: Cents;
  /** The first unpaid due date: `next_due_date` on a transfer tape; `first_payment_date` at fund. */
  readonly first_due: PlainDate;
  readonly first_payment_date: PlainDate;
  readonly maturity_date: PlainDate;
  readonly original_upb_cents: Cents | null;
  readonly original_term_months: number | null;
  readonly note_rate_pct: string;
  readonly note_rate_bps: number;
  readonly pi_cents: Cents | null;
  readonly escrow_payment_cents: Cents;
  readonly amortization: string;
}
/** The context the projection runs in: the boarding transaction's event store, engine and clock (a unit of work's, or the transfer batch's in-memory set). */
export interface BoardingProjectionContext { readonly events: EventStore; readonly timers: TimerEngine; readonly clock: Clock; }
export interface BoardingProjectionDeps { readonly registry: TimerRegistry; readonly escalations: EscalationService; readonly batchId?: string; }
export interface ProjectedSchedule {
  readonly loan_id: string; readonly run_id: string; readonly decision_id: string; readonly decision: (termsId: string | null) => DecisionInput; readonly terms_id: string | null; readonly source: "fund" | "transfer";
  readonly trigger_event_id: string | null; readonly projection: ScheduleProjection; readonly pi_cents: Cents; readonly rate_bps: number; readonly upb_start_cents: Cents; readonly sha256: string; readonly hf005: ReturnType<typeof levelPaymentCheck>;
  readonly event: DomainEvent;
}

function refuse(command: string, code: string, citation: string, reason: string): never { throw new CommandRefused(command, code, citation, reason); }

/** Rule 1: the run and the rows for a boarding loan; `installment.schedule.written` on the log; the decision prepared (recorded by `persistBoardingSchedule` in the same transaction). Throws CommandRefused SCHEDULE_REQUIRED — the board is refused, nothing commits. */
export function projectBoarding(ctx: BoardingProjectionContext, f: BoardingScheduleFacts, deps: BoardingProjectionDeps): ProjectedSchedule {
  const command = "installments.write";
  if (f.pi_cents === null) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 1 / edge cases: a tape with no pi_cents", `loan ${f.loan_id}: pi_cents missing — 1.1's exception, not a guessed payment`);
  const pi = f.pi_cents;
  const hf005 = levelPaymentCheck(f.original_upb_cents, f.note_rate_pct, f.original_term_months, pi);
  if (f.amortization === "fixed" && !hf005.ok) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 2 / 1.1 HF-005: the level payment on the original terms is more than 1¢ from the P&I", `loan ${f.loan_id}: levelPayment ${hf005.level_payment_cents} vs pi ${pi} (diff ${hf005.diff_cents}¢)`);
  const terms = { escrow_payment_cents: f.escrow_payment_cents, escrow_version: null };
  const projection = projectSchedule({ upb_start_cents: f.upb_cents, first_due: f.first_due, first_sequence: monthsBetween(f.first_payment_date, f.first_due) + 1, maturity_date: f.maturity_date, pi_cents: pi, rate_bps: f.note_rate_bps, escrow: (due) => escrowPortionOn(terms, due) });
  if (!projection.rows.length) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 1: no loans row is committed without its rows", `loan ${f.loan_id}: no installment between ${f.first_due} and maturity ${f.maturity_date} — the first row is at or before maturity or the board is refused`);
  const run_id = randomUUID(); const decision_id = randomUUID();
  const sha256 = scheduleSha256(projection.rows);
  const boarded = ctx.events.byLoan(f.loan_id).filter((e) => e.type === LOAN_BOARDED).at(-1);
  // the transfer path's `loan.boarded` carries no origination context, so the engine skipped this section's clocks — arm them on the loan before the satisfier
  if (boarded) armServicingSideClocks(ctx.timers, deps.registry, boarded, ["SM_INSTALLMENT_SCHEDULE_AT_BOARD_0"]);
  const first = projection.rows[0]!; const last = projection.rows[projection.rows.length - 1]!;
  const event = ctx.events.append({ type: SCHEDULE_WRITTEN, loanId: f.loan_id, actor: CASHIERING_AGENT, ...(boarded ? { causationId: boarded.id } : {}),
    payload: { loan_id: f.loan_id, run_id, source: f.source, rows: projection.rows.length, first_due: first.due_date, last_due: last.due_date, pi_cents: s(pi), sha256, upb_start_cents: s(f.upb_cents), rate_bps: f.note_rate_bps, maturity_variance_cents: s(projection.maturity_variance_cents), decision_id } });
  if (projection.maturity_variance_cents !== 0n) {
    // worked example B: a tape that does not reproduce a zero variance still boards; the variance is 1.1's HF-005 exception, escalated to `officer`
    deps.escalations.open({ kind: "officer", ownerRole: "officer", loanId: f.loan_id, ...(deps.batchId ? { batchId: deps.batchId } : {}), severity: "2",
      payload: { rule_code: "HF-005", process: "35.5", run_id, reason: "the tape's UPB, P&I and next due date do not amortize to zero by maturity; the final row absorbs the variance", maturity_variance_cents: s(projection.maturity_variance_cents), pi_cents: s(pi), upb_start_cents: s(f.upb_cents), maturity_date: f.maturity_date, next: "transferor correction or officer waiver (money field)" } }, CASHIERING_AGENT);
  }
  // the decision record (the spec's schema): rationale = the record as JSON; the terms id is the boarding transaction's (resolved at persist time on the fund path)
  const decision = (termsId: string | null): DecisionInput => {
    const record = { loan_id: f.loan_id, action: "installments.write", inputs: { terms_id: termsId, source: f.source, trigger_event_id: boarded?.id ?? null, upb_start_cents: s(f.upb_cents), hf005: { level_payment_cents: hf005.level_payment_cents === null ? null : s(hf005.level_payment_cents), diff_cents: hf005.diff_cents === null ? null : s(hf005.diff_cents) } },
      outputs: { run_id, rows: projection.rows.length, first_due: first.due_date, last_due: last.due_date, sha256, maturity_variance_cents: s(projection.maturity_variance_cents), total_interest_cents: s(projection.total_interest_cents), total_principal_cents: s(projection.total_principal_cents) }, rule_set_version: RULE_SET_SCHEDULE, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1 };
    return { agent: CASHIERING_AGENT.id, action: "installments.write", rationale: toJson(record), ruleSetVersion: RULE_SET_SCHEDULE, loanId: f.loan_id, subject: { kind: "installment_schedule_run", id: run_id }, ruleCode: "HF-005", confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 };
  };
  return { loan_id: f.loan_id, run_id, decision_id, decision, terms_id: f.terms_id, source: f.source, trigger_event_id: boarded?.id ?? null, projection, pi_cents: pi, rate_bps: f.note_rate_bps, upb_start_cents: f.upb_cents, sha256, hf005, event };
}

/** The latest `loan_terms` row of the loan (effective_from, created_at). */
export async function latestTermsId(q: Queryable, loanId: string): Promise<string | null> {
  return (await q.query<{ id: string }>(`SELECT id FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0]?.id ?? null;
}

export interface RunRowInput {
  readonly id: string; readonly loan_id: string; readonly terms_id: string | null; readonly source: "fund" | "transfer" | "reprojection" | "correction"; readonly trigger_event_id: string | null; readonly first_due: PlainDate; readonly last_due: PlainDate;
  readonly rows: number; readonly rows_replaced: number; readonly rows_kept: number; readonly pi_cents: Cents; readonly rate_bps: number; readonly upb_start_cents: Cents; readonly total_interest_cents: Cents; readonly total_principal_cents: Cents;
  readonly maturity_variance_cents: Cents; readonly replaced: readonly Record<string, unknown>[]; readonly sha256: string; readonly decision_id: string | null;
}
/** One `installment_schedule_runs` row. */
export async function insertScheduleRun(q: Queryable, r: RunRowInput): Promise<void> {
  await q.query(`INSERT INTO installment_schedule_runs (id, loan_id, terms_id, source, trigger_event_id, first_due, last_due, rows, rows_replaced, rows_kept, pi_cents, rate_bps, upb_start_cents, total_interest_cents, total_principal_cents, maturity_variance_cents, replaced, sha256, decision_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)`,
    [r.id, r.loan_id, r.terms_id, r.source, r.trigger_event_id, r.first_due, r.last_due, r.rows, r.rows_replaced, r.rows_kept, r.pi_cents, r.rate_bps, r.upb_start_cents, r.total_interest_cents, r.total_principal_cents, r.maturity_variance_cents, toJson(r.replaced), r.sha256, r.decision_id]);
}
/** The rows: INSERT … ON CONFLICT (loan_id, due_date) DO UPDATE — rule 3 replaces `due` rows in place (the row trigger protects satisfied ones); one statement per run (unnest). */
export async function persistScheduleRows(q: Queryable, loanId: string, runId: string, termsId: string | null, rows: readonly ScheduleRow[]): Promise<void> {
  if (!rows.length) return;
  await q.query(`INSERT INTO loan_installments (loan_id, due_date, pi_cents, interest_cents, principal_cents, escrow_cents, status, sequence, upb_before_cents, upb_after_cents, rate_bps, terms_id, schedule_run_id, absorbs_rounding)
    SELECT $1, d, pi, i, p, e, 'due', sq, ub, ua, rb, $2, $3, ab FROM unnest($4::date[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[], $9::int[], $10::bigint[], $11::bigint[], $12::int[], $13::boolean[]) AS t(d, pi, i, p, e, sq, ub, ua, rb, ab)
    ON CONFLICT (loan_id, due_date) DO UPDATE SET pi_cents = EXCLUDED.pi_cents, interest_cents = EXCLUDED.interest_cents, principal_cents = EXCLUDED.principal_cents, escrow_cents = EXCLUDED.escrow_cents, status = 'due', sequence = EXCLUDED.sequence,
      upb_before_cents = EXCLUDED.upb_before_cents, upb_after_cents = EXCLUDED.upb_after_cents, rate_bps = EXCLUDED.rate_bps, terms_id = EXCLUDED.terms_id, schedule_run_id = EXCLUDED.schedule_run_id, absorbs_rounding = EXCLUDED.absorbs_rounding, updated_at = now()`,
    [loanId, termsId, runId, rows.map((r) => r.due_date), rows.map((r) => r.pi_cents), rows.map((r) => r.interest_cents), rows.map((r) => r.principal_cents), rows.map((r) => r.escrow_cents), rows.map((r) => r.sequence), rows.map((r) => r.upb_before_cents), rows.map((r) => r.upb_after_cents), rows.map((r) => r.rate_bps), rows.map((r) => r.absorbs_rounding)]);
}

/** The typed rows of a boarding projection, in the boarding transaction: the decision (its id known to the run), the run, the rows. */
export async function persistBoardingSchedule(q: Queryable, decisions: PgDecisionRepository, p: ProjectedSchedule): Promise<{ terms_id: string | null }> {
  const termsId = p.terms_id ?? (await latestTermsId(q, p.loan_id));
  await decisions.record(p.decision(termsId), q, p.decision_id);
  const rows = p.projection.rows; const first = rows[0]!; const last = rows[rows.length - 1]!;
  await insertScheduleRun(q, { id: p.run_id, loan_id: p.loan_id, terms_id: termsId, source: p.source, trigger_event_id: p.trigger_event_id, first_due: first.due_date, last_due: last.due_date, rows: rows.length, rows_replaced: 0, rows_kept: 0, pi_cents: p.pi_cents, rate_bps: p.rate_bps, upb_start_cents: p.upb_start_cents,
    total_interest_cents: p.projection.total_interest_cents, total_principal_cents: p.projection.total_principal_cents, maturity_variance_cents: p.projection.maturity_variance_cents, replaced: [], sha256: p.sha256, decision_id: p.decision_id });
  await persistScheduleRows(q, p.loan_id, p.run_id, termsId, rows);
  return { terms_id: termsId };
}

// ---------------------------------------------------------------- reading the schedule
export interface InstallmentRow {
  readonly loan_id: string; readonly due_date: PlainDate; readonly sequence: number | null; readonly pi_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly escrow_cents: Cents; readonly status: string;
  readonly satisfied_on: PlainDate | null; readonly credited_as_of: PlainDate | null; readonly satisfied_by_payment_id: string | null; readonly upb_before_cents: Cents | null; readonly upb_after_cents: Cents | null; readonly rate_bps: number | null;
  readonly terms_id: string | null; readonly schedule_run_id: string | null; readonly absorbs_rounding: boolean; readonly interest_variance_cents: Cents | null; readonly late_charge_state: string | null;
}
type Raw = Record<string, unknown>;
const rowOf = (r: Raw): InstallmentRow => ({ loan_id: String(r.loan_id), due_date: D(String(r.due_date)), sequence: r.sequence === null || r.sequence === undefined ? null : Number(r.sequence), pi_cents: c(r.pi_cents), interest_cents: c(r.interest_cents), principal_cents: c(r.principal_cents), escrow_cents: c(r.escrow_cents), status: String(r.status),
  satisfied_on: r.satisfied_on ? D(String(r.satisfied_on)) : null, credited_as_of: r.credited_as_of ? D(String(r.credited_as_of)) : null, satisfied_by_payment_id: (r.satisfied_by_payment_id as string | null) ?? null, upb_before_cents: r.upb_before_cents === null || r.upb_before_cents === undefined ? null : c(r.upb_before_cents), upb_after_cents: r.upb_after_cents === null || r.upb_after_cents === undefined ? null : c(r.upb_after_cents),
  rate_bps: r.rate_bps === null || r.rate_bps === undefined ? null : Number(r.rate_bps), terms_id: (r.terms_id as string | null) ?? null, schedule_run_id: (r.schedule_run_id as string | null) ?? null, absorbs_rounding: r.absorbs_rounding === true, interest_variance_cents: r.interest_variance_cents === null || r.interest_variance_cents === undefined ? null : c(r.interest_variance_cents), late_charge_state: (r.late_charge_state as string | null) ?? null });
/** Every row of the loan, by due date; `from`/`to`/`status` narrow it. */
export async function readSchedule(q: Queryable, loanId: string, o: { from?: PlainDate; to?: PlainDate; status?: string } = {}): Promise<InstallmentRow[]> {
  const rows = await q.query<Raw>(`SELECT loan_id, due_date::text AS due_date, sequence, pi_cents, interest_cents, principal_cents, escrow_cents, status::text AS status, satisfied_on::text AS satisfied_on, credited_as_of::text AS credited_as_of, satisfied_by_payment_id, upb_before_cents, upb_after_cents, rate_bps, terms_id, schedule_run_id, absorbs_rounding, interest_variance_cents, late_charge_state
    FROM loan_installments WHERE loan_id = $1 AND ($2::date IS NULL OR due_date >= $2::date) AND ($3::date IS NULL OR due_date <= $3::date) AND ($4::text IS NULL OR status::text = $4) ORDER BY due_date`, [loanId, o.from ?? null, o.to ?? null, o.status ?? null]);
  return rows.map(rowOf);
}

/** 2.1's `payment.posted` moved the rows: status `satisfied`, the payment's uuid, the credit date (the row trigger allows exactly these columns). The caller appends `installment.satisfied`. */
export async function satisfyInstallments(q: Queryable, loanId: string, items: readonly { due_date: PlainDate; payment_id: string | null; credited_as_of: PlainDate; satisfied_on: PlainDate; interest_variance_cents?: Cents | null }[]): Promise<void> {
  for (const it of items) await q.query(`UPDATE loan_installments SET status = 'satisfied', satisfied_on = $3, credited_as_of = $4, satisfied_by_payment_id = $5, interest_variance_cents = $6, updated_at = now() WHERE loan_id = $1 AND due_date = $2 AND status = 'due'`, [loanId, it.due_date, it.satisfied_on, it.credited_as_of, it.payment_id, it.interest_variance_cents ?? null]);
}
/** 2.1's `payment.reversed` restored the rows to `due` (satisfied_on, credited_as_of, satisfied_by_payment_id cleared). The caller appends `installment.restored`. */
export async function restoreInstallments(q: Queryable, loanId: string, items: readonly { due_date: PlainDate; payment_id?: string | null }[]): Promise<void> {
  for (const it of items) await q.query(`UPDATE loan_installments SET status = 'due', satisfied_on = NULL, credited_as_of = NULL, satisfied_by_payment_id = NULL, interest_variance_cents = NULL, updated_at = now() WHERE loan_id = $1 AND due_date = $2 AND status = 'satisfied' AND ($3::uuid IS NULL OR satisfied_by_payment_id = $3::uuid)`, [loanId, it.due_date, it.payment_id ?? null]);
}

// ---------------------------------------------------------------- rule 3: the reprojection (`installments.reproject`; `installments.write` on a loan that has its rows)
interface TermsRow { readonly id: string; readonly effective_from: PlainDate; readonly source: string; readonly note_rate_bps: number; readonly pi_cents: Cents; readonly escrow_payment_cents: Cents; readonly maturity_date: PlainDate; readonly amortization: string; }
const TERMS_COLS = "id, effective_from::text AS effective_from, source, note_rate_bps, pi_cents, escrow_payment_cents, maturity_date::text AS maturity_date, amortization::text AS amortization";
const termsOf = (r: Raw): TermsRow => ({ id: String(r.id), effective_from: D(String(r.effective_from)), source: String(r.source), note_rate_bps: Number(r.note_rate_bps), pi_cents: c(r.pi_cents), escrow_payment_cents: c(r.escrow_payment_cents), maturity_date: D(String(r.maturity_date)), amortization: String(r.amortization) });
async function termsRow(q: Queryable, loanId: string, termsId: string | null): Promise<TermsRow | null> {
  const rows = termsId
    ? await q.query<Raw>(`SELECT ${TERMS_COLS} FROM loan_terms WHERE id = $1 AND loan_id = $2`, [termsId, loanId])
    : await q.query<Raw>(`SELECT ${TERMS_COLS} FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]);
  const r = rows[0]; return r ? termsOf(r) : null;
}
/** The typed version an earlier run projected from this very event (a re-run of the same trigger writes no second version). */
async function termsRowByEvent(q: Queryable, loanId: string, eventId: string): Promise<TermsRow | null> {
  const r = (await q.query<Raw>(`SELECT ${TERMS_COLS} FROM loan_terms WHERE loan_id = $1 AND source_event_id = $2 ORDER BY created_at DESC LIMIT 1`, [loanId, eventId]))[0];
  return r ? termsOf(r) : null;
}

/**
 * What a `loan_terms.*` event says the new version is, in its owner's spelling (none of the four emitters writes a typed `loan_terms` row —
 * 7.2 ops-7-2.ts:486 `loan_terms.version.activated{effective_on, rate_pct, pi_cents, next_change_date, reason}`, 2.4 cashiering/ops.ts:230
 * `loan_terms.activated{effective_on, new_pi_cents}`, 3.6 ops-3-6.ts:127 `loan_terms.versioned{effective_from, escrow_payment_cents, step_down_*}`,
 * 12.8 ops-12-8.ts:325 `loan_terms.versioned{effective_date, rate_pct, term_months, ib_upb_cents}`); 7.2's expected UPB at the change date
 * (`arm_adjustments.expected_upb_cents`) rides on its stored terms' `schedule_basis` when the store carries it.
 */
export interface TermsChange { readonly effective_from: PlainDate | null; readonly note_rate_bps: number | null; readonly pi_cents: Cents | null; readonly escrow_payment_cents: Cents | null; readonly upb_start_cents: Cents | null; readonly term_months: number | null; readonly next_change_date: PlainDate | null; readonly source: "arm_change" | "correction" | "reamortization" | "escrow_analysis" | "modification"; }
export function termsChangeOf(e: DomainEvent, store?: Pick<ToolRuntime["store"], "get">): TermsChange {
  const p = e.payload as Record<string, unknown>;
  const date = (k: string): PlainDate | null => (typeof p[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p[k] as string) ? D(p[k] as string) : null);
  const effective_from = date("effective_on") ?? date("effective_from") ?? date("effective_date");
  const ratePct = typeof p.rate_pct === "string" ? p.rate_pct : typeof p.new_rate_pct === "string" ? p.new_rate_pct : null;
  const pi = p.pi_cents ?? p.new_pi_cents;
  const reason = String(p.reason ?? "");
  const source: TermsChange["source"] = e.type === "loan_terms.version.activated" ? (reason === "arm_correction" ? "correction" : "arm_change") : e.type === "loan_terms.activated" ? "reamortization" : reason === "escrow_repayment_plan" || p.escrow_payment_cents !== undefined ? "escrow_analysis" : "modification";
  const basis = e.loanId ? (store?.get("loan_terms", e.loanId)?.data?.schedule_basis as Record<string, unknown> | undefined) : undefined;
  const basisUpb = basis && effective_from && typeof basis.from_due_date === "string" && basis.from_due_date === effective_from && basis.upb_cents !== undefined && basis.upb_cents !== null ? c(basis.upb_cents) : null;
  return { effective_from, note_rate_bps: ratePct === null ? null : pctScaled(ratePct, 10_000), pi_cents: pi === undefined || pi === null ? null : c(pi), escrow_payment_cents: p.escrow_payment_cents === undefined || p.escrow_payment_cents === null ? null : c(p.escrow_payment_cents),
    upb_start_cents: p.ib_upb_cents !== undefined && p.ib_upb_cents !== null ? c(p.ib_upb_cents) : basisUpb, term_months: p.term_months !== undefined && p.term_months !== null ? Number(p.term_months) : null, next_change_date: date("next_change_date"), source };
}
interface NewTermsVersion { readonly id: string; readonly prior_id: string; readonly effective_from: PlainDate; readonly source: string; readonly source_event_id: string; readonly note_rate_bps: number; readonly pi_cents: Cents; readonly escrow_payment_cents: Cents; readonly maturity_date: PlainDate; readonly remaining_term_months: number; readonly next_change_date: PlainDate | null; }
/** The typed `loan_terms` version the event projects, copied from the prior version's other columns (the prior row closed at the new effective date). */
async function insertTermsVersion(q: Queryable, loanId: string, v: NewTermsVersion): Promise<void> {
  await q.query(`INSERT INTO loan_terms (id, loan_id, effective_from, source, source_event_id, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, late_charge_max_cents, maturity_date, remaining_term_months, deferred_principal_cents, forborne_principal_cents, arm_index, arm_margin_bps, arm_initial_cap_bps, arm_periodic_cap_bps, arm_lifetime_cap_bps, arm_floor_bps, arm_lookback_days, arm_next_change_date, arm_change_frequency_months)
    SELECT $1, loan_id, $2, $3, $4, amortization, $5, $6, $7, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, late_charge_max_cents, $8, $9, deferred_principal_cents, forborne_principal_cents, arm_index, arm_margin_bps, arm_initial_cap_bps, arm_periodic_cap_bps, arm_lifetime_cap_bps, arm_floor_bps, arm_lookback_days, COALESCE($10::date, arm_next_change_date), arm_change_frequency_months
    FROM loan_terms WHERE id = $11 AND loan_id = $12`, [v.id, v.effective_from, v.source, v.source_event_id, v.note_rate_bps, v.pi_cents, v.escrow_payment_cents, v.maturity_date, v.remaining_term_months, v.next_change_date, v.prior_id, loanId]);
  await q.query(`UPDATE loan_terms SET effective_to = $2 WHERE id = $1 AND effective_to IS NULL AND effective_from < $2::date`, [v.prior_id, v.effective_from]);
}

export interface ReprojectInput { readonly loan_id: string; readonly terms_id?: string | null; readonly effective_from?: PlainDate | null; readonly source?: "reprojection" | "correction" | "fund" | "transfer"; readonly trigger_event_id?: string | null; }
export interface ReprojectResult { readonly run_id: string; readonly terms_id: string; readonly terms_version_written: boolean; readonly effective_from: PlainDate; readonly rows_replaced: number; readonly rows_kept: number; readonly rows: number; readonly sha256: string; readonly first_due: PlainDate; readonly last_due: PlainDate; readonly maturity_variance_cents: Cents; readonly event_id: string; }
/**
 * Rule 3 inside a bus command (loan scope): the terms are a named `loan_terms` row, else the version the trigger event carries (its
 * effective date, rate, P&I, escrow, expected UPB — written as the typed `loan_terms` version keyed by `source_event_id`, once), else the
 * latest typed row; refuses SATISFIED_ROW_FROZEN, projects the replaced rows from the expected UPB, arms SM_INSTALLMENT_REPROJECT_1BD
 * explicitly when the terms event carried no origination context, appends `installment.schedule.reprojected`, and defers the version,
 * the run row and the rows to the command's commit (the decision id is read there by the run's subject: the bus records the decision
 * before the deferred writes run).
 */
export async function reprojectSchedule(db: Queryable, ctx: CommandContext, store: ToolRuntime["store"], registry: TimerRegistry, deferWrite: (fn: (q: Queryable) => Promise<void>) => void, i: ReprojectInput): Promise<ReprojectResult> {
  const command = "installments.reproject"; const loanId = i.loan_id;
  const existing = await readSchedule(db, loanId);
  if (!existing.length) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 1: no loans row without its rows", `loan ${loanId} has no installment rows — boarding writes the schedule; a loan without one is an officer exception`);
  // the trigger: the named terms event, else the newest loan_terms.* event on the loan (2.4 / 7.2 / 3.6 / 12.8's spellings)
  const byLoan = ctx.events.byLoan(loanId);
  const termsEvent = (i.trigger_event_id ? byLoan.find((e) => e.id === i.trigger_event_id && e.type.startsWith("loan_terms.")) : undefined) ?? byLoan.filter((e) => e.type.startsWith("loan_terms.")).at(-1);
  const named = i.terms_id ? await termsRow(db, loanId, i.terms_id) : null;
  if (i.terms_id && !named) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 3: a reprojection needs a loan_terms row", `loan ${loanId}: no loan_terms ${i.terms_id}`);
  const latest = named ?? (await termsRow(db, loanId, null));
  if (!latest) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 3: a reprojection needs a loan_terms row", `loan ${loanId}: no loan_terms`);
  const projectedBefore = !named && termsEvent ? await termsRowByEvent(db, loanId, termsEvent.id) : null;
  const change = !named && !projectedBefore && termsEvent ? termsChangeOf(termsEvent, store) : null;
  // the event's version applies when it postdates the typed row it changes (an event that names only a date re-projects the row it found)
  const changes = !!change && change.effective_from !== null && change.effective_from > latest.effective_from && (change.note_rate_bps !== null || change.pi_cents !== null || change.escrow_payment_cents !== null || change.upb_start_cents !== null || change.term_months !== null);
  const base: TermsRow = projectedBefore ?? latest;
  const effectiveFrom = i.effective_from ?? (change?.effective_from ?? null) ?? base.effective_from;
  const frozen = existing.filter((r) => (r.status === "satisfied" || r.status === "prepaid") && r.due_date >= effectiveFrom);
  if (frozen.length) refuse(command, "SATISFIED_ROW_FROZEN", "35.5 rule 3: a satisfied row changes only through 2.1's reversal", `effective_from ${effectiveFrom} names ${frozen.length} satisfied/prepaid row(s) (${frozen.map((r) => r.due_date).join(", ")}) — reverse the payment first (2.1 rule 9) or move the effective date`);
  const kept = existing.filter((r) => r.due_date < effectiveFrom);
  const replaced = existing.filter((r) => r.due_date >= effectiveFrom);
  const firstReplaced = replaced[0]; const lastKept = kept[kept.length - 1];
  // the expected UPB at the effective date: the owner's figure when its event carries one (7.2's schedule basis, 12.8's IB UPB), else the first replaced row's opening UPB
  const upbStart = (changes ? change!.upb_start_cents : null) ?? firstReplaced?.upb_before_cents ?? lastKept?.upb_after_cents ?? null;
  if (upbStart === null) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 3: the expected UPB at the effective date is the first replaced row's upb_before", `loan ${loanId}: no row carries an opening UPB at ${effectiveFrom}`);
  const firstDue = firstReplaced?.due_date ?? addMonths(lastKept!.due_date, 1);
  const firstSequence = firstReplaced?.sequence ?? (lastKept?.sequence ?? kept.length) + 1;
  // the version projected: the event's figures over the prior version (rate, P&I — or the level payment over a new term —, escrow, maturity)
  let terms: TermsRow = base; let newVersion: NewTermsVersion | null = null;
  if (changes) {
    const ch = change!;
    const rateBps = ch.note_rate_bps ?? latest.note_rate_bps;
    const maturity = ch.term_months !== null ? addMonths(firstDue, ch.term_months - 1) : latest.maturity_date;
    const pi = ch.pi_cents ?? (ch.term_months !== null ? levelPayment(upbStart, ratePercent((rateBps / 10_000).toFixed(4)), ch.term_months) : latest.pi_cents);
    terms = { id: randomUUID(), effective_from: ch.effective_from!, source: ch.source, note_rate_bps: rateBps, pi_cents: pi, escrow_payment_cents: ch.escrow_payment_cents ?? latest.escrow_payment_cents, maturity_date: maturity, amortization: latest.amortization };
    newVersion = { id: terms.id, prior_id: latest.id, effective_from: terms.effective_from, source: terms.source, source_event_id: termsEvent!.id, note_rate_bps: rateBps, pi_cents: pi, escrow_payment_cents: terms.escrow_payment_cents, maturity_date: maturity, remaining_term_months: 0, next_change_date: ch.next_change_date };
  }
  const escrowVersion = escrowVersionFrom(store.get("loan_terms", loanId)?.data);
  const projection = projectSchedule({ upb_start_cents: upbStart, first_due: firstDue, first_sequence: firstSequence, maturity_date: terms.maturity_date, pi_cents: terms.pi_cents, rate_bps: terms.note_rate_bps, escrow: (due) => escrowPortionOn({ escrow_payment_cents: terms.escrow_payment_cents, escrow_version: escrowVersion }, due) });
  if (!projection.rows.length) refuse(command, "SCHEDULE_REQUIRED", "35.5 rule 3", `loan ${loanId}: no installment between ${firstDue} and maturity ${terms.maturity_date}`);
  if (newVersion) newVersion = { ...newVersion, remaining_term_months: projection.rows.length };
  const run_id = randomUUID(); const sha256 = scheduleSha256(projection.rows);
  const first = projection.rows[0]!; const last = projection.rows[projection.rows.length - 1]!;
  // the four `loan_terms.*` spellings carry no origination context: arm the clock on the loan from the terms event before the satisfier (the reactor armed it already on its path — the guard keeps one instance)
  if (termsEvent) armServicingSideClocks(ctx.timers, registry, termsEvent, ["SM_INSTALLMENT_REPROJECT_1BD"]);
  const event = ctx.events.append({ type: SCHEDULE_REPROJECTED, loanId, actor: ctx.actor, ...(termsEvent ? { causationId: termsEvent.id } : {}),
    payload: { loan_id: loanId, run_id, terms_id: terms.id, terms_version_written: newVersion !== null, effective_from: effectiveFrom, rows_replaced: replaced.length, rows_kept: kept.length, rows: projection.rows.length, sha256, source: i.source ?? "reprojection", pi_cents: s(terms.pi_cents), rate_bps: terms.note_rate_bps, upb_start_cents: s(upbStart), maturity_variance_cents: s(projection.maturity_variance_cents) } });
  const replacedValues = replaced.map((r) => ({ due_date: r.due_date, sequence: r.sequence, pi_cents: s(r.pi_cents), interest_cents: s(r.interest_cents), principal_cents: s(r.principal_cents), escrow_cents: s(r.escrow_cents), upb_before_cents: r.upb_before_cents === null ? null : s(r.upb_before_cents), upb_after_cents: r.upb_after_cents === null ? null : s(r.upb_after_cents), rate_bps: r.rate_bps, terms_id: r.terms_id, schedule_run_id: r.schedule_run_id, status: r.status }));
  const source = i.source ?? "reprojection";
  const version = newVersion;
  deferWrite(async (q) => {
    if (version) await insertTermsVersion(q, loanId, version);
    const decision = (await q.query<{ id: string }>(`SELECT id FROM agent_decisions WHERE subject_kind = 'installment_schedule_run' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [run_id]))[0]?.id ?? null;
    await insertScheduleRun(q, { id: run_id, loan_id: loanId, terms_id: terms.id, source, trigger_event_id: i.trigger_event_id ?? termsEvent?.id ?? null, first_due: first.due_date, last_due: last.due_date, rows: projection.rows.length, rows_replaced: replaced.length, rows_kept: kept.length, pi_cents: terms.pi_cents, rate_bps: terms.note_rate_bps, upb_start_cents: upbStart,
      total_interest_cents: projection.total_interest_cents, total_principal_cents: projection.total_principal_cents, maturity_variance_cents: projection.maturity_variance_cents, replaced: replacedValues, sha256, decision_id: decision });
    await persistScheduleRows(q, loanId, run_id, terms.id, projection.rows);
  });
  return { run_id, terms_id: terms.id, terms_version_written: newVersion !== null, effective_from: effectiveFrom, rows_replaced: replaced.length, rows_kept: kept.length, rows: projection.rows.length, sha256, first_due: first.due_date, last_due: last.due_date, maturity_variance_cents: projection.maturity_variance_cents, event_id: event.id };
}

// ---------------------------------------------------------------- the bus tools (src/app/tools/section35-5.ts binds them)
export const MONEY_KEY = /(_cents$|^amount|^waive|^changes$)/;
const need = (i: ToolInput, k: string): string => { const v = str(i, k); if (!v) throw new RangeError(`${k} is required`); return v; };
type Services = { db?: Queryable; deferWrite?: (fn: (q: Queryable) => Promise<void>) => void; runtime?: Runtime };
const dbOf = (rt: ToolRuntime): Queryable => { const db = (rt.services as Services).db; if (!db) throw new RangeError("installments tools need the runtime's database (services.db)"); return db; };
const deferOf = (rt: ToolRuntime): ((fn: (q: Queryable) => Promise<void>) => void) => { const d = (rt.services as Services).deferWrite; if (!d) throw new RangeError("installments tools need the command's deferred write (services.deferWrite)"); return d; };
const registryOf = (rt: ToolRuntime): TimerRegistry => { const r = (rt.services as Services).runtime?.registry; if (!r) throw new RangeError("installments tools need the runtime's timer registry (services.runtime)"); return r; };

/** `installments.write{loan_id, source: fund | transfer, terms_id?, trigger_event_id?}` — on a loan that has its rows this is rule 3 from the first `due` row (idempotent when nothing changed: identical rows); boarding itself writes through `projectBoarding` in the boarding transaction. */
export async function installmentsWrite(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const loanId = need(i, "loan_id"); const source = (str(i, "source") || "transfer") as "fund" | "transfer" | "correction" | "reprojection";
  if (source !== "fund" && source !== "transfer" && source !== "correction" && source !== "reprojection") throw new RangeError("source must be fund | transfer");
  const db = dbOf(rt);
  const rows = await readSchedule(db, loanId, { status: "due" });
  const firstDue = rows[0]?.due_date;
  if (!firstDue) refuse("installments.write", "SCHEDULE_REQUIRED", "35.5 rule 1: the schedule is written in the boarding transaction", `loan ${loanId} has no due rows to (re)write — boarding writes the schedule; a correction of a fully satisfied loan is 4.1's`);
  return reprojectSchedule(db, ctx, rt.store, registryOf(rt), deferOf(rt), { loan_id: loanId, terms_id: str(i, "terms_id") || null, effective_from: firstDue, source, trigger_event_id: str(i, "trigger_event_id") || null });
}
/** `installments.reproject{loan_id, terms_id?, effective_from?, source?, trigger_event_id?}`. */
export async function installmentsReproject(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const loanId = need(i, "loan_id");
  const source = str(i, "source") || "reprojection";
  if (source !== "reprojection" && source !== "correction") throw new RangeError("source must be reprojection | correction");
  return reprojectSchedule(dbOf(rt), ctx, rt.store, registryOf(rt), deferOf(rt), { loan_id: loanId, terms_id: str(i, "terms_id") || null, effective_from: str(i, "effective_from") ? D(str(i, "effective_from")) : null, source, trigger_event_id: str(i, "trigger_event_id") || null });
}
/** `installments.read{loan_id, from?, to?, status?}`. */
export async function installmentsRead(i: ToolInput, _ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const loanId = need(i, "loan_id");
  const rows = await readSchedule(dbOf(rt), loanId, { ...(str(i, "from") ? { from: D(str(i, "from")) } : {}), ...(str(i, "to") ? { to: D(str(i, "to")) } : {}), ...(str(i, "status") ? { status: str(i, "status") } : {}) });
  const runs = await dbOf(rt).query<Raw>(`SELECT id, terms_id, source, rows, rows_replaced, rows_kept, pi_cents, rate_bps, upb_start_cents, maturity_variance_cents, sha256, created_at FROM installment_schedule_runs WHERE loan_id = $1 ORDER BY created_at`, [loanId]);
  return { loan_id: loanId, rows: rows.map((r) => ({ ...r, pi_cents: s(r.pi_cents), interest_cents: s(r.interest_cents), principal_cents: s(r.principal_cents), escrow_cents: s(r.escrow_cents), upb_before_cents: r.upb_before_cents === null ? null : s(r.upb_before_cents), upb_after_cents: r.upb_after_cents === null ? null : s(r.upb_after_cents), interest_variance_cents: r.interest_variance_cents === null ? null : s(r.interest_variance_cents) })),
    runs: runs.map((r) => ({ ...r, pi_cents: s(c(r.pi_cents)), upb_start_cents: s(c(r.upb_start_cents)), maturity_variance_cents: s(c(r.maturity_variance_cents)) })) };
}

// ---------------------------------------------------------------- the reactor: a terms change re-projects the schedule after the commit
/**
 * A post-commit reactor: any `loan_terms.*` event on a loan (2.4's activated, 7.2's version.activated, 3.6/12.8's versioned) first arms
 * SM_INSTALLMENT_REPROJECT_1BD on the loan in its own unit of work (the engine skips this section's def on a servicing-side event —
 * timers-35-5.ts), then runs `installments.reproject` on the bus. A refused reprojection (SATISFIED_ROW_FROZEN, SCHEDULE_REQUIRED) rolls
 * its own unit of work back, leaves the clock armed to breach (sev 2 → officer) and opens rule 3's `officer` escalation at once; errors are
 * logged, never thrown into the committing command. `settle()` awaits the in-flight runs (tests).
 */
export function registerReprojectionReactor(rt: Runtime, log: (msg: string, ctx: Record<string, unknown>) => void = (msg, ctx) => rt.logger?.warn(msg, ctx)): { settle(): Promise<void>; stop(): void } {
  const inflight = new Set<Promise<void>>();
  const stop = rt.onCommitted((events) => {
    for (const e of events) {
      if (!e.type.startsWith("loan_terms.") || !e.loanId) continue;
      const loanId = e.loanId;
      const p = reactToTermsEvent(rt, loanId, e, log)
        .catch((err: unknown) => { log("35.5 reprojection reactor failed", { loan_id: loanId, event: e.type, error: err instanceof Error ? err.message : String(err) }); })
        .finally(() => { inflight.delete(p); });
      inflight.add(p);
    }
  });
  return { settle: async () => { while (inflight.size) await Promise.all([...inflight]); }, stop };
}
async function reactToTermsEvent(rt: Runtime, loanId: string, e: DomainEvent, log: (msg: string, ctx: Record<string, unknown>) => void): Promise<void> {
  // 1. the clock, on the terms event, in its own unit of work — so a refused reprojection still leaves a clock to breach
  await rt.uow.run({ loanId }, (ctx) => { armServicingSideClocks(ctx.timers, rt.registry, ctx.events.byLoan(loanId).find((x) => x.id === e.id) ?? e, ["SM_INSTALLMENT_REPROJECT_1BD"]); }, { clock: rt.clock });
  // 2. the reprojection on the bus (allowlists, guardrails, the decision record)
  try {
    await rt.execute({ process: "35.5", name: "installments.reproject", loanId, actor: CASHIERING_AGENT, input: { loan_id: loanId, trigger_event_id: e.id, source: "reprojection" } });
  } catch (err: unknown) {
    log("35.5 reprojection reactor: installments.reproject failed", { loan_id: loanId, event: e.type, error: err instanceof Error ? err.message : String(err) });
    if (!(err instanceof CommandRefused)) return;
    // rule 3: "a reprojection that would change a satisfied row is refused (SATISFIED_ROW_FROZEN) and escalated to officer" — the refusal wrote nothing; the escalation is its own unit of work
    const code = err.code; const reason = err.message;
    let opened: EscalationService | undefined;
    await rt.uow.run({ loanId }, (ctx) => {
      opened = new EscalationService(ctx.events, ctx.clock);
      opened.open({ kind: "officer", ownerRole: "officer", loanId, severity: "2", payload: { rule_code: code, process: "35.5", command: "installments.reproject", trigger_event_id: e.id, trigger_event_type: e.type, reason,
        next: code === "SATISFIED_ROW_FROZEN" ? "reverse the payment first (2.1 rule 9) and re-post, or move the effective date — a satisfied row changes only through 2.1's reversal" : "officer review: the terms changed and the schedule still shows the prior P&I / rate" } }, CASHIERING_AGENT);
    }, { clock: rt.clock, commit: async (q) => { for (const x of opened?.list() ?? []) await rt.escalationRepo.save(x, q); } });
  }
}
