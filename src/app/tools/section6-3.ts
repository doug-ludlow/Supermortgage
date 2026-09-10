/**
 * §6.3 process-owned tools — the handlers behind the 6.3 tool strings the bus registers in ./section06.ts
 * (`bank.read_statement`, `timer.*`, `documents.write`, the `ledger.post_reclass` after-hook and its rule-4 sign
 * guard), each routed through src/domain/custodial/ops-6-3.ts so every 6.3 timer row is armed and satisfied by a
 * real act. Every tool string must be one spec/registry/agents.json names for 6.3; src/app/tools.test.ts refuses the
 * rest, and a name may be registered once per process — so this file exports handlers, not a second `bank.read_statement`.
 */
import { compute, write, timerOps, guard, cents, str, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { SectionI, LedgerItem } from "../../domain/custodial/reconciliation.ts";
import { periodClosedEvent } from "../../domain/custodial/ops.ts";
import { receiveStatement, classifyResiduals, closeDailyReconciliation, openRemittancePeriod, confirmDraftCoverage, ingestRemittanceDetailReport, explainShortageSurplus, draftVarianceSignViolation, remittanceClass, PERIOD_AGG, type ResidualLine, type StatementFormat } from "../../domain/custodial/ops-6-3.ts";
import type { CandidateLoan } from "../../domain/custodial/suspense.ts";

export const TOOLS_6_3: readonly ToolDef[] = [];

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const centsList = (i: ToolInput, k: string): bigint[] => rows<unknown>(i, k).map(cents);
const INTRADAY = new Set(["camt052", "bai2_intraday"]);
const sectionI = (i: ToolInput): SectionI => { const s = i.section_i as Partial<SectionI> | undefined; return { bank_closing_ledger_cents: cents(s?.bank_closing_ledger_cents ?? i.bank_closing_ledger_cents), deposits_in_transit_cents: cents(s?.deposits_in_transit_cents ?? i.deposits_in_transit_cents), disbursements_in_transit_cents: cents(s?.disbursements_in_transit_cents ?? i.disbursements_in_transit_cents), adjustments_cents: cents(s?.adjustments_cents ?? i.adjustments_cents) }; };

/**
 * `bank.read_statement`: a prior-day BAI2/camt.053 file is validated (rule 1 control totals) and becomes the balance of
 * record — `custodial.statement.received{all_active_accounts}` — with its residual lines classified into items (rule 2 iv);
 * an intraday camt.052/BAI2 snapshot with an `expected_draft_cents` is the draft-coverage check only (never the
 * reconciliation of record) — `custodial.draft.coverage_confirmed` / `.coverage_short` with the auto-prepared top-up.
 */
export const bankReadStatement63 = compute((i, ctx, rt) => {
  need(i, "custodial_account_id");
  const account = str(i, "custodial_account_id"); const format = (str(i, "format") || "bai2") as StatementFormat;
  if ((INTRADAY.has(format) || flag(i, "intraday")) && i.expected_draft_cents !== undefined) {
    need(i, "remittance_type", "as_of");
    const period = str(i, "period") || null; const rc = remittanceClass(str(i, "remittance_type"));
    const subject = (i.aggregate as { kind: string; id: string } | undefined) ?? (period && rc === "aa" ? PERIOD_AGG(period) : undefined);
    return confirmDraftCoverage(ctx, { custodial_account_id: account, remittance_type: str(i, "remittance_type"), expected_draft_cents: cents(i.expected_draft_cents), intraday_available_cents: cents(i.intraday_available_cents ?? i.closing_available_cents), as_of: D(str(i, "as_of")), draft_date: str(i, "draft_date") ? D(str(i, "draft_date")) : null, period, notification_id: str(i, "notification_id") || null, ...(subject ? { subject } : {}) });
  }
  need(i, "as_of_date");
  const asOf = D(str(i, "as_of_date"));
  const already = rt.store.list("bank_statements", (d) => d.as_of_date === asOf && d.control_totals_ok === true && !INTRADAY.has(String(d.format))).map((r) => String(r.data.custodial_account_id));
  const active = Array.isArray(i.active_account_ids) ? (i.active_account_ids as string[]) : rt.store.list("custodial_accounts", (d) => d.status === "active" && (d.kind === "pi" || d.kind === undefined)).map((r) => r.id);
  const r = receiveStatement(ctx, { custodial_account_id: account, file_id: str(i, "file_id") || "unknown", format, as_of_date: asOf, credit_lines: centsList(i, "credit_lines"), summary_credits: cents(i.summary_credits), debit_lines: centsList(i, "debit_lines"), summary_debits: cents(i.summary_debits), closing_ledger_cents: i.closing_ledger_cents === undefined ? null : cents(i.closing_ledger_cents), closing_available_cents: i.closing_available_cents === undefined ? null : cents(i.closing_available_cents), active_account_ids: active, received_account_ids: already });
  rt.store.put("bank_statements", r.statement_id, { custodial_account_id: account, format, as_of_date: asOf, file_id: str(i, "file_id") || "unknown", control_totals_ok: r.ok, quarantined: r.quarantined, closing_ledger_cents: i.closing_ledger_cents === undefined ? null : cents(i.closing_ledger_cents), closing_available_cents: i.closing_available_cents === undefined ? null : cents(i.closing_available_cents), parsed_at: ctx.now }, ctx.actor, ctx.now);
  if (!r.ok) { rt.store.put("reconciliation_items", r.item_id!, { custodial_account_id: account, category: "control_total_mismatch", severity: "high", status: "open", first_seen_on: ctx.now.slice(0, 10), root_cause: r.daily_close_item, statement_id: r.statement_id }, ctx.actor, ctx.now); return { ...r, items: [], suspense_rows: [] }; }
  if (!Array.isArray(i.lines)) return { ...r, items: [], suspense_rows: [] };
  const lines = rows<Record<string, unknown>>(i, "lines").map((l): ResidualLine => ({ id: String(l.id), direction: l.direction === "debit" ? "debit" : "credit", amount_cents: cents(l.amount_cents), value_date: D(String(l.value_date ?? asOf)), ...(typeof l.type_code === "string" ? { type_code: l.type_code } : {}), ...(typeof l.memo === "string" ? { memo: l.memo } : {}), ...(typeof l.reference === "string" ? { reference: l.reference } : {}) }));
  const notified = [...rt.store.list("draft_notifications").map((n) => cents(n.data.amount_cents)), ...(Array.isArray(i.draft_notification_amounts) ? (i.draft_notification_amounts as unknown[]).map(cents) : [])];
  const c = classifyResiduals(ctx, { custodial_account_id: account, today: D(str(i, "today") || ctx.now.slice(0, 10)), lines, ledger: Array.isArray(i.ledger) ? (i.ledger as LedgerItem[]) : [], ...(Array.isArray(i.candidates) ? { candidates: i.candidates as CandidateLoan[] } : {}), draft_notification_amounts: notified, crs_report_amounts: Array.isArray(i.crs_report_amounts) ? (i.crs_report_amounts as unknown[]).map(cents) : [], escalations: rt.escalations });
  for (const it of c.items) rt.store.put("reconciliation_items", it.item_id, { custodial_account_id: account, line_id: it.line_id, category: it.category, kind: it.kind, severity: it.severity, amount_cents: it.amount_cents, loan_id: it.loan_id, root_cause: it.root_cause, first_seen_on: it.first_seen_on, status: it.status, suspense_item_id: it.suspense_item_id, fraud_case: it.fraud_case, funding_tier: it.funding_tier, reimburse_by: it.reimburse_by }, ctx.actor, ctx.now);
  for (const s of c.suspense_rows) rt.store.put("suspense_items", s.id, { source: s.source, reason_code: s.reason_code, amount_cents: s.amount_cents, received_on: s.received_on, created_on: s.created_on, payer_name: s.payer_name, status: s.status, loan_id: s.loan_id, bank_statement_line_id: s.bank_statement_line_id, custodial_account_id: s.custodial_account_id }, ctx.actor, ctx.now);
  return { ...r, items: c.items, suspense_rows: c.suspense_rows, matched_line_ids: c.matched_line_ids, escalation_ids: c.escalation_ids };
});

/**
 * `timer.*` for 6.3: `close_period` is the month-end cut-off (`ledger.period.closed` with the computed day-45 anchor, and for
 * a P&I account the `period.opened` remittance schedule of the following month); `close_day` is the 17:00 daily three-way
 * close (`custodial.reconciliation.daily_completed`, shortfall identification); everything else is the engine's list/open/arm/cancel.
 */
export const timerOps63 = compute((i, ctx, rt) => {
  if (i.op === "close_period") {
    need(i, "period_end");
    const accountKind = (str(i, "account_kind") || "pi") as Parameters<typeof periodClosedEvent>[0]["account_kind"]; const account = str(i, "custodial_account_id") || "unknown";
    const ev = ctx.events.append({ ...periodClosedEvent({ period_end: D(str(i, "period_end")), account_kind: accountKind, custodial_account_id: account, ...(typeof i.remittance_type === "string" ? { remittance_type: i.remittance_type } : {}) }), actor: ctx.actor });
    const remittance = accountKind === "pi" ? openRemittancePeriod(ctx, { custodial_account_id: account, period_end: D(str(i, "period_end")), remittance_type: typeof i.remittance_type === "string" ? i.remittance_type : null }) : null;
    return { ...ev, remittance_period: remittance };
  }
  if (i.op === "close_day") {
    need(i, "custodial_account_id", "as_of_date");
    const r = closeDailyReconciliation(ctx, { custodial_account_id: str(i, "custodial_account_id"), as_of_date: D(str(i, "as_of_date")), section_i: sectionI(i), cashbook_cents: cents(i.cashbook_cents), carried_item_ids: Array.isArray(i.carried_item_ids) ? (i.carried_item_ids as string[]) : [], statement_missing: flag(i, "statement_missing") });
    rt.store.put("custodial_reconciliations", `daily-${str(i, "custodial_account_id")}-${str(i, "as_of_date")}`, { kind: "daily_three_way", custodial_account_id: str(i, "custodial_account_id"), period_start: str(i, "as_of_date"), period_end: str(i, "as_of_date"), status: r.status === "balanced" ? "closed_day" : "exceptions_open", bank_balance_cents: sectionI(i).bank_closing_ledger_cents, adjusted_bank_cents: r.adjusted_depository_cents, cashbook_cents: cents(i.cashbook_cents), difference_cents: r.difference_cents, items_carried: r.items_carried, completed_at: r.closed_at }, ctx.actor, ctx.now);
    if (r.shortfall) rt.store.put("reconciliation_items", r.shortfall.item_id, { custodial_account_id: str(i, "custodial_account_id"), category: "bank_debit_unposted", kind: "cash_shortfall", amount_cents: -r.shortfall.amount_cents, first_seen_on: str(i, "as_of_date"), status: "open", funding_tier: r.shortfall.tier, fund_by: r.shortfall.fund_by }, ctx.actor, ctx.now);
    return r;
  }
  return timerOps()(i, ctx);
});

/** `documents.write` for 6.3: a `kind: "fnma_remittance_pi_detail"` document is the Connect report — validated and recorded as line 9's source (`fnma.remittance_detail.report_received`); any other document is the plain store write. */
export const documentsWrite63 = compute((i, ctx, rt) => {
  const d = data(i);
  if (d.kind !== "fnma_remittance_pi_detail") return write("documents", "document.written")(i, ctx, rt);
  const id = typeof i.id === "string" ? i.id : `rpd-${String(d.period ?? "unknown")}-${String(d.servicer_number ?? "")}`;
  const rec = rt.store.put("documents", id, { ...d, retention: "life_of_loan_plus_4y" }, ctx.actor, ctx.now);
  ctx.events.append({ type: "document.written", loanId: ctx.loanId, aggregate: { kind: "documents", id }, actor: ctx.actor, payload: { id, version: rec.version, fields: Object.keys(d) } });
  const r = ingestRemittanceDetailReport(ctx, { period: String(d.period ?? ""), servicer_number: String(d.servicer_number ?? ""), remittance_type: String(d.remittance_type ?? "S/S"), document_id: id, sha256: String(d.sha256 ?? ""), rows: (Array.isArray(d.rows) ? d.rows : []).map((x) => { const row = x as Record<string, unknown>; return { fnma_loan_number: String(row.fnma_loan_number ?? ""), pi_receivable_cents: cents(row.pi_receivable_cents) }; }), custodial_account_id: typeof d.custodial_account_id === "string" ? d.custodial_account_id : null });
  return { ...rec.data, ...r };
});

/** After a `ledger.post_reclass` that documents a Fannie Mae surplus (`surplus_id`): `fnma.shortage_surplus.explained` (IRM §1-02, 90 days). */
export function afterReclass63(i: ToolInput, ctx: CommandContext, set: unknown): void {
  if (!str(i, "surplus_id")) return;
  const agg = i.aggregate as { kind: string; id: string } | undefined;
  explainShortageSurplus(ctx, { surplus_id: str(i, "surplus_id"), period: str(i, "period") || null, remittance_type: str(i, "remittance_type") || "unknown", amount_cents: cents(i.amount_cents), root_cause: str(i, "root_cause"), evidence_refs: Array.isArray(i.evidence_refs) ? (i.evidence_refs as string[]) : [], posting_set_id: (set as { id?: string } | undefined)?.id ?? null, ...(agg ? { subject: agg } : {}) });
}

/** 6.3 rule 4 / worked example 8: a `draft_variance` reclass posts in the direction of the bank debit — never the reverse (the sign is part of the evidence). */
export const DRAFT_VARIANCE_SIGN = guard("DRAFT_VARIANCE_SIGN", "6.3 rule 4 / worked example 8: bank debit 4,841,033 vs expected 4,821,033 → item `draft_variance` −$200.00 posted to `fnma_shortage_surplus` — custodial cash is credited for the excess the bank took, never debited", (i) => {
  if (str(i, "category") !== "draft_variance" && i.variance_cents === undefined) return undefined;
  if (i.variance_cents === undefined) return "a draft_variance reclass states variance_cents (bank debit − expected draft)";
  return draftVarianceSignViolation(i.entry_set as Parameters<typeof draftVarianceSignViolation>[0], cents(i.variance_cents));
});

export type { PlainDate };
