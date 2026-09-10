/**
 * §5.5 operating rules over the g-fee calculators in ./ops.ts (`gfeeBillLine`, `gfeeDraft`, `gfeeReliefPrediction`,
 * `gfeeRecovery`, `gfeeBillVariance`) and the event vocabulary the 5.5 timer rows arm on and are satisfied by. The tools
 * in src/app/tools/section5-5.ts are thin shells over these (pattern: ./ops-5-4.ts for Stop Delinquency Advance).
 * Guardrails read the thing being done, not a caller's description of it: every rule below takes the loan's relief
 * status and balances from its `gfee_relief_status.*` / `gfee.recovery.matched` history (`gfeeReliefFromEvents`), the
 * accepted LAR from 5.1's `investor_events.accepted` row on the loan, current-ness from the platform's
 * `loan.became_current` fact, and the bill from the parsed `draft_notifications` row.
 *   - period clocks (timer table: 'period open' → bill parsed by CD5 12:00 ET; g-fee draft funded by CD7 −1 BD 16:00 ET):
 *     `parseGfeeBill` — the monthly MBS guaranty-fee bill "retrieve[d] … from Fannie Mae's website" (F-1-20) parsed into
 *     a `draft_notifications` row (`draft_type = mbs_gfee`) → `gfee.bill.parsed{draft_type=mbs_gfee, period,
 *     servicer_number}`; `fundGfeeDraft` — the CD7 draft funded through the T−1 16:00 ET funding check →
 *     `remittances.funded{kind=gfee, initiator=fnma}` (an uncollected g-fee on a delinquent non-relief loan is an
 *     `advances(kind=gfee)` transfer, rule 2). Both carry 5.1's period aggregate `{kind: period, id: <servicer>:<period>}`
 *     (src/domain/investor/ops-5-1.ts `openReportingPeriod`), the subject the two period clocks are armed on.
 *   - rule 3 / state machine: `predictGfeeRelief` — the period-end prediction (same consecutive-month logic as 5.4) →
 *     `gfee_relief_status.predicted` for an S/S MBS loan four or more consecutive months delinquent (once), and
 *     `gfee_relief.reconciled` per reconciliation; `activateGfeeRelief` — "authoritative when the bill omits/zeros the
 *     loan" → `gfee_relief_status.active{fnma_start_date}` (only from Fannie Mae's bill, never predicted alone);
 *     `reconcileReliefToBill` — every predicted/active relief loan reconciled to the parsed bill (omitted/zero line =
 *     relief confirmed; a non-zero line is the rule-4 recovery draft when a contractual payment was reported, else the
 *     Agents-paragraph escalation "a relief loan reappears on the bill without a contractual payment") →
 *     `gfee_relief.reconciled` per loan and `gfee_relief.bill_reconciled{all_reconciled}` for the bill;
 *   - rule 4 recovery: `expectGfeeRecovery` on 5.1's accepted contractual-payment LAR (`investor_events.accepted{event_type=
 *     payment.contractual}` on the loan) → `gfee.recovery.expected{gfee_relief_active=true, contractual=true, accepted_on}`
 *     — Fannie Mae "will draft the guaranty fee amount associated with the contractual payment", applied first "to
 *     recover the outstanding guaranty fees due to Fannie Mae", then "the servicer may then retain subsequent guaranty fee
 *     amounts to recover delinquent guaranty fee advances it has made" (F-1-20); arms SM_GFEE_RECOVERY_MATCH_2_CYCLES
 *     (two CD7 bill cycles from the acceptance date); `matchGfeeRecoveryDebit` → `gfee.recovery.matched{kind}` per matched
 *     component (`fnma_recovery` then `servicer_retention`, FIFO per bill line) and the balanced entry sets the tool posts
 *     (rule 4: "posts Cr `servicer_advance_receivable(gfee)`" — the kernel's corporate `advance_receivable`);
 *   - rule 5 exits: `recordGfeeReliefExit` → `gfee_relief_status.exited{reason, exited_on, period_end, resume_draft_on}` —
 *     current (the loan's `loan.became_current` fact) → "the servicer must resume remitting guaranty fees … beginning with
 *     the applicable draft date" (the next CD7, FNMA_F120_GFEE_RESUME_ON_CURRENT); reclass → PTR adjusted "to include
 *     guaranty fee" (F-1-25); payoff / repurchase / liquidation → "the servicer is no longer responsible for remitting
 *     guaranty fees"; `resumeGfeeDraft` funds the resumed g-fee draft through 5.2's funding check →
 *     `remittances.funded{kind=gfee, remittance_type=ss}` on the loan, which satisfies the resume clock.
 *
 * Subjects: loan-level facts carry `loanId`; the bill, its reconciliation and the CD7 funding carry the period aggregate
 * (`gfeePeriodSubject`); the resumed draft also carries 5.2's remittance-cycle aggregate as every other funded draft does.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, endOfMonth, addMonths } from "../../kernel/calendar/date.ts";
import { toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import type { RemittanceType } from "./types.ts";
import type { SdaStatus } from "./sda.ts";
import { period as periodOf, periodStart, nextMonth, calendarDraftDate, fundingGateMs } from "./period.ts";
import { ET, advanceTransfer, gfeeReliefPrediction, gfeeRecovery, type AdvanceTransfer } from "./ops.ts";
import { fundDraft, type Emitter, type Subject, type FundDraftInput, type FundDraftResult } from "./ops-5-2.ts";

export const RULE_SET_VERSION_5_5 = "5.5@ops.v2";
/** 5.5 data model `gfee_relief_status.status` — mirrors 5.4's `sda_status` (state machine). */
export type GfeeReliefStatus = SdaStatus;
/** 5.5 rule 5 exits: current → drafting resumes; reclass to A/A → PTR carries the fee; payoff/repurchase/liquidation → no further g-fee. */
export type GfeeReliefExitReason = "current" | "reclass" | "payoff" | "repurchase" | "liquidation";
export interface GfeeReliefState { status: GfeeReliefStatus; fnma_start_date: PlainDate | null; outstanding_fnma_gfee_cents: Cents; servicer_gfee_advances_cents: Cents; exit_reason: GfeeReliefExitReason | null; }
export type { Emitter, Subject };

const SERVICER = /^\d{9}$/;
const isoDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const asPeriod = (s: string): string => { if (!/^\d{4}-\d{2}$/.test(s)) throw new RangeError(`period ${s} is not YYYY-MM`); return s; };
const etDate = (ms: number): PlainDate => wallClock(ms, ET).date;
const inRelief = (s: GfeeReliefStatus): boolean => s === "predicted" || s === "active";
const centsOf = (v: unknown, fallback: Cents): Cents => { if (typeof v === "bigint") return v; if (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v))) return BigInt(v); return fallback; };

/** 5.1's period aggregate `{kind: "period", id: "<servicer>:<period>"}` (src/domain/investor/ops-5-1.ts `openReportingPeriod`) — the subject the period clocks are armed on. */
export function gfeePeriodSubject(servicerNumber: string, period: string): Subject { return { kind: "period", id: `${servicerNumber}:${asPeriod(period)}` }; }
/** Two g-fee bill cycles from a date: the CD7 draft (preceding `fannie_et` BD) of the month after next (timer table: "2 bill cycles"). */
export function gfeeTwoCyclesFrom(d: PlainDate): PlainDate { return calendarDraftDate(nextMonth(nextMonth(d)), 7); }
/** Exit (current): "resume from the next CD7 bill" — the CD7 draft (preceding `fannie_et` BD) of the month after the period end. */
export function gfeeResumeDraftOn(periodEnd: PlainDate): PlainDate { return calendarDraftDate(nextMonth(periodEnd), 7); }

/** The loan's `gfee_relief_status` as its `gfee_relief_status.*` history says (state machine: not_applicable → predicted → active → exited). */
export function gfeeReliefStatusFromEvents(events: readonly DomainEvent[]): { status: GfeeReliefStatus; reason: GfeeReliefExitReason | null; last: DomainEvent | null } {
  const evs = events.filter((e) => e.type.startsWith("gfee_relief_status.")); const last = evs[evs.length - 1] ?? null;
  if (!last) return { status: "not_applicable", reason: null, last: null };
  const status = last.type.slice("gfee_relief_status.".length);
  if (status === "exited") return { status: "exited", reason: (typeof last.payload.reason === "string" ? last.payload.reason : null) as GfeeReliefExitReason | null, last };
  return { status: status === "predicted" || status === "active" ? status : "not_applicable", reason: null, last };
}
/**
 * The loan's relief state (status, Fannie Mae start date, `outstanding_fnma_gfee_cents`, `servicer_gfee_advances_cents`,
 * exit reason) replayed from its history: `gfee_relief_status.predicted` (the servicer's pre-relief g-fee advances),
 * `.active` (Fannie Mae's start date and the forgone fees), `gfee.recovery.matched` (the balances after each matched
 * recovery / retention), `.exited`. This — never a caller-supplied state — is what every 5.5 guardrail reads.
 */
export function gfeeReliefFromEvents(events: readonly DomainEvent[]): GfeeReliefState {
  const st: GfeeReliefState = { status: "not_applicable", fnma_start_date: null, outstanding_fnma_gfee_cents: 0n, servicer_gfee_advances_cents: 0n, exit_reason: null };
  for (const e of events) {
    const p = e.payload;
    if (e.type === "gfee_relief_status.predicted") { st.status = "predicted"; st.exit_reason = null; st.servicer_gfee_advances_cents = centsOf(p.servicer_gfee_advances_cents, st.servicer_gfee_advances_cents); }
    else if (e.type === "gfee_relief_status.active") { st.status = "active"; st.exit_reason = null; st.fnma_start_date = isoDate(p.fnma_start_date) ? p.fnma_start_date : st.fnma_start_date; st.outstanding_fnma_gfee_cents = centsOf(p.outstanding_fnma_gfee_cents, st.outstanding_fnma_gfee_cents); st.servicer_gfee_advances_cents = centsOf(p.servicer_gfee_advances_cents, st.servicer_gfee_advances_cents); }
    else if (e.type === "gfee_relief_status.exited") { st.status = "exited"; st.exit_reason = (typeof p.reason === "string" ? p.reason : null) as GfeeReliefExitReason | null; }
    else if (e.type === "gfee.recovery.matched") { st.outstanding_fnma_gfee_cents = centsOf(p.outstanding_fnma_gfee_after_cents, st.outstanding_fnma_gfee_cents); st.servicer_gfee_advances_cents = centsOf(p.servicer_gfee_advances_after_cents, st.servicer_gfee_advances_cents); }
  }
  return st;
}
const reliefOf = (em: Emitter, loanId: string): GfeeReliefState => gfeeReliefFromEvents(em.events.byLoan(loanId));

// ───── period clocks: the bill (CD5) and the draft (CD7) ─────
export interface GfeeBillLineRow { readonly fnma_loan_number: string; readonly loan_id: string | null; readonly amount_cents: Cents; }
export interface GfeeBillRow {
  readonly notification_id: string; readonly draft_type: "mbs_gfee"; readonly kind: "gfee"; readonly initiator: "fnma"; readonly source: "api" | "connect_report";
  readonly servicer_number: string; readonly period: string; readonly draft_date: PlainDate; readonly bill_due_on: PlainDate; readonly funding_gate_at: string;
  readonly amount_cents: Cents; readonly lines: readonly GfeeBillLineRow[]; readonly zero_lines: readonly string[]; readonly document_id: string | null; readonly subject: Subject;
}
/** The inbound bill validated (Loan-Level Draft Notifications API or the `fnma_portal_operator`'s Connect pull): 9-digit servicer number, YYYY-MM activity period, at least one loan line, no negative amounts. */
export function validateGfeeBill(r: { servicer_number: string; period: string; lines: readonly { fnma_loan_number: string; loan_id?: string | null; amount_cents: Cents }[]; source?: string | null; document_id?: string | null; notification_id?: string | null }): Omit<GfeeBillRow, "subject"> {
  if (!SERVICER.test(r.servicer_number)) throw new RangeError("servicer_number (9 digits) is required");
  const period = asPeriod(r.period);
  if (!r.lines.length) throw new RangeError("the g-fee bill has no loan lines");
  const lines: GfeeBillLineRow[] = r.lines.map((l, n) => {
    if (typeof l.fnma_loan_number !== "string" || !/^\d{1,10}$/.test(l.fnma_loan_number)) throw new RangeError(`g-fee bill: lines[${n}].fnma_loan_number`);
    if (typeof l.amount_cents !== "bigint") throw new RangeError(`g-fee bill: lines[${n}].amount_cents must be cents`);
    if (l.amount_cents < 0n) throw new RangeError(`g-fee bill: lines[${n}].amount_cents cannot be negative`);
    return { fnma_loan_number: l.fnma_loan_number, loan_id: typeof l.loan_id === "string" && l.loan_id ? l.loan_id : null, amount_cents: l.amount_cents };
  });
  const source = r.source === "connect_report" ? "connect_report" : "api";
  const next = nextMonth(periodStart(period)); const draft = calendarDraftDate(next, 7);
  return { notification_id: r.notification_id && r.notification_id !== "" ? r.notification_id : `gfee-${r.servicer_number}-${period}`, draft_type: "mbs_gfee", kind: "gfee", initiator: "fnma", source, servicer_number: r.servicer_number, period, draft_date: draft, bill_due_on: calendarDraftDate(next, 5), funding_gate_at: toIso(fundingGateMs(draft)),
    amount_cents: lines.reduce((a, l) => a + l.amount_cents, 0n), lines, zero_lines: lines.filter((l) => l.amount_cents === 0n).map((l) => l.fnma_loan_number), document_id: r.document_id ?? null };
}
/** "Bill parsed into `draft_notifications`" (timer table): `gfee.bill.parsed{draft_type=mbs_gfee}` on the period — satisfies FNMA_F120_GFEE_BILL_RETRIEVE_CD5 and arms FNMA_F120_GFEE_RELIEF_RECONCILE_BILL. */
export function parseGfeeBill(em: Emitter, r: Parameters<typeof validateGfeeBill>[0]): GfeeBillRow {
  const bill = validateGfeeBill(r); const subject = gfeePeriodSubject(bill.servicer_number, bill.period);
  em.events.append({ type: "gfee.bill.parsed", aggregate: subject, actor: em.actor, payload: { draft_type: "mbs_gfee", notification_id: bill.notification_id, period: bill.period, servicer_number: bill.servicer_number, source: bill.source, draft_date: bill.draft_date, bill_due_on: bill.bill_due_on, funding_gate_at: bill.funding_gate_at, lines: bill.lines.length, total_cents: bill.amount_cents, zero_lines: [...bill.zero_lines], document_id: bill.document_id, parsed_at: em.now } });
  return { ...bill, subject };
}
export interface FundGfeeDraftInput { readonly servicer_number: string; readonly period?: string | null; readonly draft_date: PlainDate; readonly expected_draft_cents: Cents; readonly custodial_available_cents: Cents; readonly facility_available_cents: Cents; readonly custodial_account_id?: string | null; readonly loan_id?: string | null; readonly at_ms: number; }
/** Rule 2 (Outputs): the uncollected g-fee on a delinquent non-relief loan is a corporate advance — Dr `servicer_advance_receivable(gfee)` Cr corporate cash / Dr `custodial_pi_cash` Cr transfer clearing (the kernel's `advance_receivable` / `clearing_cash`). */
export function gfeeAdvanceEntrySet(i: { amount_cents: Cents; custodial_account_id: string; effective_date: PlainDate; period: string }): EntrySetInput {
  const ref = "5.5 rule 2 advance (gfee)"; const memo = `gfee advance ${i.period}`;
  return { effectiveDate: i.effective_date, description: `corporate advance of the guaranty fee to ${i.custodial_account_id} for the CD7 draft (${i.period})`, lines: [
    { account: { scope: "corporate", account: "advance_receivable" }, amountCents: i.amount_cents, ruleRef: ref, memo: `servicer_advance_receivable(gfee): ${memo}` },
    { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -i.amount_cents, ruleRef: ref, memo },
    { account: { scope: "custodial", custodialAccountId: i.custodial_account_id, account: "custodial_pi_cash" }, amountCents: i.amount_cents, ruleRef: ref, memo },
    { account: { scope: "custodial", custodialAccountId: i.custodial_account_id, account: "clearing_cash" }, amountCents: -i.amount_cents, ruleRef: ref, memo: `transfer clearing: ${memo}` },
  ] };
}
/**
 * The CD7 g-fee draft funded through the T−1 16:00 ET funding check (F-1-20: fees "available to Fannie Mae on the seventh
 * calendar day of the month, or on the preceding business day"): `custodial.funding.verified{covered}` and, when funded,
 * `remittances.funded{kind=gfee, initiator=fnma}` on the period — the satisfaction of FNMA_F120_GFEE_DRAFT_CD7.
 */
export function fundGfeeDraft(em: Emitter, i: FundGfeeDraftInput): { advance: AdvanceTransfer; status: AdvanceTransfer["status"]; entry_set: EntrySetInput | null; funded_at: string | null; period: string; draft_date: PlainDate; subject: Subject } {
  if (!SERVICER.test(i.servicer_number)) throw new RangeError("servicer_number (9 digits) is required");
  if (!isoDate(i.draft_date)) throw new RangeError("draft_date must be YYYY-MM-DD");
  if (i.expected_draft_cents < 0n) throw new RangeError("expected draft cannot be negative");
  const period = i.period ? asPeriod(i.period) : periodOf(addMonths(i.draft_date, -1));   // the CD7 draft settles the prior month's activity
  const a = advanceTransfer({ expected_draft_cents: i.expected_draft_cents, custodial_available_cents: i.custodial_available_cents, facility_available_cents: i.facility_available_cents, at_ms: i.at_ms, draft_date: i.draft_date });
  if (a.status === "funded" && a.amount_cents > 0n && !i.custodial_account_id) throw new RangeError("custodial_account_id is required to fund the g-fee advance");
  const subject = gfeePeriodSubject(i.servicer_number, period); const loan = i.loan_id ? { loanId: i.loan_id } : {};
  const set = a.status === "funded" && a.amount_cents > 0n ? gfeeAdvanceEntrySet({ amount_cents: a.amount_cents, custodial_account_id: i.custodial_account_id!, effective_date: etDate(i.at_ms), period }) : null;
  const fundedAt = a.funded_at_ms !== null ? toIso(a.funded_at_ms) : null;
  const base = { period, servicer_number: i.servicer_number, remittance_type: "ss", cycle: "standard", kind: "gfee", draft_type: "mbs_gfee", draft_date: i.draft_date, expected_cents: i.expected_draft_cents, available_cents: i.custodial_available_cents, advance_cents: a.amount_cents, custodial_account_id: i.custodial_account_id ?? null, dual_control: a.dual_control };
  em.events.append({ type: "custodial.funding.verified", ...loan, aggregate: subject, actor: em.actor, payload: { ...base, covered: a.status === "funded", verified_at: toIso(i.at_ms), funded_by_at: toIso(a.funded_by_ms), escalation: a.escalation } });
  if (a.status === "funded") em.events.append({ type: "remittances.funded", ...loan, aggregate: subject, actor: em.actor, payload: { ...base, funded_at: fundedAt, initiator: "fnma" } });
  return { advance: a, status: a.status, entry_set: set, funded_at: fundedAt, period, draft_date: i.draft_date, subject };
}

// ───── rule 3: relief entry — predicted at period end, authoritative from the bill ─────
export interface GfeeReliefFacts { readonly loan_id: string; readonly lpi: PlainDate; readonly period_end: PlainDate; readonly type: RemittanceType; readonly option: "special" | "regular"; readonly sda_status: SdaStatus; readonly bill_line_cents: Cents; readonly servicer_gfee_advances_cents?: Cents; }
/**
 * Period-end prediction with the same consecutive-month logic as 5.4 (rule 3): `gfee_relief_status.predicted` is set once
 * for an S/S MBS loan at four or more consecutive months (idempotent against the loan's history — never re-set on a
 * predicted/active loan), and `gfee_relief.reconciled{gfee_relief_status, consistent, expected_divergence}` records the
 * reconciliation (the special-servicing consistency assertion against `sda_status`, T2; the regular-option documented
 * divergence, T5). Bill-vs-prediction: the loan's expected bill line is zero once in relief.
 */
export function predictGfeeRelief(em: Emitter, f: GfeeReliefFacts): ReturnType<typeof gfeeReliefPrediction> & { period: string; predicted_set: boolean } {
  if (!isoDate(f.lpi) || !isoDate(f.period_end)) throw new RangeError("lpi and period_end must be YYYY-MM-DD");
  const r = gfeeReliefPrediction({ lpi: f.lpi, period_end: f.period_end, type: f.type, option: f.option, sda_status: f.sda_status, bill_line_cents: f.bill_line_cents });
  const period = periodOf(f.period_end); const prior = reliefOf(em, f.loan_id).status;
  const set = r.gfee_relief_status === "predicted" && !inRelief(prior);
  if (set) em.events.append({ type: "gfee_relief_status.predicted", loanId: f.loan_id, actor: em.actor, payload: { period, period_end: f.period_end, lpi: f.lpi, months_delinquent: r.months_delinquent, remittance_type: f.type, servicing_option: f.option, sda_status: f.sda_status, bill_expected_cents: 0n, servicer_gfee_advances_cents: f.servicer_gfee_advances_cents ?? 0n, predicted_at: em.now } });
  em.events.append({ type: "gfee_relief.reconciled", loanId: f.loan_id, actor: em.actor, payload: { period, source: "period_end", gfee_relief_status: r.gfee_relief_status, months_delinquent: r.months_delinquent, bill_expected_cents: r.bill_expected_cents, bill_line_cents: f.bill_line_cents, consistent: r.consistent, expected_divergence: r.expected_divergence, alert: r.alert, assertion: r.assertion, reconciled_at: em.now } });
  return { ...r, period, predicted_set: set };
}
/** "Authoritative when the bill omits/zeros the loan": a predicted loan whose bill line is zero (or absent) is `active` from Fannie Mae's bill — `gfee_relief_status.active{fnma_start_date}` with the forgone fees and the servicer's pre-relief advances. */
export function activateGfeeRelief(em: Emitter, i: { loan_id: string; period: string; bill_line_cents: Cents | null; fnma_start_date: PlainDate; outstanding_fnma_gfee_cents?: Cents; servicer_gfee_advances_cents?: Cents }): { status: "active"; fnma_start_date: PlainDate; period: string; outstanding_fnma_gfee_cents: Cents; servicer_gfee_advances_cents: Cents } {
  const st = reliefOf(em, i.loan_id);
  if (!inRelief(st.status)) throw new RangeError(`loan ${i.loan_id} is not predicted for Guaranty Fee Relief (status ${st.status})`);
  if (i.bill_line_cents !== null && i.bill_line_cents !== 0n) throw new RangeError(`the bill shows ${i.bill_line_cents} cents for loan ${i.loan_id}: relief is only authoritative when the bill omits or zeros the loan`);
  if (!isoDate(i.fnma_start_date)) throw new RangeError("fnma_start_date must be YYYY-MM-DD");
  const outstanding = i.outstanding_fnma_gfee_cents ?? st.outstanding_fnma_gfee_cents, advances = i.servicer_gfee_advances_cents ?? st.servicer_gfee_advances_cents;
  if (outstanding < 0n || advances < 0n) throw new RangeError("relief balances cannot be negative");
  em.events.append({ type: "gfee_relief_status.active", loanId: i.loan_id, actor: em.actor, payload: { period: asPeriod(i.period), fnma_start_date: i.fnma_start_date, bill_line_cents: i.bill_line_cents, outstanding_fnma_gfee_cents: outstanding, servicer_gfee_advances_cents: advances, entered_from: st.status, source: "gfee_bill", activated_at: em.now } });
  return { status: "active", fnma_start_date: i.fnma_start_date, period: asPeriod(i.period), outstanding_fnma_gfee_cents: outstanding, servicer_gfee_advances_cents: advances };
}
export interface ReliefBillLine { readonly loan_id: string; readonly gfee_relief_status: GfeeReliefStatus; readonly fnma_loan_number: string | null; readonly bill_line_cents: Cents; readonly expected_cents: 0n; readonly consistent: boolean; readonly reason: "relief_confirmed" | "recovery_draft" | "reappeared_without_contractual_payment"; }
/**
 * Timer table: "every predicted/active relief loan reconciled to the bill" (same BD as the parse). The relief loans are
 * the loans whose history says predicted/active; each is looked up on the parsed bill by loan id: omitted or zero →
 * relief confirmed (`consistent`); a non-zero line is the rule-4 recovery draft when a contractual payment was reported
 * on the loan (`gfee.recovery.expected` still within its two cycles) — otherwise the loan "reappears on the bill without
 * a contractual payment" (Agents paragraph → `officer`) and the bill is not reconciled. One `gfee_relief.reconciled` per
 * loan, then `gfee_relief.bill_reconciled{all_reconciled}` on the period (the satisfaction when true).
 */
export function reconcileReliefToBill(em: Emitter, bill: GfeeBillRow): { period: string; notification_id: string; all_reconciled: boolean; officer: boolean; relief_loans: ReliefBillLine[]; variances: string[]; subject: Subject } {
  const subject = gfeePeriodSubject(bill.servicer_number, bill.period);
  const ids = new Set<string>();
  for (const t of ["gfee_relief_status.predicted", "gfee_relief_status.active"]) for (const e of em.events.ofType(t)) if (e.loanId) ids.add(e.loanId);
  const relief: ReliefBillLine[] = [];
  for (const loanId of [...ids].sort()) {
    const history = em.events.byLoan(loanId); const st = gfeeReliefFromEvents(history);
    if (!inRelief(st.status)) continue;
    const line = bill.lines.find((l) => l.loan_id === loanId); const billed = line?.amount_cents ?? 0n;
    const recoveryExpected = history.some((e) => e.type === "gfee.recovery.expected" && isoDate(e.payload.match_by) && e.payload.match_by >= bill.draft_date);
    const reason: ReliefBillLine["reason"] = billed === 0n ? "relief_confirmed" : recoveryExpected ? "recovery_draft" : "reappeared_without_contractual_payment";
    const row: ReliefBillLine = { loan_id: loanId, gfee_relief_status: st.status, fnma_loan_number: line?.fnma_loan_number ?? null, bill_line_cents: billed, expected_cents: 0n, consistent: reason !== "reappeared_without_contractual_payment", reason };
    relief.push(row);
    em.events.append({ type: "gfee_relief.reconciled", loanId, aggregate: subject, actor: em.actor, payload: { period: bill.period, source: "gfee_bill", notification_id: bill.notification_id, gfee_relief_status: st.status, bill_line_cents: billed, bill_expected_cents: 0n, consistent: row.consistent, reason, outstanding_fnma_gfee_cents: st.outstanding_fnma_gfee_cents, servicer_gfee_advances_cents: st.servicer_gfee_advances_cents, reconciled_at: em.now } });
  }
  const variances = relief.filter((r) => !r.consistent).map((r) => r.loan_id); const all = variances.length === 0;
  em.events.append({ type: "gfee_relief.bill_reconciled", aggregate: subject, actor: em.actor, payload: { all_reconciled: all, period: bill.period, servicer_number: bill.servicer_number, notification_id: bill.notification_id, relief_loans: relief.length, reconciled: relief.length - variances.length, variances: [...variances], officer: !all, reconciled_at: em.now } });
  return { period: bill.period, notification_id: bill.notification_id, all_reconciled: all, officer: !all, relief_loans: relief, variances, subject };
}

// ───── rule 4: recovery on contractual payments ─────
/**
 * The accepted contractual-payment LAR on a relief loan sets the recovery expectation: for each full contractual payment
 * Fannie Mae drafts the g-fee associated with it, first against `outstanding_fnma_gfee`, then the servicer retains against
 * `servicer_gfee_advances` (rule 4). The loan must be predicted/active per its history and the LAR must be 5.1's
 * `investor_events.accepted{event_type=payment.contractual}` row on the loan (src/domain/investor/ops-5-1.ts `acceptEvent`).
 * `gfee.recovery.expected{gfee_relief_active=true, contractual=true, accepted_on}` arms SM_GFEE_RECOVERY_MATCH_2_CYCLES on
 * the acceptance date (two CD7 bill cycles).
 */
export function expectGfeeRecovery(em: Emitter, i: { loan_id: string; event_id: string; payment_gfees_cents: readonly Cents[] }): { accepted_on: PlainDate; event_id: string; activity_period: string; fnma_recovery_expected_cents: Cents; servicer_retention_expected_cents: Cents; match_by: PlainDate; lines: ReturnType<typeof gfeeRecovery>["lines"] } {
  const history = em.events.byLoan(i.loan_id); const st = gfeeReliefFromEvents(history);
  if (!inRelief(st.status)) throw new RangeError(`loan ${i.loan_id} is not in the Guaranty Fee Relief process (status ${st.status})`);
  if (!i.event_id) throw new RangeError("event_id (the accepted contractual-payment LAR) is required");
  const accepted = history.filter((e) => e.type === "investor_events.accepted" && e.payload.event_id === i.event_id).pop();
  if (!accepted) throw new RangeError(`no investor_events.accepted row for event ${i.event_id} on loan ${i.loan_id}`);
  if (accepted.payload.event_type !== "payment.contractual") throw new RangeError(`accepted event ${i.event_id} is ${String(accepted.payload.event_type)}, not payment.contractual`);
  if (typeof accepted.payload.status !== "string" || !accepted.payload.status.startsWith("accepted")) throw new RangeError(`event ${i.event_id} is ${String(accepted.payload.status)}, not accepted`);
  if (!i.payment_gfees_cents.length) throw new RangeError("the g-fee component of each contractual payment is required");
  for (const g of i.payment_gfees_cents) if (g <= 0n) throw new RangeError("each contractual payment's g-fee must be positive");
  const acceptedAt = typeof accepted.payload.accepted_at === "string" ? accepted.payload.accepted_at : accepted.occurredAt;
  const ms = Date.parse(acceptedAt); if (Number.isNaN(ms)) throw new RangeError("accepted_at is not an instant");
  const activityPeriod = typeof accepted.payload.activity_period === "string" ? asPeriod(accepted.payload.activity_period) : periodOf(etDate(ms));
  const r = gfeeRecovery({ outstanding_fnma_gfee_cents: st.outstanding_fnma_gfee_cents, servicer_gfee_advances_cents: st.servicer_gfee_advances_cents, payment_gfees_cents: i.payment_gfees_cents });
  const acceptedOn = etDate(ms); const matchBy = gfeeTwoCyclesFrom(acceptedOn);
  em.events.append({ type: "gfee.recovery.expected", loanId: i.loan_id, actor: em.actor, causationId: accepted.id, payload: { gfee_relief_active: true, contractual: true, event_id: i.event_id, event_type: "payment.contractual", activity_period: activityPeriod, accepted_at: acceptedAt, accepted_on: acceptedOn, payments: i.payment_gfees_cents.length, payment_gfees_cents: [...i.payment_gfees_cents], fnma_recovery_expected_cents: r.bill_draft_cents, servicer_retention_expected_cents: r.servicer_retention_cents, outstanding_fnma_gfee_cents: st.outstanding_fnma_gfee_cents, servicer_gfee_advances_cents: st.servicer_gfee_advances_cents, order: ["fnma_recovery", "servicer_retention"], match_by: matchBy } });
  return { accepted_on: acceptedOn, event_id: i.event_id, activity_period: activityPeriod, fnma_recovery_expected_cents: r.bill_draft_cents, servicer_retention_expected_cents: r.servicer_retention_cents, match_by: matchBy, lines: r.lines };
}
export interface GfeeRecoveryMatch { readonly kind: "fnma_recovery" | "servicer_retention"; readonly amount_cents: Cents; readonly outstanding_fnma_gfee_after_cents: Cents; readonly servicer_gfee_advances_after_cents: Cents; readonly ledger: readonly { account: string; side: "Dr" | "Cr"; amount_cents: Cents }[]; }
/**
 * Rule 4 / Outputs, balanced per scope (ARCHITECTURE: balanced ledger sets with `rule_ref`): Fannie Mae's recovery draft
 * leaves the custodial account (Dr `gfee_payable` Cr `custodial_pi_cash` — the kernel's clearing / custodial P&I cash);
 * the servicer's retention moves the g-fee component to corporate and posts Cr `servicer_advance_receivable(gfee)`
 * (the kernel's corporate `advance_receivable`).
 */
export function gfeeRecoveryEntrySets(i: { loan_id: string; matches: readonly GfeeRecoveryMatch[]; custodial_account_id: string; effective_date: PlainDate }): EntrySetInput[] {
  const out: EntrySetInput[] = [];
  for (const m of i.matches) {
    if (m.amount_cents <= 0n) continue;
    const custodial = (account: "clearing_cash" | "custodial_pi_cash") => ({ scope: "custodial" as const, custodialAccountId: i.custodial_account_id, account });
    if (m.kind === "fnma_recovery") out.push({ effectiveDate: i.effective_date, description: `Fannie Mae guaranty-fee recovery draft on ${i.loan_id} (Dr gfee_payable Cr custodial_pi_cash)`, lines: [
      { account: custodial("clearing_cash"), amountCents: m.amount_cents, ruleRef: "5.5 rule 4 fnma_recovery", memo: `gfee_payable settled by Fannie Mae's draft: ${i.loan_id}` },
      { account: custodial("custodial_pi_cash"), amountCents: -m.amount_cents, ruleRef: "5.5 rule 4 fnma_recovery", memo: `g-fee recovery draft: ${i.loan_id}` }] });
    else out.push({ effectiveDate: i.effective_date, description: `servicer retention of the guaranty fee on ${i.loan_id} against servicer g-fee advances (Cr servicer_advance_receivable(gfee))`, lines: [
      { account: custodial("clearing_cash"), amountCents: m.amount_cents, ruleRef: "5.5 rule 4 servicer_retention", memo: `g-fee component retained: ${i.loan_id}` },
      { account: custodial("custodial_pi_cash"), amountCents: -m.amount_cents, ruleRef: "5.5 rule 4 servicer_retention", memo: `g-fee component retained: ${i.loan_id}` },
      { account: { scope: "corporate", account: "corporate_cash" }, amountCents: m.amount_cents, ruleRef: "5.5 rule 4 servicer_retention", memo: `g-fee retention received: ${i.loan_id}` },
      { account: { scope: "corporate", account: "advance_receivable" }, amountCents: -m.amount_cents, ruleRef: "5.5 rule 4 servicer_retention", memo: `servicer_advance_receivable(gfee) recovered: ${i.loan_id}` }] });
  }
  return out;
}
/**
 * The bill's recovery draft against the loan's relief balances (from its history): the custodial debit must equal the
 * bill draft (the FIFO Fannie Mae recovery); the servicer's retention credit is what remains of each payment's g-fee once
 * Fannie Mae is whole. One `gfee.recovery.matched{kind}` per non-zero component (`fnma_recovery` first, then
 * `servicer_retention`) carrying the balances after; the balanced entry sets are returned for the tool to post. An
 * unmatched debit emits nothing (the variance is the caller's).
 */
export function matchGfeeRecoveryDebit(em: Emitter, i: { loan_id: string; debit_cents: Cents; payment_gfees_cents: readonly Cents[]; custodial_account_id: string; debit_id?: string | null; settled_on?: PlainDate | null }): ReturnType<typeof gfeeRecovery> & { debit_cents: Cents; matched: boolean; matches: GfeeRecoveryMatch[]; entry_sets: EntrySetInput[]; ledger_rule: string; outstanding_fnma_gfee_after_cents: Cents; servicer_gfee_advances_after_cents: Cents } {
  if (i.debit_cents < 0n) throw new RangeError("debit_cents cannot be negative");
  if (!i.custodial_account_id) throw new RangeError("custodial_account_id is required");
  const st = reliefOf(em, i.loan_id);
  if (!inRelief(st.status)) throw new RangeError(`loan ${i.loan_id} is not in the Guaranty Fee Relief process (status ${st.status})`);
  const r = gfeeRecovery({ outstanding_fnma_gfee_cents: st.outstanding_fnma_gfee_cents, servicer_gfee_advances_cents: st.servicer_gfee_advances_cents, payment_gfees_cents: i.payment_gfees_cents });
  const matched = r.bill_draft_cents === i.debit_cents;
  const matches: GfeeRecoveryMatch[] = [];
  if (matched) {
    if (r.bill_draft_cents > 0n) matches.push({ kind: "fnma_recovery", amount_cents: r.bill_draft_cents, outstanding_fnma_gfee_after_cents: r.remaining_fnma_cents, servicer_gfee_advances_after_cents: r.remaining_servicer_advances_cents, ledger: [{ account: "gfee_payable", side: "Dr", amount_cents: r.bill_draft_cents }, { account: "custodial_pi_cash", side: "Cr", amount_cents: r.bill_draft_cents }] });
    if (r.servicer_retention_cents > 0n) matches.push({ kind: "servicer_retention", amount_cents: r.servicer_retention_cents, outstanding_fnma_gfee_after_cents: r.remaining_fnma_cents, servicer_gfee_advances_after_cents: r.remaining_servicer_advances_cents, ledger: [{ account: "custodial_pi_cash", side: "Dr", amount_cents: r.servicer_retention_cents }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: r.servicer_retention_cents }] });
    if (!matches.length) matches.push({ kind: "servicer_retention", amount_cents: 0n, outstanding_fnma_gfee_after_cents: r.remaining_fnma_cents, servicer_gfee_advances_after_cents: r.remaining_servicer_advances_cents, ledger: [] });
    for (const m of matches) em.events.append({ type: "gfee.recovery.matched", loanId: i.loan_id, actor: em.actor, payload: { kind: m.kind, amount_cents: m.amount_cents, debit_cents: i.debit_cents, bill_draft_cents: r.bill_draft_cents, servicer_retention_cents: r.servicer_retention_cents, outstanding_fnma_gfee_after_cents: m.outstanding_fnma_gfee_after_cents, servicer_gfee_advances_after_cents: m.servicer_gfee_advances_after_cents, custodial_account_id: i.custodial_account_id, debit_id: i.debit_id ?? null, settled_on: i.settled_on ?? null, ledger_rule: "Cr servicer_advance_receivable(gfee)", matched_at: em.now } });
  }
  const effective = i.settled_on ?? etDate(Date.parse(em.now));
  const sets = matched ? gfeeRecoveryEntrySets({ loan_id: i.loan_id, matches, custodial_account_id: i.custodial_account_id, effective_date: effective }) : [];
  return { ...r, debit_cents: i.debit_cents, matched, matches, entry_sets: sets, ledger_rule: "Cr servicer_advance_receivable(gfee)", outstanding_fnma_gfee_after_cents: matched ? r.remaining_fnma_cents : st.outstanding_fnma_gfee_cents, servicer_gfee_advances_after_cents: matched ? r.remaining_servicer_advances_cents : st.servicer_gfee_advances_cents };
}

// ───── rule 5: exits ─────
export interface GfeeReliefExit { readonly reason: GfeeReliefExitReason; readonly exited_on: PlainDate; readonly became_current_on: PlainDate | null; readonly period_end: PlainDate; readonly resume_draft_on: PlainDate | null; readonly funding_gate_at: string | null; readonly expected: "gfee_drafting_resumes" | "ptr_adjusted_to_include_gfee" | "no_further_gfee"; readonly outstanding_fnma_gfee_cents: Cents; readonly servicer_gfee_advances_cents: Cents; readonly claim_servicer_gfee_advances: boolean; }
/** The platform's current-ness fact on the loan: the latest `loan.became_current{became_current_on}` (the cure the subsequent review found — src/domain/pmi/ops-10-2.ts). */
export function becameCurrentOn(events: readonly DomainEvent[]): PlainDate | null {
  const e = events.filter((x) => x.type === "loan.became_current").pop();
  if (!e) return null;
  const on = isoDate(e.payload.became_current_on) ? e.payload.became_current_on : isoDate(e.payload.cure_date) ? e.payload.cure_date : etDate(Date.parse(e.occurredAt));
  return on;
}
/**
 * F-1-20 exits: `gfee_relief_status.exited{reason, exited_on, period_end, resume_draft_on}` — current (the loan's
 * `loan.became_current` fact, never a caller's say-so) → "resume remitting guaranty fees … beginning with the applicable
 * draft date" (next CD7; arms FNMA_F120_GFEE_RESUME_ON_CURRENT on the period end); reclass to A/A → PTR adjusted "to
 * include guaranty fee" (F-1-25); payoff/repurchase/liquidation → "the servicer is no longer responsible for remitting
 * guaranty fees" (outstanding servicer g-fee advances on a liquidation are claimed per Section 15 — flagged, not added to
 * the payoff figure). The relief status is the loan's history.
 */
export function recordGfeeReliefExit(em: Emitter, i: { loan_id: string; reason: GfeeReliefExitReason; exited_on?: PlainDate | null }): GfeeReliefExit {
  const history = em.events.byLoan(i.loan_id); const st = gfeeReliefFromEvents(history);
  if (!inRelief(st.status)) throw new RangeError(`loan ${i.loan_id} is not in the Guaranty Fee Relief process (status ${st.status})`);
  if (!["current", "reclass", "payoff", "repurchase", "liquidation"].includes(i.reason)) throw new RangeError(`exit reason ${String(i.reason)} is not an F-1-20 exit`);
  let current: PlainDate | null = null;
  if (i.reason === "current") {
    current = becameCurrentOn(history);
    if (!current) throw new RangeError(`loan ${i.loan_id} has no loan.became_current fact: a Guaranty Fee Relief exit for "current" is recorded from the loan becoming current, not from a caller's description`);
    if (st.fnma_start_date && current < st.fnma_start_date) throw new RangeError(`loan ${i.loan_id} became current ${current}, before Fannie Mae's relief start ${st.fnma_start_date}`);
  }
  const exitedOn = i.exited_on ?? current;
  if (!isoDate(exitedOn)) throw new RangeError("exited_on must be YYYY-MM-DD");
  if (current && exitedOn < current) throw new RangeError(`exited_on ${exitedOn} precedes the date the loan became current (${current})`);
  const periodEnd = endOfMonth(exitedOn);
  const expected: GfeeReliefExit["expected"] = i.reason === "current" ? "gfee_drafting_resumes" : i.reason === "reclass" ? "ptr_adjusted_to_include_gfee" : "no_further_gfee";
  const resume = i.reason === "current" ? gfeeResumeDraftOn(periodEnd) : null;
  const gate = resume ? toIso(fundingGateMs(resume)) : null;
  const claim = i.reason === "liquidation" && st.servicer_gfee_advances_cents > 0n;
  em.events.append({ type: "gfee_relief_status.exited", loanId: i.loan_id, actor: em.actor, payload: { reason: i.reason, exited_on: exitedOn, became_current_on: current, period_end: periodEnd, resume_draft_on: resume, funding_gate_at: gate, expected, exited_from: st.status, outstanding_fnma_gfee_cents: st.outstanding_fnma_gfee_cents, servicer_gfee_advances_cents: st.servicer_gfee_advances_cents, claim_servicer_gfee_advances: claim, exited_at: em.now } });
  return { reason: i.reason, exited_on: exitedOn, became_current_on: current, period_end: periodEnd, resume_draft_on: resume, funding_gate_at: gate, expected, outstanding_fnma_gfee_cents: st.outstanding_fnma_gfee_cents, servicer_gfee_advances_cents: st.servicer_gfee_advances_cents, claim_servicer_gfee_advances: claim };
}
/** Exit (current): the loan's g-fee is back on the next CD7 bill — funded through 5.2's T−1 16:00 ET funding check (`remittances.funded{kind=gfee, remittance_type=ss}` on the loan). */
export function resumeGfeeDraft(em: Emitter, i: Omit<FundDraftInput, "remittance_type" | "kind" | "loan_id" | "cycle"> & { loan_id: string; cycle?: FundDraftInput["cycle"] }): FundDraftResult & { resumed_from: PlainDate; resume_draft_on: PlainDate } {
  const st = gfeeReliefStatusFromEvents(em.events.byLoan(i.loan_id));
  if (st.status !== "exited" || st.reason !== "current") throw new RangeError(`loan ${i.loan_id} has not exited Guaranty Fee Relief by becoming current (status ${st.status}${st.reason ? `/${st.reason}` : ""})`);
  const exitedOn = st.last && isoDate(st.last.payload.exited_on) ? st.last.payload.exited_on : etDate(Date.parse(st.last!.occurredAt));
  const resumeOn = st.last && isoDate(st.last.payload.resume_draft_on) ? st.last.payload.resume_draft_on : gfeeResumeDraftOn(endOfMonth(exitedOn));
  if (!isoDate(i.draft_date)) throw new RangeError("draft_date must be YYYY-MM-DD");
  if (i.draft_date < resumeOn) throw new RangeError(`draft date ${i.draft_date} precedes the resumed CD7 draft ${resumeOn}: g-fee drafting resumes from the month after the loan became current`);
  if (asPeriod(i.period) < periodOf(exitedOn)) throw new RangeError(`period ${i.period} precedes the exit ${exitedOn}`);
  return { ...fundDraft(em, { ...i, cycle: i.cycle ?? "standard", remittance_type: "ss", kind: "gfee", loan_id: i.loan_id }), resumed_from: exitedOn, resume_draft_on: resumeOn };
}
