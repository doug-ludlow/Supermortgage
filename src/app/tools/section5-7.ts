/**
 * §5.7 tools — Delinquent loan status reporting (`investor-reporting`). Every tool string is one
 * spec/registry/agents.json names for 5.7, via `defineTools("5.7", "investor-reporting", defs)` from ../tools.ts;
 * src/app/tools.test.ts refuses the rest. The section's original 5.7 block moved here from ./section05.ts. Spread by
 * ./index.ts (TOOLS_5_7).
 *
 * The handlers are thin shells over src/domain/investor/ops-5-7.ts, which owns the event vocabulary the 5.7 timer rows
 * arm on and are satisfied by:
 *   buildDqSnapshot: month-end population (rule 1) → `delinquency_report_lines.snapshot{periods_delinquent}` per loan +
 *     `delinquency_reports.snapshot_built` (FNMA_F121_DQ_SNAPSHOT_EOM; the D2-4-01 management-action gate);
 *   deriveStatusCode: rule 2/3 derivation with the decision record's candidates and evidence ids (read);
 *   validateF121Layout: F-1-21 line / 80-byte record validation (read);
 *   submitAmnFile: the BD2 transmission with its B2B ack → `delinquency_reports.submitted{ack}` + per-line
 *     `delinquency_report_lines.submitted{status_code}` (FNMA_F121_DQ_REPORT_BD2, FNMA_F121_AW_ONE_MONTH); late → `officer`
 *     compensatory-fee escalation; confidence < 0.85 → `human_agent` review before BD2; `{op=corrections}` = the CD10
 *     correction file with its ack → `delinquency_reports.corrections_accepted` (FNMA_F121_DQ_CORRECT_CD10);
 *   parseExceptionReport: BD4 exception report → `delinquency_reports.exception_parsed` (FNMA_F121_DQ_EXCEPTIONS_BD4);
 *     `{op=final}` = CD11 final report reconciled → `delinquency_reports.final_reconciled{status}` (FNMA_F121_DQ_FINAL_CD11);
 *     `{op=connect_report}` = a Fannie Mae Connect report-available notice → `fnma.connect.report.available{report}`;
 *   submitDqEvent: the LL-2026-05 delinquency event → `delinquency_events.submitted` (FNMA_LL202605_DQ_EVENT_NEXTBD_0300);
 *     `{op=record_action}` = a §11–§14 action processed → `delinquency.action.processed` (arms it); `{op=response}` = the
 *     platform's response → `delinquency_events.accepted{servicer_action_type}` / `.rejected` (FNMA_LL202605_DQ_PMT_REMINDER_CD23);
 *   checkConsistency: rule 7 per loan, or `{op=file}` over the whole file → `delinquency_reports.consistency_checked{errors}`
 *     (SM_DQ_SMDU_DRA_CONSISTENCY_BD1), blocked lines escalated sev-2 before BD2;
 *   recordDecision: the per-line decision record; `{op=reclass_deselection}` records the 5.4 deselection decision
 *     (`reclass.deselection.decided`, FNMA_F125_RECLASS_DESELECT_CD15).
 * Guardrails encode the Agents paragraph verbatim: a code is never chosen without an evidence event id; AW once; no
 * Level 1 code without an SMDU case id (except 27/29/32/44); reason code changes require a new borrower statement.
 */
import { defineTools, compute, decision, guard, never, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { deriveStatusCode, candidates, statusLine, validateF121Layout, validateF121Record, type LoanStatusFacts, type StatusLine } from "../../domain/investor/delinquency-status.ts";
import { period as periodOf } from "../../domain/investor/period.ts";
import { dqExceptionCycle, lineReviewFlag, consistencyBlock, type DqException } from "../../domain/investor/ops.ts";
import {
  buildSnapshot, transmitAmnFile, transmitCorrections, reconcileFinal, fileConsistency, lineConsistencyErrors, recordDelinquencyAction, submitDelinquencyEvent, ingestEventResponse, ingestConnectReport, recordReclassDeselection,
  type Emitter, type SnapshotLoan, type AmnLine, type ConsistencyInput,
} from "../../domain/investor/ops-5-7.ts";

const AGENT = "investor-reporting";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const ms = (i: ToolInput, k: string, ctx: CommandContext): number => { const v = str(i, k); const t = Date.parse(v || ctx.now); if (Number.isNaN(t)) throw new RangeError(`${k} must be an ISO timestamp`); return t; };
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const isoDate = (s: string): s is PlainDate => /^\d{4}-\d{2}-\d{2}$/.test(s);
const em = (ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const facts = (i: ToolInput): LoanStatusFacts => { const f = i.facts as LoanStatusFacts | undefined; if (!f || !Array.isArray(f.actions)) throw new RangeError("facts (LoanStatusFacts) is required"); return f; };
const LEVEL1_WITHOUT_SMDU = new Set(["27", "29", "32", "44"]);
const amnLines = (i: ToolInput): AmnLine[] => (Array.isArray(i.lines) ? (i.lines as AmnLine[]).filter((l) => l && typeof l === "object") : []);
const priorPeriod = (periodMonth: string): string | null => (isoDate(periodMonth) ? periodOf(addMonths(D(periodMonth), -1)) : null);
/** AW may only be reported for one month: the loan's previous-period line, read from its `delinquency_report_lines.submitted` history. */
const awReportedLastPeriod = (ctx: CommandContext, loanId: string, prev: string): boolean => ctx.events.byLoan(loanId).some((e) => e.type === "delinquency_report_lines.submitted" && (e.payload as { status_code?: unknown; period?: unknown }).status_code === "AW" && (e.payload as { period?: unknown }).period === prev);

export const TOOLS_5_7: readonly ToolDef[] = defineTools("5.7", AGENT, [
  { name: "buildDqSnapshot", kind: "write", handler: compute((i, ctx) => { need(i, "period"); const loans = rows<SnapshotLoan>(i, "loans");
      const s = buildSnapshot(em(ctx), { period: str(i, "period"), loans, servicer_number: optStr(i, "servicer_number"), ...(str(i, "as_of") ? { as_of_ms: ms(i, "as_of", ctx) } : {}) });
      return { period: s.period, population: s.population, record_count: s.record_count, loans_with_management_action: s.loans_with_management_action, lines: s.lines }; }) },
  { name: "deriveStatusCode", kind: "read", handler: compute((i) => { const f = facts(i); const c = deriveStatusCode(f); const line = statusLine(f);
      const review = typeof i.confidence === "number" && typeof i.period_month === "string" && isoDate(i.period_month) ? lineReviewFlag({ confidence: i.confidence, period_month: D(i.period_month) }) : null;
      return { chosen: c, candidates: candidates(f), line, evidence_event_ids: f.actions.map((a) => a.evidence_event_id ?? null), review }; }),
    guardrails: [never("CODE_NEEDS_EVIDENCE", "5.7 guardrail: a code is never chosen without an evidence event id", (i) => { const f = i.facts as LoanStatusFacts | undefined; return !!f && Array.isArray(f.actions) && f.actions.some((a) => !a.evidence_event_id); }, "every candidate action carries its evidence event id"),
      never("LEVEL1_NEEDS_SMDU_CASE", "5.7 guardrail: no Level 1 code without an SMDU case id (except 27/29/32/44)", (i) => { const f = i.facts as LoanStatusFacts | undefined; if (!f || !Array.isArray(f.actions)) return false; const c = deriveStatusCode(f); return !!c && c.level === 1 && !LEVEL1_WITHOUT_SMDU.has(c.code) && !i.smdu_case_id; }, "Level 1 codes require the SMDU case id"),
      never("REASON_CHANGE_NEEDS_STATEMENT", "5.7 guardrail: reason code changes require a new borrower statement", (i) => typeof i.prior_reason_code === "string" && typeof i.reason_code === "string" && i.prior_reason_code !== i.reason_code && !flag(i, "new_borrower_statement"), "the reason code only changes on a new borrower statement")] },
  { name: "validateF121Layout", kind: "read", handler: compute((i) => { if (typeof i.record === "string") { const errors = validateF121Record(i.record); return { ok: errors.length === 0, errors }; } need(i, "line"); const errors = validateF121Layout(i.line as StatusLine); return { ok: errors.length === 0, errors }; }) },
  { name: "submitAmnFile", kind: "act", handler: compute((i, ctx, rt) => {
      const pm = date(i, "period_month"); need(i, "ack");
      if (i.op === "corrections") {
        const c = transmitCorrections(em(ctx), { period_month: pm, lines: amnLines(i), ack: str(i, "ack"), transmitted_at_ms: ms(i, "transmitted_at", ctx), published_cd10: optDate(i, "published_cd10"), channel: optStr(i, "channel"), servicer_number: optStr(i, "servicer_number") });
        if (c.late) rt.escalations.open({ kind: "officer", payload: { reason: `F-1-21 corrections for ${c.period} transmitted after CD10 17:00 ET — potential compensatory-fee instance`, corrected: c.corrected }, ownerRole: "officer", severity: "sev1" }, ctx.actor);
        return { period: c.period, due_at: new Date(c.due_ms).toISOString(), late: c.late, corrected: c.corrected, status: "corrected" };
      }
      const t = transmitAmnFile(em(ctx), { period_month: pm, lines: amnLines(i), ...(Number.isFinite(num(i, "record_count")) ? { record_count: num(i, "record_count") } : {}), transmitted_at_ms: ms(i, "transmitted_at", ctx), ack: str(i, "ack"), channel: optStr(i, "channel"), servicer_number: optStr(i, "servicer_number"), document_id: optStr(i, "document_id") });
      for (const f of t.flagged_for_review) rt.escalations.open({ kind: "human_agent", loanId: f.loan_id, payload: { reason: "5.7 guardrail: line confidence < 0.85 — review before BD2; the file transmitted on time with the best code, correct by CD10 if the review changes it", status_code: f.status, review_before: new Date(f.review_before_ms).toISOString(), correction_by: new Date(f.correction_by_ms).toISOString() }, ownerRole: "human_agent" }, ctx.actor);
      if (t.late) rt.escalations.open({ kind: "officer", payload: { reason: t.sentinel_line, compfee_instance: t.compfee_instance, period: t.period }, ownerRole: "officer", severity: "sev1" }, ctx.actor);
      return { period: t.period, due_at: new Date(t.due_ms).toISOString(), late: t.late, escalation: t.escalation, compfee_instance: t.compfee_instance, sentinel_line: t.sentinel_line, lines_submitted: t.lines_submitted, flagged_for_review: t.flagged_for_review.map((f) => f.loan_id), status: "submitted" }; }),
    guardrails: [guard("AW_ONCE", "5.7 guardrail: AW once — AW must only be reported for one month (F-1-21)", (i, ctx) => { const prev = priorPeriod(str(i, "period_month")); if (!prev) return undefined; const repeat = amnLines(i).filter((l) => l.status === "AW" && awReportedLastPeriod(ctx, l.loan_id, prev)); return repeat.length ? `AW was reported for ${repeat.map((l) => l.loan_id).join(", ")} in ${prev}; it may not repeat in consecutive periods` : undefined; })] },
  { name: "parseExceptionReport", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "connect_report") { need(i, "report", "period", "document_id"); const r = ingestConnectReport(em(ctx), { report: str(i, "report"), period: str(i, "period"), document_id: str(i, "document_id"), ...(str(i, "available_at") ? { available_at_ms: ms(i, "available_at", ctx) } : {}), servicer_number: optStr(i, "servicer_number"), ...(Number.isFinite(num(i, "loan_count")) ? { loan_count: num(i, "loan_count") } : {}) }); return { report: r.report, period: r.period, event_id: r.event.id }; }
      if (i.op === "final") {
        const r = reconcileFinal(em(ctx), { period_month: date(i, "period_month"), lines: rows(i, "lines"), final: rows(i, "final"), document_id: optStr(i, "document_id"), ...(str(i, "received_at") ? { received_at_ms: ms(i, "received_at", ctx) } : {}), servicer_number: optStr(i, "servicer_number") });
        if (r.status !== "final") rt.escalations.open({ kind: "human_portal_task", payload: { reason: `CD11 final delinquency report for ${r.period} still lists ${r.critical_remaining} critical exception(s) / ${r.mismatched.length} mismatched line(s) — pull the detail and correct`, mismatched: r.mismatched }, ownerRole: "fnma_portal_operator", severity: "sev2" }, ctx.actor);
        return { period: r.period, critical_remaining: r.critical_remaining, mismatched: r.mismatched, status: r.status };
      }
      const fm = date(i, "file_month"); const c = dqExceptionCycle({ file_month: fm, exceptions: rows<DqException>(i, "exceptions"), published_cd10: date(i, "published_cd10") });
      ctx.events.append({ type: "delinquency_reports.exception_parsed", aggregate: { kind: "period", id: optStr(i, "servicer_number") ? `${str(i, "servicer_number")}:${periodOf(fm)}` : periodOf(fm) }, actor: ctx.actor, payload: { period: periodOf(fm), critical: c.critical.length, noncritical: c.noncritical.length, corrections_due_on: c.corrections_due_on, corrections_due_at: new Date(c.corrections_due_ms).toISOString(), final_report_on: c.final_report_on, exception_report_document_id: optStr(i, "document_id"), status: c.status } });
      return c; }) },
  { name: "submitDqEvent", kind: "act", handler: compute((i, ctx) => {
      if (i.op === "response") { need(i, "submission_id", "status"); const r = ingestEventResponse(em(ctx), { loan_id: loanOf(i, ctx), submission_id: str(i, "submission_id"), servicer_action_type: str(i, "servicer_action_type") || str(i, "action"), status: str(i, "status"), warnings: i.warnings, exceptions: i.exceptions, ...(str(i, "received_at") ? { received_at_ms: ms(i, "received_at", ctx) } : {}) }); return { loan_id: r.loan_id, submission_id: r.submission_id, status: r.status, warnings: r.warnings, exceptions: r.exceptions }; }
      need(i, "action");
      if (i.op === "record_action") { need(i, "source_event_id"); const r = recordDelinquencyAction(em(ctx), { loan_id: loanOf(i, ctx), action: str(i, "action"), source_event_id: str(i, "source_event_id"), processed_at_ms: ms(i, "processed_at", ctx), mode: optStr(i, "mode") }); return { loan_id: r.loan_id, servicer_action_type: r.servicer_action_type, submit_by: new Date(r.submit_by_ms).toISOString(), env: r.env, amn_line: r.amn_line, event_id: r.event.id }; }
      const e = submitDelinquencyEvent(em(ctx), { loan_id: loanOf(i, ctx), action: str(i, "action"), processed_at_ms: ms(i, "processed_at", ctx), submitted_at_ms: ms(i, "submitted_at", ctx), mode: optStr(i, "mode"), status_types: i.status_types, reason_types: i.reason_types, ...(typeof i.prior_reason_reported === "boolean" ? { prior_reason_reported: i.prior_reason_reported } : {}), submission_id: optStr(i, "submission_id"), ...(Number.isFinite(num(i, "per_loan_sequence")) ? { per_loan_sequence: num(i, "per_loan_sequence") } : {}), action_event_id: optStr(i, "action_event_id") });
      return { loan_id: e.loan_id, servicer_action_type: e.servicer_action_type, status_types: e.status_types, dropped_status_types: e.dropped_status_types, reason_types: e.reason_types, env: e.env, submit_by: new Date(e.submit_by_ms).toISOString(), on_time: e.on_time, submission_id: e.submission_id, per_loan_sequence: e.per_loan_sequence, amn_line: e.amn_line }; }) },
  { name: "checkConsistency", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "file") {
        const r = fileConsistency(em(ctx), { period_month: date(i, "period_month"), lines: rows<ConsistencyInput>(i, "lines"), servicer_number: optStr(i, "servicer_number") });
        for (const x of r.results) if (x.escalation) rt.escalations.open({ kind: "sev2", loanId: x.loan_id, payload: { reason: `5.7 rule 7: line ${x.line?.status ?? "?"} blocked from the ${r.period} delinquency file — ${x.errors.join("; ")}`, before: new Date(x.escalation.before_ms).toISOString() }, ownerRole: "investor-reporting", severity: "sev2" }, ctx.actor);
        return { period: r.period, checked: r.checked, errors: r.errors, blocked_loans: r.blocked_loans, results: r.results.map((x) => ({ loan_id: x.loan_id, status_code: x.line?.status ?? null, errors: x.errors, blocked: x.blocked })) };
      }
      const f = facts(i); const line = statusLine(f); const errors = line ? lineConsistencyErrors(f, line, { smdu_case_status: optStr(i, "smdu_case_status"), dra_sale_date: optDate(i, "dra_sale_date"), pacer_chapter: optStr(i, "pacer_chapter") }) : [];
      const block = typeof i.period_month === "string" && isoDate(i.period_month) ? consistencyBlock({ loan_id: loanOf(i, ctx), period_month: D(i.period_month), errors }) : null;
      ctx.events.append({ type: "delinquency_report_lines.consistency_checked", loanId: loanOf(i, ctx), actor: ctx.actor, payload: { period: block ? periodOf(D(str(i, "period_month"))) : null, status_code: line?.status ?? null, errors: errors.length, detail: errors, blocked: block?.blocked ?? errors.length > 0 } });
      if (block?.escalation) rt.escalations.open({ kind: "sev2", loanId: loanOf(i, ctx), payload: { reason: `5.7 rule 7: line ${line?.status ?? "?"} blocked — ${errors.join("; ")}`, before: new Date(block.escalation.before_ms).toISOString() }, ownerRole: "investor-reporting", severity: "sev2" }, ctx.actor);
      return { line, errors, ok: errors.length === 0, ...(block ? { blocked: block.blocked, escalation: block.escalation } : {}) }; }) },
  { name: "recordDecision", kind: "write", handler: compute((i, ctx) => {
      if (i.op === "reclass_deselection") { need(i, "period", "decision", "rationale"); const r = recordReclassDeselection(em(ctx), { loan_id: loanOf(i, ctx), period: str(i, "period"), decision: str(i, "decision"), rationale: str(i, "rationale"), servicer_number: optStr(i, "servicer_number"), portal_task_id: optStr(i, "portal_task_id") }); return { loan_id: r.loan_id, decision: r.decision, recorded: true }; }
      return decision()(i, ctx); }),
    decision: (i) => ({ action: i.op === "reclass_deselection" ? "recordDecision:reclass_deselection" : str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) },
]);
