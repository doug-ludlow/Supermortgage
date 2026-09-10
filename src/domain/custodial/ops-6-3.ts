/**
 * §6.3 operating rules — Monthly P&I reconciliation (Form 496). The calculators live in ./reconciliation.ts
 * (Section I/II arithmetic, matching tiers, BAI2 categories, draft variance, funding tiers, draft coverage) and
 * the pure outcomes in ./ops.ts (period-close anchor, unposted credits, unidentified debits, bank fees, statement
 * quarantine, reviewer, generator). This file is every state change the daily and monthly engines make, each
 * appended to the event store by a real act so the §6.3 timer rows arm and are satisfied for real:
 *
 *   dailyTick                    the scheduler's `schedule.tick{cadence=daily_business_servicer, at}` that arms the two
 *                                recurring rows SM_RECON_DAILY_FEED_10AM / SM_RECON_DAILY_CLOSE_5PM
 *   receiveStatement             `custodial.statement.received{all_active_accounts}` (rule 1 control totals; satisfies
 *                                the 10:00 row once every active account's prior-day file is in) or
 *                                `custodial.statement.quarantined` + `reconciliation_item.opened{control_total_mismatch}` (T10)
 *   classifyResiduals            rule 2 residuals → `reconciliation_item.opened{category, kind, first_seen_on}` per line
 *                                (arms SM_RECON_ITEM_AGE_30/60), the 6.5 `suspense.item.created` row for an unposted
 *                                credit (T4), the fraud path for an unidentified debit (T5), the bank-fee reimbursement
 *                                command (T7); an auto-posted credit clears the same day (`reconciliation_item.resolved`)
 *   closeDailyReconciliation     `custodial.reconciliation.daily_completed{status}` (17:00 row); a confirmed cash shortfall
 *                                → `reconciliation_item.opened{kind=cash_shortfall}` (arms AGE_90) and
 *                                `custodial.shortage.identified{identification}` (arms SM_CUSTODIAL_SHORTAGE_FUND_2BD, T8)
 *   openRemittancePeriod         `period.opened{remittance_type, period_start}` from the P&I `close_period` act — the
 *                                monthly schedule that arms FNMA_F120_SS/SA_FUNDS_AVAILABLE (18th / 20th, preceding Fannie BD)
 *   confirmDraftCoverage         `custodial.draft.coverage_confirmed{remittance_type}` from the intraday available balance
 *                                (satisfies the F-1-20 and LL-2026-05 coverage rows) or `custodial.draft.coverage_short` with
 *                                the auto-prepared corporate top-up (T9)
 *   ingestRemittanceDetailReport `fnma.remittance_detail.report_received{period}` — the Connect "Remittance Principal and
 *                                Interest Detail Report" that is line 9's source (satisfies SM_FNMA_CONNECT_REMIT_DETAIL_PULL_2BD)
 *   explainShortageSurplus       `fnma.shortage_surplus.explained{surplus_id}` from a documented `ledger.post_reclass`
 *                                (satisfies FNMA_IRM102_SURPLUS_UNEXPLAINED_90)
 *   draftVarianceSignViolation   rule 4 / worked example 8: a draft-variance reclass moves custodial cash in the direction
 *                                of the bank debit (bank took more → cash credited, `fnma_shortage_surplus` debited)
 *
 * Aggregates: statements, daily closes, shortages and coverage ride on the custodial account; a reconciling item is
 * its own aggregate (`reconciliation_item`) so each item's aging clocks are its own; the Fannie Mae reporting period
 * (`period`, as 5.2 spells it) carries the Remittance Detail report and the shortage/surplus schedule. bigint cents.
 */
import { type PlainDate, addDays, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { rollBack, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { type Cents, formatCents } from "../../kernel/money/cents.ts";
import type { Actor, EventInput, EventStore } from "../../kernel/events/index.ts";
import { adjustedDepository, draftCoverage, shortageFunding, matchBankLine, residualCategory, type LedgerItem, type ReconciliationCategory, type SectionI } from "./reconciliation.ts";
import { ET, ingestStatement, openBankCreditUnposted, unidentifiedDebit, bankFeeReimbursement, type PostingSet } from "./ops.ts";
import type { CandidateLoan } from "./suspense.ts";

export interface Emitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
export const ACCOUNT_AGG = (id: string): { kind: "custodial_account"; id: string } => ({ kind: "custodial_account", id });
export const ITEM_AGG = (id: string): { kind: "reconciliation_item"; id: string } => ({ kind: "reconciliation_item", id });
/** 5.2's `periodSubject`: the Fannie Mae reporting period the Remittance Detail report and Schedule 3 ride on. */
export const PERIOD_AGG = (period: string): { kind: "period"; id: string } => ({ kind: "period", id: period });
export const DAILY_RECON_JOB = "custodial-daily-recon";
export type RemittanceClass = "ss" | "sa" | "aa";
export type StatementFormat = "bai2" | "camt053" | "camt052" | "bai2_intraday";
const INTRADAY: ReadonlySet<StatementFormat> = new Set<StatementFormat>(["camt052", "bai2_intraday"]);
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const plug = (s: string): boolean => /^(plug|balancing|unexplained|)$/i.test(s.trim());

/** "S/S", "S/S MBS", "S/S MRS", "ss" → ss; "S/A" → sa; "A/A" → aa; anything else has no Fannie Mae draft schedule. */
export function remittanceClass(s: string | null | undefined): RemittanceClass | null {
  const k = String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (k.startsWith("s/s") || k === "ss" || k.startsWith("ssm")) return "ss";
  if (k === "s/a" || k === "sa") return "sa";
  if (k === "a/a" || k === "aa") return "aa";
  return null;
}

/** The scheduler's tick for each servicer business day (10:00 statement cut-off, 17:00 daily close). */
export function dailyTick(today: PlainDate, at: "10:00" | "17:00"): EventInput {
  return { type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, occurredAt: new Date(zonedEpochMs(today, at, ET)).toISOString(), payload: { cadence: "daily_business_servicer", at, tz: "servicer_local", job: DAILY_RECON_JOB, date: today } };
}

// ---- statements (rule 1) --------------------------------------------------------------------------------------------
export interface StatementInput {
  readonly custodial_account_id: string; readonly file_id: string; readonly format: StatementFormat; readonly as_of_date: PlainDate;
  readonly credit_lines: readonly Cents[]; readonly summary_credits: Cents; readonly debit_lines: readonly Cents[]; readonly summary_debits: Cents;
  readonly closing_ledger_cents?: Cents | null; readonly closing_available_cents?: Cents | null;
  /** Active P&I accounts the 10:00 row waits on (default: this account) and the ones whose file for `as_of_date` already passed control totals. */
  readonly active_account_ids?: readonly string[]; readonly received_account_ids?: readonly string[];
}
export interface StatementReceipt { readonly ok: boolean; readonly exception: "control_total_mismatch" | null; readonly quarantined: boolean; readonly bank_rerequest_logged: boolean; readonly daily_close_item: string | null; readonly event: "custodial.statement.received" | "custodial.statement.quarantined"; readonly all_active_accounts: boolean; readonly item_id: string | null; readonly balance_of_record_cents: Cents | null; readonly statement_id: string; }
/** Prior-day file: control totals must tie (Σ 16-record credits = 03/49 summary) or the file is quarantined and re-requested; a tied file is the balance of record (closing ledger 015 / CLBD). */
export function receiveStatement(em: Emitter, f: StatementInput): StatementReceipt {
  if (!f.custodial_account_id) throw new RangeError("custodial_account_id is required");
  if (!isDate(f.as_of_date)) throw new RangeError("as_of_date must be YYYY-MM-DD");
  if (!["bai2", "camt053", "camt052", "bai2_intraday"].includes(f.format)) throw new RangeError("format must be bai2, camt053, camt052 or bai2_intraday");
  const r = ingestStatement({ file_id: f.file_id, credit_lines: f.credit_lines, summary_credits: f.summary_credits, debit_lines: f.debit_lines, summary_debits: f.summary_debits });
  const statement_id = `${f.custodial_account_id}-${f.as_of_date}-${f.format}`;
  const agg = ACCOUNT_AGG(f.custodial_account_id);
  const today = em.now.slice(0, 10) as PlainDate;
  if (!r.ok) {
    const item_id = `cti-${statement_id}`;
    em.events.append({ type: "custodial.statement.quarantined", aggregate: agg, actor: em.actor, payload: { custodial_account_id: f.custodial_account_id, statement_id, file_id: f.file_id, format: f.format, as_of_date: f.as_of_date, exception: "control_total_mismatch", bank_rerequest_logged: true, item_id } });
    em.events.append({ type: "reconciliation_item.opened", aggregate: ITEM_AGG(item_id), actor: em.actor, payload: { item_id, custodial_account_id: f.custodial_account_id, category: "control_total_mismatch", kind: "statement", severity: "high", file_id: f.file_id, amount_cents: 0n, loan_id: null, root_cause: r.daily_close_item, first_seen_on: today, status: "open" } });
    return { ...r, event: "custodial.statement.quarantined", all_active_accounts: false, item_id, balance_of_record_cents: null, statement_id };
  }
  const received = new Set([...(f.received_account_ids ?? []), f.custodial_account_id]);
  const active = f.active_account_ids?.length ? f.active_account_ids : [f.custodial_account_id];
  const all_active_accounts = !INTRADAY.has(f.format) && active.every((a) => received.has(a));
  const balance = INTRADAY.has(f.format) ? null : f.closing_ledger_cents ?? null;
  em.events.append({ type: "custodial.statement.received", aggregate: agg, actor: em.actor, payload: { custodial_account_id: f.custodial_account_id, statement_id, file_id: f.file_id, format: f.format, as_of_date: f.as_of_date, control_totals_ok: true, closing_ledger_cents: f.closing_ledger_cents ?? null, closing_available_cents: f.closing_available_cents ?? null, balance_of_record: INTRADAY.has(f.format) ? null : "closing_ledger_015_CLBD", all_active_accounts, active_accounts: [...active], received_accounts: [...received] } });
  return { ...r, event: "custodial.statement.received", all_active_accounts, item_id: null, balance_of_record_cents: balance, statement_id };
}

// ---- residuals (rule 2 iv, rule 3) ---------------------------------------------------------------------------------------
export interface ResidualLine { readonly id: string; readonly type_code?: string; readonly direction: "credit" | "debit"; readonly amount_cents: Cents; readonly value_date: PlainDate; readonly memo?: string; readonly reference?: string; }
export interface OpenedItem { readonly item_id: string; readonly line_id: string; readonly category: ReconciliationCategory; readonly kind: string; readonly severity: "low" | "medium" | "high" | "critical"; readonly amount_cents: Cents; readonly loan_id: string | null; readonly root_cause: string; readonly first_seen_on: PlainDate; readonly status: "open" | "cleared"; readonly suspense_item_id: string | null; readonly fraud_case: boolean; readonly bank_contact_by: PlainDate | null; readonly funding_tier: string | null; readonly reimbursement: PostingSet | null; readonly reimburse_by: PlainDate | null; readonly commands: readonly string[]; }
export interface ResidualInput { readonly custodial_account_id: string; readonly today: PlainDate; readonly lines: readonly ResidualLine[]; readonly ledger?: readonly LedgerItem[]; readonly candidates?: readonly CandidateLoan[]; readonly draft_notification_amounts?: readonly Cents[]; readonly crs_report_amounts?: readonly Cents[]; readonly escalations?: { open(input: { kind: "fraud_officer" | "officer"; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string } }; }
export interface SuspenseRow { readonly id: string; readonly source: "bank_credit_unposted"; readonly reason_code: "unidentified_payer" | "unidentified_loan"; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly created_on: PlainDate; readonly payer_name: string | null; readonly status: string; readonly loan_id: string | null; readonly bank_statement_line_id: string; readonly custodial_account_id: string; }
/**
 * Every line the deterministic tiers (i)–(iii) leave over becomes an item with its category inferred from the type
 * code; the agent never posts without a ≥ 0.97 identification (credits) or documentary evidence on both sides.
 */
export function classifyResiduals(em: Emitter, f: ResidualInput): { items: OpenedItem[]; suspense_rows: SuspenseRow[]; matched_line_ids: string[]; escalation_ids: string[] } {
  if (!f.custodial_account_id) throw new RangeError("custodial_account_id is required");
  if (!isDate(f.today)) throw new RangeError("today must be YYYY-MM-DD");
  const items: OpenedItem[] = []; const suspense_rows: SuspenseRow[] = []; const matched: string[] = []; const escalation_ids: string[] = [];
  const ledger = f.ledger ?? [];
  const open = (o: Omit<OpenedItem, "item_id" | "status" | "suspense_item_id" | "fraud_case" | "bank_contact_by" | "funding_tier" | "reimbursement" | "reimburse_by" | "commands"> & Partial<Pick<OpenedItem, "suspense_item_id" | "fraud_case" | "bank_contact_by" | "funding_tier" | "reimbursement" | "reimburse_by" | "commands">>, extra: Record<string, unknown> = {}): OpenedItem => {
    const item_id = `ri-${f.custodial_account_id}-${o.line_id}`;
    const it: OpenedItem = { item_id, status: "open", suspense_item_id: null, fraud_case: false, bank_contact_by: null, funding_tier: null, reimbursement: null, reimburse_by: null, commands: [], ...o };
    em.events.append({ type: "reconciliation_item.opened", aggregate: ITEM_AGG(item_id), actor: em.actor, payload: { item_id, custodial_account_id: f.custodial_account_id, line_id: o.line_id, category: o.category, kind: o.kind, severity: o.severity, amount_cents: o.amount_cents, loan_id: o.loan_id, root_cause: o.root_cause, first_seen_on: o.first_seen_on, status: "open", ...extra } });
    items.push(it); return it;
  };
  for (const line of f.lines) {
    if (line.amount_cents <= 0n) throw new RangeError(`line ${line.id}: amount_cents must be positive (direction carries the sign)`);
    const category = residualCategory(line.type_code, line.direction);
    if (line.direction === "credit") {
      const r = openBankCreditUnposted({ line: { id: line.id, amount_cents: line.amount_cents, value_date: line.value_date, ...(line.type_code ? { type_code: line.type_code } : {}), ...(line.memo ? { memo: line.memo } : {}), ...(line.reference ? { reference: line.reference } : {}) }, ledger, today: f.today, custodial_account_id: f.custodial_account_id, ...(f.candidates ? { candidates: f.candidates } : {}) });
      if (r.matched) { matched.push(line.id); continue; }
      const s = r.suspense_item!; const suspense_id = `susp-${line.id}`;
      const row: SuspenseRow = { id: suspense_id, ...s, custodial_account_id: f.custodial_account_id };
      suspense_rows.push(row);
      // 6.5's register row, the same day (its reason_code arms SM_UNIDENTIFIED_RESEARCH_30 / SM_SUSPENSE_TRIAGE_1BD there)
      em.events.append({ type: "suspense.item.created", ...(s.loan_id ? { loanId: s.loan_id } : {}), aggregate: { kind: "suspense_item", id: suspense_id }, actor: em.actor, payload: { id: suspense_id, status: s.status, reason_code: s.reason_code, source: s.source, amount_cents: s.amount_cents, received_on: s.received_on, loan_id: s.loan_id, custodial_account_id: f.custodial_account_id, bank_statement_line_id: line.id } });
      const it = open({ line_id: line.id, category: r.item!.category, kind: "residual_credit", severity: "medium", amount_cents: line.amount_cents, loan_id: r.item!.loan_id, root_cause: r.item!.root_cause, first_seen_on: r.item!.first_seen_on, suspense_item_id: suspense_id }, { identification_score: r.identification?.scores[0]?.score ?? null, auto_post: r.auto_post });
      if (r.auto_post) { em.events.append({ type: "reconciliation_item.resolved", aggregate: ITEM_AGG(it.item_id), actor: em.actor, payload: { item_id: it.item_id, status: "cleared", loan_id: r.item!.loan_id, root_cause: r.item!.root_cause, resolved_on: f.today } }); items[items.length - 1] = { ...it, status: "cleared" }; }
      continue;
    }
    const m = matchBankLine({ id: line.id, amount_cents: line.amount_cents, value_date: line.value_date, ...(line.reference ? { reference: line.reference } : {}), ...(line.type_code ? { type_code: line.type_code } : {}) }, ledger);
    if (m.tier !== "unmatched") { matched.push(line.id); continue; }
    if (category === "bank_fee") {
      const b = bankFeeReimbursement({ fee_cents: line.amount_cents, debited_on: line.value_date, custodial_account_id: f.custodial_account_id, account_kind: "pi", reimbursed_on: null });
      open({ line_id: line.id, category: "bank_fee", kind: "bank_fee", severity: "low", amount_cents: b.item.amount_cents, loan_id: null, root_cause: b.item.root_cause, first_seen_on: b.item.first_seen_on, reimbursement: b.reimbursement, reimburse_by: b.reimburse_by, commands: ["6.3 ledger.post_reclass (corporate reimburses ≤ 1 BD; re-bill corporate ops)"] }, { reimburse_by: b.reimburse_by });
      continue;
    }
    if (category === "bank_debit_unposted") {
      const inDn = (f.draft_notification_amounts ?? []).includes(line.amount_cents), inCrs = (f.crs_report_amounts ?? []).includes(line.amount_cents);
      const d = unidentifiedDebit({ amount_cents: line.amount_cents, type_code: line.type_code ?? "", in_draft_notifications: inDn, in_crs_reports: inCrs, identified_on: f.today });
      if (d.severity === "critical") {
        const it = open({ line_id: line.id, category: "bank_debit_unposted", kind: "unidentified_debit", severity: "critical", amount_cents: -line.amount_cents, loan_id: null, root_cause: `unidentified ${d.instrument} debit (BAI2 ${line.type_code ?? "?"}) absent from Draft Notifications and CRS reports — suspected unauthorized debit`, first_seen_on: line.value_date, fraud_case: true, bank_contact_by: d.bank_contact_by, funding_tier: d.funding!.tier, commands: ["18.5 fraud case", "bank claim (same day)", `corporate funding tier ${d.funding!.tier} by ${d.funding!.due_on}`] }, { fraud_case: true, bank_contact_by: d.bank_contact_by, funding_tier: d.funding!.tier, fund_by: d.funding!.due_on, escalation: "officer" });
        // T5: the `fraud` case (18.5, bank claim the same day) and the `officer` escalation that evaluates the funding tier
        if (f.escalations) { const payload = { item_id: it.item_id, custodial_account_id: f.custodial_account_id, amount_cents: line.amount_cents, type_code: line.type_code ?? null, bank_contact_by: d.bank_contact_by, funding_tier: d.funding!.tier, fund_by: d.funding!.due_on, fraud_case: true, partner_notice: d.funding!.tier === "officer_partner_fraud" };
          escalation_ids.push(f.escalations.open({ kind: "fraud_officer", severity: "critical", payload }, em.actor).id, f.escalations.open({ kind: "officer", severity: "critical", payload: { ...payload, decision: "funding tier + bank claim + partner notice" } }, em.actor).id); }
      } else open({ line_id: line.id, category: "draft_variance", kind: "draft_debit", severity: "medium", amount_cents: -line.amount_cents, loan_id: null, root_cause: `Fannie Mae draft per ${inDn ? "Draft Notifications" : "CRS Draft Request Report"} not yet matched to the expected draft (rule 4)`, first_seen_on: line.value_date, commands: ["6.3 rule 4 draft variance against LSDU adjustments"] });
      continue;
    }
    open({ line_id: line.id, category, kind: category === "returned_item" ? "returned_item" : "residual_debit", severity: category === "returned_item" ? "high" : "medium", amount_cents: -line.amount_cents, loan_id: null, root_cause: category === "returned_item" ? `deposited item returned (BAI2 ${line.type_code ?? "555"}) — payment reversal the same day, draft coverage re-run` : `unmatched debit (BAI2 ${line.type_code ?? "?"})`, first_seen_on: line.value_date, commands: category === "returned_item" ? ["2.1 payment.reverse (same day)", "6.3 draft coverage re-run"] : [] });
  }
  return { items, suspense_rows, matched_line_ids: matched, escalation_ids };
}

// ---- daily close (state machine: daily_three_way) ----------------------------------------------------------------------------
export interface DailyCloseInput { readonly custodial_account_id: string; readonly as_of_date: PlainDate; readonly section_i: SectionI; readonly cashbook_cents: Cents; readonly carried_item_ids?: readonly string[]; readonly statement_missing?: boolean; readonly shortfall_category?: ReconciliationCategory; }
export interface DailyClose { readonly status: "balanced" | "exceptions_open"; readonly adjusted_depository_cents: Cents; readonly difference_cents: Cents; readonly shortfall: { item_id: string; amount_cents: Cents; tier: "agent_auto" | "officer_1bd" | "officer_partner_fraud"; fund_by: PlainDate; fund_by_at: string; approval: "agent" | "officer" | "officer_plus_partner" } | null; readonly surplus_item_id: string | null; readonly statement_missing_item_id: string | null; readonly items_carried: readonly string[]; readonly closed_at: string; }
/** Bank (adjusted for validated in-transit items) vs cashbook: a shortfall is funded from corporate within 2 BD regardless of root cause (rule 5); the day closes at 17:00 even with items carried. */
export function closeDailyReconciliation(em: Emitter, f: DailyCloseInput): DailyClose {
  if (!f.custodial_account_id) throw new RangeError("custodial_account_id is required");
  if (!isDate(f.as_of_date)) throw new RangeError("as_of_date must be YYYY-MM-DD");
  const agg = ACCOUNT_AGG(f.custodial_account_id);
  const adjusted = adjustedDepository(f.section_i); const difference = adjusted - f.cashbook_cents;
  const carried = [...(f.carried_item_ids ?? [])];
  let statement_missing_item_id: string | null = null, surplus_item_id: string | null = null, shortfall: DailyClose["shortfall"] = null;
  if (f.statement_missing) {
    statement_missing_item_id = `sm-${f.custodial_account_id}-${f.as_of_date}`;
    em.events.append({ type: "reconciliation_item.opened", aggregate: ITEM_AGG(statement_missing_item_id), actor: em.actor, payload: { item_id: statement_missing_item_id, custodial_account_id: f.custodial_account_id, category: "statement_missing", kind: "statement", severity: "medium", amount_cents: 0n, loan_id: null, root_cause: `prior-day statement for ${f.as_of_date} not received by 10:00 local; bank ops contacted`, first_seen_on: f.as_of_date, status: "open" } });
    carried.push(statement_missing_item_id);
  }
  if (difference < 0n) {
    const amount = -difference; const sf = shortageFunding(amount, f.as_of_date); const item_id = `shortfall-${f.custodial_account_id}-${f.as_of_date}`;
    const approval = sf.tier === "agent_auto" ? "agent" as const : sf.tier === "officer_1bd" ? "officer" as const : "officer_plus_partner" as const;
    em.events.append({ type: "reconciliation_item.opened", aggregate: ITEM_AGG(item_id), actor: em.actor, payload: { item_id, custodial_account_id: f.custodial_account_id, category: f.shortfall_category ?? "bank_debit_unposted", kind: "cash_shortfall", severity: sf.tier === "officer_partner_fraud" ? "critical" : "high", amount_cents: difference, loan_id: null, root_cause: `cash in bank ${formatCents(adjusted)} < cashbook ${formatCents(f.cashbook_cents)} after in-transit items validated (root cause under research)`, first_seen_on: f.as_of_date, status: "open", fund_by: sf.due_on } });
    em.events.append({ type: "custodial.shortage.identified", aggregate: agg, actor: em.actor, payload: { custodial_account_id: f.custodial_account_id, item_id, amount_cents: amount, identification: f.as_of_date, identified_on: f.as_of_date, tier: sf.tier, approval, fund_by: sf.due_on, fund_by_at: new Date(sf.due_at_ms).toISOString(), partner_notice: sf.tier === "officer_partner_fraud" } });
    shortfall = { item_id, amount_cents: amount, tier: sf.tier, fund_by: sf.due_on, fund_by_at: new Date(sf.due_at_ms).toISOString(), approval }; carried.push(item_id);
  } else if (difference > 0n) {
    surplus_item_id = `surplus-${f.custodial_account_id}-${f.as_of_date}`;
    em.events.append({ type: "reconciliation_item.opened", aggregate: ITEM_AGG(surplus_item_id), actor: em.actor, payload: { item_id: surplus_item_id, custodial_account_id: f.custodial_account_id, category: "bank_credit_unposted", kind: "cash_surplus", severity: "medium", amount_cents: difference, loan_id: null, root_cause: `cash in bank ${formatCents(adjusted)} > cashbook ${formatCents(f.cashbook_cents)} — unposted credit under research`, first_seen_on: f.as_of_date, status: "open" } });
    carried.push(surplus_item_id);
  }
  const status = carried.length === 0 && difference === 0n ? "balanced" : "exceptions_open";
  em.events.append({ type: "custodial.reconciliation.daily_completed", aggregate: agg, actor: em.actor, payload: { custodial_account_id: f.custodial_account_id, kind: "daily_three_way", as_of_date: f.as_of_date, status, bank_balance_cents: f.section_i.bank_closing_ledger_cents, adjusted_depository_cents: adjusted, cashbook_cents: f.cashbook_cents, difference_cents: difference, items_carried: carried, shortfall_item_id: shortfall?.item_id ?? null, closed_at: em.now } });
  return { status, adjusted_depository_cents: adjusted, difference_cents: difference, shortfall, surplus_item_id, statement_missing_item_id, items_carried: carried, closed_at: em.now };
}

// ---- remittance calendar (F-1-20: S/S 18th, S/A 20th; A/A per notification) -----------------------------------------------------------
export interface RemittancePeriod { readonly period: string; readonly period_start: PlainDate; readonly remittance_type: RemittanceClass; readonly draft_on: PlainDate | null; readonly funds_available_at: string | null; }
/** Closing the P&I ledger for month M opens the remittance period in which Fannie Mae drafts M's activity: the 18th (S/S) or 20th (S/A), each on the preceding Fannie Mae business day, funds there by 00:01 ET; A/A drafts follow the pre-draft notification (LL-2026-05). */
export function openRemittancePeriod(em: Emitter, f: { custodial_account_id: string; period_end: PlainDate; remittance_type: string | null | undefined }): RemittancePeriod | null {
  if (!f.custodial_account_id) throw new RangeError("custodial_account_id is required");
  if (!isDate(f.period_end) || f.period_end !== endOfMonth(f.period_end)) throw new RangeError("period_end must be the last calendar day of the month");
  const rc = remittanceClass(f.remittance_type); if (!rc) return null;
  const period_start = addDays(f.period_end, 1); const { y, m } = parts(period_start);
  const day = rc === "ss" ? 18 : rc === "sa" ? 20 : null;
  const draft_on = day === null ? null : rollBack(ymd(y, m, day), fannieEt);
  const funds_available_at = draft_on ? new Date(zonedEpochMs(draft_on, "00:01", ET)).toISOString() : null;
  const period = `${y}-${String(m).padStart(2, "0")}`;
  em.events.append({ type: "period.opened", aggregate: ACCOUNT_AGG(f.custodial_account_id), actor: em.actor, payload: { custodial_account_id: f.custodial_account_id, remittance_type: rc, remittance_type_label: f.remittance_type ?? null, period, period_start, closed_period_end: f.period_end, draft_on, funds_available_at } });
  return { period, period_start, remittance_type: rc, draft_on, funds_available_at };
}

// ---- draft coverage (intraday available balance, never the reconciliation of record) --------------------------------------------------------
export interface CoverageInput { readonly custodial_account_id: string; readonly remittance_type: string; readonly expected_draft_cents: Cents; readonly intraday_available_cents: Cents; readonly as_of: PlainDate; readonly draft_date?: PlainDate | null; readonly period?: string | null; readonly notification_id?: string | null; readonly subject?: { kind: string; id: string }; }
export interface Coverage { readonly covered: boolean; readonly remittance_type: RemittanceClass; readonly shortfall_cents: Cents; readonly balance_basis: "available_045_CLAV"; readonly event: "custodial.draft.coverage_confirmed" | "custodial.draft.coverage_short"; readonly top_up: { posting: PostingSet; by: PlainDate; tier: "agent_auto" | "officer_1bd" | "officer_partner_fraud"; approval: "agent" | "officer" | "officer_plus_partner" } | null; readonly escalation: { role: "officer"; severity: "critical" } | null; }
export function confirmDraftCoverage(em: Emitter, f: CoverageInput): Coverage {
  if (!f.custodial_account_id) throw new RangeError("custodial_account_id is required");
  if (!isDate(f.as_of)) throw new RangeError("as_of must be YYYY-MM-DD");
  const rc = remittanceClass(f.remittance_type); if (!rc) throw new RangeError(`remittance_type ${f.remittance_type} has no Fannie Mae draft schedule`);
  if (f.expected_draft_cents < 0n) throw new RangeError("expected_draft_cents must be ≥ 0");
  const c = draftCoverage({ expected_draft_cents: f.expected_draft_cents, intraday_available_cents: f.intraday_available_cents, as_of: f.as_of });
  const subject = f.subject ?? ACCOUNT_AGG(f.custodial_account_id);
  const base = { custodial_account_id: f.custodial_account_id, remittance_type: rc, as_of: f.as_of, expected_draft_cents: f.expected_draft_cents, available_cents: f.intraday_available_cents, balance_basis: c.balance_basis, draft_date: f.draft_date ?? null, period: f.period ?? null, notification_id: f.notification_id ?? null };
  if (c.covered) {
    em.events.append({ type: "custodial.draft.coverage_confirmed", aggregate: subject, actor: em.actor, payload: { ...base, confirmed_at: em.now } });
    return { covered: true, remittance_type: rc, shortfall_cents: 0n, balance_basis: c.balance_basis, event: "custodial.draft.coverage_confirmed", top_up: null, escalation: null };
  }
  const sf = shortageFunding(c.shortfall_cents, f.as_of);
  const approval = sf.tier === "agent_auto" ? "agent" as const : sf.tier === "officer_1bd" ? "officer" as const : "officer_plus_partner" as const;
  const posting: PostingSet = { description: `corporate top-up ${formatCents(c.shortfall_cents)} for the ${rc.toUpperCase()} draft${f.draft_date ? ` of ${f.draft_date}` : ""} (same day)`, effective_on: f.as_of, lines: [{ account: `custodial_pi_cash:${f.custodial_account_id}`, amount_cents: c.shortfall_cents, rule_ref: "6.3 draft coverage top-up" }, { account: "corporate_cash", amount_cents: -c.shortfall_cents, rule_ref: "6.3 draft coverage top-up" }] };
  em.events.append({ type: "custodial.draft.coverage_short", aggregate: subject, actor: em.actor, payload: { ...base, shortfall_cents: c.shortfall_cents, top_up_by: c.top_up_by, approval, tier: sf.tier, escalation: "officer", severity: "critical" } });
  return { covered: false, remittance_type: rc, shortfall_cents: c.shortfall_cents, balance_basis: c.balance_basis, event: "custodial.draft.coverage_short", top_up: { posting, by: c.top_up_by!, tier: sf.tier, approval }, escalation: c.escalation };
}

// ---- Fannie Mae Connect Remittance P&I Detail report (line 9) ------------------------------------------------------------------------
export interface RemittanceDetailInput { readonly period: string; readonly servicer_number: string; readonly remittance_type: string; readonly document_id: string; readonly sha256: string; readonly rows: readonly { fnma_loan_number: string; pi_receivable_cents: Cents }[]; readonly custodial_account_id?: string | null; }
export function ingestRemittanceDetailReport(em: Emitter, f: RemittanceDetailInput): { fnma_receivable_cents: Cents; fnma_receivable_source_document_id: string; row_count: number; period: string; line: "II.9" } {
  if (!/^\d{4}-\d{2}$/.test(f.period)) throw new RangeError("period must be YYYY-MM (the month being reconciled)");
  if (!/^\d{9}$/.test(f.servicer_number)) throw new RangeError("servicer_number must be 9 digits");
  if (!f.document_id) throw new RangeError("document_id is required");
  if (!/^(sha256:)?[0-9a-f]{64}$/i.test(f.sha256)) throw new RangeError("sha256 of the downloaded report is required");
  if (!Array.isArray(f.rows) || f.rows.length === 0) throw new RangeError("rows[] from the Remittance P&I Detail report are required");
  for (const r of f.rows) if (!/^\d{10}$/.test(r.fnma_loan_number)) throw new RangeError(`row ${r.fnma_loan_number}: Fannie Mae loan number must be 10 digits`);
  const total = f.rows.reduce((a, r) => a + r.pi_receivable_cents, 0n);
  em.events.append({ type: "fnma.remittance_detail.report_received", aggregate: PERIOD_AGG(f.period), actor: em.actor, payload: { period: f.period, servicer_number: f.servicer_number, remittance_type: f.remittance_type, report: "remittance_detail_pi", source: "fnma_connect", document_id: f.document_id, sha256: f.sha256, row_count: f.rows.length, fnma_receivable_cents: total, custodial_account_id: f.custodial_account_id ?? null, received_at: em.now } });
  return { fnma_receivable_cents: total, fnma_receivable_source_document_id: f.document_id, row_count: f.rows.length, period: f.period, line: "II.9" };
}

// ---- shortage/surplus schedule (IRM §1-02) ----------------------------------------------------------------------------------
export interface SurplusExplanation { readonly surplus_id: string; readonly period: string | null; readonly remittance_type: string; readonly amount_cents: Cents; readonly root_cause: string; readonly evidence_refs: readonly string[]; readonly posting_set_id: string | null; readonly subject?: { kind: string; id: string }; }
/** A surplus is explained by a documented reclass (root cause + evidence, never a plug) within 90 days or Fannie Mae may zero it. */
export function explainShortageSurplus(em: Emitter, f: SurplusExplanation): { explained: true; surplus_id: string; explained_on: PlainDate } {
  if (!f.surplus_id) throw new RangeError("surplus_id is required");
  if (plug(f.root_cause)) throw new RangeError("a surplus explanation needs a root cause (never a plug)");
  if (f.evidence_refs.length < 1) throw new RangeError("a surplus explanation needs documentary evidence");
  const explained_on = em.now.slice(0, 10) as PlainDate;
  em.events.append({ type: "fnma.shortage_surplus.explained", aggregate: f.subject ?? (f.period ? PERIOD_AGG(f.period) : { kind: "shortage_surplus", id: f.surplus_id }), actor: em.actor, payload: { surplus_id: f.surplus_id, period: f.period, remittance_type: f.remittance_type, amount_cents: f.amount_cents, root_cause: f.root_cause, evidence_refs: [...f.evidence_refs], posting_set_id: f.posting_set_id, explained_on } });
  return { explained: true, surplus_id: f.surplus_id, explained_on };
}

// ---- rule 4 sign check --------------------------------------------------------------------------------------------------------
/** `variance_cents` = bank debit − expected draft. Bank took more → custodial cash goes down (credit, −) and `fnma_shortage_surplus` up (+); the reverse for an under-draft. */
export function draftVarianceSignViolation(set: { readonly lines?: readonly { readonly account: { readonly account: string }; readonly amountCents: Cents }[] } | undefined, varianceCents: Cents): string | undefined {
  if (varianceCents === 0n || !set?.lines?.length) return undefined;
  const cash = set.lines.filter((l) => /custodial_pi_cash|custodial_ti/.test(l.account.account)).reduce((s, l) => s + l.amountCents, 0n);
  const ss = set.lines.filter((l) => /shortage_surplus/.test(l.account.account)).reduce((s, l) => s + l.amountCents, 0n);
  if (varianceCents > 0n && (cash >= 0n || ss <= 0n)) return `bank debit exceeded the expected draft by ${formatCents(varianceCents)}: custodial cash must be credited (−) and fnma_shortage_surplus debited (+)`;
  if (varianceCents < 0n && (cash <= 0n || ss >= 0n)) return `bank debit fell short of the expected draft by ${formatCents(-varianceCents)}: custodial cash must be debited (+) and fnma_shortage_surplus credited (−)`;
  return undefined;
}
