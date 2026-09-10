/**
 * §14.4 tools — the bankruptcy feed into 8.3's overlay engine (`bankruptcy-ops`):
 * `bk.reporting_state.write` (one state row per filer; `op: "retract"` for a
 * false match; `op: "review"` for the docket-check review of a standing row),
 * `bk.case.read` and `escalation.file`, verbatim from the spec's Agents paragraph.
 * Guardrails encode the paragraph: no state row without a verified case and
 * evidence; non-filing obligors never receive a row; `debt_discharged=true`
 * requires the discharge order document; reaffirmation is not `final` until the
 * rescission window lapses; the agent cannot create suppressions directly (only
 * 8.3 does, from the state row). The filer set and the verification come from the
 * 14.1 case record (`bankruptcy_cases`), never from the caller's say-so — so the
 * handler re-checks the same guardrails against the record and records a typed
 * `command.refused` under the guardrail's code (the bus's input-level predicate
 * can only see what the caller volunteers). Spread by ./section14.ts.
 */
import { defineTools, compute, read, escalate, never, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Chapter } from "../../domain/bankruptcy/case.ts";
import { stateRow, falseMatchReversal, suppressionRequest, rescissionWindowEnds, RULE_SET_VERSION, type FeedEvent, type FurnishedCycle, type ReportingStateRow, type StateRowInput, type RefusalCode } from "../../domain/bankruptcy/ops-14-4.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const money = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v : BigInt(String(v)));
const AGENT = "bankruptcy-ops";
const KIND = "bankruptcy_reporting_state";
const CASES = "bankruptcy_cases";
const TOOL = "bk.reporting_state.write";
const rowId = (loanId: string, borrowerId: string): string => `${loanId}:${borrowerId}`;

/** The rescission window has not lapsed on `as_of` for the reaffirmation the input describes (the window includes its last day). */
const inRescissionWindow = (i: ToolInput): boolean => {
  const filed = optDate(i, "reaffirmation_filed_on"), asOf = optDate(i, "as_of");
  return Boolean(filed && asOf && asOf <= rescissionWindowEnds(filed, optDate(i, "discharge_date")));
};

/** The 14.1 case record (`bankruptcy_cases`: `filer_borrower_ids`, `verification` {sources, pcl_case_id, verified_at, verified_by}). */
const caseRecord = (rt: ToolRuntime, caseId: string): Record<string, unknown> | null =>
  rt.store.get(CASES, caseId)?.data ?? rt.store.list(CASES, (d) => d.case_id === caseId || d.case_number_full === caseId)[0]?.data ?? null;
/** Filer identity as 14.1 verified it; null when the record does not carry it. */
const caseFilers = (kase: Record<string, unknown> | null): string[] | null => (kase && Array.isArray(kase.filer_borrower_ids) ? ids(kase.filer_borrower_ids) : null);
/** 14.1's verification record on the case (`verification.verified_at` / `verified_by`, or an explicit verified flag/status). */
const caseVerified = (kase: Record<string, unknown>): boolean => {
  const v = kase.verification as Record<string, unknown> | undefined;
  return kase.verified === true || kase.identity_verified === true || kase.status === "verified" || kase.verification_status === "verified" || Boolean(v && typeof v === "object" && (v.verified_at || v.verified_by || v.outcome === "verified"));
};

/** The guardrail text each `stateRow` refusal code enforces (the same citations the bus-level predicates carry). */
const GUARDRAIL_CITATION: Record<RefusalCode, string> = {
  NON_FILER_NEVER_GETS_ROW: "14.4 rule 1 / guardrail: non-filing obligors never receive a row (the §1301 co-debtor stay restricts collection, not accurate reporting)",
  NO_ROW_WITHOUT_VERIFIED_CASE: "14.4 guardrail: no state row without a verified case and evidence",
  DISCHARGE_ORDER_REQUIRED: "14.4 guardrail: `debt_discharged=true` requires the discharge order document",
  REAFFIRMATION_NOT_FINAL: "14.4 guardrail: reaffirmation is not `final` until the §524(c)(4) rescission window lapses (SM_BK_CR_REAFFIRM_HOLD)",
  STATUS_AT_PETITION_DERIVED: "14.4 rule 2: `status_at_petition` is 8.1's day count on the petition date — derived, never asserted",
};
/** A refusal the handler finds on the record (not the input) is recorded exactly as the bus records a guardrail refusal: `command.refused{code}` then `CommandRefused`. */
function refuseTyped(ctx: CommandContext, i: ToolInput, code: RefusalCode, reason: string): never {
  ctx.events.append({ type: "command.refused", loanId: str(i, "loan_id") || ctx.loanId, actor: ctx.actor, payload: { command: TOOL, code, citation: GUARDRAIL_CITATION[code], reason, subject_id: rowId(str(i, "loan_id"), str(i, "borrower_id")) } });
  throw new CommandRefused(TOOL, code, GUARDRAIL_CITATION[code], reason);
}

/** 8.3 suppression-row fields: their presence on a feed call is an attempt to create the suppression here rather than let 8.3 derive it from the row. */
const SUPPRESSION_FIELDS = ["mechanism", "codes", "suppression", "suppression_id", "create_suppression", "release_suppression"] as const;
const asksForSuppression = (i: ToolInput): boolean =>
  ["create_suppression", "release_suppression", "suppress", "suppression"].includes(str(i, "op")) || SUPPRESSION_FIELDS.some((k) => i[k] !== undefined && i[k] !== null && i[k] !== "" && i[k] !== false) || /^credit\.suppression\./.test(str(i, "tool"));

/** The spec's decision record: `{case_id, borrower_id, trigger_event_id, phase, fields_written, evidence_document_id, rule_set_version, rationale}`. */
interface FeedDecision { readonly case_id: string; readonly borrower_id: string; readonly trigger_event_id: string | null; readonly phase: string | null; readonly fields_written: readonly string[]; readonly evidence_document_id: string | null; readonly rule_set_version: string; readonly rationale: string; }
const ROW_FIELDS: readonly (keyof ReportingStateRow)[] = ["loan_id", "borrower_id", "case_id", "chapter", "phase", "petition_date", "confirmation_date", "discharge_date", "dismissal_date", "reaffirmation_date", "reaffirmation_final", "debt_discharged", "status_at_petition", "post_petition_payment_cents", "plan_cures_arrears", "postpetition_days_delinquent", "cramdown", "cii_current", "surrendered", "discharge_order_document_id", "evidence_document_id", "rule_set_version", "retracted"];
/** The fields a write changed against the prior version (every field on the first version). */
const fieldsWritten = (prior: ReportingStateRow | null, row: ReportingStateRow): string[] =>
  ROW_FIELDS.filter((k) => !prior || JSON.stringify(prior[k], bigintJson) !== JSON.stringify(row[k], bigintJson));
const bigintJson = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export const TOOLS_14_4: readonly ToolDef[] = defineTools("14.4", AGENT, [
  { name: "bk.case.read", kind: "read", handler: read(CASES) },
  { name: TOOL, kind: "write", ruleSetVersion: RULE_SET_VERSION,
    handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "borrower_id", "case_id");
      const loanId = str(i, "loan_id"), borrowerId = str(i, "borrower_id"), caseId = str(i, "case_id");
      const stored = (rt.store.get(KIND, rowId(loanId, borrowerId))?.data as unknown as ReportingStateRow | undefined) ?? null;
      const prior = stored && !stored.retracted ? stored : null;
      if (i.op === "retract") {
        // rule 10 / T8: a same-name false match reversed by 14.1 — no state row of the case survives
        need(i, "reversed_on", "evidence_document_id");
        const rows = rt.store.list(KIND, (d) => d.case_id === caseId).map((r) => r.data as unknown as ReportingStateRow);
        const r = falseMatchReversal({ reversed_on: date(i, "reversed_on"), rows, furnished: (i.furnished as FurnishedCycle[] | undefined) ?? [], evidence_document_id: str(i, "evidence_document_id") });
        for (const row of r.retracted) {
          const rec = rt.store.put(KIND, rowId(row.loan_id, row.borrower_id), row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
          ctx.events.append({ type: "bankruptcy.reporting_state.retracted", loanId: row.loan_id, aggregate: { kind: KIND, id: rec.id }, actor: ctx.actor, payload: { borrower_id: row.borrower_id, case_id: caseId, reason: "false_match", trigger_event_id: optStr(i, "trigger_event_id"), release: r.releases.find((x) => x.party_id === row.borrower_id) ?? null, version: rec.version } });
        }
        for (const aud of r.auds) ctx.events.append({ type: "credit.correction.requested", loanId, actor: ctx.actor, payload: { ...aud } });
        rt.escalations.open({ kind: r.escalation.kind, loanId, payload: { reason: r.escalation.reason, case_id: caseId, auds: r.auds.length }, caseId }, ctx.actor);
        return { retracted: r.retracted.length, surviving_rows: r.surviving_rows.length, auds: r.auds, aud_due: r.aud_due, escalation: r.escalation.kind, fields_written: r.retracted.length ? ["retracted", "retracted_on", "retraction_reason", "evidence_document_id"] : [] };
      }
      // rule 1 / guardrails: the filer set and the verification are the 14.1 case record's (prerequisite: "14.1 case record with verified filer
      // identity"); a caller-supplied `filer_borrower_ids` is only cross-checked by the bus-level guardrail, never the source of a row
      const kase = caseRecord(rt, caseId);
      if (!kase) refuseTyped(ctx, i, "NO_ROW_WITHOUT_VERIFIED_CASE", `no 14.1 case record for ${caseId} — no state row without a verified case and evidence (read it with bk.case.read)`);
      const filers = caseFilers(kase) ?? [];
      const verified = caseVerified(kase) && i.case_verified !== false;
      if (i.op === "review") {
        // SM_CR_SUPPRESSION_REVIEW_30 (14.4 row: "review with docket check (14.1 daily sync)") / SM_BK_CR_STATE_SYNC_1BD for a case write that is not
        // a phase event: the standing row is checked against the case record — filer still on the case, case still verified, the row's phase
        // consistent with the case status — and the review is recorded; an inconsistency is the human_agent's (breach role) to resolve
        const caseStatus = str(kase, "status");
        const stale = prior ? (caseStatus === "dismissed" && prior.phase !== "dismissed" && prior.phase !== "withdrawn") || (caseStatus === "discharged" && prior.phase !== "discharged" && prior.phase !== "reaffirmed") || !filers.includes(borrowerId) : false;
        if (stale) rt.escalations.open({ kind: "human_agent", loanId, payload: { reason: `bankruptcy_reporting_state ${rowId(loanId, borrowerId)} (phase ${prior!.phase}) disagrees with the 14.1 case record (status ${caseStatus || "n/a"}; filers ${filers.join(",") || "none"}) — a stale freeze is an inaccuracy (14.4 SM_CR_SUPPRESSION_REVIEW_30)`, case_id: caseId }, caseId }, ctx.actor);
        ctx.events.append({ type: "bankruptcy.reporting_state.reviewed", loanId, actor: ctx.actor, payload: { borrower_id: borrowerId, case_id: caseId, docket_checked: true, consistent: !stale, phase: prior?.phase ?? null, case_status: caseStatus || null, verified, trigger_event_id: optStr(i, "trigger_event_id") } });
        // the standing row is what 8.3's bankruptcy suppression was derived from, so this docket-check review is that suppression's 30-day review
        // ("review recorded", 8.3's row; "review with docket check", 14.4's) — recorded under 8.3's event so SM_CR_SUPPRESSION_REVIEW_30 re-arms on it
        if (prior) { const sup = suppressionRequest(prior); ctx.events.append({ type: "credit.suppression.reviewed", loanId, actor: ctx.actor, payload: { party_id: borrowerId, reason: sup.reason, mechanism: sup.mechanism, codes: sup.codes, docket_checked: true, consistent: !stale, case_id: caseId, reviewed_at: ctx.now } }); }
        return { reviewed: true, docket_checked: true, consistent: !stale, phase: prior?.phase ?? null, suppression_reviewed: prior ? suppressionRequest(prior).reason : null, escalation: stale ? "human_agent" : null };
      }
      need(i, "chapter", "event", "event_on", "petition_date");
      const input: StateRowInput = {
        case_id: caseId, case_verified: verified, loan_id: loanId, borrower_id: borrowerId, filer_borrower_ids: filers,
        chapter: str(i, "chapter") as Chapter, event: str(i, "event") as FeedEvent, event_on: date(i, "event_on"), evidence_document_id: optStr(i, "evidence_document_id"), petition_date: date(i, "petition_date"),
        prior, debtor_motion: flag(i, "debtor_motion"),
        // rule 2: the frozen status is derived from 8.1's day count (the contract-terms earliest unpaid installment, or the day count 8.1 reports)
        earliest_unpaid_due_at_petition: optDate(i, "earliest_unpaid_due_at_petition") ?? optDate(i, "earliest_unpaid_due"), days_delinquent_at_petition: typeof i.days_delinquent_at_petition === "number" ? i.days_delinquent_at_petition : null,
        status_at_petition: optStr(i, "status_at_petition"),
        ...(typeof i.debt_discharged === "boolean" ? { debt_discharged: i.debt_discharged } : {}),
        discharge_order_document_id: optStr(i, "discharge_order_document_id"), discharge_date: optDate(i, "discharge_date"),
        treatment: (optStr(i, "treatment") as StateRowInput["treatment"]) ?? null,
        reaffirmation_filed_on: optDate(i, "reaffirmation_filed_on"), as_of: optDate(i, "as_of") ?? D(ctx.now.slice(0, 10)),
        plan_cures_arrears: typeof i.plan_cures_arrears === "boolean" ? i.plan_cures_arrears : null, post_petition_payment_cents: money(i.post_petition_payment_cents),
        postpetition_days_delinquent: typeof i.postpetition_days_delinquent === "number" ? i.postpetition_days_delinquent : null,
        cramdown: (i.cramdown as { secured_balance_cents: bigint; payment_cents: bigint } | undefined) ?? null,
      };
      const r = stateRow(input);
      if (r.refusal) refuseTyped(ctx, i, r.refusal_code ?? "NO_ROW_WITHOUT_VERIFIED_CASE", r.refusal);
      if (!r.row) {
        // rule 8 / rule 6: the event was consumed and changes nothing (relief from stay; the routine closure after a discharge) — recorded for the trail, no row written
        ctx.events.append({ type: "bankruptcy.reporting_state.reviewed", loanId, actor: ctx.actor, payload: { borrower_id: borrowerId, case_id: caseId, event: str(i, "event"), no_change: true, docket_checked: false, phase: prior?.phase ?? null, trigger_event_id: optStr(i, "trigger_event_id") } });
        return { written: false, no_change: true, phase: prior?.phase ?? null, sync_due: r.sync_due, fields_written: [] };
      }
      const rec = rt.store.put(KIND, rowId(loanId, borrowerId), r.row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      const suppression = suppressionRequest(r.row);
      // the prior row's suppression (e.g. the petition `freeze_status`) is superseded when this row asks for a different one: 8.3 releases it with
      // this event as the reason/evidence and creates the new row — the feed never calls credit.suppression.create/release itself (guardrail)
      const before = prior ? suppressionRequest(prior) : null;
      const supersedes = before && (before.reason !== suppression.reason || before.mechanism !== suppression.mechanism || before.codes.join() !== suppression.codes.join()) ? before : null;
      const fields = fieldsWritten(prior, r.row);
      ctx.events.append({ type: r.event!, loanId, aggregate: { kind: KIND, id: rec.id }, actor: ctx.actor, payload: { borrower_id: borrowerId, case_id: caseId, trigger_event_id: optStr(i, "trigger_event_id"), event: str(i, "event"), phase: r.row.phase, chapter: r.row.chapter, debt_discharged: r.row.debt_discharged, cii_current: r.row.cii_current,
        discharge_date: r.row.discharge_date, dismissal_date: r.row.dismissal_date, reaffirmation_date: r.row.reaffirmation_date, reaffirmation_final: r.row.reaffirmation_final, suppression, supersedes, fields_written: fields, evidence_document_id: r.row.evidence_document_id, version: rec.version, sync_due: r.sync_due } });
      return { ...rec.data, written: true, sync_due: r.sync_due, suppression, supersedes, fields_written: fields };
    }),
    decision: (i, out) => {
      const o = (out ?? {}) as { phase?: string | null; fields_written?: readonly string[]; retracted?: number; no_change?: boolean; reviewed?: boolean };
      const op = str(i, "op") || "write";
      const record: FeedDecision = { case_id: str(i, "case_id"), borrower_id: str(i, "borrower_id"), trigger_event_id: optStr(i, "trigger_event_id"), phase: o.phase ?? (op === "retract" ? "retracted" : null), fields_written: o.fields_written ?? [],
        evidence_document_id: optStr(i, "evidence_document_id"), rule_set_version: RULE_SET_VERSION,
        rationale: str(i, "rationale") || (op === "retract" ? `false match reversed: ${o.retracted ?? 0} state row(s) retracted (14.4 rule 10)` : op === "review" ? "docket-check review of the standing row (14.4 SM_CR_SUPPRESSION_REVIEW_30)" : `${str(i, "event")} → ${o.no_change ? `no reporting change (phase stays ${o.phase ?? "none"})` : `phase ${o.phase ?? "none"}`} for filer ${str(i, "borrower_id")}`) };
      return { action: `${TOOL}:${op}`, rationale: JSON.stringify(record), subject: { kind: KIND, id: rowId(str(i, "loan_id"), str(i, "borrower_id")) }, ruleCode: op === "retract" ? "14.4 rule 10" : op === "review" ? "14.4 SM_CR_SUPPRESSION_REVIEW_30" : "14.4 rules 1-7", ...(str(i, "evidence_document_id") ? { evidenceDocumentIds: [str(i, "evidence_document_id")] } : {}) };
    },
    guardrails: [
      never("NO_ROW_WITHOUT_VERIFIED_CASE", GUARDRAIL_CITATION.NO_ROW_WITHOUT_VERIFIED_CASE, (i) => i.op !== "retract" && i.op !== "review" && (i.case_verified === false || !str(i, "evidence_document_id")), "verify the case in 14.1 (the handler reads its verification record) and attach the docket evidence document"),
      never("NON_FILER_NEVER_GETS_ROW", GUARDRAIL_CITATION.NON_FILER_NEVER_GETS_ROW, (i) => i.op !== "retract" && i.op !== "review" && Array.isArray(i.filer_borrower_ids) && str(i, "borrower_id") !== "" && !ids(i.filer_borrower_ids).includes(str(i, "borrower_id")), "only the 14.1 case record's filer_borrower_ids receive a state row (the handler re-checks the record and refuses under this code); the co-obligor keeps contractual reporting"),
      never("DISCHARGE_ORDER_REQUIRED", GUARDRAIL_CITATION.DISCHARGE_ORDER_REQUIRED, (i) => flag(i, "debt_discharged") && !str(i, "discharge_order_document_id") && str(i, "event") !== "bankruptcy.case.discharged", "attach the discharge order"),
      never("REAFFIRMATION_NOT_FINAL", GUARDRAIL_CITATION.REAFFIRMATION_NOT_FINAL, (i) => (str(i, "event") === "bankruptcy.reaffirmation.final" || flag(i, "reaffirmation_final")) && inRescissionWindow(i), "hold; CII stays A through the later of the discharge and 60 days after filing"),
      // the feed writes the row; 8.3's `credit.suppression.create/release` is not in 14.4's tool list, and a call that carries 8.3's suppression-row
      // fields (mechanism/codes/suppression…) or a suppression op is refused rather than silently ignored
      never("NO_DIRECT_SUPPRESSION", "14.4 guardrail: the agent cannot create suppressions directly (only 8.3 does, from the state row)", asksForSuppression, "write the state row; 8.3 derives the suppression, codes and mechanism from it (credit.suppression.create/release is 8.3's tool)"),
    ] },
  { name: "escalation.file", kind: "act", handler: escalate("officer"), decision: (i) => ({ action: "escalation.file", rationale: str(i, "reason") || "14.4 credit feed escalation (attorney: liability unclear; officer: systemic correction or any deletion; human_agent on request)" }) },
]);
