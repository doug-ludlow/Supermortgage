/**
 * §2.2 process-owned tools — additional bus tools for 2.2 defined with `defineTools("2.2", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section02.ts). Every tool string must be one
 * spec/registry/agents.json names for 2.2; src/app/tools.test.ts refuses the rest (and refuses a duplicate
 * `<process> <name>`), so every 2.2 tool string already lives in ./section02.ts and this file extends one of them:
 * `withStatementSummary` adds `op=statement_summary` to `suspense.read/write` — the `statement_suspense_summary`
 * read model 7.1 renders as the §1026.41(d)(3) amount and (d)(5) instructions (2.2 "Integrations — Statements"; 2.2-T10).
 * Spread by ./index.ts.
 */
import { cents, str, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { statementSuspenseSummary, type OpenSuspenseItem } from "../../domain/cashiering/ops-2-2.ts";

type Def = Omit<ToolDef, "process" | "agent">;

/** `suspense.read/write{op=statement_summary, loan_id, period_end?, since?, periodic_payment_cents?}` → StatementSuspenseSummary; every other op is the base tool. */
export function withStatementSummary(base: Def): Def {
  return { ...base, handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown => {
    if (i.op !== "statement_summary") return base.handler(i, ctx, rt);
    const loanId = str(i, "loan_id") || ctx.loanId;
    if (!loanId) throw new RangeError("statement_summary needs loan_id");
    const P = cents(i.periodic_payment_cents) || cents(rt.store.get("loan_terms", loanId)?.data.periodic_payment_cents);
    if (P <= 0n) throw new RangeError("statement_summary needs periodic_payment_cents (or a loan_terms row carrying it)");
    const items: OpenSuspenseItem[] = rt.store.list("suspense_items", (d) => d.loan_id === loanId).map((r) => ({
      id: String(r.data.id ?? r.id), amount_cents: cents(r.data.amount_cents), received_on: D(String(r.data.received_on)), reason_code: String(r.data.reason_code ?? "partial_payment") as OpenSuspenseItem["reason_code"], status: String(r.data.status ?? "open") as OpenSuspenseItem["status"] }));
    return statementSuspenseSummary({ loan_id: loanId, periodic_payment_cents: P, items, since: str(i, "since") ? D(str(i, "since")) : null, period_end: D(str(i, "period_end") || ctx.now.slice(0, 10)) });
  } };
}

export const TOOLS_2_2: readonly ToolDef[] = [];

// ---- 32.8 §3.3 (2.2 rule 6 / T3): the borrower asks for a held partial back — `suspense.read/write{op=refund}` ------------
import { CashieringOps } from "../../domain/cashiering/ops.ts";
import type { SuspenseItem } from "../../domain/cashiering/partials.ts";
/**
 * `suspense.read/write{op=refund, id, loan_id, refunded_on?, custodial_clearing?}`: the open partial is refunded to the borrower
 * — `suspense.item.closed{outcome=refunded}` (src/domain/cashiering/ops.ts closeSuspenseItem), the receipt entry set reversed
 * (Dr suspense_unapplied / Cr clearing) when the item carries it, the item and the payment rows `refunded`, `payment.refunded`.
 * The 2.2 guardrails read `data.action=return` (payee = borrower; a loss-mit case needs the case owner) — the caller passes those facts.
 */
export function withRefund(base: Def): Def {
  return { ...base, handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown => {
    if (i.op !== "refund") return base.handler(i, ctx, rt);
    const id = str(i, "id"); const rec = rt.store.get("suspense_items", id); if (!rec) throw new RangeError(`no suspense item ${id} on this loan`);
    const d = rec.data; const loanId = String(d.loan_id ?? ctx.loanId); const on = D(str(i, "refunded_on") || ctx.now.slice(0, 10));
    if (String(d.status) !== "open" && String(d.status) !== "contact_pending") throw new RangeError(`suspense item ${id} is ${String(d.status)}, not open`);
    const item: SuspenseItem = { id, loan_id: loanId, payment_id: String(d.payment_id ?? ""), amount_cents: cents(d.amount_cents), received_on: D(String(d.received_on)), reason_code: (d.reason_code as SuspenseItem["reason_code"]) ?? "partial_payment", status: d.status as SuspenseItem["status"], partial_commitment_due_on: typeof d.partial_commitment_due_on === "string" ? D(d.partial_commitment_due_on) : null, rule_path: String(d.rule_path ?? "2.2:r3"), return_rail: (d.return_rail as SuspenseItem["return_rail"]) ?? "ach_credit" };
    new CashieringOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor }).closeSuspenseItem(item, "refunded", on);
    let reversal: string | null = null;
    if (typeof d.receipt_entry_set_id === "string" && d.receipt_entry_set_id) { try { reversal = ctx.ledger.reverse(d.receipt_entry_set_id, on, `partial refunded to the borrower (${id})`, ctx.now).id; } catch { reversal = null; } }
    rt.store.put("suspense_items", id, { ...d, status: "refunded", refunded_on: on, refund_rail: item.return_rail ?? "ach_credit", refund_entry_set_id: reversal }, ctx.actor, ctx.now);
    const pay = item.payment_id ? rt.store.get("payments", item.payment_id)?.data : undefined;
    if (pay) rt.store.put("payments", item.payment_id, { ...pay, status: "refunded", refunded_on: on, suspense_item_id: id }, ctx.actor, ctx.now);
    ctx.events.append({ type: "payment.refunded", loanId, aggregate: { kind: "payment", id: item.payment_id || id }, actor: ctx.actor, payload: { payment_id: item.payment_id || null, suspense_item_id: id, amount_cents: item.amount_cents.toString(), refunded_on: on, rail: item.return_rail ?? "ach_credit", requested_by: str(i, "requested_by") || "borrower", entry_set_id: reversal } });
    return { suspense_item_id: id, status: "refunded", amount_cents: item.amount_cents.toString(), refunded_on: on, payment_id: item.payment_id || null, entry_set_id: reversal };
  } };
}
