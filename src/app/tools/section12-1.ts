/**
 * §12.1 process-owned tool paths. Every 12.1 tool string in spec/registry/agents.json is registered by ./section12.ts
 * (src/app/tools.test.ts refuses duplicates), so `TOOLS_12_1` stays empty and the 12.1 paths below extend the section's
 * `lossmit.application.open/update` handler, which calls `intake_12_1` first and runs its ordinary receipt path when this
 * returns undefined:
 *  - op=document      → `lossmit.document.received{state, section_2924_15, received_on}` (ops-12-1 `documentReceipt`) — arms `CA_CIV_2924_10_ACK_5BD` on a CA §2924.15 loan (T10);
 *  - op=carryover     → `transfer.in.completed{lossmit_pending, ack_not_sent, lossmit_ack_unexpired, transfer_date}` from the transferor's lossmit file (`carryoverIntake`) — arms 1.7's `REGX_1024_41K2_TRANSFEREE_ACK_10`; a lapsed-unsent period makes the transferee newly subject (`lossmit.application.received`);
 *  - op=breach_sweep  → the 00:05 day-6 sweep: `ctx.timers.evaluate(now)`, an `officer` escalation per breached acknowledgment clock, the NoE-risk flag on the loan (`ackBreachResponse`; T12);
 *  - op=update        → `ack_sent_on` records the reasonable-date decision (`reasonableDateDecision`, T1/T3; `lossmit_reviewer` on a milestone conflict); status=facially_complete writes the (c)(2)(iv) hold (`facialHold`, T4); then the section's lifecycle events run;
 *  - open             → prior-application facts run the §1024.41(i) test (`duplicativeIntake`, T6/T7: a duplicative application records `lossmit.application.duplicative`, never `lossmit.application.received`, so no (b)(2)/(c)(3) clock arms); a 2024nprm RFA opens the review cycle and its hold (`nprmReviewCycle`, T11); an application within 45 days of a sale takes the D2-2-05 plan path (`lateApplicationIntake`, T5).
 */
import { str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { EscalationKind } from "../escalations.ts";
import { classify } from "../../domain/lossmit/application.ts";
import { rfaFlow, ACK_TIMER_CODES } from "../../domain/lossmit/ops.ts";
import { documentReceipt, carryoverIntake, lateApplicationIntake, duplicativeIntake, reasonableDateDecision, facialHold, nprmReviewCycle, ackBreachResponse, type TransferorLossmitFile } from "../../domain/lossmit/ops-12-1.ts";

export const TOOLS_12_1: readonly ToolDef[] = [];

const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optFlag = (i: ToolInput, k: string): boolean | null => (i[k] === undefined || i[k] === null ? null : i[k] === true);
/** One `foreclosure_holds` row (12.1 data model: append-only close) with its `foreclosure_holds.opened{kind}` event — the same shape the 12.1 `foreclosure_holds.set` tool writes. */
const openHold = (rt: ToolRuntime, ctx: CommandContext, loanId: string, h: { kind: string; scope: readonly string[]; opened_on: PlainDate; rule_citation: string }, sourceCaseId: string | null) => {
  const rec = rt.store.put("foreclosure_holds", `hold-${loanId}-${h.kind}`, { loan_id: loanId, kind: h.kind, scope: [...h.scope], status: "active", from: h.opened_on, opened_at: ctx.now, rule_citation: h.rule_citation, source_case_id: sourceCaseId, opened_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
  ctx.events.append({ type: "foreclosure_holds.opened", loanId, actor: ctx.actor, payload: { kind: h.kind, hold_id: rec.id, scope: [...h.scope], rule_citation: h.rule_citation, opened_on: h.opened_on } });
  return rec.data;
};

export function intake_12_1(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown | undefined {
  const loanId = str(i, "loan_id"); if (!loanId) return undefined;   // the section handler raises the RangeError
  const today = ctx.now.slice(0, 10); const received = optDate(i, "received_on") ?? D(today);
  const appId = str(i, "id") || `lma-${loanId}-${received}`;
  switch (i.op) {
    case "document": {
      const r = documentReceipt({ document_id: str(i, "document_id"), loan_id: loanId, doc_class: str(i, "doc_class"), received_on: received, state: str(i, "state"), section_2924_15: optFlag(i, "section_2924_15"), application_id: str(i, "application_id") || null, sha256: str(i, "sha256") || null, channel: str(i, "channel") || null });
      const doc = rt.store.put("documents", r.document.id, { ...r.document, ...(r.ca_ack ? { ca_ack_by: r.ca_ack.ack_by, ca_ack_code: r.ca_ack.code } : {}) }, ctx.actor, ctx.now);
      const ev = ctx.events.append({ type: r.event.type, loanId, actor: ctx.actor, payload: r.event.payload });
      return { ...doc.data, event_id: ev.id, ca_ack: r.ca_ack };
    }
    case "carryover": {
      const inline = i.transferor_file as TransferorLossmitFile | undefined;
      const stored = rt.store.list("transfer_lossmit_files", (d) => d.loan_id === loanId).at(-1)?.data as (TransferorLossmitFile & Record<string, unknown>) | undefined;
      const r = carryoverIntake({ loan_id: loanId, transfer_date: optDate(i, "transfer_date") ?? D(today), file: inline ?? stored ?? null, rule_set: str(i, "rule_set") || null });
      const rec = r.record ? rt.store.put("lossmit_applications", str(i, "id") || `lma-${loanId}-${r.deemed_received_at}`, { ...r.record, regime: str(i, "regime") || "2013" }, ctx.actor, ctx.now) : null;
      const ev = ctx.events.append({ type: r.event.type, loanId, actor: ctx.actor, payload: { ...r.event.payload, application_id: rec?.id ?? null } });
      if (r.received_event) ctx.events.append({ type: r.received_event.type, loanId, actor: ctx.actor, causationId: ev.id, payload: { ...r.received_event.payload, application_id: rec?.id ?? null } });
      return { ...(rec?.data ?? {}), application_id: rec?.id ?? null, lossmit_pending: r.lossmit_pending, ack_not_sent: r.ack_not_sent, lossmit_ack_unexpired: r.lossmit_ack_unexpired, lossmit_ack_sent: r.lossmit_ack_sent, deemed_received_at: r.deemed_received_at, transferee_ack_due: r.transferee_ack_due, timer: r.timer, event_id: ev.id };
    }
    case "breach_sweep": {
      const breaches = ctx.timers.evaluate(ctx.now).filter((b) => (ACK_TIMER_CODES as readonly string[]).includes(b.def.code) && b.instance.loanId === loanId);
      const out: Record<string, unknown>[] = [];
      for (const b of breaches) {
        const app = rt.store.list("lossmit_applications", (d) => d.loan_id === loanId && typeof d.received_on === "string").at(-1);
        const r = ackBreachResponse({ code: b.def.code, received_on: app ? D(String(app.data.received_on)) : D(b.instance.anchorDate), timer_id: b.instance.id, tz: str(i, "tz") || "America/New_York" });
        const esc = rt.escalations.open({ kind: r.escalation.kind as EscalationKind, severity: r.escalation.severity, loanId, slaTimerId: b.instance.id, payload: { reason: r.escalation.reason, code: r.code, timer_id: b.instance.id, day6: r.day6, ack_resend_required: true } }, ctx.actor);
        if (r.noe_risk_flag) { rt.store.put("loans", loanId, { noe_risk_flag: true, noe_risk_reason: `12.1 ack breach ${r.code}`, noe_risk_flagged_at: ctx.now }, ctx.actor, ctx.now); }
        if (app) rt.store.put("lossmit_applications", app.id, { ack_breach_escalation_id: esc.id, ack_breached_code: r.code, noe_risk_flag: r.noe_risk_flag || app.data.noe_risk_flag === true }, ctx.actor, ctx.now);
        ctx.events.append({ type: r.event.type, loanId, actor: ctx.actor, payload: { ...r.event.payload, escalation_id: esc.id, application_id: app?.id ?? null } });
        out.push({ code: r.code, timer_id: b.instance.id, escalation_id: esc.id, kind: esc.kind, severity: esc.severity ?? null, day6: r.day6, noe_risk_flag: r.noe_risk_flag, ack_resend_required: true });
      }
      return { breaches: out, ack_resend_required: out.length > 0, noe_risk_flag: out.some((o) => o.noe_risk_flag === true) };
    }
    case "update": {
      const prev = rt.store.get("lossmit_applications", appId);
      if (optDate(i, "ack_sent_on")) {
        const r = reasonableDateDecision({ ack_sent_on: optDate(i, "ack_sent_on")!, earliest_unpaid_due: optDate(i, "earliest_unpaid_due"), sale_on: optDate(i, "sale_on") ?? (prev?.data.foreclosure_sale_date_at_receipt ? D(String(prev.data.foreclosure_sale_date_at_receipt)) : null), oldest_doc_date: optDate(i, "oldest_doc_date") });
        rt.store.put("lossmit_applications", appId, { loan_id: loanId, ack_sent_on: optDate(i, "ack_sent_on"), reasonable_date: r.reasonable_date, reasonable_date_basis: r.reasonable_date_basis, milestone_conflict: r.milestone_conflict }, ctx.actor, ctx.now);
        if (r.escalation) rt.escalations.open({ kind: "lossmit_reviewer", ...(r.escalation.severity ? { severity: r.escalation.severity } : {}), loanId, payload: { reason: r.escalation.reason, application_id: appId, reasonable_date: r.reasonable_date, basis: r.basis } }, ctx.actor);
      }
      if (str(i, "status") === "facially_complete") openHold(rt, ctx, loanId, facialHold({ facially_complete_on: optDate(i, "facially_complete_on") ?? D(today), first_filing_made: flag(i, "first_filing_made") || prev?.data.first_filing_made_at_receipt === true }), str(i, "case_id") || null);
      return undefined;
    }
    default: {
      if (i.op !== undefined && i.op !== "open") return undefined;
      const kind = classify({ has_evaluative_info: flag(i, "has_evaluative_info"), confidence: Number(i.confidence ?? 1) });
      if (kind === "rfa_only") {
        if (str(i, "regime") !== "2024nprm") return undefined;
        const r = rfaFlow({ utterance: str(i, "utterance"), has_evaluative_info: false, confidence: Number(i.confidence ?? 1), state: str(i, "state") });
        const n = nprmReviewCycle({ regime: "2024nprm", rfa_on: received, sale_on: optDate(i, "sale_on"), oral: flag(i, "oral") });
        const rec = rt.store.put("lossmit_applications", appId, { loan_id: loanId, status: n.status, rule_set: "regx.lossmit.2024nprm", regime: "2024nprm", received_on: received, foreclosure_sale_date_at_receipt: optDate(i, "sale_on"), ack_due: null, ...(str(i, "state") ? { state: str(i, "state") } : {}) }, ctx.actor, ctx.now);
        ctx.events.append({ type: "lossmit.rfa.received", loanId, actor: ctx.actor, payload: { ...r, application_id: rec.id, regime: "2024nprm", review_cycle_opened: n.review_cycle_opened, days_before_sale: n.days_before_sale, received_date: received } });
        const hold = n.hold_record ? openHold(rt, ctx, loanId, n.hold_record, str(i, "case_id") || null) : null;
        return { ...r, classification: kind, application_id: rec.id, status: n.status, nprm: { review_cycle_opened: n.review_cycle_opened, hold: n.hold, notice: n.notice, days_before_sale: n.days_before_sale }, hold_record: hold };
      }
      if (optDate(i, "prior_complete_on")) {
        const d = duplicativeIntake({ loan_id: loanId, application_id: appId, received_on: received, prior_complete_on: optDate(i, "prior_complete_on")!, prior_application_id: str(i, "prior_application_id") || null, prior_fully_processed_by_us: flag(i, "prior_fully_processed_by_us"), current_since_prior: flag(i, "current_since_prior"), reviewer_approval_id: str(i, "reviewer_approval_id") || null });
        if (d.refusal) throw new RangeError(`DUPLICATIVE_NEEDS_REVIEWER: ${d.refusal}`);
        if (!d.duplicative) { rt.store.put("lossmit_applications", appId, { loan_id: loanId, duplicative_determination: d.determination }, ctx.actor, ctx.now); return undefined; }   // full process (T7)
        const rec = rt.store.put("lossmit_applications", appId, { ...d.record!, regime: str(i, "regime") || "2013", ...(str(i, "state") ? { state: str(i, "state") } : {}) }, ctx.actor, ctx.now);
        ctx.events.append({ type: d.event!.type, loanId, actor: ctx.actor, payload: d.event!.payload });
        return { ...rec.data, application_id: rec.id, duplicative: true, timers_started: d.timers_started, courtesy_notice: d.courtesy_notice, fnma_evaluation_required: true };
      }
      const late = lateApplicationIntake({ loan_id: loanId, received_on: received, sale_on: optDate(i, "sale_on"), application_id: appId });
      if (!late) return undefined;
      const rec = rt.store.put("lossmit_applications", appId, { ...late.record, regime: str(i, "regime") || "2013", ...(str(i, "state") ? { state: str(i, "state") } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: late.event.type, loanId, actor: ctx.actor, payload: late.event.payload });
      return { ...rec.data, application_id: rec.id, b2_applies: false, days_before_sale: late.days_before_sale, d2205_notice: late.d2205_notice, d2205_notice_due: late.d2205_notice_due, expedited_review: true, timers_started: [] as string[] };
    }
  }
}
