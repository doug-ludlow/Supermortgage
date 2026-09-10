/**
 * §12.9 process-owned tools — additional bus tools for 12.9 defined with `defineTools("12.9", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section12.ts). Every tool string must be one
 * spec/registry/agents.json names for 12.9; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * Every 12.9 tool string is already on the bus from ./section12.ts, so this file carries the inbound ops of the
 * `liquidation.case.*` tool instead (the handler in ./section12.ts dispatches `op ∈ INBOUND_OPS_12_9` here): the
 * SMDU/BPO valuation result, closing proceeds, the DIL inspection report, the relocation disbursement, the CA
 * NOD rescission and a 13.x sale date — each validated against the case by src/domain/lossmit/ops-12-9.ts and
 * appended as the event a 12.9 timer row is satisfied or armed by.
 */
import { cents, str, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { recordValuationReceived, recordClosingFundsReceived, recordInspectionReport, disburseRelocation, recordNodRescinded, recordForeclosureSaleScheduled, type LiquidationEnv, type RelocationPayer } from "../../domain/lossmit/ops-12-9.ts";

export const TOOLS_12_9: readonly ToolDef[] = [];

/** `liquidation.case.*` ops served by ops-12-9.ts (inbound records; the case transitions themselves stay in ./section12.ts). */
export const INBOUND_OPS_12_9: ReadonlySet<string> = new Set(["valuation_received", "funds_received", "inspection_received", "relocation_disbursed", "nod_rescinded", "sale_scheduled"]);

const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : str(i, k));
const reqDate = (i: ToolInput, k: string): PlainDate => { const v = optDate(i, k); if (!v) throw new RangeError(`${k} is required (YYYY-MM-DD)`); return v; };
const optCents = (i: ToolInput, k: string): bigint | undefined => (i[k] === undefined || i[k] === null || i[k] === "" ? undefined : cents(i[k]));
const env = (ctx: CommandContext): LiquidationEnv => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const strip = <T extends { event: unknown }>(r: T): Omit<T, "event"> & { event_id: string; event_type: string } => { const { event, ...rest } = r; const e = event as { id: string; type: string }; return { ...rest, event_id: e.id, event_type: e.type }; };

/** The `liquidation.case.*` inbound ops: `op` names the record; the result is the calculator's verdict plus the appended event's id/type. */
export function inboundOps_12_9(i: ToolInput, ctx: CommandContext): unknown {
  const loanId = str(i, "loan_id"); const caseId = optStr(i, "case_id") ?? optStr(i, "id");
  switch (i.op) {
    case "valuation_received": return strip(recordValuationReceived(env(ctx), { loan_id: loanId, valuation_id: str(i, "valuation_id"), method: str(i, "method"), value_cents: cents(i.value_cents), as_of: reqDate(i, "as_of"), received_on: optDate(i, "received_on") }));
    case "funds_received": return strip(recordClosingFundsReceived(env(ctx), { loan_id: loanId, case_id: caseId, amount_cents: cents(i.amount_cents), received_on: optDate(i, "received_on"), reference: optStr(i, "reference"), fnma_extension_id: optStr(i, "fnma_extension_id") }));
    case "inspection_received": return strip(recordInspectionReport(env(ctx), { loan_id: loanId, case_id: caseId, report_doc_id: str(i, "report_doc_id"), received_on: optDate(i, "received_on"), interior: flag(i, "interior"), vacant: flag(i, "vacant"), secure: flag(i, "secure"), broom_swept: flag(i, "broom_swept"), hazards: Array.isArray(i.hazards) ? (i.hazards as unknown[]).map(String) : [], ...(optCents(i, "personal_property_value_cents") !== undefined ? { personal_property_value_cents: optCents(i, "personal_property_value_cents")! } : {}) }));
    case "relocation_disbursed": return strip(disburseRelocation(env(ctx), { loan_id: loanId, case_id: caseId, disbursed_on: optDate(i, "disbursed_on"), payer: (optStr(i, "payer") ?? "closing_agent") as RelocationPayer, third_party_assistance_cents: cents(i.third_party_assistance_cents), remediation_estimate_cents: cents(i.remediation_estimate_cents), fnma_approval_id: optStr(i, "fnma_approval_id") }));
    case "nod_rescinded": return strip(recordNodRescinded(env(ctx), { loan_id: loanId, case_id: caseId, recorded_on: optDate(i, "recorded_on"), instrument_no: str(i, "instrument_no"), county: optStr(i, "county") }));
    case "sale_scheduled": return strip(recordForeclosureSaleScheduled(env(ctx), { loan_id: loanId, sale_date: reqDate(i, "sale_date"), docket_date: optDate(i, "docket_date"), source: optStr(i, "source") }));
    default: throw new RangeError(`unknown 12.9 inbound op ${String(i.op)}`);
  }
}
