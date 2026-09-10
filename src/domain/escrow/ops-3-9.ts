/**
 * §3.9 year-end operations — the 1099-INT pipeline the spec's state machine names (`aggregated` → `furnished` →
 * `filed` → `corrected`) and the AI-off path runs as a scheduled job ("scheduled jobs run without the agent").
 * spec/registry/agents.json names no 1099 tool for 3.9 (`generate1099` is spec prose only), so this service is the
 * code path that appends every event the two IRS timer rows arm on or close with:
 *   - `tax_year.closed{source=escrow_interest_1099, tax_year, tax_year_end, furnish_by, efile_by}` per reportable loan
 *     (rule 9: "aggregate per tax year per primary borrower TIN across all loans; furnish Box 1 when ≥ $10.00") — arms
 *     IRS_1099INT_FURNISH_0131 (Jan 31, rolled to the next federal business day) and IRS_1099INT_EFILE_0331 (Mar 31),
 *     both anchored on `tax_year_end`. The `source` qualifier is what the 3.9 rows arm on (timers-3-9.ts): 7.1's Form
 *     1098 close appends the same event type for every loan with interest received and carries no `source`, so it
 *     never arms a 1099-INT row, and this close never defers to it — one 1099-INT close per loan and tax year.
 *   - `schedule.tick{cadence=daily, job=escrow-interest-accrual, accrual_clock_on}` (openAccrualClock) opens a loan's
 *     STATE_IOE_ACCRUAL_DAILY clock; `escrow.interest.accrued{accrued_on, accrual_clock_on = next day, …}` (accrueDay,
 *     idempotent per loan and day — rule 3, "recompute from ledger — accruals are idempotent") is the accrual row for
 *     the day that satisfies the recurring row and re-arms it for the next day.
 *   - `tax.1099int.furnished{furnished_at, channel, …}` — the `escrow_interest_1099.furnished_at` write (Copy B to the
 *     borrower through the print/e-delivery vendor); closes IRS_1099INT_FURNISH_0131.
 *   - `tax.1099int.filed{filed_at, irs_accepted, irs_receipt_id, …}` — IRIS/FIRE acknowledgment ingestion; only an
 *     accepted transmittal writes `filed_at` and closes IRS_1099INT_EFILE_0331 (a rejection is corrected and resent).
 * Money is bigint cents in results; event payloads carry cents as decimal strings (JSON-safe, like 2.x and 7.1).
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { divRound, Decimal, ONE_UNIT } from "../../kernel/money/decimal.ts";
import { SYSTEM, type Actor, type DomainEvent, type EventStore } from "../../kernel/events/index.ts";
import { needs1099Int, FORM_1099_INT_THRESHOLD_CENTS } from "./interest.ts";
import { form1099Int, accrueDaily } from "./ops.ts";
import { IOE_1099_CLOSE_SOURCE, IOE_ACCRUAL_JOB } from "./timers-3-9.ts";

/** IRS e-file mandate (T.D. 9972): 10 or more information returns in the aggregate must be filed electronically. */
export const IRS_EFILE_MANDATE_RETURNS = 10;
export type Form1099IntStatus = "not_required" | "aggregated" | "furnished" | "filed" | "corrected";
/** A borrower's escrow-interest position for the year: the primary borrower's TIN (hashed) and every loan it is primary on. */
export interface BorrowerTaxYear { readonly borrower_id: string; readonly tin_hash: string | null; readonly loan_ids: readonly string[]; readonly tin_solicited?: boolean }
/** One `escrow_interest_1099` row (3.9 data model) plus the per-loan split the aggregation came from. */
export interface Form1099IntRecord {
  readonly tax_year: number; readonly borrower_id: string; readonly tin_hash: string | null; readonly tin_solicited: boolean; readonly total_cents: Cents;
  readonly per_loan: readonly { loan_id: string; credited_cents: Cents; credits: number }[];
  readonly required: boolean; readonly furnish_by: PlainDate | null; readonly efile_by: PlainDate | null;
  readonly furnished_at: string | null; readonly filed_at: string | null; readonly correction_of: string | null; readonly status: Form1099IntStatus;
}
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const money = (c: Cents): string => c.toString();
const year = (d: unknown): number | null => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? Number(d.slice(0, 4)) : null);

/** Rule 9 aggregation input: the year's posted credits per loan (`escrow.interest.credited`, prorated ones included — they are the borrower's money too), by `credited_on`. */
export function creditedInYear(events: EventStore, loanId: string, taxYear: number): { credited_cents: Cents; credits: number } {
  const rows = events.byLoan(loanId).filter((e) => e.type === "escrow.interest.credited" && year((e.payload as Record<string, unknown>).credited_on) === taxYear);
  return { credited_cents: rows.reduce((s, e) => s + BigInt(String((e.payload as Record<string, unknown>).amount_cents ?? "0")), 0n), credits: rows.length };
}

export class EscrowInterest1099Service {
  private readonly events: EventStore;
  private readonly actor: Actor;
  constructor(events: EventStore, actor: Actor = SYSTEM) { this.events = events; this.actor = actor; }
  private append(type: string, loanId: string, payload: Record<string, unknown>, causationId?: string): DomainEvent {
    return this.events.append({ type, loanId, actor: this.actor, payload, ...(causationId ? { causationId } : {}) });
  }
  private static checkYear(taxYear: number): void { if (!Number.isInteger(taxYear) || taxYear < 2000) throw new RangeError("tax_year must be a calendar year"); }

  /** Rule 9: "aggregate per tax year per primary borrower TIN across all loans; furnish Box 1 when ≥ $10.00" — one `escrow_interest_1099` row per borrower from the year's credits (state `aggregated`, or `not_required` under the threshold). */
  aggregate(taxYear: number, borrowers: readonly BorrowerTaxYear[]): Form1099IntRecord[] {
    EscrowInterest1099Service.checkYear(taxYear);
    if (borrowers.length === 0) throw new RangeError("1099-INT aggregation needs the borrowers with escrow interest in the year");
    return borrowers.map((b) => {
      if (b.loan_ids.length === 0) throw new RangeError(`borrower ${b.borrower_id} has no loans to aggregate`);
      const per_loan = b.loan_ids.map((loan_id) => ({ loan_id, ...creditedInYear(this.events, loan_id, taxYear) }));
      const total_cents = per_loan.reduce((s, l) => s + l.credited_cents, 0n);
      const required = needs1099Int(total_cents); const dates = form1099Int(total_cents, taxYear);
      return { tax_year: taxYear, borrower_id: b.borrower_id, tin_hash: b.tin_hash, tin_solicited: b.tin_solicited ?? false, total_cents, per_loan, required, furnish_by: dates.furnish_by, efile_by: dates.efile_by, furnished_at: null, filed_at: null, correction_of: null, status: required ? "aggregated" : "not_required" };
    });
  }

  /**
   * Year-end (`tax.year_closed` → 1099-INT aggregation): aggregates and appends `tax_year.closed{source=escrow_interest_1099}` per reportable loan — the trigger of
   * IRS_1099INT_FURNISH_0131 / IRS_1099INT_EFILE_0331 — skipping only loans this 1099-INT close already closed for the same year (a 7.1 Form 1098 close of the same
   * loan and year carries no `source`, arms no 1099-INT row, and so does not count). `other_information_returns` is the servicer's count of the year's other
   * information returns (7.1's 1098s, 1099-C/-A/-MISC …): the T.D. 9972 mandate is "10 or more information returns in the aggregate", not per form type.
   */
  closeTaxYear(taxYear: number, borrowers: readonly BorrowerTaxYear[], opts: { other_information_returns?: number } = {}): { tax_year_end: PlainDate; records: Form1099IntRecord[]; reportable_loans: string[]; already_closed: string[]; returns: number; information_returns_total: number; electronic_filing_required: boolean } {
    const other = opts.other_information_returns ?? 0;
    if (!Number.isInteger(other) || other < 0) throw new RangeError("other_information_returns must count the year's other information returns (≥ 0)");
    const records = this.aggregate(taxYear, borrowers);
    const tax_year_end = `${taxYear}-12-31` as PlainDate;
    const reportable_loans: string[] = [], already_closed: string[] = [];
    for (const r of records) {
      if (!r.required) continue;
      for (const l of r.per_loan) {
        if (this.events.byLoan(l.loan_id).some((e) => e.type === "tax_year.closed" && (e.payload as Record<string, unknown>).source === IOE_1099_CLOSE_SOURCE && (e.payload as Record<string, unknown>).tax_year === taxYear)) { already_closed.push(l.loan_id); continue; }
        this.append("tax_year.closed", l.loan_id, { tax_year: taxYear, tax_year_end, furnish_by: r.furnish_by, efile_by: r.efile_by, source: IOE_1099_CLOSE_SOURCE, borrower_id: r.borrower_id, total_cents: money(r.total_cents) });
        reportable_loans.push(l.loan_id);
      }
    }
    const returns = records.filter((r) => r.required).length;
    const information_returns_total = returns + other;
    return { tax_year_end, records, reportable_loans, already_closed, returns, information_returns_total, electronic_filing_required: information_returns_total >= IRS_EFILE_MANDATE_RETURNS };
  }

  /** `escrow_interest_1099.furnished_at`: Copy B delivered (print vendor manifest or e-delivery receipt) — `tax.1099int.furnished` per loan on the form closes IRS_1099INT_FURNISH_0131. Guardrails: nothing under $10.00; a missing TIN is solicited first and then furnished with backup withholding (rule 9). */
  furnish(record: Form1099IntRecord, f: { furnished_at: string; channel: "paper" | "electronic"; delivery_evidence_id: string }): { record: Form1099IntRecord; on_time: boolean; backup_withholding: boolean; events: DomainEvent[] } {
    if (!record.required || record.total_cents < FORM_1099_INT_THRESHOLD_CENTS) throw new RangeError(`no 1099-INT under $10.00 (total ${money(record.total_cents)} cents)`);
    if (record.furnished_at) throw new RangeError(`1099-INT for ${record.borrower_id} tax year ${record.tax_year} already furnished at ${record.furnished_at}`);
    if (!ISO_INSTANT.test(f.furnished_at)) throw new RangeError("furnished_at must be an ISO instant");
    if (!f.delivery_evidence_id) throw new RangeError("furnishing needs the vendor manifest or e-delivery receipt id");
    const backup_withholding = record.tin_hash === null;   // rule 9: backup withholding if the TIN is still missing after solicitation
    if (backup_withholding && !record.tin_solicited) throw new RangeError(`TIN missing for ${record.borrower_id}: solicit the TIN before furnishing (backup withholding applies only after solicitation)`);
    const furnished_on = f.furnished_at.slice(0, 10) as PlainDate;
    const on_time = record.furnish_by !== null && furnished_on <= record.furnish_by;
    const events = record.per_loan.map((l) => this.append("tax.1099int.furnished", l.loan_id, { tax_year: record.tax_year, borrower_id: record.borrower_id, tin_hash: record.tin_hash, total_cents: money(record.total_cents), loan_cents: money(l.credited_cents), furnished_at: f.furnished_at, furnished_on, channel: f.channel, delivery_evidence_id: f.delivery_evidence_id, backup_withholding, furnish_by: record.furnish_by, on_time }));
    return { record: { ...record, furnished_at: f.furnished_at, status: "furnished" }, on_time, backup_withholding, events };
  }

  /** IRIS/FIRE acknowledgment ingestion: `tax.1099int.filed{irs_accepted}` per loan on the form; only an accepted transmittal (with its receipt id) writes `filed_at` and closes IRS_1099INT_EFILE_0331 — a rejection keeps the timer open for the corrected resubmission. */
  recordFiled(record: Form1099IntRecord, f: { filed_at: string; irs_receipt_id: string | null; irs_accepted: boolean; rejection_reason?: string | null; returns_in_transmittal: number }): { record: Form1099IntRecord; on_time: boolean; electronic: boolean; events: DomainEvent[] } {
    if (!record.required) throw new RangeError(`no 1099-INT to file for ${record.borrower_id} (under $10.00)`);
    if (!record.furnished_at) throw new RangeError("file after furnishing: the state machine is aggregated → furnished → filed");
    if (!ISO_INSTANT.test(f.filed_at)) throw new RangeError("filed_at must be an ISO instant");
    if (f.irs_accepted && !f.irs_receipt_id) throw new RangeError("an IRS acceptance carries the receipt id from the IRIS/FIRE acknowledgment");
    if (!f.irs_accepted && !f.rejection_reason) throw new RangeError("an IRS rejection carries its reason");
    if (!Number.isInteger(f.returns_in_transmittal) || f.returns_in_transmittal < 1) throw new RangeError("returns_in_transmittal must count the information returns in the transmittal");
    const electronic = f.returns_in_transmittal >= IRS_EFILE_MANDATE_RETURNS;
    const filed_on = f.filed_at.slice(0, 10) as PlainDate;
    const on_time = record.efile_by !== null && filed_on <= record.efile_by;
    const events = record.per_loan.map((l) => this.append("tax.1099int.filed", l.loan_id, { tax_year: record.tax_year, borrower_id: record.borrower_id, total_cents: money(record.total_cents), filed_at: f.filed_at, filed_on, irs_receipt_id: f.irs_receipt_id, irs_accepted: f.irs_accepted, rejection_reason: f.rejection_reason ?? null, electronic, returns_in_transmittal: f.returns_in_transmittal, efile_by: record.efile_by, on_time }));
    return { record: f.irs_accepted ? { ...record, filed_at: f.filed_at, status: "filed" } : record, on_time, electronic, events };
  }
}

/** One `escrow_interest_accruals` row for a calendar day (3.9 data model; `accrued_exact` is cents to 8 places, `posted_cents` is written at the crediting date by postInterestCredit). */
export interface DailyAccrualRow { readonly loan_id: string; readonly state: string; readonly accrued_on: PlainDate; readonly balance_cents: Cents; readonly rate_pct: string; readonly accrued_exact: string; readonly accrued_cents: Cents; readonly status: "accruing"; readonly event: DomainEvent; readonly already_accrued: boolean }
const EXACT_PLACES = 8n, EXACT_UNIT = 10n ** EXACT_PLACES;
/** Rule 3, exact: `max(EOD balance, 0) × rate / 365` in cents to 8 decimal places (actual/365 fixed; a negative balance accrues nothing). */
export function dailyAccrualExact(balanceCents: Cents, ratePct: string): string {
  const base = balanceCents > 0n ? balanceCents : 0n;
  const scaled = divRound(base * Decimal.parse(ratePct).unscaled * EXACT_UNIT, 100n * 365n * ONE_UNIT, "HALF_UP");
  return `${scaled / EXACT_UNIT}.${(scaled % EXACT_UNIT).toString().padStart(Number(EXACT_PLACES), "0")}`;
}

/**
 * The daily accrual job ("Daily accrual job (`timer-sweep` 00:30 servicer TZ) for loans where `jurisdiction_rules.escrow_interest.applies` and the loan passes
 * scope/exemption tests"; AI-off path: "scheduled jobs run without the agent"). STATE_IOE_ACCRUAL_DAILY: `openAccrualClock` appends the sweep's own
 * `schedule.tick{cadence=daily, job=escrow-interest-accrual}` for a loan whose clock is not open (the recurring row's trigger); `accrueDay` appends the day's
 * `escrow.interest.accrued` row (the row's "accrual row for the day"), which satisfies the row and re-arms it for the next day through `accrual_clock_on`.
 */
export class EscrowInterestAccrualJob {
  private readonly events: EventStore;
  private readonly actor: Actor;
  constructor(events: EventStore, actor: Actor = { kind: "system", id: "scheduler" }) { this.events = events; this.actor = actor; }

  /** Opens the loan's daily accrual clock on `on` (the day the first row is for): the 00:30 servicer-local sweep tick that arms STATE_IOE_ACCRUAL_DAILY. */
  openAccrualClock(loanId: string, on: PlainDate, f: { state: string }): DomainEvent {
    if (!loanId) throw new RangeError("the accrual clock is per loan");
    return this.events.append({ type: "schedule.tick", loanId, actor: this.actor, payload: { cadence: "daily", at: "00:30", tz: "servicer_local", job: IOE_ACCRUAL_JOB, state: f.state, date: on, accrual_clock_on: on } });
  }

  /** The accrual row for the day already appended for this loan, if any (accruals are idempotent: a re-run recomputes and finds the row instead of doubling it). */
  rowFor(loanId: string, on: PlainDate): DomainEvent | null {
    return this.events.byLoan(loanId).find((e) => e.type === "escrow.interest.accrued" && (e.payload as Record<string, unknown>).accrued_on === on) ?? null;
  }

  /** Rule 3: one row per loan and calendar day from the day's EOD T&I balance at the rate in effect — `escrow.interest.accrued{accrued_on, accrual_clock_on = the next day}`; a negative balance accrues $0 (T11). */
  accrueDay(loanId: string, f: { state: string; on: PlainDate; eod_balance_cents: Cents; rate_pct: string }): DailyAccrualRow {
    if (!loanId) throw new RangeError("accrual rows are per loan");
    if (!/^\d+(\.\d+)?$/.test(f.rate_pct)) throw new RangeError("rate_pct must be a non-negative decimal percent from a verified observation or the statute");
    const balance_cents = f.eod_balance_cents;
    const accrued_cents = accrueDaily([balance_cents], f.rate_pct), accrued_exact = dailyAccrualExact(balance_cents, f.rate_pct);
    const row = (event: DomainEvent, already_accrued: boolean): DailyAccrualRow => ({ loan_id: loanId, state: f.state, accrued_on: f.on, balance_cents, rate_pct: f.rate_pct, accrued_exact, accrued_cents, status: "accruing", event, already_accrued });
    const existing = this.rowFor(loanId, f.on);
    if (existing) return row(existing, true);
    const next = addDays(f.on, 1);
    const event = this.events.append({ type: "escrow.interest.accrued", loanId, actor: this.actor, payload: { state: f.state, accrued_on: f.on, days: 1, balance_cents: money(balance_cents), rate_pct: f.rate_pct, accrued_exact, accrued_cents: money(accrued_cents), basis: "daily", through: f.on, accrual_clock_on: next, job: IOE_ACCRUAL_JOB } });
    return row(event, false);
  }
}
