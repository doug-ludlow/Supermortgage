/**
 * §35.9 — the command bodies behind the 35.9 bus tools (src/app/tools/section35-9.ts registers them under process 35.9,
 * agent foreclosure-ops). Every command runs inside 35.1's unit of work on the loan scope: `ctx.q` is its transaction,
 * `rt.store` the bounded entity store, `ctx.events` the log the engine arms and satisfies clocks from. Nothing here writes a
 * section's row or a money figure (rule 10); the sections' tools are run through ./delegate.ts.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { ENGINE_ACTOR, ET, type CaseKind } from "../default-35-9.ts";
import { expectationsOf, markDue, waiveExpectation, writeExpectation, type Basis, type ExpectIo } from "./expectations.ts";
import { caseFactsOf, foldLoan, timelineOf, type FoldIo } from "./timeline.ts";
import { caseUuid, currentRow, loanRows, openForeclosure, str, type Row } from "./store.ts";
import { portsOf, type DefaultOpsPorts } from "./ports.ts";
import { delegate } from "./delegate.ts";

export const s = (i: ToolInput, k: string): string => (i[k] === undefined || i[k] === null ? "" : String(i[k]));
export const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (s(i, k) === "") throw new RangeError(`${k} is required`); };
export const dateOf = (i: ToolInput, k: string, fallback?: string): PlainDate => { const v = s(i, k) || fallback || ""; if (!/^\d{4}-\d{2}-\d{2}/.test(v)) throw new RangeError(`${k} must be a date`); return D(v.slice(0, 10)); };
export const q = (ctx: CommandContext): Queryable => { if (!ctx.q) throw new RangeError("35.9 commands run on the seam (ctx.q): no transaction in this context"); return ctx.q; };
export const asOfOf = (ctx: CommandContext, i: ToolInput): PlainDate => (s(i, "as_of_date") ? dateOf(i, "as_of_date") : D(wallClock(Date.parse(ctx.now), ET).date));
export const screenOf = (caseKind: string): string => (caseKind === "bankruptcy" ? "bankruptcy_case" : "foreclosure_case");
/** The ports a command uses (a test injects them on `rt.services["default_ops_ports"]`). */
export const portsFor = (rt: ToolRuntime): Required<DefaultOpsPorts> => portsOf(rt.services["default_ops_ports"] as DefaultOpsPorts | undefined);
export const ioOf = (ctx: CommandContext, rt: ToolRuntime, actor: Actor = ctx.actor): FoldIo & ExpectIo => ({ q: q(ctx), events: ctx.events, now: ctx.now, actor, workItems: portsFor(rt).workItems, timers: ctx.timers });

/** `case.timeline{loan_id, case_id?}` — rule 1: the rows in `event_sequence` order with the owning rows' current status. */
export async function caseTimeline(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const rows = await timelineOf(q(ctx), loanId, s(i, "case_id") || null);
  const cases = new Map<string, { case_id: string; case_kind: CaseKind; current_status: string | null; case_ref: string | null }>();
  for (const r of rows) {
    if (!r.case_id || cases.has(r.case_id)) continue;
    const ref = (r.detail["case_ref"] as string | undefined) ?? r.case_id;
    const owning = r.case_kind === "foreclosure" ? "foreclosure_cases" : r.case_kind === "bankruptcy" ? "bankruptcy_cases" : r.case_kind === "lossmit" ? "lossmit_applications" : r.case_kind === "reo" ? "reo_cases" : "mi_claims";
    const cur = rt.store.get(owning, ref) ?? await currentRow(q(ctx), owning, ref);
    cases.set(r.case_id, { case_id: r.case_id, case_kind: r.case_kind, current_status: cur ? str(cur.data, "status") || null : null, case_ref: ref });
  }
  const expectations = s(i, "case_id") ? await expectationsOf(q(ctx), caseUuid(s(i, "case_id"))) : [];
  return { loan_id: loanId, rows, cases: [...cases.values()], expectations, through_sequence: rows.length ? Number(rows[rows.length - 1]!.event_sequence) : 0 };
}

/** rule 2 step (a): the fold inside the command. */
export async function foldInCommand(ctx: CommandContext, rt: ToolRuntime, loanId: string, actor: Actor = ENGINE_ACTOR): Promise<{ folded: number; unexpected: number }> {
  const r = await foldLoan(ioOf(ctx, rt, actor), loanId);
  return { folded: r.folded, unexpected: r.unexpected };
}

/** `case.milestone.expect{case_id, milestone_code, expected_on, basis}` (a person or the agent states an expectation) and `{op: waive, reason}` (attorney / officer). */
export async function caseMilestoneExpect(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  need(i, "case_id", "milestone_code"); const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const io = ioOf(ctx, rt);
  const caseId = caseUuid(s(i, "case_id"));
  if (s(i, "op") === "waive") {
    need(i, "reason");
    const staff = /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? ctx.actor.id : null;
    const w = await waiveExpectation(io, { case_id: caseId, milestone_code: s(i, "milestone_code"), loan_id: loanId, by: ctx.actor, staff_user_id: staff, reason: s(i, "reason") });
    if (!w) throw new RangeError(`no open expectation ${s(i, "milestone_code")} on case ${s(i, "case_id")}`);
    return { expectation: w };
  }
  need(i, "expected_on", "basis");
  const basis = s(i, "basis") as Basis;
  if (!["firm_forecast", "docket_order", "jurisdiction_default", "section_clock", "person"].includes(basis)) throw new RangeError(`basis must be firm_forecast | docket_order | jurisdiction_default | section_clock | person`);
  const kind = (s(i, "case_kind") || "foreclosure") as CaseKind;
  const row = await writeExpectation(io, { loan_id: loanId, case_id: caseId, case_kind: kind, milestone_code: s(i, "milestone_code"), expected_on: dateOf(i, "expected_on"), basis, basis_ref: s(i, "basis_ref") || (ctx.actor.kind === "human" ? `${ctx.actor.kind}:${ctx.actor.id}` : null), supersede: i.supersede === true });
  return { expectation: row };
}

/**
 * `case.milestone.record{case_id, milestone_code, occurred_on, source, evidence_document_id?}` — never a milestone of this process's own
 * (AI agent design: "never fabricates a milestone — a milestone comes from the firm, the DRA, the docket or a person"): the
 * record is 13.3's `MILESTONE` ingest run as foreclosure-ops, and the fold that follows satisfies the expectation.
 */
export async function caseMilestoneRecord(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  need(i, "case_id", "milestone_code", "occurred_on", "source"); const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const source = s(i, "source");
  if (!["firm", "dra", "court", "docket", "servicer", "person"].includes(source)) throw new RangeError("source must name the firm, the DRA, the docket/court or a person");
  const fc = rt.store.get("foreclosure_cases", s(i, "case_id")) ?? openForeclosure(await loanRows(q(ctx), "foreclosure_cases", loanId));
  const firmId = s(i, "firm_id") || (fc ? str(fc.data, "firm_id") : "");
  const code = s(i, "milestone_code").toUpperCase();
  const r = await delegate(rt, ctx, "13.2", "attorney.instruction.status", { op: "firm_message", kind: "MILESTONE", loan_id: loanId, case_id: s(i, "case_id"), firm_id: firmId, code, occurred_on: s(i, "occurred_on"), source: source === "person" || source === "docket" ? (source === "docket" ? "court" : "servicer") : source, ...(s(i, "evidence_document_id") ? { evidence_document_id: s(i, "evidence_document_id") } : {}) });
  const fold = await foldInCommand(ctx, rt, loanId, ctx.actor);
  return { recorded: true, milestone_event_id: r.event_id, fold };
}

/** rule 2 step (d) — expectations due today (the daily unit; also `case.progress` by hand). */
export async function markExpectationsDue(ctx: CommandContext, rt: ToolRuntime, loanId: string, asOf: PlainDate): Promise<number> {
  return (await markDue(ioOf(ctx, rt), { loan_id: loanId, as_of_date: asOf, screen_code_of: screenOf })).length;
}
export { caseFactsOf };
