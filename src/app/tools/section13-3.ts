/**
 * §13.3 process-owned tool paths. 13.3 names no tools of its own in spec/registry/agents.json (`tools: []`), so
 * `TOOLS_13_3` stays empty and the referral lifecycle rides on two §13 tools already on the bus from ./section13.ts:
 *   attorney.instruction.status{op=firm_message, kind, …}  inbound attorney-network messages (13.3 Integrations) —
 *       ACK{complete, missing[]} · DOCUMENT_REQUEST · ADVANCE_REQUEST · SALE_SCHEDULED · MILESTONE — each validated by
 *       src/domain/foreclosure/ops-13-3.ts and appended as the event the process's registry rows arm on / are satisfied by
 *   attorney.message.send{op=fc.<act>, …}                   the servicer's own acts of the referral lifecycle —
 *       fc.referral_eligible · fc.send_referral · fc.send_documents · fc.decide_advance · fc.close_outreach ·
 *       fc.state_notice_sent · fc.state_filing · fc.presale_review · fc.presale_inspection · fc.valuation_order ·
 *       fc.valuation_result · fc.reserve_request · fc.reserve_received · fc.sale_completed · fc.reinstatement ·
 *       fc.document_request_breach
 * A refusal from the lifecycle is a RangeError (typed reason; nothing appended).
 */
import { str, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { ReferralLifecycle, type LifecycleDeps } from "../../domain/foreclosure/ops-13-3.ts";
import type { Gates } from "../../domain/foreclosure/referral.ts";

export const TOOLS_13_3: readonly ToolDef[] = [];

type Row = Record<string, unknown>;
const need = (i: Row, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: Row, k: string): PlainDate => { need(i, k); return D(String(i[k]).slice(0, 10)); };
const optDate = (i: Row, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(String(i[k]).slice(0, 10)));
const optStr = (i: Row, k: string): string | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : String(i[k]));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const docs = (v: unknown): { id: string; sha256: string }[] => (Array.isArray(v) ? (v as Row[]).map((d) => ({ id: String(d.id ?? ""), sha256: String(d.sha256 ?? "") })) : []);
const loanOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "loan_id") || ctx.loanId; if (!id) throw new RangeError("loan_id is required"); return id; };
const todayOf = (i: Row, k: string, ctx: CommandContext): PlainDate => optDate(i, k) ?? D(ctx.now.slice(0, 10));
const lifecycle = (ctx: CommandContext, rt: ToolRuntime): ReferralLifecycle => { const deps: LifecycleDeps = { events: ctx.events, clock: ctx.clock, actor: ctx.actor, store: rt.store, escalations: rt.escalations }; return new ReferralLifecycle(deps); };
const unwrap = <T extends { ok: boolean; refusal: string | null }>(r: T): Extract<T, { ok: true }> => { if (!r.ok) throw new RangeError(r.refusal ?? "refused"); return r as Extract<T, { ok: true }>; };
const summarize = (r: { event: { id: string; type: string } | null; facts?: object; events?: readonly { id: string; type: string }[] }): Row => ({ ...((r.facts ?? {}) as Row), event_id: r.event?.id ?? null, event: r.event?.type ?? null, events: (r.events ?? (r.event ? [r.event] : [])).map((e) => e.type) });

/** `attorney.instruction.status{op=firm_message}`: one inbound attorney-network message (idempotent on `case_id+message_seq` at the adapter). */
export function firmMessageIngest_13_3(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Row {
  const loanId = loanOf(i, ctx); const lc = lifecycle(ctx, rt); need(i, "kind", "case_id", "firm_id");
  const caseId = str(i, "case_id"), firmId = str(i, "firm_id"); const seq = i.message_seq === undefined || i.message_seq === null ? null : Number(i.message_seq);
  switch (str(i, "kind")) {
    case "ACK": { need(i, "referral_id"); const r = unwrap(lc.ingestFirmAck({ loan_id: loanId, case_id: caseId, referral_id: str(i, "referral_id"), firm_id: firmId, acknowledged_on: todayOf(i, "acknowledged_on", ctx), complete: flag(i, "complete"), missing: list(i.missing), message_seq: seq, sent_at: optDate(i, "sent_at") })); return summarize(r); }
    case "DOCUMENT_REQUEST": { need(i, "request_id"); const r = unwrap(lc.ingestFirmDocumentRequest({ loan_id: loanId, case_id: caseId, firm_id: firmId, request_id: str(i, "request_id"), items: list(i.items), requested_on: todayOf(i, "requested_on", ctx) })); return summarize(r); }
    case "ADVANCE_REQUEST": { need(i, "request_id", "amount_cents"); const r = unwrap(lc.ingestFirmAdvanceRequest({ loan_id: loanId, case_id: caseId, firm_id: firmId, request_id: str(i, "request_id"), amount_cents: cents(i.amount_cents), purpose: str(i, "purpose"), requested_on: todayOf(i, "requested_on", ctx) })); return summarize(r); }
    case "SALE_SCHEDULED": { const r = unwrap(lc.ingestFirmSaleScheduled({ loan_id: loanId, case_id: caseId, firm_id: firmId, sale_at: date(i, "sale_at"), method: str(i, "method"), message_seq: seq, rescheduled_from: optDate(i, "rescheduled_from") })); return summarize(r); }
    case "MILESTONE": { const r = unwrap(lc.ingestFirmMilestone({ loan_id: loanId, case_id: caseId, firm_id: firmId, code: str(i, "code"), occurred_on: date(i, "occurred_on"), source: str(i, "source") || "firm", evidence_document_id: optStr(i, "evidence_document_id"), first_notice_kind: optStr(i, "first_notice_kind") })); return summarize(r); }
    default: throw new RangeError(`kind must be one of ACK, DOCUMENT_REQUEST, ADVANCE_REQUEST, SALE_SCHEDULED, MILESTONE (13.3 Integrations inbound set)`);
  }
}

/** `attorney.message.send{op=fc.<act>}`: the servicer-side acts of the referral lifecycle. */
export function foreclosureAct_13_3(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Row {
  const loanId = loanOf(i, ctx); const lc = lifecycle(ctx, rt); need(i, "case_id"); const caseId = str(i, "case_id");
  switch (str(i, "op")) {
    case "fc.referral_eligible": { need(i, "review_outcome", "gates"); const r = unwrap(lc.referralEligible({ loan_id: loanId, case_id: caseId, review_outcome: str(i, "review_outcome") as Parameters<ReferralLifecycle["referralEligible"]>[0]["review_outcome"], gates: i.gates as Gates, today: todayOf(i, "today", ctx), principal_residence: flag(i, "principal_residence") })); return summarize(r); }
    case "fc.send_referral": { need(i, "firm_id", "day"); const r = unwrap(lc.sendReferralPackage({ loan_id: loanId, case_id: caseId, firm_id: str(i, "firm_id"), referral_on: todayOf(i, "referral_on", ctx), day: Number(i.day), principal_residence: flag(i, "principal_residence"), review_outcome: str(i, "review_outcome") || "refer", documents: docs(i.documents), ...(i.data_snapshot ? { data_snapshot: i.data_snapshot as Row } : {}) })); return summarize(r); }
    case "fc.send_documents": { need(i, "firm_id", "request_id"); const r = unwrap(lc.sendDocumentsToFirm({ loan_id: loanId, case_id: caseId, firm_id: str(i, "firm_id"), request_id: str(i, "request_id"), documents: docs(i.documents), sent_on: todayOf(i, "sent_on", ctx), requested_on: optDate(i, "requested_on") })); return summarize(r); }
    case "fc.document_request_breach": { need(i, "request_id", "requested_on"); const r = lc.documentRequestBreach({ loan_id: loanId, case_id: caseId, request_id: str(i, "request_id"), requested_on: date(i, "requested_on"), fulfilled_on: optDate(i, "fulfilled_on"), today: todayOf(i, "today", ctx) }); return { breached: r.breached, due: r.due, escalation_id: r.escalation_id, event: r.event?.type ?? null, event_id: r.event?.id ?? null }; }
    case "fc.decide_advance": { need(i, "firm_id", "request_id", "result"); const r = unwrap(lc.decideAdvanceRequest({ loan_id: loanId, case_id: caseId, firm_id: str(i, "firm_id"), request_id: str(i, "request_id"), result: str(i, "result") as "funded" | "declined", decided_on: todayOf(i, "decided_on", ctx), amount_cents: i.amount_cents === undefined ? null : cents(i.amount_cents), reason: optStr(i, "reason") })); return summarize(r); }
    case "fc.close_outreach": { need(i, "campaign_id", "sale_at", "method"); const r = unwrap(lc.closeOutreachCampaign({ loan_id: loanId, case_id: caseId, campaign_id: str(i, "campaign_id"), closed_on: todayOf(i, "closed_on", ctx), sale_at: date(i, "sale_at"), method: str(i, "method") })); return summarize(r); }
    case "fc.state_notice_sent": { need(i, "template", "state", "mailed_on"); const r = unwrap(lc.sendStatePreForeclosureNotice({ loan_id: loanId, case_id: caseId, template: str(i, "template"), state: str(i, "state"), mailed_on: date(i, "mailed_on"), channels: (Array.isArray(i.channels) ? (i.channels as Row[]) : []).map((c) => ({ channel: String(c.channel ?? ""), tracking: optStr(c, "tracking"), party_id: optStr(c, "party_id") })), notice_id: optStr(i, "notice_id"), county_agencies: list(i.county_agencies), language: optStr(i, "language") })); return summarize(r); }
    case "fc.state_filing": { need(i, "kind", "receipt_id"); const r = unwrap(lc.recordStateFiling({ loan_id: loanId, case_id: caseId, kind: str(i, "kind"), filed_on: todayOf(i, "filed_on", ctx), receipt_id: str(i, "receipt_id"), mailed_on: optDate(i, "mailed_on") })); return summarize(r); }
    case "fc.presale_review": { need(i, "sale_at"); const c = (i.checks as Row | undefined) ?? {}; const r = lc.completePresaleReview({ loan_id: loanId, case_id: caseId, sale_at: date(i, "sale_at"), completed_on: todayOf(i, "completed_on", ctx), checks: { gates_open: c.gates_open === true, scra_verified: c.scra_verified === true, bk_scrub_clear: c.bk_scrub_clear === true, holds_clear: c.holds_clear === true, bid_basis_ready: c.bid_basis_ready === true } }); return summarize(r); }
    case "fc.presale_inspection": { need(i, "inspection_id", "sale_at", "inspected_on"); const r = unwrap(lc.recordPresaleInspection({ loan_id: loanId, case_id: caseId, inspection_id: str(i, "inspection_id"), sale_at: date(i, "sale_at"), inspected_on: date(i, "inspected_on"), major_damage: flag(i, "major_damage"), insured: flag(i, "insured"), damage_kind: optStr(i, "damage_kind") })); return summarize(r); }
    case "fc.valuation_order": { need(i, "order_id", "sale_at"); const r = unwrap(lc.orderValuation({ loan_id: loanId, case_id: caseId, order_id: str(i, "order_id"), sale_at: date(i, "sale_at"), ordered_on: todayOf(i, "ordered_on", ctx) })); return summarize(r); }
    case "fc.valuation_result": { need(i, "order_id", "value_cents"); const r = unwrap(lc.ingestValuationResult({ loan_id: loanId, case_id: caseId, order_id: str(i, "order_id"), received_on: todayOf(i, "received_on", ctx), value_cents: cents(i.value_cents), valuation_kind: optStr(i, "valuation_kind") })); return summarize(r); }
    case "fc.reserve_request": { need(i, "request_id", "sale_at"); const r = unwrap(lc.requestReservePrice({ loan_id: loanId, case_id: caseId, request_id: str(i, "request_id"), sale_at: date(i, "sale_at"), requested_on: todayOf(i, "requested_on", ctx) })); return summarize(r); }
    case "fc.reserve_received": { need(i, "request_id", "sale_at", "reserve_cents", "expires_on"); const r = unwrap(lc.ingestReservePrice({ loan_id: loanId, case_id: caseId, request_id: str(i, "request_id"), sale_at: date(i, "sale_at"), reserve_cents: cents(i.reserve_cents), expires_on: date(i, "expires_on"), received_on: todayOf(i, "received_on", ctx) })); return summarize(r); }
    case "fc.sale_completed": { need(i, "sale_on", "outcome"); const r = unwrap(lc.recordSaleCompleted({ loan_id: loanId, case_id: caseId, sale_on: date(i, "sale_on"), completed_on: todayOf(i, "completed_on", ctx), outcome: str(i, "outcome") as "fnma_acquired" | "third_party", confirmation_required: flag(i, "confirmation_required"), confirmed_on: optDate(i, "confirmed_on") })); return summarize(r); }
    case "fc.reinstatement": { need(i, "firm_id", "sale_on", "quote_cents", "tendered_cents"); const r = unwrap(lc.reinstatementTendered({ loan_id: loanId, case_id: caseId, firm_id: str(i, "firm_id"), tendered_on: todayOf(i, "tendered_on", ctx), sale_on: date(i, "sale_on"), quote_cents: cents(i.quote_cents), tendered_cents: cents(i.tendered_cents), note_pulled: flag(i, "note_pulled") })); return summarize(r); }
    default: throw new RangeError(`op ${str(i, "op")} is not a 13.3 act (fc.referral_eligible … fc.reinstatement)`);
  }
}
