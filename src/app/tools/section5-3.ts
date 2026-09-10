/**
 * §5.3 tools — Reporting liquidations (payoff/foreclosure/short sale). Every tool string is one spec/registry/agents.json
 * names for 5.3 (`selectLiquidationCode`, `computeRemovalAmounts`, `projectEvent`, `buildCrsBatch`, `prepareReogramPackage`,
 * `reconcileDra`, `draftCpmNotice`, `recordDecision`) via `defineTools("5.3", <agent>, defs)` from ../tools.ts —
 * `investor-reporting` (removal reporting and code selection), `claims-reo` (REOgram/TPS packages), `foreclosure-ops`
 * (DRA reconciliation); src/app/tools.test.ts refuses the rest. The section's original 5.3 block moved here from
 * ./section05.ts. Spread by ./index.ts (TOOLS_5_3).
 *
 * The handlers are thin shells over src/domain/investor/ops-5-3.ts (the 5.3 event vocabulary) and ./ops.ts / ./liquidation.ts:
 *   projectEvent{op}: default projects the LAR 96 70/71/72/60 (and, under `mode=event`, the P360 liquidation event JSON,
 *     rule 9 / T9) → `investor_events.projected{family=removal}`; `record_fact` (the liquidation fact: state `fact_recorded`
 *     → `code_selected`) → `liquidation_facts.processed{mode}` arming the LAR clock and, under `mode=event`, the P360 event
 *     clock; `accept_p360` (the parsed fnma-p360 acceptance) → `p360.liquidation_event.accepted`; `post_close_error`
 *     (rule 6 / T6) → `loans.fnma_liquidated_in_error` + `case.opened{kind=qc_finding}` + the `officer` escalation;
 *   draftCpmNotice{op}: `detect` (code change after close, IRM 4-08) → `liquidation.code_change.needed`; default drafts;
 *     `{send=true}` (fnma_portal_operator/officer only) → `cpm.notification.sent`;
 *   prepareReogramPackage{op}: default prepares the P360 confirmation package (rule 8); `open_task` → `reogram.created` +
 *     `human_portal_task.created{task=reogram_confirmation}`; `confirm` (human) → `human_portal_task.completed` +
 *     `reogram.confirmed`; `exception` / `resolve_exception` → `reogram.exception.raised` / `.resolved`;
 *   reconcileDra: rule 7 — a DRA sale-held with no `foreclosure.sale.held` of ours within 1 BD → sev-1 escalation and the
 *     REOgram confirmation task pre-created; our sale events without a DRA entry within 2 BD → `attorney` task; →
 *     `dra.reconciliation.recorded`.
 * Guardrails read the thing being done, not the caller's description: AC 60 is projected only when the loan's history
 * carries `payoff.funds.cleared`; the post-close finality guard derives the removal family from the tool itself (every
 * 5.3 projection is a removal), the correction from `correction` / `supersedes_event_id` / the loan's accepted removal,
 * and the activity period from the input, that acceptance or the legal date; the CPM send is a role gate (the spec's
 * senders), not an unconditional refusal.
 */
import { defineTools, decision, compute, never, needsRole, humanWhen, guard, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import { actionCode, removalAmounts, type LiquidationKind, type InsuredFlag, type SaAdvanceState } from "../../domain/investor/liquidation.ts";
import { larDeadlineMs, removalCorrectionCloseMs, period as periodOf } from "../../domain/investor/period.ts";
import type { ChannelMode, RemittanceType } from "../../domain/investor/types.ts";
import { ET, reconcileDra, reogramConfirmation, projectLiquidationEvent, removalConfidenceHold, tpsProceeds, type DraMilestone } from "../../domain/investor/ops.ts";
import {
  processLiquidationFact, acceptP360LiquidationEvent, codeChangeAfterClose, draftCpmNotice, sendCpmNotice, recordPostCloseRemovalError, preCreateReogramTask, confirmReogram, raiseReogramException, resolveReogramException, removalEventType, RULE_SET_VERSION,
  type Emitter, type LiquidationType, type Purchaser, type P360EventType, type RemovalCode,
} from "../../domain/investor/ops-5-3.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const nowMs = (ctx: CommandContext): number => Date.parse(ctx.now);
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const isoDate = (s: string): s is PlainDate => /^\d{4}-\d{2}-\d{2}$/.test(s);
const em = (i: ToolInput, ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now, loanId: loanOf(i, ctx) });
const liqKind = (i: ToolInput): LiquidationKind => { need(i, "kind"); return str(i, "kind") as LiquidationKind; };
const insuredOf = (i: ToolInput): InsuredFlag => (str(i, "insured") || str(i, "insured_flag") || "none") as InsuredFlag;
const op = (i: ToolInput): string => str(i, "op") || "project";
const CODES: readonly RemovalCode[] = ["60", "70", "71", "72"];
const codeOf = (i: ToolInput, k: string): RemovalCode => { const c = str(i, k); if (!CODES.includes(c as RemovalCode)) throw new RangeError(`${k} ${c} is not one of 60/70/71/72`); return c as RemovalCode; };

// ---- guardrails that read the loan's history --------------------------------------------------------------------------------
/** Rule 6 / guardrail: `removal.payoff` is projected only from `payoff.funds.cleared` — the loan's own event, not a caller flag. */
const fundsCleared = (ctx: CommandContext, loanId: string): boolean => ctx.events.byLoan(loanId).some((e) => e.type === "payoff.funds.cleared");
const noAc60WithoutClearedFunds = guard("NO_AC60_WITHOUT_CLEARED_FUNDS", "5.3 guardrail: never project AC 60 without cleared funds (rule 6: `removal.payoff` is projected only from `payoff.funds.cleared`)",
  (i, ctx) => (op(i) === "project" && str(i, "kind") === "payoff" && !fundsCleared(ctx, loanOf(i, ctx)) ? "no `payoff.funds.cleared` event on this loan — the good-funds gate (SM_PAYOFF_GOODFUNDS_GATE) is still closed" : undefined));
/** The loan's accepted removal (the thing a re-projection would correct) and its activity period. */
const acceptedRemoval = (ctx: CommandContext, loanId: string): { activity_period: string } | null => {
  const evs = ctx.events.byLoan(loanId).filter((e) => e.type === "investor_events.accepted" && ((e.payload as { family?: unknown }).family === "removal" || /^removal\./.test(String((e.payload as { event_type?: unknown }).event_type ?? ""))));
  const last = evs[evs.length - 1]; return last ? { activity_period: String((last.payload as { activity_period?: unknown }).activity_period ?? "") } : null;
};
const isCorrection = (i: ToolInput, ctx: CommandContext): boolean => flag(i, "correction") || (typeof i.supersedes_event_id === "string" && i.supersedes_event_id !== "") || acceptedRemoval(ctx, loanOf(i, ctx)) !== null;
const activityPeriod = (i: ToolInput, ctx: CommandContext): string => {
  const p = str(i, "activity_period"); if (/^\d{4}-\d{2}$/.test(p)) return p;
  const accepted = acceptedRemoval(ctx, loanOf(i, ctx))?.activity_period ?? ""; if (/^\d{4}-\d{2}$/.test(accepted)) return accepted;
  const d = str(i, "legal_date"); return isoDate(d) ? periodOf(D(d)) : "";
};
/** Rule 6 / guardrail "never change a removal after BD2 17:00 ET" (IRM 4-08): every 5.3 projection is a removal; the correction and the period are read off the loan, not the call. */
const noPostCloseRemovalCorrection = guard("NO_REMOVAL_CORRECTION_AFTER_BD2", "5.3 guardrail: never change a removal after BD2 17:00 ET (IRM 4-08; SVC-2026-03 finality) — family from the tool (removal), correction from `correction` / `supersedes_event_id` / the loan's accepted removal",
  (i, ctx) => { if (op(i) !== "project") return undefined; const p = activityPeriod(i, ctx); return isCorrection(i, ctx) && /^\d{4}-\d{2}$/.test(p) && nowMs(ctx) > removalCorrectionCloseMs(p) ? `removal corrections close at BD2 17:00 ET of the month after the ${p} activity period; the removal is final — record the post-close error (projectEvent{op=post_close_error}) or the CPM code change (draftCpmNotice{op=detect}) instead` : undefined; });

const investorReporting = defineTools("5.3", "investor-reporting", [
  { name: "selectLiquidationCode", kind: "read", handler: compute((i) => { const code = actionCode(liqKind(i), insuredOf(i)); const hold = removalConfidenceHold({ confidence: typeof i.confidence === "number" ? i.confidence : 1, deadline_ms: Date.parse(str(i, "deadline_at") || "") || 0, candidates: ["70", "71", "72"], evidence: Array.isArray(i.evidence) ? (i.evidence as string[]) : [] }); return { code, event_type: removalEventType(code), ...hold }; }),
    guardrails: [humanWhen("CODE_CONFIDENCE_090", "5.3 guardrail: confidence < 0.9 on 70 vs 71 vs 72 → hold and escalate to the claims-reo human reviewer before the deadline − 4h", (i) => typeof i.confidence === "number" && i.confidence < 0.9, "insured/purchaser status uncertain: human_agent review")] },
  { name: "computeRemovalAmounts", kind: "read", handler: compute((i) => removalAmounts({ kind: liqKind(i), insured: insuredOf(i), type: (str(i, "type") || "SS") as RemittanceType, actual_upb_cents: cents(i.actual_upb_cents), scheduled_upb_cents: cents(i.scheduled_upb_cents), nib_cents: cents(i.nib_cents), ptr: str(i, "ptr") || "0", legal_date: date(i, "legal_date"), period_open: i.period_open !== false,
      ...(i.interest_cents !== undefined ? { interest_cents: cents(i.interest_cents) } : {}), ...(typeof i.sa_state === "string" ? { sa_state: i.sa_state as SaAdvanceState } : {}), ...(i.total_advanced_interest_cents !== undefined ? { total_advanced_interest_cents: cents(i.total_advanced_interest_cents) } : {}), ...(typeof i.lpi_movement === "string" ? { lpi_movement: i.lpi_movement as "none" | "forward" | "backward" } : {}), ...(typeof i.participation_pct === "string" ? { participation_pct: i.participation_pct } : {}) })) },
  { name: "projectEvent", kind: "write", ruleSetVersion: RULE_SET_VERSION, handler: compute((i, ctx, rt) => {
      switch (op(i)) {
        case "record_fact": {
          need(i, "liquidation_type", "legal_date", "processed_at");
          const { fact, event } = processLiquidationFact(em(i, ctx), { fact_id: optStr(i, "fact_id"), case_id: optStr(i, "case_id"), liquidation_type: str(i, "liquidation_type") as LiquidationType, legal_date: date(i, "legal_date"), processed_at: str(i, "processed_at"),
            purchaser: optStr(i, "purchaser") as Purchaser | null, insured_flag: insuredOf(i), fnma_loss_risk: typeof i.fnma_loss_risk === "boolean" ? i.fnma_loss_risk : null, proceeds_cents: optCents(i, "proceeds_cents"), proceeds_received_at: optStr(i, "proceeds_received_at"), mode: (str(i, "mode") || "legacy") as ChannelMode });
          return { ...fact, proceeds_cents: fact.proceeds_cents, event_id: event.id };
        }
        case "accept_p360": {
          need(i, "fnma_loan_number", "liquidation_event_type", "p360_case_id", "accepted_at");
          const e = acceptP360LiquidationEvent(em(i, ctx), { fact_id: optStr(i, "fact_id"), fnma_loan_number: str(i, "fnma_loan_number"), liquidation_event_type: str(i, "liquidation_event_type") as P360EventType, p360_case_id: str(i, "p360_case_id"), accepted_at: str(i, "accepted_at"), action_code: (optStr(i, "action_code") as RemovalCode | null), env: (optStr(i, "env") as "production" | "api-clve" | null) });
          return { accepted: true, event_id: e.id, ...e.payload };
        }
        case "post_close_error": {
          need(i, "accepted_period", "reported_principal_cents");
          const r = recordPostCloseRemovalError(em(i, ctx), { accepted_period: str(i, "accepted_period"), discovered_at: optStr(i, "discovered_at"), reported_principal_cents: cents(i.reported_principal_cents), reported_interest_cents: cents(i.reported_interest_cents), reason: optStr(i, "reason") });
          const escalation_id = r.after_close ? rt.escalations.open({ kind: "officer", loanId: loanOf(i, ctx), ...(r.case_id ? { caseId: r.case_id } : {}), payload: { reason: "post-close payoff error: the removal is final (IRM 4-08) — remit/advance the amount Fannie Mae is owed per 5.2 and decide the funding; re-add via readd_requests@fanniemae.com or repurchase", amount_due_cents: r.amount_due_cents.toString(), accepted_period: str(i, "accepted_period") } }, ctx.actor).id : null;
          return { ...r, events: r.events.map((e) => e.id), escalation_id };
        }
        case "project": {
          need(i, "kind", "legal_date");
          const p = projectLiquidationEvent({ mode: (str(i, "mode") || "legacy") as ChannelMode, kind: liqKind(i), insured: insuredOf(i), principal_cents: cents(i.principal_cents), interest_cents: cents(i.interest_cents), legal_date: date(i, "legal_date"), fnma_loan_number: str(i, "fnma_loan_number"), cit: flag(i, "cit") });
          const processedMs = Date.parse(str(i, "processed_at") || ctx.now); const due = larDeadlineMs(processedMs, true);
          const eventType = removalEventType(p.lar.action_code); const correction = isCorrection(i, ctx); const period = activityPeriod(i, ctx) || null;
          ctx.events.append({ type: "investor_events.projected", loanId: loanOf(i, ctx), actor: ctx.actor, payload: { family: "removal", event_type: eventType, action_code: p.lar.action_code, env: p.env, mode: str(i, "mode") || "legacy", activity_period: period, correction, supersedes_event_id: optStr(i, "supersedes_event_id"), processed_at: toIso(processedMs), due_at: toIso(due), status: "projected" } });
          return { ...p, event_type: eventType, family: "removal", correction, activity_period: period, due_at_ms: due };
        }
        default: throw new RangeError(`op ${op(i)} is not one of project/record_fact/accept_p360/post_close_error`);
      }
    }),
    guardrails: [noAc60WithoutClearedFunds, noPostCloseRemovalCorrection,
      never("NO_ACCEPT_WITHOUT_RESPONSE", "5.3 state machine: `accepted` is written from the parsed Fannie Mae (Property 360) acceptance only", (i) => op(i) === "accept_p360" && !flag(i, "fnma_response_parsed"), "acceptance is recorded from the parsed fnma-p360 response, never asserted"),
      humanWhen("CODE_CONFIDENCE_090", "5.3 guardrail: confidence < 0.9 on 70 vs 71 vs 72 → hold and escalate to the claims-reo human reviewer before the deadline − 4h", (i) => op(i) === "project" && typeof i.confidence === "number" && num(i, "confidence") < 0.9, "insured/purchaser status uncertain: the removal is held for human_agent review")] },
  { name: "buildCrsBatch", kind: "write", handler: compute((i) => tpsProceeds({ bid_cents: cents(i.bid_cents), received_on: date(i, "received_on"), scheduled_upb_cents: cents(i.scheduled_upb_cents), ptr: str(i, "ptr") || "0", lpi_due: date(i, "lpi_due"), sale_on: date(i, "sale_on"), settlement_on: date(i, "settlement_on") })) },
  { name: "draftCpmNotice", kind: "write", ruleSetVersion: RULE_SET_VERSION, handler: compute((i, ctx) => {
      if (op(i) === "detect") { need(i, "from_code", "to_code", "accepted_period", "reason"); const r = codeChangeAfterClose(em(i, ctx), { from_code: codeOf(i, "from_code"), to_code: codeOf(i, "to_code"), accepted_period: str(i, "accepted_period"), reason: str(i, "reason"), detected_at: optStr(i, "detected_at") }); return { ...r, event_id: r.event?.id ?? null, event: undefined }; }
      if (flag(i, "send")) { need(i, "sent_via", "reference"); const e = sendCpmNotice(em(i, ctx), { kind: (str(i, "kind") || "code_change") as "code_change" | "readd", from_code: str(i, "from_code") ? codeOf(i, "from_code") : null, to_code: str(i, "to_code") ? codeOf(i, "to_code") : null, sent_via: str(i, "sent_via") as "email" | "portal", reference: str(i, "reference"), body: optStr(i, "body") }); return { sent: true, event_id: e.id, ...e.payload }; }
      need(i, "reason"); return draftCpmNotice({ loan_id: loanOf(i, ctx), kind: (str(i, "kind") || "code_change") as "code_change" | "readd", reason: str(i, "reason"), from_code: str(i, "from_code") ? codeOf(i, "from_code") : null, to_code: str(i, "to_code") ? codeOf(i, "to_code") : null }); }),
    guardrails: [needsRole("AGENT_DRAFTS_ONLY", "5.3 guardrail: code-change requests to SF CPM and readd requests are drafted by the agent and sent by fnma_portal_operator/officer", (i) => flag(i, "send"), ["fnma_portal_operator", "officer"], "the agent drafts; a human sends")] },
  { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) },
]);

const claimsReo = defineTools("5.3", "claims-reo", [
  { name: "prepareReogramPackage", kind: "write", ruleSetVersion: RULE_SET_VERSION, handler: compute((i, ctx) => {
      switch (op(i)) {
        case "open_task": { need(i, "source"); const t = preCreateReogramTask(em(i, ctx), { source: str(i, "source") as "p360_notice" | "ac70_72_acceptance" | "dra_sale_event", received_at: optStr(i, "received_at"), sale_date: str(i, "sale_date") ? date(i, "sale_date") : null, p360_case_id: optStr(i, "p360_case_id"), bid_cents: optCents(i, "bid_cents") }); return { ...t, events: t.events.map((e) => e.id) }; }
        case "confirm": { need(i, "p360_case_id", "evidence_document_id"); const evs = confirmReogram(em(i, ctx), { p360_case_id: str(i, "p360_case_id"), evidence_document_id: str(i, "evidence_document_id"), task_id: optStr(i, "task_id"), confirmed_at: optStr(i, "confirmed_at") }); return { confirmed: true, events: evs.map((e) => e.id), ...evs[1]!.payload }; }
        case "exception": { need(i, "p360_case_id", "code"); const e = raiseReogramException(em(i, ctx), { p360_case_id: str(i, "p360_case_id"), code: str(i, "code"), text: optStr(i, "text"), raised_at: optStr(i, "raised_at") }); return { raised: true, event_id: e.id, ...e.payload }; }
        case "resolve_exception": { need(i, "p360_case_id", "code", "evidence_document_id"); const e = resolveReogramException(em(i, ctx), { p360_case_id: str(i, "p360_case_id"), code: str(i, "code"), evidence_document_id: str(i, "evidence_document_id") }); return { resolved: true, event_id: e.id, ...e.payload }; }
        case "project": {
          need(i, "loan_id", "received_at"); const t = reogramConfirmation(Date.parse(str(i, "received_at")));
          return { loan_id: str(i, "loan_id"), package: { sale_date: i.sale_date ?? null, bid_cents: cents(i.bid_cents), occupancy: i.occupancy ?? null, insurance: i.insurance ?? null, hoa: i.hoa ?? null, contacts: i.contacts ?? null, mi_claim_status: i.mi_claim_status ?? null }, ...t, due_at: toIso(t.due_ms), warning_at: toIso(t.warning_at_ms) };
        }
        default: throw new RangeError(`op ${op(i)} is not one of project/open_task/confirm/exception/resolve_exception`);
      }
    }),
    guardrails: [humanWhen("PORTAL_TASK_IS_HUMAN", "5.3 SoR: REOgram confirmation in Property 360 is a Supermortgage portal task (E-4.1-01; `fnma_portal_operator` for REOgram/TPS/DRA/CRS UI steps)", (i) => op(i) === "confirm" || op(i) === "resolve_exception", "the agent prepares the package; the fnma_portal_operator confirms in P360 and captures the evidence")] },
]);

const foreclosureOps = defineTools("5.3", "foreclosure-ops", [
  { name: "reconcileDra", kind: "write", ruleSetVersion: RULE_SET_VERSION, handler: compute((i, ctx, rt) => {
      const asOf = date(i, "as_of"); const loanId = loanOf(i, ctx);
      const r = reconcileDra({ dra: rows<DraMilestone>(i, "dra"), ours: rows<DraMilestone>(i, "ours"), as_of: asOf });
      // rule 7: a DRA sale-held with none of ours → sev-1 ("a REOgram will appear") and the confirmation task pre-created, due 1 `fannie_et` BD
      const receivedAt = wallClock(nowMs(ctx), ET).date === asOf ? ctx.now : toIso(zonedEpochMs(asOf, "09:00", ET));
      const sev1 = r.sev1.map((s) => {
        const escalation = rt.escalations.open({ kind: "sev1", loanId, severity: "sev1", payload: { reason: `DRA "${s.milestone.type}" dated ${s.milestone.date} from the firm feed has no matching foreclosure.sale.held in our system (5.3 rule 7)`, milestone: s.milestone, reogram_task_due: s.reogram_task_due } }, ctx.actor);
        const task = preCreateReogramTask(em(i, ctx), { source: "dra_sale_event", received_at: receivedAt, sale_date: s.milestone.date });
        return { ...s, escalation_id: escalation.id, task_id: task.task_id, reogram_task_due: task.due_on, reogram_task_due_at: task.due_at };
      });
      // our sale events without a DRA entry within 2 BD → task to the firm (the firm, not the servicer, enters DRA)
      const firm_tasks = r.firm_tasks.map((m) => ({ milestone: m, escalation_id: rt.escalations.open({ kind: "attorney", loanId, payload: { reason: `our ${m.type} dated ${m.date} has no DRA entry within 2 BD — the firm must enter the milestone (5.3 rule 7 / A4-2.2 retention addendum)`, milestone: m } }, ctx.actor).id }));
      ctx.events.append({ type: "dra.reconciliation.recorded", loanId, actor: ctx.actor, payload: { as_of: asOf, matched: r.matched, sev1: r.sev1.length, firm_tasks: r.firm_tasks.length, dra_count: rows(i, "dra").length, ours_count: rows(i, "ours").length } });
      return { as_of: asOf, matched: r.matched, sev1, firm_tasks }; }) },
]);

export const TOOLS_5_3: readonly ToolDef[] = [...investorReporting, ...claimsReo, ...foreclosureOps];
export type { ToolRuntime };
