/**
 * §35.5 rules 4–6 — the engines read the schedule, the server derives the cash state, and one cashiering unit runs per loan per day
 * over the whole book (the `cashiering_daily` cycle of 35.3; rule set `cashiering.allocation.v1`).
 *
 *   loanCashStateFromRows(db, loanId, asOf, overlay?)   rule 4: the 2.x LoanCashState of a boarded loan from `loans`, `loan_terms`, the
 *                                     `loan_installments` rows 35.5 wrote (status, P&I, escrow, satisfied_on, credited_as_of, the payment),
 *                                     the ledger balances (a unit's in-memory ledger when given, else the persisted lines), the `payments` /
 *                                     `fees` / `autodraft_enrollments` rows (the unit's store when given), the configuration row's late-charge
 *                                     terms (rule 9) and the open `payment_holds` — never a hand-fed figure. A payment posted earlier in the
 *                                     same unit overlays its rows as `satisfied`, so sequential postings in one transaction see each other.
 *   refuseClientState(process, name, input)   rule 5 (NO_CLIENT_STATE): the hosted route refuses `input.state` / `input.custodial` on
 *                                     `payments.read/write{op=post}`, `fees.assess{op=daily_run}`, `autodraft.read/write{op=amount_change_check}`
 *                                     before the bus runs — nothing is written.
 *   runCashieringUnit(rt, input)      rule 6, one unit of work: step 0 the once-per-day key (ONE_UNIT_PER_LOAN_PER_DAY) and the schedule
 *                                     self-check; (a) 2.1 `payments.read/write{op=post}` per received payment in receipt order, the rows moved
 *                                     (`installments.satisfy`, `installment.satisfied{interest_variance_cents}`); (b) `installment.due_date_reached`
 *                                     through 2.7's `fees.assess{op=daily_run}` on a due date and the assessment the day after a grace end, 2.7's
 *                                     accrual set (Dr late_charges / Cr late_charge_income, rule_ref 2.7:r1:accrual) per assessed fee; (c) 2.3's
 *                                     amount-change check per active enrollment within 31 days; `cashiering.unit.completed`, the decision and
 *                                     the `cashiering_unit_runs` row. A `payment_holds` row → (b)–(c) `skipped_hold`. A throw → a `failed` row.
 *   cashieringDailyRun(rt, nowIso)    the whole-book selector (no origination_application_id condition), a unit per loan under the lease port,
 *                                     the cycle row (CyclePort), and the receipt `cashiering.daily.run_completed{…, origination: true}` once per
 *                                     day (satisfies and re-arms SM_CASHIERING_DAILY_RECEIPT_1D); a loan with no configuration row → a `failed`
 *                                     CONFIG_REQUIRED unit row and nothing else.
 *   cashieringRunUnit(i, ctx, rt)     the bus tool `cashiering.run_unit{loan_id, as_of_date, as_of_instant?, job_id?, run_id?}`: the same
 *                                     steps on the command's own unit of work (the decision is the bus's).
 *
 * Money is bigint cents; dates are PlainDate; every event type is a string literal (tools/lint-emission.ts).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { PgEntityRepository } from "../../infra/db/entities.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandRefused, type CommandContext } from "../../app/commands.ts";
import { EntityStore, str, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import type { Ledger } from "../../kernel/ledger/ledger.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { graceEndFor } from "../cashiering/latecharges.ts";
import type { Fee, HoldType, InstallmentProjection, LoanCashState } from "../cashiering/types.ts";
import type { Runtime } from "../../runtime/app.ts";
import { recipientsOf, servicingParties } from "../../runtime/servicing-parties.ts";
import { CASHIERING_AGENT, MODEL_VERSION_DETERMINISTIC, PROMPT_VERSION_35_5, escrowPortionOn, escrowVersionFrom, readSchedule, satisfyInstallments, type InstallmentRow, type LoanTerms } from "./installments.ts";
import { loanLocalDate, servicingConfigFor, servicingConfigIfAny, type ServicingConfigRow } from "./servicing-config.ts";
import { bindUnit, commitUnit, executeInUnit, openUnit, type BoundUnit } from "./in-process.ts";
import { ports35_5 } from "./ports-35-5.ts";

export const RULE_SET_ALLOCATION = "cashiering.allocation.v1";
export const CYCLE_CASHIERING_DAILY = "cashiering_daily";
/** Event literals this file emits. */
export const UNIT_COMPLETED = "cashiering.unit.completed";
export const DAILY_RECEIPT = "cashiering.daily.run_completed";
export const INSTALLMENT_SATISFIED = "installment.satisfied";
const DUE_DATE_REACHED = "installment.due_date_reached";
const EXCLUDED_STATUSES = ["paid_off", "transferred_out", "repurchased", "charged_off"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOLD_TYPES: ReadonlySet<string> = new Set(["bankruptcy", "foreclosure_post_referral", "noe_dispute", "fraud", "deceased_estate", "payoff_pending", "transfer_out_cutover"]);
type Row = Record<string, unknown>;
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const s = (v: Cents): string => v.toString();
/** The ET civil date of an instant — the planner's period key (demo-clock.ts DEMO_ZONE). */
export const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
function refuse(command: string, code: string, citation: string, reason: string): never { throw new CommandRefused(command, code, citation, reason); }

// ---------------------------------------------------------------- rule 4: the state from the rows
export interface LoanRow { readonly id: string; readonly instrument_date: PlainDate; readonly original_upb_cents: Cents; readonly first_payment_date: PlainDate; readonly boarded_at: string | null; readonly servicer_loan_number: string; readonly partner_party_id: string; readonly property_id: string; readonly status: string; readonly origination_application_id: string | null; }
export interface LoanFacts {
  readonly loan: LoanRow; readonly terms: LoanTerms; readonly custodial: { clearing: string; pi: string; ti: string } | null; readonly state: LoanCashState; readonly store: EntityStore;
  readonly balances: { principal: Cents; escrow: Cents; suspense_unapplied: Cents; late_charges: Cents; interest_due: Cents }; readonly received_payments: Row[];
  /** The schedule rows the state was built from (through the month after `asOf`), by due date. */
  readonly rows: readonly InstallmentRow[]; readonly config: ServicingConfigRow | undefined;
}
export interface StateOverlay { readonly store?: EntityStore; readonly ledger?: Pick<Ledger, "balance">; }
async function balancesOf(db: Queryable, loanId: string, ledger?: Pick<Ledger, "balance">): Promise<LoanFacts["balances"]> {
  if (ledger) { const of = (account: "principal" | "escrow" | "suspense_unapplied" | "late_charges" | "interest_due"): Cents => ledger.balance({ scope: "loan", loanId, account }); return { principal: of("principal"), escrow: -of("escrow"), suspense_unapplied: -of("suspense_unapplied"), late_charges: -of("late_charges"), interest_due: -of("interest_due") }; }
  const rows = await db.query<{ account: string; s: string }>(`SELECT account, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 GROUP BY account`, [loanId]);
  const of = (a: string): Cents => c(rows.find((r) => r.account === a)?.s ?? "0");
  return { principal: of("principal"), escrow: -of("escrow"), suspense_unapplied: -of("suspense_unapplied"), late_charges: -of("late_charges"), interest_due: -of("interest_due") };
}
/**
 * The 2.x LoanCashState of a boarded loan as of a date, from the typed rows (rule 4) — see the header. A loan boarded before 35.5 wrote schedules
 * (a fixture inserted by hand, no `schedule_run_id` on any row) keeps the fixed-rate projection loop until it is re-boarded; every loan 35.5
 * boarded reads its rows.
 */
export async function loanCashStateFromRows(db: Queryable, loanId: string, asOf: PlainDate, overlay: StateOverlay = {}): Promise<LoanFacts> {
  const loanRow = (await db.query<Row>(`SELECT id, instrument_date::text AS instrument_date, original_upb_cents::text AS original_upb_cents, first_payment_date::text AS first_payment_date, boarded_at, servicer_loan_number, partner_party_id, property_id, status::text AS status, origination_application_id FROM loans WHERE id = $1`, [loanId]))[0];
  if (!loanRow) throw new RangeError(`no loan ${loanId}`);
  const termsRow = (await db.query<Row>(`SELECT pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents, note_rate_bps, late_charge_pct_bps, late_charge_grace_days, late_charge_max_cents::text AS late_charge_max_cents, escrowed FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  if (!termsRow) throw new RangeError(`no loan_terms for ${loanId}`);
  const store = overlay.store ?? (() => { const st = new EntityStore(); return st; })();
  if (!overlay.store) store.seed(await new PgEntityRepository(db).load({ loanId }));
  const escrowVersion = escrowVersionFrom(store.get("loan_terms", loanId)?.data);
  const loan: LoanRow = { id: loanId, instrument_date: D(String(loanRow.instrument_date)), original_upb_cents: c(loanRow.original_upb_cents), first_payment_date: D(String(loanRow.first_payment_date)), boarded_at: (loanRow.boarded_at as string | null) ?? null, servicer_loan_number: String(loanRow.servicer_loan_number ?? ""), partner_party_id: String(loanRow.partner_party_id), property_id: String(loanRow.property_id), status: String(loanRow.status), origination_application_id: (loanRow.origination_application_id as string | null) ?? null };
  const bps = Number(termsRow.late_charge_pct_bps ?? 5000);
  // rule 9: the late-charge terms 2.7 assesses are the configuration row's (2.7's lateChargeTerms against the state's bound at boarding); the note's when the loan has no row
  const config = await servicingConfigIfAny(db, loanId, asOf);
  const lc = config?.late_charge_terms;
  const terms: LoanTerms = { pi_cents: c(termsRow.pi_cents), escrow_payment_cents: c(termsRow.escrow_payment_cents), note_rate_bps: Number(termsRow.note_rate_bps), late_charge_pct: lc?.pct ?? String(bps / 1000), late_charge_grace_days: lc?.grace_days ?? Number(termsRow.late_charge_grace_days ?? 15), late_charge_max_cents: termsRow.late_charge_max_cents === null || termsRow.late_charge_max_cents === undefined ? null : c(termsRow.late_charge_max_cents), escrowed: termsRow.escrowed === true, escrow_version: escrowVersion };
  const bal = await balancesOf(db, loanId, overlay.ledger);
  const cust = await db.query<{ id: string; kind: string }>(`SELECT id, kind FROM custodial_accounts WHERE partner_party_id = $1 AND kind IN ('clearing', 'pi', 'ti') ORDER BY created_at`, [loan.partner_party_id]);
  const last = (kind: string): string | undefined => cust.filter((x) => x.kind === kind).at(-1)?.id;
  const custodial = last("clearing") && last("pi") && last("ti") ? { clearing: last("clearing")!, pi: last("pi")!, ti: last("ti")! } : null;
  const holds = (await db.query<{ hold_type: string }>(`SELECT hold_type::text AS hold_type FROM payment_holds WHERE loan_id = $1 AND released_at IS NULL ORDER BY set_at`, [loanId])).map((h) => h.hold_type).filter((h): h is HoldType => HOLD_TYPES.has(h));
  const payments = store.list("payments", (d) => d.loan_id === loanId).map((r) => r.data);
  const satisfied = new Map<string, { payment_id: string; credited_as_of: PlainDate; received_on: PlainDate }>();
  for (const p of payments) if (p.status === "posted" && Array.isArray(p.installments)) for (const due of p.installments as string[]) satisfied.set(due, { payment_id: String(p.payment_id ?? ""), credited_as_of: D(String(p.credited_as_of ?? p.received_on)), received_on: D(String(p.received_on)) });
  // a reversed payment (2.3's return, 2.1 rule 9) restores its rows to `due` in the reversing transaction; inside that unit the store already says `reversed` while the row's restore is deferred — the overlay reads it as due
  const reversedPayments = new Set(payments.filter((p) => p.status === "reversed").map((p) => String(p.payment_id ?? "")));
  const reversedDues = new Set(payments.filter((p) => p.status === "reversed" && Array.isArray(p.installments)).flatMap((p) => p.installments as string[]));
  const installments: InstallmentProjection[] = [];
  const horizon = addMonths(asOf, 1);
  const rows = (await readSchedule(db, loanId, { to: horizon })).filter((r) => r.schedule_run_id !== null);
  let lpiFromRows: PlainDate | null = null;
  if (rows.length) {
    for (const r of rows) {
      const hit = satisfied.get(r.due_date);
      const restored = !hit && (r.status === "satisfied" || r.status === "prepaid") && ((r.satisfied_by_payment_id !== null && reversedPayments.has(r.satisfied_by_payment_id)) || (r.satisfied_by_payment_id === null && reversedDues.has(r.due_date)));
      if (restored) { installments.push({ due_date: r.due_date, pi_cents: r.pi_cents, escrow_cents: escrowVersion ? escrowPortionOn({ escrow_payment_cents: r.escrow_cents, escrow_version: escrowVersion }, r.due_date) : r.escrow_cents, status: "due" }); continue; }
      const rowSatisfied = r.status === "satisfied" || r.status === "prepaid";
      // 3.6's effective-dated escrow version in the entity store overlays the row's escrow column until the reprojection reactor rewrites it (rule 3: "3.x escrow changes (escrow column only)")
      installments.push({ due_date: r.due_date, pi_cents: r.pi_cents, escrow_cents: escrowVersion ? escrowPortionOn({ escrow_payment_cents: r.escrow_cents, escrow_version: escrowVersion }, r.due_date) : r.escrow_cents, status: hit ? "satisfied" : (r.status as InstallmentProjection["status"]),
        ...(hit ? { satisfied_on: hit.received_on, credited_as_of: hit.credited_as_of, satisfied_by_payment_id: hit.payment_id } : rowSatisfied ? { ...(r.satisfied_on ? { satisfied_on: r.satisfied_on } : {}), ...(r.credited_as_of ? { credited_as_of: r.credited_as_of } : {}), ...(r.satisfied_by_payment_id ? { satisfied_by_payment_id: r.satisfied_by_payment_id } : {}) } : {}) });
    }
    const paidRows = installments.filter((x) => x.status === "satisfied" || x.status === "prepaid").map((x) => x.due_date);
    // the LPI: the latest satisfied row, else the installment before the schedule's first row (a transfer tape's next due date is the first unpaid one)
    const firstRow = rows[0]!;
    lpiFromRows = [...paidRows].sort().at(-1) ?? (firstRow.due_date > loan.first_payment_date ? addMonths(firstRow.due_date, -1) : null);
  } else {
    // a loan with no written schedule (a fixture boarded by hand before 35.5): the fixed-rate projection of the boarded terms — never a 35.5-boarded loan
    for (let due = loan.first_payment_date, k = 0; due <= horizon && k < 480; due = addMonths(loan.first_payment_date, ++k)) {
      const hit = satisfied.get(due);
      installments.push({ due_date: due, pi_cents: terms.pi_cents, escrow_cents: escrowPortionOn(terms, due), status: hit ? "satisfied" : "due", ...(hit ? { satisfied_on: hit.received_on, credited_as_of: hit.credited_as_of, satisfied_by_payment_id: hit.payment_id } : {}) });
    }
  }
  const fees: Fee[] = store.list("fees", (d) => d.loan_id === loanId && (d.fee_type === "late_charge" || d.fee_type === "nsf_fee")).map((r) => ({ id: r.id, fee_type: r.data.fee_type as Fee["fee_type"], installment_due_date: typeof r.data.installment_due_date === "string" ? D(r.data.installment_due_date) : null, amount_cents: c(r.data.amount_cents), state: (r.data.state as Fee["state"]) ?? "assessed", assessed_on: D(String(r.data.assessed_on)), ...(typeof r.data.grace_end_on === "string" ? { grace_end_on: D(r.data.grace_end_on) } : {}), collected_cents: c(r.data.collected_cents) } as Fee));
  const lcDue = fees.filter((f) => f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "partially_collected")).reduce((a, f) => a + f.amount_cents - f.collected_cents, 0n);
  const lpi = [...satisfied.keys(), ...(lpiFromRows ? [lpiFromRows] : [])].sort().at(-1) ?? null;
  // rule 7: a lockbox item's receipt set (Dr clearing_cash / Cr the loan's suspense_unapplied) is posted at ingest, before 2.1 applies the payment —
  // that credit is the payment itself, not accumulated suspense (2.1 rule 3 pools `state.suspense_unapplied_cents` with the payment's amount, so
  // counting it would apply the check twice). The loan-scoped receipts of the payments still to be posted are taken out of the balance; a
  // receipt parked on the custodial account (`receipt_parked_account`, an item a person identified after the ingest) never sat in the loan's suspense.
  const pendingReceipts = payments.filter((p) => (p.status === "received" || p.status === "identified") && typeof p.receipt_entry_set_id === "string" && p.receipt_entry_set_id && !p.receipt_parked_account).reduce((a, p) => a + c(p.amount_cents), 0n);
  const accumulatedSuspense = bal.suspense_unapplied - pendingReceipts;
  const state: LoanCashState = { loan_id: loanId, instrument_date: loan.instrument_date, lien: "first", escrowed: terms.escrowed, note_rate_pct: (terms.note_rate_bps / 10_000).toFixed(3), remittance_type: "A/A", upb_cents: bal.principal, lpi_date: lpi ? D(lpi) : null, installments, late_charges_due_cents: lcDue, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: accumulatedSuspense > 0n ? accumulatedSuspense : 0n, holds, trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false,
    late_charge_pct: terms.late_charge_pct, late_charge_grace_days: terms.late_charge_grace_days, late_charge_cap_cents: terms.late_charge_max_cents, late_charge_basis: "pi", fees, overlays: [], courtesy_waivers_12m: 0, loan_terms_version: 1 };
  const received = payments.filter((p) => p.status === "received" || p.status === "identified").sort((a, b) => String(a.received_on ?? "").localeCompare(String(b.received_on ?? "")) || String(a.received_at ?? "").localeCompare(String(b.received_at ?? "")));
  return { loan, terms, custodial, state, store, balances: bal, received_payments: received, rows, config };
}

// ---------------------------------------------------------------- rule 5: NO_CLIENT_STATE on the hosted route
const STATE_COMMANDS: readonly { process: string; name: string; op: string }[] = [{ process: "2.1", name: "payments.read/write", op: "post" }, { process: "2.7", name: "fees.assess", op: "daily_run" }, { process: "2.3", name: "autodraft.read/write", op: "amount_change_check" }];
/** Throws CommandRefused NO_CLIENT_STATE when a hosted caller supplies `state` / `custodial` to one of the three state-deriving commands — before the bus, so nothing is written (no `command.refused` event either). */
export function refuseClientState(process: string, name: string, input: Record<string, unknown>): void {
  const op = typeof input.op === "string" ? input.op : "";
  if (!STATE_COMMANDS.some((x) => x.process === process && x.name === name && x.op === op)) return;
  const supplied = ["state", "custodial"].filter((k) => input[k] !== undefined);
  if (!supplied.length) return;
  refuse(name, "NO_CLIENT_STATE", "35.5 rule 5: the command derives LoanCashState from the typed rows; the hosted route refuses a caller's own figures", `${name}{op: ${op}} carries ${supplied.join(", ")} — the server derives the loan's cash state (rule 4); a caller cannot post against its own figures`);
}

// ---------------------------------------------------------------- rule 6: the unit
export interface UnitInput { readonly loan_id: string; readonly as_of_date: PlainDate; readonly as_of_instant?: string; readonly job_id?: string | null; readonly run_id?: string | null; }
export interface UnitOutcome {
  readonly loan_id: string; readonly as_of_date: PlainDate; readonly local_date: PlainDate | null; readonly time_zone: string | null; readonly outcome: "done" | "skipped_hold" | "failed" | "already_done"; readonly unit_run_id: string | null;
  readonly posted: readonly string[]; readonly late_charge_run: boolean; readonly late_charge_fee_ids: readonly string[]; readonly amount_change_checks: readonly string[]; readonly due_today: boolean; readonly grace_ended_yesterday: boolean;
  readonly interest_variance_cents: Cents; readonly error_class: string | null; readonly error: string | null; readonly duration_ms: number; readonly schedule_reprojected: boolean;
}
interface UnitRowInput { readonly id: string; readonly loan_id: string; readonly as_of_date: PlainDate; readonly job_id: string | null; readonly run_id: string | null; readonly time_zone: string | null; readonly local_date: PlainDate | null; readonly payments_posted: readonly string[]; readonly late_charge_run: boolean; readonly late_charge_fee_ids: readonly string[]; readonly amount_change_checks: readonly string[]; readonly due_today: boolean; readonly grace_ended_yesterday: boolean; readonly outcome: "done" | "skipped_hold" | "failed"; readonly error_class: string | null; readonly duration_ms: number; readonly interest_variance_cents: Cents | null; readonly decision_id: string | null; }
/** One `cashiering_unit_runs` row. */
export async function insertUnitRun(q: Queryable, r: UnitRowInput): Promise<void> {
  await q.query(`INSERT INTO cashiering_unit_runs (id, loan_id, as_of_date, job_id, run_id, time_zone, local_date, payments_posted, late_charge_run, late_charge_fee_ids, amount_change_checks, due_today, grace_ended_yesterday, outcome, error_class, duration_ms, interest_variance_cents, decision_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::text[], $11::text[], $12, $13, $14, $15, $16, $17, $18)`,
    [r.id, r.loan_id, r.as_of_date, r.job_id, r.run_id, r.time_zone, r.local_date, [...r.payments_posted], r.late_charge_run, [...r.late_charge_fee_ids], [...r.amount_change_checks], r.due_today, r.grace_ended_yesterday, r.outcome, r.error_class, r.duration_ms, r.interest_variance_cents, r.decision_id]);
}
/** The unit row already written for the loan-day (`done` or `skipped_hold`): the once-per-day key. */
async function unitDoneForDay(q: Queryable, loanId: string, asOf: PlainDate): Promise<{ id: string; outcome: string; created_at: string } | undefined> {
  const r = (await q.query<{ id: string; outcome: string; created_at: string }>(`SELECT id, outcome, created_at::text AS created_at FROM cashiering_unit_runs WHERE loan_id = $1 AND as_of_date = $2 AND outcome IN ('done', 'skipped_hold') ORDER BY created_at LIMIT 1`, [loanId, asOf]))[0];
  return r;
}
/** The next draft date of an active enrollment: `next_draft_on` when set, else the draft day in the month of the next due installment. */
function nextDraftOn(e: Row, state: LoanCashState, today: PlainDate): PlainDate | null {
  if (typeof e.next_draft_on === "string" && e.next_draft_on >= today) return D(e.next_draft_on);
  const due = state.installments.find((x) => x.status === "due" && x.due_date >= addDays(today, -30));
  if (!due) return null;
  const day = Math.min(Number(e.draft_day ?? 1), 28);
  return D(`${due.due_date.slice(0, 8)}${String(day).padStart(2, "0")}`);
}
const decisionRecord = (o: UnitOutcome, extra: Row = {}): Row => ({ loan_id: o.loan_id, action: "cashiering.run_unit", inputs: { as_of_date: o.as_of_date, local_date: o.local_date, time_zone: o.time_zone }, outputs: { unit_run_id: o.unit_run_id, outcome: o.outcome, posted: o.posted, fee_ids: o.late_charge_fee_ids, checks: o.amount_change_checks, interest_variance_cents: s(o.interest_variance_cents), schedule_reprojected: o.schedule_reprojected }, rule_set_version: RULE_SET_ALLOCATION, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1, ...extra });

/**
 * The unit's steps on an open unit of work (the runner's or the bus command's). `recordDecision` queues the unit's decision through `ctx.decide`
 * (the runner path; the bus records its own for the tool). Throws CommandRefused (CONFIG_REQUIRED, CUSTODIAL_REQUIRED, an engine's refusal) —
 * the caller's transaction rolls back, nothing is written.
 */
export async function runUnitSteps(rt: Runtime, u: BoundUnit, input: UnitInput, opts: { recordDecision: boolean }): Promise<UnitOutcome> {
  const started = Date.now(); const loanId = input.loan_id; const ctx = u.ctx; const asOfDate = input.as_of_date; const instant = input.as_of_instant ?? ctx.clock.now();
  const unitRunId = randomUUID();
  // step 0: the once-per-day key — a second unit the same day records only a decision naming the first
  const existing = await unitDoneForDay(rt.db, loanId, asOfDate);
  if (existing) {
    const o: UnitOutcome = { loan_id: loanId, as_of_date: asOfDate, local_date: null, time_zone: null, outcome: "already_done", unit_run_id: existing.id, posted: [], late_charge_run: false, late_charge_fee_ids: [], amount_change_checks: [], due_today: false, grace_ended_yesterday: false, interest_variance_cents: 0n, error_class: null, error: null, duration_ms: Date.now() - started, schedule_reprojected: false };
    const rationale = `ONE_UNIT_PER_LOAN_PER_DAY: unit ${existing.id} ${existing.outcome} at ${existing.created_at} for ${loanId} on ${asOfDate}; nothing posted, assessed or checked again — ${toJson(decisionRecord(o))}`;
    if (opts.recordDecision) {
      const already = (await rt.db.query<{ id: string }>(`SELECT id FROM agent_decisions WHERE loan_id = $1 AND action = 'cashiering.run_unit' AND rule_code = 'ONE_UNIT_PER_LOAN_PER_DAY' AND subject_kind = 'cashiering_unit_run' AND subject_id = $2 LIMIT 1`, [loanId, existing.id]))[0];
      if (!already) ctx.decide({ agent: CASHIERING_AGENT.id, action: "cashiering.run_unit", rationale, ruleSetVersion: RULE_SET_ALLOCATION, loanId, subject: { kind: "cashiering_unit_run", id: existing.id }, ruleCode: "ONE_UNIT_PER_LOAN_PER_DAY", confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 });
    }
    return o;
  }
  // rule 9: the loan-local civil date of the as-of instant — a loan with no configuration row is refused, never defaulted
  const cfg = await servicingConfigFor(rt.db, loanId, asOfDate);
  const localDate = loanLocalDate(cfg, instant);
  // step 0b: the schedule self-check — a typed loan_terms version newer than the rows' terms with due rows on or after its effective date is re-projected (rule 3's safety net; the reactor is the primary path; a refusal is the reactor's escalation, never a failed unit)
  let reprojected = false;
  const latestTerms = (await rt.db.query<{ id: string; effective_from: string }>(`SELECT id, effective_from::text AS effective_from FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  if (latestTerms) {
    const stale = (await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_installments WHERE loan_id = $1 AND status = 'due' AND due_date >= $2::date AND schedule_run_id IS NOT NULL AND terms_id IS DISTINCT FROM $3`, [loanId, latestTerms.effective_from, latestTerms.id]))[0]!.c;
    const current = (await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_installments WHERE loan_id = $1 AND terms_id = $2`, [loanId, latestTerms.id]))[0]!.c;
    if (Number(stale) > 0 && Number(current) === 0) {
      try { await executeInUnit(rt, u, { process: "35.5", name: "installments.reproject", actor: CASHIERING_AGENT, input: { loan_id: loanId, terms_id: latestTerms.id, source: "reprojection" } }); reprojected = true; }
      catch (e) { if (!(e instanceof CommandRefused)) throw e; }
    }
  }
  let facts = await loanCashStateFromRows(rt.db, loanId, localDate, { store: u.store, ledger: ctx.ledger });
  const holds = facts.state.holds;
  const posted: string[] = []; const satisfyItems: { due_date: PlainDate; payment_id: string | null; credited_as_of: PlainDate; satisfied_on: PlainDate; interest_variance_cents: Cents | null; status: "satisfied" | "prepaid" }[] = []; let variance = 0n;
  // (a) 2.1: every received / identified payment through the allocation engine, in receipt order; the state re-derived after each from the unit's own store and ledger
  const received = facts.received_payments;
  if (received.length && !facts.custodial) refuse("cashiering.run_unit", "CUSTODIAL_REQUIRED", "35.5 rule 5: the per-loan custodial accounts come from custodial_accounts by partner_party_id", `loan ${loanId}: ${received.length} received payment(s) and no clearing / pi / ti custodial account for partner ${facts.loan.partner_party_id}`);
  for (const p of received) {
    const id = String(p.payment_id ?? ""); const before = ctx.events.lastSequence();
    const r = await executeInUnit(rt, u, { process: "2.1", name: "payments.read/write", actor: CASHIERING_AGENT, input: { op: "post", id, loan_id: loanId, state: facts.state, custodial: facts.custodial } });
    const out = (r.output ?? {}) as Row; posted.push(id);
    const applied = ctx.events.since(before).filter((e) => e.type === "payment.applied" && e.loanId === loanId && String((e.payload as Row).payment_id) === id);
    for (const due of Array.isArray(out.installments) ? (out.installments as string[]) : []) {
      const row = facts.rows.find((x) => x.due_date === due); const ap = applied.find((e) => String((e.payload as Row).due_date) === due);
      const engineInterest = ap ? c((ap.payload as Row).interest_cents) : null;
      const rowVariance = row && engineInterest !== null ? row.interest_cents - engineInterest : null;
      if (rowVariance !== null) variance += rowVariance;
      const creditedAsOf = D(String((ap?.payload as Row | undefined)?.credited_as_of ?? p.credited_as_of ?? p.received_on)); const receivedOn = D(String(p.received_on));
      const kind = (ap?.payload as Row | undefined)?.kind === "prepaid" ? "prepaid" : "satisfied";
      ctx.events.append({ type: INSTALLMENT_SATISFIED, loanId, actor: CASHIERING_AGENT, causationId: r.event.id, payload: { loan_id: loanId, due_date: due, payment_id: id, credited_as_of: creditedAsOf, satisfied_on: receivedOn, status: kind, interest_variance_cents: rowVariance === null ? null : s(rowVariance), row_interest_cents: row ? s(row.interest_cents) : null, engine_interest_cents: engineInterest === null ? null : s(engineInterest), unit_run_id: unitRunId } });
      // the row's `satisfied_by_payment_id` is a uuid: a legacy JSONB id (`PAY-…`, `ACH-…`, written before 35.5) rides on the event only until 35.1 mints the typed id (plan D5 / Ask 2)
      satisfyItems.push({ due_date: D(due), payment_id: UUID_RE.test(id) ? id : null, credited_as_of: creditedAsOf, satisfied_on: receivedOn, interest_variance_cents: rowVariance, status: kind });
    }
    facts = await loanCashStateFromRows(rt.db, loanId, localDate, { store: u.store, ledger: ctx.ledger });
  }
  // (b) 2.7: `installment.due_date_reached` on a due date (once per due date) and the assessment the day after a grace end; the accrual set per assessed fee
  let lateChargeRun = false; const feeIds: string[] = []; let dueToday = false; let graceYesterday = false; const checks: string[] = [];
  const held = holds.length > 0;
  if (!held) {
    const reached = new Set(ctx.events.byLoan(loanId).filter((e) => e.type === DUE_DATE_REACHED).map((e) => String((e.payload as Row).due_date ?? (e.payload as Row).installment_due_date ?? "")));
    dueToday = facts.state.installments.some((x) => x.due_date === localDate && !reached.has(x.due_date));
    graceYesterday = facts.state.installments.some((x) => x.status === "due" && graceEndFor(facts.state, x.due_date) === addDays(localDate, -1));
    if (dueToday || graceYesterday) {
      const backlog = facts.received_payments.filter((p) => String(p.received_on ?? "") <= localDate).length;
      const r = await executeInUnit(rt, u, { process: "2.7", name: "fees.assess", actor: CASHIERING_AGENT, input: { op: "daily_run", loan_id: loanId, state: facts.state, run_on: localDate, facts: { items_received_or_identified_on_or_before_gate_date: backlog, run_on: localDate }, unposted_receipts_on_or_before_grace: backlog } });
      lateChargeRun = true;
      const decisions = ((r.output as Row | undefined)?.decisions ?? []) as Row[];
      for (const d of decisions) {
        if (d.outcome !== "assessed" || !d.fee) continue;
        const fee = d.fee as Row; const feeId = String(fee.id); const amount = c(fee.amount_cents); feeIds.push(feeId);
        // D11: 2.7's accrual — bookkeeping of the engine's figure, never a decision (Dr loan late_charges / Cr corporate late_charge_income on the assessment date)
        if (amount > 0n) ctx.ledger.post({ effectiveDate: D(String(fee.assessed_on ?? localDate)), description: `late charge accrual ${feeId}`, lines: [{ account: { scope: "loan", loanId, account: "late_charges" }, amountCents: amount, ruleRef: "2.7:r1:accrual" }, { account: { scope: "corporate", account: "late_charge_income" }, amountCents: -amount, ruleRef: "2.7:r1:accrual" }] }, ctx.clock.now());
      }
      facts = await loanCashStateFromRows(rt.db, loanId, localDate, { store: u.store, ledger: ctx.ledger });
    }
    // (c) 2.3 rule 5: a changed draft amount within the 31-day window needs the Reg E notice (or the escrow statement that stated it); `next` from the schedule row
    for (const rec of u.store.list("autodraft_enrollments", (d) => d.loan_id === loanId && d.status === "active")) {
      const e = rec.data; if (e.last_debit_cents === null || e.last_debit_cents === undefined) continue;
      const debitOn = nextDraftOn(e, facts.state, localDate); if (!debitOn || debitOn < localDate || debitOn > addDays(localDate, 31)) continue;
      const inst = facts.state.installments.find((x) => x.due_date.slice(0, 7) === debitOn.slice(0, 7)) ?? facts.state.installments.find((x) => x.status === "due");
      if (!inst) continue;
      const next = inst.pi_cents + inst.escrow_cents + c(e.extra_principal_cents);
      if (next === c(e.last_debit_cents)) continue;
      const notices = Array.isArray(e.notices) ? (e.notices as Row[]) : [];
      if (notices.some((n) => c(n.amount_cents) === next && n.debit_on === debitOn)) continue;   // already noticed (or the statement stated it)
      const stmt = ctx.events.byLoan(loanId).filter((x) => x.type === "escrow.statement.sent" && typeof (x.payload as Row).stated_payment_cents === "string").at(-1);
      const recipients = recipientsOf(await servicingParties(rt, loanId));
      await executeInUnit(rt, u, { process: "2.3", name: "autodraft.read/write", actor: CASHIERING_AGENT, input: { op: "amount_change_check", id: rec.id, loan_id: loanId, next_amount_cents: s(next), debit_on: debitOn, today: localDate, prior_amount_cents: String(e.last_debit_cents), reason: "your escrow payment changed after the annual escrow analysis", recipients,
        ...(stmt ? { statement: { template: String((stmt.payload as Row).template), sent_on: String((stmt.payload as Row).sent_on), amount_cents: String((stmt.payload as Row).stated_payment_cents), debit_on: String((stmt.payload as Row).stated_payment_effective_on) } } : {}) } });
      checks.push(rec.id);
    }
  }
  const outcome: UnitOutcome["outcome"] = held ? "skipped_hold" : "done";
  const duration = Date.now() - started;
  const o: UnitOutcome = { loan_id: loanId, as_of_date: asOfDate, local_date: localDate, time_zone: cfg.time_zone, outcome, unit_run_id: unitRunId, posted, late_charge_run: lateChargeRun, late_charge_fee_ids: feeIds, amount_change_checks: checks, due_today: dueToday, grace_ended_yesterday: graceYesterday, interest_variance_cents: variance, error_class: null, error: null, duration_ms: duration, schedule_reprojected: reprojected };
  ctx.events.append({ type: UNIT_COMPLETED, loanId, actor: CASHIERING_AGENT, payload: { loan_id: loanId, as_of_date: asOfDate, local_date: localDate, time_zone: cfg.time_zone, job_id: input.job_id ?? null, run_id: input.run_id ?? null, unit_run_id: unitRunId, posted, late_charge_run: lateChargeRun, late_charge_fee_ids: feeIds, amount_change_checks: checks, due_today: dueToday, grace_ended_yesterday: graceYesterday, outcome, ...(held ? { holds } : {}), interest_variance_cents: s(variance), schedule_reprojected: reprojected, duration_ms: duration } });
  if (opts.recordDecision) ctx.decide({ agent: CASHIERING_AGENT.id, action: "cashiering.run_unit", rationale: toJson(decisionRecord(o, { holds })), ruleSetVersion: RULE_SET_ALLOCATION, loanId, subject: { kind: "cashiering_unit_run", id: unitRunId }, ...(held ? { ruleCode: "HOLD" } : {}), confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 });
  const jobId = input.job_id ?? null; const runId = input.run_id ?? null;
  u.deferWrite(async (q) => {
    if (satisfyItems.length) await satisfyInstallments(q, loanId, satisfyItems);
    const decision = (await q.query<{ id: string }>(`SELECT id FROM agent_decisions WHERE subject_kind = 'cashiering_unit_run' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [unitRunId]))[0]?.id ?? null;
    await insertUnitRun(q, { id: unitRunId, loan_id: loanId, as_of_date: asOfDate, job_id: jobId, run_id: runId, time_zone: cfg.time_zone, local_date: localDate, payments_posted: posted, late_charge_run: lateChargeRun, late_charge_fee_ids: feeIds, amount_change_checks: checks, due_today: dueToday, grace_ended_yesterday: graceYesterday, outcome, error_class: null, duration_ms: duration, interest_variance_cents: variance, decision_id: decision });
  });
  return o;
}

/** The runner path: one unit of work per loan-day; a throw becomes a `failed` row written in its own small transaction (nothing else for that loan). */
export async function runCashieringUnit(rt: Runtime, input: UnitInput): Promise<UnitOutcome> {
  const started = Date.now(); const loanId = input.loan_id;
  try {
    const opened = await openUnit(rt, { loanId });
    let bound: BoundUnit | undefined; let outcome: UnitOutcome | undefined;
    await rt.uow.run({ loanId }, async (uow) => { bound = bindUnit(rt, opened, uow); outcome = await runUnitSteps(rt, bound, input, { recordDecision: true }); return outcome; }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
    return outcome!;
  } catch (e) {
    const errorClass = e instanceof CommandRefused ? e.code : e instanceof Error ? e.name : "Error"; const message = e instanceof Error ? e.message : String(e);
    const id = randomUUID();
    await rt.db.tx((q) => insertUnitRun(q, { id, loan_id: loanId, as_of_date: input.as_of_date, job_id: input.job_id ?? null, run_id: input.run_id ?? null, time_zone: null, local_date: null, payments_posted: [], late_charge_run: false, late_charge_fee_ids: [], amount_change_checks: [], due_today: false, grace_ended_yesterday: false, outcome: "failed", error_class: errorClass, duration_ms: Date.now() - started, interest_variance_cents: null, decision_id: null }));
    return { loan_id: loanId, as_of_date: input.as_of_date, local_date: null, time_zone: null, outcome: "failed", unit_run_id: id, posted: [], late_charge_run: false, late_charge_fee_ids: [], amount_change_checks: [], due_today: false, grace_ended_yesterday: false, interest_variance_cents: 0n, error_class: errorClass, error: message, duration_ms: Date.now() - started, schedule_reprojected: false };
  }
}

// ---------------------------------------------------------------- the bus tool `cashiering.run_unit`
type Services = { runtime?: Runtime; deferWrite?: (fn: (q: Queryable) => Promise<void>) => void };
/** `cashiering.run_unit{loan_id, as_of_date, as_of_instant?, job_id?, run_id?}` on the command's own unit of work — the steps above; the decision is the bus's (subject = the unit row). */
export async function cashieringRunUnit(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const loanId = str(i, "loan_id"); if (!loanId) throw new RangeError("loan_id is required");
  const asOf = str(i, "as_of_date"); if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new RangeError("as_of_date (YYYY-MM-DD) is required");
  const services = rt.services as Services; const runtime = services.runtime; const deferWrite = services.deferWrite;
  if (!runtime || !deferWrite) throw new RangeError("cashiering.run_unit needs the hosted runtime (services.runtime, services.deferWrite)");
  const bound: BoundUnit = { scope: { loanId }, store: rt.store, mark: 0, openEscalations: [], deferred: [], ctx, escalations: rt.escalations, toolRt: rt, deferWrite };
  const o = await runUnitSteps(runtime, bound, { loan_id: loanId, as_of_date: D(asOf), ...(str(i, "as_of_instant") ? { as_of_instant: str(i, "as_of_instant") } : {}), job_id: str(i, "job_id") || null, run_id: str(i, "run_id") || null }, { recordDecision: false });
  return { ...o, interest_variance_cents: s(o.interest_variance_cents) };
}

// ---------------------------------------------------------------- the whole-book daily run and its receipt
export interface CashieringDailyReport {
  readonly at: string; readonly as_of_date: PlainDate; readonly run_id: string; readonly already: boolean; readonly loans: number;
  readonly posted: string[]; readonly late_charge_runs: string[]; readonly amount_change_checks: string[]; readonly errors: { loan_id: string; step: string; error: string }[]; readonly skipped: { loan_id: string; reason: string }[];
  readonly units: { done: number; already: number; skipped_hold: number; failed: number }; readonly receipt_event_id: string | null;
}
/**
 * The selector of rule 6: every loan boarded by the as-of instant (`boarded_at <= as_of`, the book as the planner saw it) and not paid off /
 * transferred out / repurchased / charged off — no origination_application_id condition — with its configuration row in force on the day;
 * a boarded loan without a row is listed separately (CONFIG_REQUIRED, rule 9).
 */
export async function selectBook(db: Queryable, asOf: PlainDate, asOfInstant: string): Promise<{ loans: { loan_id: string; time_zone: string }[]; unconfigured: string[] }> {
  const loans = await db.query<{ loan_id: string; time_zone: string }>(`SELECT l.id AS loan_id, cfg.time_zone FROM loans l JOIN LATERAL (SELECT time_zone FROM loan_servicing_configs c WHERE c.loan_id = l.id AND c.effective_from <= $1::date ORDER BY c.effective_from DESC, c.created_at DESC LIMIT 1) cfg ON true
    WHERE l.boarded_at IS NOT NULL AND l.boarded_at <= $3::timestamptz AND l.status::text <> ALL($2::text[]) ORDER BY l.boarded_at, l.created_at`, [asOf, EXCLUDED_STATUSES, asOfInstant]);
  const unconfigured = await db.query<{ loan_id: string }>(`SELECT l.id AS loan_id FROM loans l WHERE l.boarded_at IS NOT NULL AND l.boarded_at <= $3::timestamptz AND l.status::text <> ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM loan_servicing_configs c WHERE c.loan_id = l.id AND c.effective_from <= $1::date) ORDER BY l.boarded_at, l.created_at`, [asOf, EXCLUDED_STATUSES, asOfInstant]);
  return { loans, unconfigured: unconfigured.map((r) => r.loan_id) };
}
export async function cashieringDailyRun(rt: Runtime, nowIso: string = rt.clock.now()): Promise<CashieringDailyReport> {
  const asOf = etDate(nowIso); const ports = ports35_5(rt);
  const book = await selectBook(rt.db, asOf, nowIso);
  const report = { at: nowIso, as_of_date: asOf, run_id: "", already: false, loans: book.loans.length, posted: [] as string[], late_charge_runs: [] as string[], amount_change_checks: [] as string[], errors: [] as CashieringDailyReport["errors"], skipped: [] as CashieringDailyReport["skipped"], units: { done: 0, already: 0, skipped_hold: 0, failed: 0 }, receipt_event_id: null as string | null };
  const leased = await ports.runLease.withRunLease(CYCLE_CASHIERING_DAILY, async () => {
    const run = await ports.cycles.openRun(CYCLE_CASHIERING_DAILY, asOf, asOf, book.loans.length, `sweep:${nowIso}`);
    report.run_id = run.run_id; report.already = run.already;
    // a boarded loan with no configuration row: refused CONFIG_REQUIRED — one failed unit row per day, no event, nothing else (rule 9)
    for (const loanId of book.unconfigured) {
      report.skipped.push({ loan_id: loanId, reason: "CONFIG_REQUIRED" });
      const prior = (await rt.db.query<{ id: string }>(`SELECT id FROM cashiering_unit_runs WHERE loan_id = $1 AND as_of_date = $2 AND outcome = 'failed' AND error_class = 'CONFIG_REQUIRED' LIMIT 1`, [loanId, asOf]))[0];
      if (!prior) await rt.db.tx((q) => insertUnitRun(q, { id: randomUUID(), loan_id: loanId, as_of_date: asOf, job_id: null, run_id: run.run_id, time_zone: null, local_date: null, payments_posted: [], late_charge_run: false, late_charge_fee_ids: [], amount_change_checks: [], due_today: false, grace_ended_yesterday: false, outcome: "failed", error_class: "CONFIG_REQUIRED", duration_ms: 0, interest_variance_cents: null, decision_id: null }));
    }
    for (const l of book.loans) {
      const o = await runCashieringUnit(rt, { loan_id: l.loan_id, as_of_date: asOf, as_of_instant: nowIso, run_id: run.run_id });
      if (o.outcome === "failed") { report.units.failed += 1; report.errors.push({ loan_id: l.loan_id, step: o.error_class ?? "unit", error: o.error ?? "failed" }); continue; }
      if (o.outcome === "already_done") { report.units.already += 1; continue; }
      if (o.outcome === "skipped_hold") report.units.skipped_hold += 1; else report.units.done += 1;
      report.posted.push(...o.posted); if (o.late_charge_run) report.late_charge_runs.push(l.loan_id); report.amount_change_checks.push(...o.amount_change_checks);
    }
    const doneRows = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM cashiering_unit_runs WHERE as_of_date = $1 AND outcome IN ('done', 'skipped_hold') AND loan_id = ANY($2::uuid[])`, [asOf, book.loans.map((l) => l.loan_id)]))[0]!.c);
    await ports.cycles.completeRun(run.run_id, { units_done: doneRows, units_dead: report.units.failed, units_skipped: book.unconfigured.length });
    // the receipt election (35.3 rule 5): once per day — a rerun of the same period elects nothing
    if (!run.already) {
      const late = Number((await rt.db.query<{ c: string }>(`SELECT coalesce(sum(cardinality(late_charge_fee_ids)), 0)::text AS c FROM cashiering_unit_runs WHERE as_of_date = $1 AND outcome = 'done'`, [asOf]))[0]!.c);
      report.receipt_event_id = (await electDailyReceipt(rt, { as_of_date: asOf, run_id: run.run_id, loans: book.loans.length, posted: report.posted.length, late_charges_assessed: late, amount_change_checks: report.amount_change_checks.length, units_total: book.loans.length, units_done: doneRows, units_dead: report.units.failed, units_skipped: book.unconfigured.length })).id;
    }
    return report;
  });
  if ("skipped" in leased && (leased as { skipped?: string }).skipped === "lease_held") return { ...report, errors: [{ loan_id: "", step: "lease", error: "lease held" }] };
  return report;
}
/** `cashiering.daily.run_completed{…, origination: true}` on the global subject: SM_CASHIERING_DAILY_RECEIPT_1D's trigger and satisfier (re-armed for the next day); 35.4's `eod_cutoff` receipt. Deleted at 35.3's merge (its `electReceipt` owns the literal — plan §9 R1). */
export async function electDailyReceipt(rt: Runtime, r: { as_of_date: PlainDate; run_id: string; loans: number; posted: number; late_charges_assessed: number; amount_change_checks: number; units_total: number; units_done: number; units_dead: number; units_skipped: number }): Promise<DomainEvent> {
  const res = await rt.uow.run({}, (ctx) => ctx.events.append({ type: DAILY_RECEIPT, aggregate: { kind: "cycle_run", id: r.run_id }, actor: CASHIERING_AGENT,
    payload: { as_of_date: r.as_of_date, run_id: r.run_id, cycle_code: CYCLE_CASHIERING_DAILY, period_key: r.as_of_date, loans: r.loans, posted: r.posted, late_charges_assessed: r.late_charges_assessed, amount_change_checks: r.amount_change_checks, units_total: r.units_total, units_done: r.units_done, units_dead: r.units_dead, units_skipped: r.units_skipped, origination: true } }), { clock: rt.clock });
  return res.result;
}

export { CASHIERING_AGENT, EXCLUDED_STATUSES };
export type { UowContext };
