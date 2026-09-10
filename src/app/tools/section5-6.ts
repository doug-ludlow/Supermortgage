/**
 * §5.6 tools — Repurchase reporting (`investor-reporting`). Every tool string is one spec/registry/agents.json names for
 * 5.6, via `defineTools("5.6", "investor-reporting", defs)` from ../tools.ts; src/app/tools.test.ts refuses the rest.
 * `draftLetter` and `openPortalTask` stay in ./section05.ts; the three write tools moved here and are thin shells over
 * src/domain/investor/ops-5-6.ts, which owns the event vocabulary the 5.6 timer rows arm on and are satisfied by:
 *   projectEvent: the repurchase processed → `repurchase.processed{processed_at}` (FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000) and,
 *     with the approval document on file, `investor_events.projected{event_type=removal.repurchase, action_code 65|67}`
 *     with the original processed timestamp (T5); without it the projection is blocked and the `officer` escalation opened.
 *     Guardrails: LAR65_NEEDS_APPROVAL_DOC (and the id must name a stored document), NO_REMOVAL_CORRECTION_AFTER_BD2 — a
 *     5.6 projection is always a removal, so any projection after BD2 17:00 ET of the month following the processed
 *     activity period is refused without the caller having to label it (rule 5: written justification to the Investor
 *     Reporting Representative, officer-signed);
 *   buildCrsBatch{op}: `build` (CRS code by proceeds type: A/A 001, make-whole 309, REO 315, recoverable advances 352;
 *     S/S, MBS Express and S/A are drafted, not requested), `schedule` (LAR 65/67 accepted → `repurchase.proceeds.scheduled
 *     {remittance_due_on}`, FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE), `match` (bank match → `remittances.funded{kind=repurchase}`
 *     + `repurchase.proceeds.matched{matched_on}`, the ledger set Dr fnma_remittance_payable Cr corporate cash);
 *   recordDecision{decision_kind}: the case actions of the A1-3-02 ladder and the close — `demand_received`,
 *     `file_review_selected`, `documents_submitted`, `appeal_decided` (officer), `appeal_denied`, `stage_entered`,
 *     `stage_action_recorded` (officer), `ownership_updated` — each appends its event, then the decision row; without a
 *     `decision_kind` it is the plain decision record.
 */
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { CommandContext } from "../commands.ts";
import { defineTools, compute, guard, never, needsRole, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { period as periodOf, removalCorrectionCloseMs } from "../../domain/investor/period.ts";
import { ET } from "../../domain/investor/ops.ts";
import { mbsRepurchasePrice, portfolioAaRepurchasePrice } from "../../domain/investor/repurchase.ts";
import { processRepurchase, scheduleRepurchaseProceeds, matchRepurchaseProceeds, ingestRepurchaseDemand, ingestFileReviewSelection, submitReviewDocuments, recordAppealDecision, ingestAppealDenial, enterAppealStage, recordStageAction, updateRepurchaseOwnership,
  type Emitter, type DemandKind, type AppealStage, type AppealOutcome, type LadderStage, type ProceedsCycle } from "../../domain/investor/ops-5-6.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const list = (i: ToolInput, k: string): string[] => { const v = i[k]; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; };
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const em = (ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const nowMs = (ctx: CommandContext): number => Date.parse(ctx.now);
const rtype = (i: ToolInput): "AA" | "SA" | "SS" => { const t = str(i, "remittance_type").toUpperCase().replace("/", ""); if (t !== "AA" && t !== "SA" && t !== "SS") throw new RangeError("remittance_type must be A/A, S/A or S/S"); return t; };
const processedMs = (i: ToolInput): number => { need(i, "processed_at"); const ms = Date.parse(str(i, "processed_at")); if (!Number.isFinite(ms)) throw new RangeError("processed_at must be an ISO instant"); return ms; };
/** The activity period a 5.6 removal reports in: the caller's, else the ET month the repurchase was processed in. */
const activityPeriod = (i: ToolInput): string | null => { const p = str(i, "activity_period"); if (/^\d{4}-\d{2}$/.test(p)) return p; const ms = Date.parse(str(i, "processed_at")); return Number.isFinite(ms) ? periodOf(wallClock(ms, ET).date) : null; };

export const TOOLS_5_6: readonly ToolDef[] = defineTools("5.6", "investor-reporting", [
  { name: "projectEvent", kind: "write", handler: compute((i, ctx, rt) => {
      const docId = str(i, "approval_document_id"); if (!rt.store.get("documents", docId)) throw new RangeError(`approval_document_id ${docId} is not a document on file — attach the signed approval (offer acceptance / uncontested or upheld demand) before the LAR 65/67 is projected`);
      const price = i.scheduled_upb_cents !== undefined ? mbsRepurchasePrice(cents(i.scheduled_upb_cents), str(i, "ptr") || "0")
        : i.actual_upb_cents !== undefined ? portfolioAaRepurchasePrice(cents(i.actual_upb_cents), str(i, "purchase_price_pct") || "100", str(i, "ptr") || "0", date(i, "lpi_date"), date(i, "effective_date"), cents(i.expenses_cents)) : null;
      const r = processRepurchase(em(ctx), { repurchase_id: str(i, "repurchase_id"), loan_id: loanOf(i, ctx), processed_at_ms: processedMs(i), approval_document_id: docId, arm_modification_feature: flag(i, "arm_modification_feature"), effective_date: date(i, "effective_date"), remittance_type: rtype(i), ...(price ? { price_cents: price.price_cents } : {}) });
      return { blocked: r.blocked, escalation: r.escalation, replayed: r.replayed, event: r.projected ? { action_code: r.action_code, processed_at: r.processed.payload.processed_at, due_at: r.projected.payload.due_at, event_id: r.projected.id } : null, price }; }),
    guardrails: [never("LAR65_NEEDS_APPROVAL_DOC", "5.6 guardrail: LAR 65/67 is projected only after the approval document is attached", (i) => !i.approval_document_id, "attach the approval document; an officer escalation is open until then"),
      guard("NO_REMOVAL_CORRECTION_AFTER_BD2", "5.6 guardrail: no removal correction after BD2 17:00 ET (IRM 4-08); rule 5: after close an action-date change requires a written justification letter to the Investor Reporting Representative, officer-signed",
        (i, ctx) => { const p = activityPeriod(i); return p !== null && nowMs(ctx) > removalCorrectionCloseMs(p) ? `the ${p} removal reporting closed at BD2 17:00 ET of the following month; a LAR 65/67 for that period is now a post-close change — draft the written justification for the officer and the Investor Reporting Representative instead` : undefined; })] },
  { name: "buildCrsBatch", kind: "write", handler: compute((i, ctx) => {
      const op = str(i, "op") || "build";
      if (op === "schedule") { need(i, "accepted_event_id", "activity_period"); const r = scheduleRepurchaseProceeds(em(ctx), { repurchase_id: str(i, "repurchase_id"), loan_id: loanOf(i, ctx), accepted_event_id: str(i, "accepted_event_id"), accepted_on: date(i, "accepted_on"), activity_period: str(i, "activity_period"), remittance_type: rtype(i), mbs_express: flag(i, "mbs_express"), amount_cents: cents(i.amount_cents), ...(i.kind === "make_whole" || i.kind === "reo" ? { kind: i.kind } : {}) });
        return { ...r.due, instruct_by_at: r.due.instruct_by_ms === null ? null : new Date(r.due.instruct_by_ms).toISOString(), event_id: r.event.id, funding_source: "responsible_party" }; }
      if (op === "match") { const r = matchRepurchaseProceeds(em(ctx), { repurchase_id: str(i, "repurchase_id"), loan_id: loanOf(i, ctx), remittance_id: str(i, "remittance_id"), expected_cents: cents(i.expected_cents), received_cents: cents(i.received_cents), matched_on: date(i, "matched_on"), remittance_type: rtype(i), cycle: (str(i, "cycle") || "aa_crs_001") as ProceedsCycle, bank_reference: str(i, "bank_reference") });
        return { status: "funded", funded_event_id: r.funded.id, matched_event_id: r.matched.id, ledger: r.ledger }; }
      if (op !== "build") throw new RangeError(`op ${op} is not one of build/schedule/match`);
      need(i, "type"); const t = str(i, "type"); const code = t === "AA" ? "001" : t === "make_whole" ? "309" : t === "reo" ? "315" : t === "advances" ? "352" : null;
      if (code === null && t !== "SS" && t !== "SA" && t !== "mbs_express") throw new RangeError("type must be AA, SS, SA, mbs_express, make_whole, reo or advances");
      return { crs_code: code, drafted_by_type: code === null, amount_cents: cents(i.amount_cents), funding_source: "responsible_party" }; }) },
  { name: "recordDecision", kind: "write", handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => {
      const kind = str(i, "decision_kind"); const e = em(ctx); const loan_id = loanOf(i, ctx); const repurchase_id = str(i, "repurchase_id");
      let effect: unknown = null;
      switch (kind) {
        case "": break;
        case "demand_received": effect = ingestRepurchaseDemand(e, { repurchase_id, loan_id, received_on: date(i, "received_on"), demand_kind: (str(i, "demand_kind") || "repurchase") as DemandKind, amount_cents: cents(i.amount_cents), demand_document_id: str(i, "demand_document_id"), loan_liquidated: flag(i, "loan_liquidated") }); break;
        case "file_review_selected": effect = ingestFileReviewSelection(e, { repurchase_id, loan_id, selected_on: date(i, "selected_on"), notification_document_id: str(i, "notification_document_id") }); break;
        case "documents_submitted": { const ids = list(i, "document_ids"); for (const d of ids) if (!rt.store.get("documents", d)) throw new RangeError(`document ${d} is not on file`); effect = submitReviewDocuments(e, { repurchase_id, loan_id, document_ids: ids }); break; }
        case "appeal_decided": effect = recordAppealDecision(e, { repurchase_id, loan_id, stage: Number(i.stage) as AppealStage, outcome: str(i, "outcome") as AppealOutcome, decision_document_id: str(i, "decision_document_id"), decided_on: date(i, "decided_on") }); break;
        case "appeal_denied": effect = ingestAppealDenial(e, { repurchase_id, loan_id, stage: Number(i.stage) as AppealStage, received_on: date(i, "received_on"), denial_document_id: str(i, "denial_document_id") }); break;
        case "stage_entered": effect = enterAppealStage(e, { repurchase_id, loan_id, stage: str(i, "stage") as LadderStage, entered_on: date(i, "entered_on") }); break;
        case "stage_action_recorded": effect = recordStageAction(e, { repurchase_id, loan_id, stage: str(i, "stage") as LadderStage, action: str(i, "action_taken"), recorded_on: date(i, "recorded_on"), document_id: str(i, "document_id"), next_stage: (str(i, "next_stage") || null) as LadderStage | null }); break;
        case "ownership_updated": effect = updateRepurchaseOwnership(e, { repurchase_id, loan_id, mers_confirmation_id: str(i, "mers_confirmation_id"), custodian_release_id: str(i, "custodian_release_id"), investor: str(i, "investor"), updated_on: date(i, "updated_on"), quit_claim_document_id: str(i, "quit_claim_document_id") || null, acquired_property: flag(i, "acquired_property") }); break;
        default: throw new RangeError(`decision_kind ${kind} is not one of demand_received/file_review_selected/documents_submitted/appeal_decided/appeal_denied/stage_entered/stage_action_recorded/ownership_updated`);
      }
      const ev = effect && typeof effect === "object" && "id" in effect ? (effect as { id: string }).id : effect && typeof effect === "object" && "event" in effect ? (effect as { event: { id: string } }).event.id : null;
      return { recorded: true, decision_kind: kind || null, event_id: ev }; },
    decision: (i) => ({ action: str(i, "action") || (str(i, "decision_kind") ? `repurchase.${str(i, "decision_kind")}` : "recordDecision"), rationale: str(i, "rationale") || `5.6 ${str(i, "decision_kind") || "decision"} for ${str(i, "repurchase_id")}` }),
    guardrails: [needsRole("NEVER_COMMITS_PARTNER", "5.6 guardrail: the agent never commits the partner — every offer, acceptance, appeal and payment authorization is an officer escalation", (i) => i.decision_kind === "appeal_decided" || i.decision_kind === "stage_action_recorded", ["officer"], "appeal decisions and ladder stage actions are officer decisions; the agent prepares the package")] },
]);
