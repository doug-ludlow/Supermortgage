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
