/**
 * §10.3 process-owned tools — additional bus tools for 10.3 defined with `defineTools("10.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section10.ts). Every tool string must be one
 * spec/registry/agents.json names for 10.3; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * agents.json names no tool string for 10.3 itself (the `pmi` agent's §10 tools are bound under 10.1/10.2 in
 * ./section10.ts and the bus refuses a second definition of the same (process, name)), so the 10.3 operation lives here as
 * an `op` extension the 10.2 `pmi.terminate` handler dispatches to first (`pmiTerminateOps_10_3(i, ctx, rt)` returns
 * `undefined` for an op it does not own):
 *
 *   pmi.terminate  op `midpoint_preview`  the 90-day preview (SM_MI_MIDPOINT_PREVIEW_90): data completeness check → `mi.midpoint.preview.completed`,
 *                                         or `mi.midpoint.preview.incomplete` + the `pmi` queue item (+ `officer` when the term is unverified)
 */
import { cents, str, num, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { runMidpointPreview, type MidpointBasis } from "../../domain/pmi/ops-10-3.ts";

export const TOOLS_10_3: readonly ToolDef[] = [];

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const optStr = (i: ToolInput, k: string, fallback: unknown): string | null => { const v = i[k] !== undefined && i[k] !== null && i[k] !== "" ? i[k] : fallback; return v === undefined || v === null || v === "" ? null : String(v); };
const optInt = (i: ToolInput, k: string, fallback: unknown): number | null => { const v = i[k] !== undefined && i[k] !== null && i[k] !== "" ? num(i, k) : typeof fallback === "number" ? fallback : null; return v === null || Number.isNaN(v) ? null : v; };
const optCents = (i: ToolInput, k: string, fallback: unknown): bigint | null => { const v = i[k] !== undefined && i[k] !== null && i[k] !== "" ? i[k] : fallback; return v === undefined || v === null || v === "" ? null : cents(v); };
const optDate = (v: unknown): PlainDate | null => (v === undefined || v === null || v === "" ? null : D(String(v)));

/** `pmi.terminate` ops 10.3 owns; `undefined` hands the call back to the 10.2 ops and the sweep handler in ./section10.ts. */
export function pmiTerminateOps_10_3(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown | undefined {
  if (i.op !== "midpoint_preview") return undefined;
  need(i, "loan_id"); const loanId = str(i, "loan_id");
  const policy = rt.store.get("mi_policies", loanId)?.data ?? {};
  // The latest `mi_schedules` version for the loan carries `derived_midpoint_date` (the midpoint termination date) and its basis.
  const schedules = rt.store.list("mi_schedules", (d) => d.loan_id === loanId).slice().sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
  const latest = schedules[schedules.length - 1];
  const mtd = optDate(i.midpoint_termination_date) ?? optDate(latest?.data.derived_midpoint_date) ?? optDate(policy.midpoint_termination_date);
  if (!mtd) throw new RangeError("midpoint_termination_date is required (input, the latest mi_schedules version or mi_policies)");
  const basis: MidpointBasis = (optStr(i, "midpoint_basis", null) ?? (latest?.data.basis === "modification" ? "modification" : "consummation")) as MidpointBasis;
  if (basis !== "consummation" && basis !== "modification") throw new RangeError(`midpoint_basis ${basis} is not consummation/modification`);
  const r = runMidpointPreview(ctx, rt.escalations, loanId, {
    midpoint_termination_date: mtd, midpoint_basis: basis,
    schedule_id: optStr(i, "schedule_id", latest?.id ?? policy.midpoint_schedule_id),
    amortization_start: optDate(i.amortization_start ?? policy.amortization_start),
    amortization_term_months: optInt(i, "amortization_term_months", policy.amortization_term_months ?? latest?.data.rows),
    note_term_months: optInt(i, "note_term_months", policy.note_term_months),
    note_document_hash: optStr(i, "note_document_hash", policy.note_document_hash),
    modification_document_hash: optStr(i, "modification_document_hash", policy.modification_document_hash),
    original_value_cents: optCents(i, "original_value_cents", policy.original_value_cents),
    insurer_certificate: optStr(i, "certificate", policy.certificate),
    insurer: optStr(i, "insurer", policy.insurer),
    refund_payee: optStr(i, "refund_payee", policy.refund_payee ?? "borrower"),
    refund_estimate_cents: optCents(i, "refund_estimate_cents", policy.refund_estimate_cents),
  });
  rt.store.put("mi_policies", loanId, { midpoint_termination_date: mtd, midpoint_basis: basis, midpoint_schedule_id: latest?.id ?? null, midpoint_preview_status: r.complete ? "completed" : "incomplete", midpoint_preview_on: ctx.now.slice(0, 10), midpoint_preview_event_id: r.event.id, midpoint_preview_queue_id: r.queue_id }, ctx.actor, ctx.now);
  return { complete: r.complete, checklist: r.checklist, missing: r.missing, preview_due: r.preview_due, officer_review: r.officer_review, event_id: r.event.id, queue_id: r.queue_id, officer_escalation_id: r.officer_escalation_id, timer: "SM_MI_MIDPOINT_PREVIEW_90" };
}
