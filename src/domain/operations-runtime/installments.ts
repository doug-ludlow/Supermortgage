/**
 * §35.5 rules 1–4 — the installment schedule: `loan_installments` written in the boarding transaction on both paths,
 * re-projected on every terms change, and moved through its state machine by 2.1's postings and reversals.
 *
 *   projectSchedule(terms)              rule 2 (`cashiering.schedule.v1`): row k has interest_k = round_half_up(U_k × rate ÷ 12)
 *                                       (bigint cents, `divRound(U_k × rate_bps, 12 × 1,000,000)`), principal_k = pi − interest_k,
 *                                       U_{k+1} = U_k − principal_k; the final row's principal is the remaining UPB and its P&I
 *                                       interest_n + U_n (`absorbs_rounding`), so Σ principal = the opening UPB exactly.
 *                                       `maturity_variance_cents`: the UPB the level payment would leave at maturity — rounding
 *                                       (0) when smaller than one level payment, else the tape's HF-005 exception (open question 2).
 *   planScheduleAtBoarding(input)       rule 1: the plan for a funded note (rows 1…n from `first_payment_date`, the level payment
 *                                       checked against the note's P&I — > 1¢ refuses the board, SCHEDULE_REQUIRED) or a transfer
 *                                       tape (rows from `next_due_date` at the sequence the paid installments leave, from the tape's
 *                                       UPB; HF-005 recomputed for the run's record).
 *   persistSchedule(q, plan)            the `installment_schedule_runs` row and one `loan_installments` row per installment, inside
 *                                       the caller's transaction (both boarding paths, the tools).
 *   appendScheduleWritten(events, …)    `installment.schedule.written{loan_id, run_id, source, rows, first_due, last_due, pi_cents, sha256}`
 *                                       — satisfies SM_INSTALLMENT_SCHEDULE_AT_BOARD_0 in the boarding commit.
 *   reprojectSchedule(q, events, …)     rule 3: keep every row before `effective_from`, replace the `due` rows from it by INSERT …
 *                                       ON CONFLICT on the primary key, record the prior values, refuse when a satisfied or prepaid
 *                                       row is named (SATISFIED_ROW_FROZEN); `installment.schedule.reprojected` satisfies
 *                                       SM_INSTALLMENT_REPROJECT_1BD.
 *   satisfyRows / restoreRows           rule 4: the state machine's transitions from 2.1's `payment.posted` / `payment.reversed`,
 *                                       logged as `installment.satisfied` / `installment.restored`.
 *   readInstallments(q, loan_id)        the rows as the engines read them (rule 4: nothing projects on the fly).
 *
 * Money is bigint cents; dates are PlainDate; every figure is arithmetic on the note's terms — no rule here decides one.
 */
import { createHash, randomUUID } from "node:crypto";
import { isUuid, type Queryable } from "../../infra/db/client.ts";
import { classifyVersion, mintKey } from "./seam/project.ts";
import type { EntityStore } from "../../app/tools.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { plainDate as D, addMonths, parts, type PlainDate } from "../../kernel/calendar/date.ts";
import { levelPayment, type Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";

export const SCHEDULE_RULE_SET = "cashiering.schedule.v1";
export const INSTALLMENT_EVENTS = {
  written: "installment.schedule.written",
  reprojected: "installment.schedule.reprojected",
  satisfied: "installment.satisfied",
  restored: "installment.restored",
  dueDateReached: "installment.due_date_reached",
} as const;
/** HF-005: a recomputed fixed-rate P&I more than one cent from the note's refuses the board at fund. */
export const HF005_TOLERANCE_CENTS = 1n;
/** Rule 3's trigger spellings: 2.4's, 7.2's and 3.6/12.8's `loan_terms` events. */
export const REPROJECT_TRIGGERS: readonly string[] = ["loan_terms.activated", "loan_terms.version.activated", "loan_terms.versioned"];

export class ScheduleRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "ScheduleRefused"; this.code = code; }
}

export interface ScheduleRow {
  readonly sequence: number;
  readonly due_date: PlainDate;
  readonly upb_before_cents: Cents;
  readonly interest_cents: Cents;
  readonly principal_cents: Cents;
  readonly pi_cents: Cents;
  readonly escrow_cents: Cents;
  readonly upb_after_cents: Cents;
  readonly absorbs_rounding: boolean;
}
export interface ScheduleTerms {
  readonly upb_cents: Cents;
  /** `loan_terms.note_rate_bps`: 6.125% = 61250. */
  readonly note_rate_bps: number;
  readonly pi_cents: Cents;
  /** The escrow portion per due date (3.6's effective-dated portion), or one figure for every row. */
  readonly escrow_cents: Cents | ((due: PlainDate) => Cents);
  readonly first_due: PlainDate;
  readonly sequence_start: number;
  readonly maturity_date: PlainDate;
}
export interface ScheduleProjection {
  readonly rows: readonly ScheduleRow[];
  readonly total_interest_cents: Cents;
  readonly total_principal_cents: Cents;
  /** The residual the level payment leaves at maturity before the final row absorbs it (signed). */
  readonly residual_cents: Cents;
  readonly maturity_variance_cents: Cents;
  readonly sha256: string;
}

const s = (c: Cents): string => c.toString();
/** Months from `a` to `b` on the first-of-month grid (due dates keep the note's day; end-of-month clamped by addMonths). */
export function installmentMonthsBetween(a: PlainDate, b: PlainDate): number { const pa = parts(a), pb = parts(b); return (pb.y - pa.y) * 12 + (pb.m - pa.m); }
/** Rule 2's interest: round_half_up(U × rate ÷ 12) with the rate in bps ×10 (1/1000 %). */
export const rowInterest = (upb: Cents, noteRateBps: number): Cents => divRound(upb * BigInt(noteRateBps), 12n * 1_000_000n, "HALF_UP");
/** `levelPayment` over a bps rate. */
export const levelPaymentBps = (upb: Cents, noteRateBps: number, termMonths: number): Cents => levelPayment(upb, Decimal.parse((noteRateBps / 1_000_000).toFixed(9)), termMonths);
export const scheduleSha256 = (rows: readonly ScheduleRow[]): string => createHash("sha256").update(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).digest("hex");

/** Rule 2 — the row-by-row schedule from `first_due` to `maturity_date`. */
export function projectSchedule(t: ScheduleTerms): ScheduleProjection {
  const n = installmentMonthsBetween(t.first_due, t.maturity_date) + 1;
  if (n < 1) throw new ScheduleRefused("SCHEDULE_REQUIRED", `no installment between ${t.first_due} and the maturity date ${t.maturity_date}`);
  if (t.pi_cents <= 0n) throw new ScheduleRefused("SCHEDULE_REQUIRED", "the note's P&I is required to project a schedule (a tape with no pi_cents is 1.1's exception, never a guessed payment)");
  const escrowOf = typeof t.escrow_cents === "bigint" ? () => t.escrow_cents as Cents : t.escrow_cents;
  const rows: ScheduleRow[] = [];
  let u = t.upb_cents; let totalI = 0n; let totalP = 0n; let residual = 0n;
  for (let k = 0; k < n; k++) {
    const due = addMonths(t.first_due, k);
    const last = k === n - 1;
    const interest = u > 0n ? rowInterest(u, t.note_rate_bps) : 0n;
    let principal = t.pi_cents - interest; let pi = t.pi_cents; let absorbs = false;
    if (last) { residual = u - principal; principal = u; pi = interest + u; absorbs = true; }
    else if (principal >= u) { principal = u; pi = interest + u; }   // the tape's payment amortizes the UPB before maturity: later rows carry nothing
    const after = u - principal;
    rows.push({ sequence: t.sequence_start + k, due_date: due, upb_before_cents: u, interest_cents: interest, principal_cents: principal, pi_cents: pi, escrow_cents: escrowOf(due), upb_after_cents: after, absorbs_rounding: absorbs });
    totalI += interest; totalP += principal; u = after;
  }
  const variance = (residual < 0n ? -residual : residual) <= t.pi_cents ? 0n : residual;
  return { rows, total_interest_cents: totalI, total_principal_cents: totalP, residual_cents: residual, maturity_variance_cents: variance, sha256: scheduleSha256(rows) };
}

export interface BoardingScheduleInput {
  readonly loan_id: string;
  readonly terms_id: string;
  readonly source: "fund" | "transfer";
  readonly note_rate_bps: number;
  readonly pi_cents: Cents;
  readonly escrow_cents: Cents | ((due: PlainDate) => Cents);
  readonly first_payment_date: PlainDate;
  readonly maturity_date: PlainDate;
  /** Fund: the note amount. Transfer: the tape's UPB as of the LPI. */
  readonly upb_cents: Cents;
  /** Transfer: the tape's next due date (rows start here); fund: absent (rows start at the first payment date). */
  readonly next_due_date?: PlainDate | null;
  /** Transfer: the original amount and term for the HF-005 recomputation. */
  readonly original_upb_cents?: Cents | null;
  readonly original_term_months?: number | null;
  readonly trigger_event_id?: string | null;
}
export interface SchedulePlan {
  readonly run_id: string;
  readonly loan_id: string;
  readonly terms_id: string | null;
  readonly source: "fund" | "transfer" | "reprojection" | "correction";
  readonly trigger_event_id: string | null;
  readonly projection: ScheduleProjection;
  readonly note_rate_bps: number;
  readonly pi_cents: Cents;
  readonly upb_start_cents: Cents;
  readonly rows_kept: number;
  readonly rows_replaced: number;
  readonly replaced: readonly Record<string, unknown>[];
  /** HF-005: the level payment recomputed from the note and its difference from the boarded P&I (informational on a transfer; refusing at fund). */
  readonly hf005: { readonly recomputed_cents: Cents; readonly difference_cents: Cents };
}

/** Rule 1 — the schedule plan at boarding (pure; the rows land through `persistSchedule`). */
export function planScheduleAtBoarding(i: BoardingScheduleInput): SchedulePlan {
  const term = installmentMonthsBetween(i.first_payment_date, i.maturity_date) + 1;
  const origUpb = i.original_upb_cents ?? i.upb_cents; const origTerm = i.original_term_months ?? term;
  const recomputed = levelPaymentBps(origUpb, i.note_rate_bps, origTerm);
  const diff = recomputed > i.pi_cents ? recomputed - i.pi_cents : i.pi_cents - recomputed;
  if (i.source === "fund" && diff > HF005_TOLERANCE_CENTS) throw new ScheduleRefused("SCHEDULE_REQUIRED", `HF-005: the note's P&I ${s(i.pi_cents)}¢ is ${s(diff)}¢ from the level payment ${s(recomputed)}¢ on ${s(origUpb)}¢ at ${i.note_rate_bps} bps over ${origTerm} months`);
  const firstDue = i.source === "transfer" && i.next_due_date ? i.next_due_date : i.first_payment_date;
  if (firstDue < i.first_payment_date) throw new ScheduleRefused("SCHEDULE_REQUIRED", `next due date ${firstDue} precedes the first payment date ${i.first_payment_date}`);
  const seqStart = installmentMonthsBetween(i.first_payment_date, firstDue) + 1;
  const projection = projectSchedule({ upb_cents: i.upb_cents, note_rate_bps: i.note_rate_bps, pi_cents: i.pi_cents, escrow_cents: i.escrow_cents, first_due: firstDue, sequence_start: seqStart, maturity_date: i.maturity_date });
  return { run_id: randomUUID(), loan_id: i.loan_id, terms_id: i.terms_id, source: i.source, trigger_event_id: i.trigger_event_id ?? null, projection, note_rate_bps: i.note_rate_bps, pi_cents: i.pi_cents, upb_start_cents: i.upb_cents, rows_kept: 0, rows_replaced: 0, replaced: [], hf005: { recomputed_cents: recomputed, difference_cents: diff } };
}

/** The run row and the installment rows, in the caller's transaction (INSERT … ON CONFLICT for a reprojection's replaced `due` rows). */
export async function persistSchedule(q: Queryable, p: SchedulePlan, opts: { decision_id?: string | null } = {}): Promise<void> {
  const pr = p.projection; const first = pr.rows[0]!; const last = pr.rows[pr.rows.length - 1]!;
  await q.query(`INSERT INTO installment_schedule_runs (id, loan_id, terms_id, source, trigger_event_id, first_due, last_due, rows, rows_replaced, rows_kept, pi_cents, rate_bps, upb_start_cents, total_interest_cents, total_principal_cents, maturity_variance_cents, replaced, sha256, decision_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)`,
    [p.run_id, p.loan_id, p.terms_id, p.source, p.trigger_event_id, first.due_date, last.due_date, pr.rows.length, p.rows_replaced, p.rows_kept, s(p.pi_cents), p.note_rate_bps, s(p.upb_start_cents), s(pr.total_interest_cents), s(pr.total_principal_cents), s(pr.maturity_variance_cents), JSON.stringify(p.replaced), pr.sha256, opts.decision_id ?? null]);
  // one multi-row INSERT per 120 rows keeps a 360-row schedule to three statements
  const chunk = 120;
  for (let i0 = 0; i0 < pr.rows.length; i0 += chunk) {
    const rows = pr.rows.slice(i0, i0 + chunk); const values: string[] = []; const params: unknown[] = [];
    for (const r of rows) {
      const b = params.length;
      values.push(`($${b + 1}, $${b + 2}::date, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, 'due', $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13})`);
      params.push(p.loan_id, r.due_date, s(r.pi_cents), s(r.interest_cents), s(r.principal_cents), s(r.escrow_cents), r.sequence, s(r.upb_before_cents), s(r.upb_after_cents), p.note_rate_bps, p.terms_id, p.run_id, r.absorbs_rounding);
    }
    await q.query(`INSERT INTO loan_installments (loan_id, due_date, pi_cents, interest_cents, principal_cents, escrow_cents, status, sequence, upb_before_cents, upb_after_cents, rate_bps, terms_id, schedule_run_id, absorbs_rounding) VALUES ${values.join(", ")}
      ON CONFLICT (loan_id, due_date) DO UPDATE SET status = 'due', pi_cents = EXCLUDED.pi_cents, interest_cents = EXCLUDED.interest_cents, principal_cents = EXCLUDED.principal_cents, escrow_cents = EXCLUDED.escrow_cents, sequence = EXCLUDED.sequence, upb_before_cents = EXCLUDED.upb_before_cents, upb_after_cents = EXCLUDED.upb_after_cents, rate_bps = EXCLUDED.rate_bps, terms_id = EXCLUDED.terms_id, schedule_run_id = EXCLUDED.schedule_run_id, absorbs_rounding = EXCLUDED.absorbs_rounding, updated_at = now()
      WHERE loan_installments.status IN ('due', 'deferred', 'forborne')`, params);
  }
}

/** `installment.schedule.written` — the boarding commit's satisfier. */
export function appendScheduleWritten(events: EventStore, p: SchedulePlan, actor: Actor, opts: { causationId?: string } = {}): DomainEvent {
  const pr = p.projection;
  return events.append({ type: INSTALLMENT_EVENTS.written, loanId: p.loan_id, aggregate: { kind: "installment_schedule_run", id: p.run_id }, actor, ...(opts.causationId ? { causationId: opts.causationId } : {}),
    payload: { loan_id: p.loan_id, run_id: p.run_id, source: p.source, rows: pr.rows.length, first_due: pr.rows[0]!.due_date, last_due: pr.rows[pr.rows.length - 1]!.due_date, pi_cents: s(p.pi_cents), rate_bps: p.note_rate_bps, upb_start_cents: s(p.upb_start_cents), total_interest_cents: s(pr.total_interest_cents), total_principal_cents: s(pr.total_principal_cents), maturity_variance_cents: s(pr.maturity_variance_cents), hf005_difference_cents: s(p.hf005.difference_cents), sha256: pr.sha256, rule_set_version: SCHEDULE_RULE_SET } });
}

export interface InstallmentRow {
  readonly loan_id: string; readonly due_date: PlainDate; readonly sequence: number | null; readonly pi_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly escrow_cents: Cents;
  readonly upb_before_cents: Cents | null; readonly upb_after_cents: Cents | null; readonly rate_bps: number | null; readonly terms_id: string | null; readonly schedule_run_id: string | null;
  readonly status: "due" | "satisfied" | "prepaid" | "deferred" | "forborne"; readonly satisfied_on: PlainDate | null; readonly credited_as_of: PlainDate | null; readonly satisfied_by_payment_id: string | null; readonly late_charge_state: string | null; readonly absorbs_rounding: boolean;
}
type Raw = Record<string, unknown>;
const c = (v: unknown): Cents => (v === null || v === undefined ? 0n : BigInt(String(v)));
const cn = (v: unknown): Cents | null => (v === null || v === undefined ? null : BigInt(String(v)));
const dn = (v: unknown): PlainDate | null => (v === null || v === undefined ? null : D(String(v).slice(0, 10)));
const rowOf = (r: Raw): InstallmentRow => ({ loan_id: String(r.loan_id), due_date: D(String(r.due_date).slice(0, 10)), sequence: r.sequence === null || r.sequence === undefined ? null : Number(r.sequence), pi_cents: c(r.pi_cents), interest_cents: c(r.interest_cents), principal_cents: c(r.principal_cents), escrow_cents: c(r.escrow_cents),
  upb_before_cents: cn(r.upb_before_cents), upb_after_cents: cn(r.upb_after_cents), rate_bps: r.rate_bps === null || r.rate_bps === undefined ? null : Number(r.rate_bps), terms_id: (r.terms_id as string | null) ?? null, schedule_run_id: (r.schedule_run_id as string | null) ?? null,
  status: String(r.status) as InstallmentRow["status"], satisfied_on: dn(r.satisfied_on), credited_as_of: dn(r.credited_as_of), satisfied_by_payment_id: (r.satisfied_by_payment_id as string | null) ?? null, late_charge_state: (r.late_charge_state as string | null) ?? null, absorbs_rounding: r.absorbs_rounding === true });
const COLS = `loan_id::text AS loan_id, due_date::text AS due_date, sequence, pi_cents::text AS pi_cents, interest_cents::text AS interest_cents, principal_cents::text AS principal_cents, escrow_cents::text AS escrow_cents, upb_before_cents::text AS upb_before_cents, upb_after_cents::text AS upb_after_cents, rate_bps, terms_id::text AS terms_id, schedule_run_id::text AS schedule_run_id, status::text AS status, satisfied_on::text AS satisfied_on, credited_as_of::text AS credited_as_of, satisfied_by_payment_id::text AS satisfied_by_payment_id, late_charge_state, absorbs_rounding`;

/** Rule 4 — the rows the engines read, oldest first (optionally through a due date). */
export async function readInstallments(q: Queryable, loanId: string, opts: { through?: PlainDate; from?: PlainDate } = {}): Promise<InstallmentRow[]> {
  const rows = await q.query<Raw>(`SELECT ${COLS} FROM loan_installments WHERE loan_id = $1 AND ($2::date IS NULL OR due_date <= $2::date) AND ($3::date IS NULL OR due_date >= $3::date) ORDER BY due_date`, [loanId, opts.through ?? null, opts.from ?? null]);
  return rows.map(rowOf);
}

export interface ReprojectInput {
  readonly loan_id: string;
  /** The `loan_terms` row the new rows are projected under (v2 after an ARM change). */
  readonly terms_id: string | null;
  readonly effective_from: PlainDate;
  readonly note_rate_bps: number;
  readonly pi_cents: Cents;
  /** A new escrow portion for the replaced rows; null keeps each row's own escrow (a rate/P&I change alone). */
  readonly escrow_cents?: Cents | null;
  /** The expected UPB at `effective_from` (7.2's `arm_adjustments.expected_upb_cents`); null takes the first replaced row's `upb_before_cents`. */
  readonly upb_start_cents?: Cents | null;
  readonly source?: "reprojection" | "correction";
  readonly trigger_event_id?: string | null;
  readonly maturity_date?: PlainDate | null;
  /** The run's decision record (pre-minted by the tool so the run row names it). */
  readonly decision_id?: string | null;
}
export interface ReprojectResult { readonly run_id: string; readonly rows_kept: number; readonly rows_replaced: number; readonly sha256: string; readonly first_replaced_due: PlainDate; readonly event: DomainEvent; readonly plan: SchedulePlan; }

/** Rule 3 — replace the `due` rows on or after `effective_from` (a `deferred` / `forborne` row comes back `due` under the new terms — state machine "(new terms) → due"); refuse when a satisfied / prepaid row is named (SATISFIED_ROW_FROZEN). */
export async function reprojectSchedule(q: Queryable, events: EventStore, actor: Actor, i: ReprojectInput): Promise<ReprojectResult> {
  const existing = await readInstallments(q, i.loan_id);
  if (!existing.length) throw new ScheduleRefused("SCHEDULE_REQUIRED", `loan ${i.loan_id} has no schedule to re-project`);
  const kept = existing.filter((r) => r.due_date < i.effective_from);
  const replaced = existing.filter((r) => r.due_date >= i.effective_from);
  if (!replaced.length) throw new ScheduleRefused("SCHEDULE_REQUIRED", `no installment due on or after ${i.effective_from} (the schedule ends ${existing[existing.length - 1]!.due_date})`);
  const frozen = replaced.find((r) => r.status === "satisfied" || r.status === "prepaid");
  if (frozen) throw new ScheduleRefused("SATISFIED_ROW_FROZEN", `installment ${frozen.due_date} is ${frozen.status}; a reprojection from ${i.effective_from} would change it — a satisfied row changes only through 2.1's reversal (officer escalation)`);
  const first = replaced[0]!;
  const upbStart = i.upb_start_cents ?? first.upb_before_cents ?? (kept.length ? kept[kept.length - 1]!.upb_after_cents ?? 0n : 0n);
  const maturity = i.maturity_date ?? existing[existing.length - 1]!.due_date;
  const escrowByDue = new Map(replaced.map((r) => [r.due_date, r.escrow_cents] as const));
  const projection = projectSchedule({ upb_cents: upbStart, note_rate_bps: i.note_rate_bps, pi_cents: i.pi_cents, escrow_cents: i.escrow_cents !== null && i.escrow_cents !== undefined ? i.escrow_cents : (due) => escrowByDue.get(due) ?? first.escrow_cents, first_due: first.due_date, sequence_start: first.sequence ?? kept.length + 1, maturity_date: maturity });
  const prior = replaced.map((r) => ({ due_date: r.due_date, sequence: r.sequence, pi_cents: s(r.pi_cents), interest_cents: s(r.interest_cents), principal_cents: s(r.principal_cents), escrow_cents: s(r.escrow_cents), upb_before_cents: r.upb_before_cents === null ? null : s(r.upb_before_cents), upb_after_cents: r.upb_after_cents === null ? null : s(r.upb_after_cents), rate_bps: r.rate_bps, terms_id: r.terms_id, schedule_run_id: r.schedule_run_id }));
  const plan: SchedulePlan = { run_id: randomUUID(), loan_id: i.loan_id, terms_id: i.terms_id, source: i.source ?? "reprojection", trigger_event_id: i.trigger_event_id ?? null, projection, note_rate_bps: i.note_rate_bps, pi_cents: i.pi_cents, upb_start_cents: upbStart, rows_kept: kept.length, rows_replaced: replaced.length, replaced: prior, hf005: { recomputed_cents: i.pi_cents, difference_cents: 0n } };
  await persistSchedule(q, plan, { decision_id: i.decision_id ?? null });
  // rows beyond the new maturity (a shortened term) stay as they were only if due; a longer schedule adds rows through ON CONFLICT's insert path
  const event = events.append({ type: INSTALLMENT_EVENTS.reprojected, loanId: i.loan_id, aggregate: { kind: "installment_schedule_run", id: plan.run_id }, actor,
    payload: { loan_id: i.loan_id, run_id: plan.run_id, terms_id: i.terms_id, effective_from: i.effective_from, rows_replaced: replaced.length, rows_kept: kept.length, rows: projection.rows.length, rate_bps: i.note_rate_bps, pi_cents: s(i.pi_cents), upb_start_cents: s(upbStart), sha256: projection.sha256, trigger_event_id: i.trigger_event_id ?? null, rule_set_version: SCHEDULE_RULE_SET } });
  return { run_id: plan.run_id, rows_kept: kept.length, rows_replaced: replaced.length, sha256: projection.sha256, first_replaced_due: first.due_date, event, plan };
}

/** Rule 4 — `due` → `satisfied` for the installments a posting applied (2.1's `payment.posted{installments[]}`), in 2.1's transaction. */
export async function satisfyRows(q: Queryable, events: EventStore, actor: Actor, i: { loan_id: string; due_dates: readonly PlainDate[]; payment_id: string; payment_row_id?: string | null; credited_as_of: PlainDate; satisfied_on: PlainDate; kind?: "satisfied" | "prepaid" }): Promise<PlainDate[]> {
  if (!i.due_dates.length) return [];
  const status = i.kind ?? "satisfied";
  const paymentUuid = i.payment_row_id === undefined ? await paymentRowId(q, i.loan_id, i.payment_id) : i.payment_row_id;
  const moved = await q.query<{ due_date: string }>(`UPDATE loan_installments SET status = $4::installment_status, satisfied_on = $5::date, credited_as_of = $6::date, satisfied_by_payment_id = $3::uuid, updated_at = now()
     WHERE loan_id = $1 AND due_date = ANY($2::date[]) AND status = 'due' RETURNING due_date::text AS due_date`, [i.loan_id, [...i.due_dates], paymentUuid, status, i.satisfied_on, i.credited_as_of]);
  const dues = moved.map((r) => D(r.due_date)).sort();
  for (const due of dues) events.append({ type: INSTALLMENT_EVENTS.satisfied, loanId: i.loan_id, aggregate: { kind: "payment", id: i.payment_id }, actor, payload: { loan_id: i.loan_id, due_date: due, payment_id: i.payment_id, credited_as_of: i.credited_as_of, satisfied_on: i.satisfied_on, status } });
  return dues;
}

/** `satisfied_by_payment_id` references the typed `payments` row (0151). A legacy `PAY-…` ref resolves to the uuid 35.1's projector mints for it — the same (kind, ref, scope) key, minted once, so the FK matches the row written at commit. */
async function paymentRowId(q: Queryable, loanId: string, paymentId: string): Promise<string> {
  return isUuid(paymentId) ? paymentId : mintKey(q, "payments", paymentId, loanId);
}

/** The row id the FK may carry: the payment's own uuid, or the minted one when the store's version projects at commit (35.1 classifyVersion) — a version the projector would gap (a §2 unit harness's bare payment) leaves the FK null and the ref on the event alone. */
export async function paymentRowIdFor(q: Queryable, store: Pick<EntityStore, "get"> | undefined, loanId: string, paymentId: string): Promise<string | null> {
  const rec = store?.get("payments", paymentId);
  // a version the projector would gap (schema mismatch) never lands a `payments` row — uuid-shaped or not, the FK stays null rather than failing the commit
  if (rec && classifyVersion(rec) !== null) return null;
  if (isUuid(paymentId)) return paymentId;
  return rec ? mintKey(q, "payments", paymentId, loanId) : null;
}

/** Rule 4 / state machine — `satisfied` → `due` when 2.1 reverses the satisfying payment (`payment.reversed`), logged as `installment.restored`. */
export async function restoreRows(q: Queryable, events: EventStore, actor: Actor, i: { loan_id: string; payment_id: string; payment_row_id?: string | null; due_dates?: readonly PlainDate[] | null; reason?: string }): Promise<PlainDate[]> {
  const paymentUuid = i.payment_row_id === undefined ? await paymentRowId(q, i.loan_id, i.payment_id) : i.payment_row_id;
  const moved = await q.query<{ due_date: string }>(`UPDATE loan_installments SET status = 'due', satisfied_on = NULL, credited_as_of = NULL, satisfied_by_payment_id = NULL, updated_at = now()
     WHERE loan_id = $1 AND status IN ('satisfied', 'prepaid') AND (satisfied_by_payment_id = $2::uuid OR ($3::date[] IS NOT NULL AND due_date = ANY($3::date[]))) RETURNING due_date::text AS due_date`, [i.loan_id, paymentUuid, i.due_dates && i.due_dates.length ? [...i.due_dates] : null]);
  const dues = moved.map((r) => D(r.due_date)).sort();
  for (const due of dues) events.append({ type: INSTALLMENT_EVENTS.restored, loanId: i.loan_id, aggregate: { kind: "payment", id: i.payment_id }, actor, payload: { loan_id: i.loan_id, due_date: due, payment_id: i.payment_id, reason: i.reason ?? "payment.reversed" } });
  return dues;
}

/** The latest schedule run for a loan (the reprojection idempotency key reads `trigger_event_id`). */
export async function scheduleRuns(q: Queryable, loanId: string): Promise<{ id: string; source: string; trigger_event_id: string | null; created_at: string; rows: number; rows_kept: number; rows_replaced: number; maturity_variance_cents: Cents; pi_cents: Cents; sha256: string }[]> {
  const rows = await q.query<Raw>(`SELECT id::text AS id, source, trigger_event_id::text AS trigger_event_id, created_at::text AS created_at, rows, rows_kept, rows_replaced, maturity_variance_cents::text AS maturity_variance_cents, pi_cents::text AS pi_cents, sha256 FROM installment_schedule_runs WHERE loan_id = $1 ORDER BY created_at, id`, [loanId]);
  return rows.map((r) => ({ id: String(r.id), source: String(r.source), trigger_event_id: (r.trigger_event_id as string | null) ?? null, created_at: String(r.created_at), rows: Number(r.rows), rows_kept: Number(r.rows_kept), rows_replaced: Number(r.rows_replaced), maturity_variance_cents: c(r.maturity_variance_cents), pi_cents: c(r.pi_cents), sha256: String(r.sha256) }));
}
