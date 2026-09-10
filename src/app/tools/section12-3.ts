/**
 * §12.3 process-owned tools — additional bus tools for 12.3 defined with `defineTools("12.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section12.ts). Every tool string must be one
 * spec/registry/agents.json names for 12.3; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * spec/registry/agents.json names no tool for 12.3 (the appeal "is a platform workflow" run by the same
 * `lossmit-underwriter` in its `appeal` sub-role), so the appeal lifecycle runs through the 12.2 `lossmit.evaluation.*`
 * tool in section12.ts, which calls `appealOps_12_3` first: op=appeal_receive / appeal_assign_reviewer /
 * appeal_new_information / appeal_decide / appeal_release_holds / appeal_denial_postmarked / appeal_breach_sweep /
 * appeal_status. Each validates its inbound record in src/domain/lossmit/ops-12-3.ts and appends the events the 12.3
 * timer rows (timers-12-3.ts) arm and satisfy on; the (h)(4) determination notice is rendered and sent through the
 * Notice Registry inside op=appeal_decide only after the assigned independent reviewer's signature (guardrail: the agent
 * "cannot issue a notice before the human decision").
 */
import { noticeOps, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { receiveAppeal, assignReviewer, newInformation, decideAppeal, releaseAppealHold, denialPostmarked, appealBreach, appealTemplate, HOLD_KIND, type AppealDecision, type EmittedEvent, type HoldReleaseReason } from "../../domain/lossmit/ops-12-3.ts";

export const TOOLS_12_3: readonly ToolDef[] = [];

const APPEAL_OPS = new Set(["appeal_receive", "appeal_assign_reviewer", "appeal_new_information", "appeal_decide", "appeal_release_holds", "appeal_denial_postmarked", "appeal_breach_sweep", "appeal_status"]);
const DECIDE_CODES = new Set(["REGX_1024_41H4_APPEAL_DECIDE_30", "FNMA_D2207_APPEAL_DECIDE_30"]);
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (str(i, k) ? D(str(i, k)) : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const emitAll = (ctx: CommandContext, loanId: string, events: readonly EmittedEvent[]): void => { for (const e of events) ctx.events.append({ type: e.type, loanId, actor: ctx.actor, payload: e.payload }); };
const appealOf = (i: ToolInput, rt: ToolRuntime, loanId: string) => { const id = str(i, "appeal_id"); return id ? rt.store.require("lossmit_appeals", id) : rt.store.list("lossmit_appeals", (d) => d.loan_id === loanId).at(-1) ?? null; };
const evaluationOf = (i: ToolInput, rt: ToolRuntime, loanId: string) => { const id = str(i, "evaluation_id"); return id ? rt.store.get("lossmit_evaluations", id) ?? null : rt.store.list("lossmit_evaluations", (d) => d.loan_id === loanId).at(-1) ?? null; };
const pendingOffer = (i: ToolInput, rt: ToolRuntime, loanId: string) => { const id = str(i, "original_offer_id"); const rec = id ? rt.store.get("lossmit_offers", id) ?? null : rt.store.list("lossmit_offers", (d) => d.loan_id === loanId && (d.status === "offered" || d.status === "pending") && typeof d.accept_by === "string").at(-1) ?? null; return rec && typeof rec.data.accept_by === "string" ? { offer_id: rec.id, accept_by: D(String(rec.data.accept_by)), option: (rec.data.option as string | undefined) ?? null } : null; };
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The 12.3 ops behind `lossmit.evaluation.*`; returns undefined for any op this process does not own. */
export function appealOps_12_3(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const op = str(i, "op"); if (!APPEAL_OPS.has(op)) return undefined;
  const loanId = str(i, "loan_id") || ctx.loanId; const now = today(ctx);
  switch (op) {
    case "appeal_status": { const a = appealOf(i, rt, loanId); if (!a) throw new RangeError(`no appeal on loan ${loanId}`); return { ...a.data, id: a.id, open_timers: ctx.timers.open().filter((t) => t.loanId === loanId).map((t) => ({ code: t.code, status: t.status, due_date: t.dueDate ?? null })) }; }
    case "appeal_receive": {
      need(i, "application_id", "channel");
      const ev = evaluationOf(i, rt, loanId); const evaluationId = str(i, "evaluation_id") || ev?.id || ""; if (!evaluationId) throw new RangeError("evaluation_id is required: an appeal is of a complete-application determination (12.2)");
      const denialOn = optDate(i, "denial_provided_on") ?? (s(ev?.data.provided_at) ? D(String(ev!.data.provided_at).slice(0, 10)) : null); if (!denialOn) throw new RangeError("denial_provided_on is required (the (c)(1)(ii) notice date)");
      const completeOn = optDate(i, "complete_on") ?? (s(ev?.data.complete_at) ? D(String(ev!.data.complete_at).slice(0, 10)) : null); if (!completeOn) throw new RangeError("complete_on is required (tier is measured from the complete application)");
      const received = optDate(i, "received_on") ?? now; const appealId = str(i, "id") || `appeal-${evaluationId}-${received}`;
      const prior = rt.store.list("lossmit_appeals", (d) => d.evaluation_id === evaluationId && typeof d.decision === "string");
      const r = receiveAppeal({ appeal_id: appealId, application_id: str(i, "application_id"), evaluation_id: evaluationId, denial_notice_id: s(i.denial_notice_id) ?? s(ev?.data.notice_id), denial_provided_on: denialOn, postmark_on: optDate(i, "postmark_on"), state: s(i.state) ?? s(ev?.data.state),
        received_on: received, received_at: s(i.received_at) ?? ctx.now, channel: str(i, "channel"), complete_on: completeOn, sale_on: optDate(i, "sale_on"), first_filing_made: flag(i, "first_filing_made"), denied_modification: i.denied_modification === undefined ? true : flag(i, "denied_modification"),
        principal_residence: i.principal_residence === undefined ? null : flag(i, "principal_residence"), prior_complete_brp_continuously_delinquent: flag(i, "prior_complete_brp_continuously_delinquent"), prior_appeal_decided: prior.length > 0, in_foreclosure: flag(i, "in_foreclosure"),
        original_offer: i.original_offer_pending === false ? null : pendingOffer(i, rt, loanId), transfer_date: optDate(i, "transfer_date"), new_information_doc_ids: strs(i.new_information_doc_ids) });
      rt.store.put("lossmit_appeals", appealId, { loan_id: loanId, application_id: str(i, "application_id"), evaluation_id: evaluationId, denial_notice_id: s(i.denial_notice_id) ?? s(ev?.data.notice_id), denial_provided_on: denialOn, appeal_window_ends: r.appeal_window_ends, received_at: s(i.received_at) ?? ctx.now, received_date: received, channel: str(i, "channel"), state: s(i.state) ?? s(ev?.data.state),
        eligible: r.eligible, ineligibility_reason: r.ineligibility_reason, tier: r.tier, decision_due: r.decision_due, decision_anchor_date: r.decision_anchor_date, assign_reviewer_by: r.assign_reviewer_by, new_information: (strs(i.new_information_doc_ids).length > 0), new_information_doc_ids: strs(i.new_information_doc_ids), reviewer_id: null, decision: null, hold_id: r.hold_id, in_foreclosure: flag(i, "in_foreclosure"),
        original_offer_id: r.original_offer_pending ? pendingOffer(i, rt, loanId)?.offer_id ?? null : null, fnma_d2207_variance: r.fnma_d2207_variance, transfer_date: optDate(i, "transfer_date"), status: r.status }, ctx.actor, ctx.now);
      rt.store.put("foreclosure_holds", r.hold_id, { loan_id: loanId, kind: HOLD_KIND, status: "active", from: received, reason: `appeal ${appealId} received`, appeal_id: appealId }, ctx.actor, ctx.now);
      for (const e of r.events) {
        if (e.type === "lossmit.offer.accept_by.extended") { rt.store.put("lossmit_offers", String(e.payload.offer_id), { accept_by: null, previous_accept_by: e.payload.previous_accept_by, accept_by_basis: "e2iii_extension" }, ctx.actor, ctx.now); for (const t of ctx.timers.open()) if (t.loanId === loanId && /_ACCEPT_(14|7|30)$/.test(t.code) && t.status === "armed") ctx.timers.cancel(t.id, `original offer acceptance extended by the appeal (§1024.41(e)(2)(iii)); REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED runs from the (h)(4) notice`, ctx.actor); }
        if (e.type === "attorney.instruction.sent") rt.store.put("attorney_instructions", String(e.payload.instruction_id), { loan_id: loanId, kind: "appeal_pending_delay", appeal_id: appealId, firm_id: s(i.firm_id) ?? "counsel", instruction: e.payload.instruction, status: "sent", sent_at: ctx.now, due_by: e.payload.due_by }, ctx.actor, ctx.now);
      }
      emitAll(ctx, loanId, r.events);
      const out = { appeal_id: appealId, evaluation_id: evaluationId, status: r.status, eligible: r.eligible, ineligibility_reason: r.ineligibility_reason, tier: r.tier, appeal_window_ends: r.appeal_window_ends, late: r.late, decision_due: r.decision_due, decision_anchor_date: r.decision_anchor_date, assign_reviewer_by: r.assign_reviewer_by, court_delay_request_by: r.court_delay_request_by, written_confirmation_required: r.written_confirmation_required, fnma_d2207_variance: r.fnma_d2207_variance, notice: r.notice, hold_id: r.hold_id, original_offer_pending: r.original_offer_pending };
      // The acknowledgment (policy, ≤5 BD) or the ineligibility notice goes out with the receipt when the recipients are supplied.
      if (Array.isArray(i.recipients) && i.recipients.length) return (async () => { const n = (await noticeOps("render_send")({ ...i, template_code: r.notice, payload: { ...((i.payload as Record<string, unknown> | undefined) ?? {}), received_on: received, denial_on: denialOn, decision_by: r.decision_due, appeal_by: r.appeal_window_ends, original_offer_pending: r.original_offer_pending }, notice_id: undefined }, ctx, rt)) as { id: string; status: string }; rt.store.put("lossmit_appeals", appealId, { ack_notice_id: n.id, ack_status: n.status }, ctx.actor, ctx.now); return { ...out, notice_id: n.id, notice_status: n.status }; })();
      return out;
    }
    case "appeal_assign_reviewer": {
      need(i, "candidate_id", "evaluator_id"); const a = appealOf(i, rt, loanId); if (!a) throw new RangeError(`no appeal on loan ${loanId}`);
      // An ineligible appeal still gets an independent reviewer: ineligibility (and the hold release) is confirmed by that reviewer through op=appeal_release_holds (rule 8; 12.3-T3).
      const r = assignReviewer({ appeal_id: a.id, candidate_id: str(i, "candidate_id"), candidate_role: str(i, "candidate_role") || "lossmit_reviewer", evaluator_id: str(i, "evaluator_id"), approver_id: s(i.approver_id), reason_code_editor_ids: strs(i.reason_code_editor_ids), directly_involved_supervisor_ids: strs(i.directly_involved_supervisor_ids), evaluator_run_id: s(i.evaluator_run_id), appeal_run_id: s(i.appeal_run_id), assigned_on: optDate(i, "assigned_on") ?? now });
      emitAll(ctx, loanId, r.events);
      if (r.accepted) rt.store.put("lossmit_appeals", a.id, { reviewer_id: str(i, "candidate_id"), reviewer_role: str(i, "candidate_role") || "lossmit_reviewer", reviewer_independence_check: { excluded_ids: r.excluded_ids, result: "passed", reason: r.reason }, ai_reeval_run_id: s(i.appeal_run_id) ?? `run-appeal-${a.id}`, ...(a.data.status === "ineligible" ? {} : { status: "under_review" }) }, ctx.actor, ctx.now);
      else rt.store.put("lossmit_appeals", a.id, { reviewer_independence_check: { excluded_ids: r.excluded_ids, result: "failed", candidate_id: str(i, "candidate_id"), reason: r.reason } }, ctx.actor, ctx.now);
      if (!r.accepted) throw new RangeError(`SM_APPEAL_INDEPENDENCE_GATE: ${r.reason}`);
      return { appeal_id: a.id, accepted: true, reviewer_id: str(i, "candidate_id"), excluded_ids: r.excluded_ids, reason: r.reason, status: "under_review" };
    }
    case "appeal_new_information": {
      const a = appealOf(i, rt, loanId); if (!a) throw new RangeError(`no appeal on loan ${loanId}`);
      const r = newInformation({ appeal_id: a.id, doc_ids: strs(i.doc_ids), received_on: optDate(i, "received_on") ?? now, appeal_window_ends: D(String(a.data.appeal_window_ends)), eligible: a.data.eligible === true, decided: typeof a.data.decision === "string", asserts_error: flag(i, "asserts_error"), borrower_current_since_prior_complete: flag(i, "borrower_current_since_prior_complete") });
      rt.store.put("lossmit_appeals", a.id, { new_information: true, new_information_doc_ids: [...strs(a.data.new_information_doc_ids), ...strs(i.doc_ids)], new_information_route: r.route }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { appeal_id: a.id, reviewed_as: r.as, route: r.route, items: strs(i.doc_ids) };
    }
    case "appeal_decide": {
      need(i, "reviewer_id", "decision"); const a = appealOf(i, rt, loanId); if (!a) throw new RangeError(`no appeal on loan ${loanId}`);
      if (a.data.status !== "under_review") throw new RangeError(`appeal ${a.id} is ${String(a.data.status)}, not under_review`);
      if (!Array.isArray(i.recipients) || !i.recipients.length) throw new RangeError("recipients are required: the (h)(4) determination is provided in writing (NTC_REGX_41H4_APPEAL_GRANTED / _DENIED)");
      const decision = str(i, "decision") as AppealDecision; const template = appealTemplate(decision); const decidedOn = optDate(i, "decided_on") ?? now;
      // The notice renders and sends only under the assigned reviewer's signature (checked by decideAppeal first, with a placeholder notice id).
      decideAppeal({ appeal_id: a.id, evaluation_id: String(a.data.evaluation_id), reviewer_id: str(i, "reviewer_id"), assigned_reviewer_id: s(a.data.reviewer_id), decision, decided_on: decidedOn, provided_on: now, notice_id: "pending", tpp: flag(i, "tpp"), state: s(a.data.state) });
      rt.store.put("lossmit_appeals", a.id, { decision, decided_at: ctx.now, status: decision === "denied" ? "decided_denied" : "decided_granted", human_decision: { reviewer_id: str(i, "reviewer_id"), decision, decided_on: decidedOn, edits: strs(i.human_edits) } }, ctx.actor, ctx.now);
      return (async () => {
        const n = (await noticeOps("render_send")({ ...i, template_code: template, notice_id: undefined }, ctx, rt)) as { id: string; status: string };
        if (n.status !== "sent") return { appeal_id: a.id, decision, notice_id: n.id, notice_status: n.status, provided: false };
        const orig = s(a.data.original_offer_id) ? rt.store.get("lossmit_offers", String(a.data.original_offer_id)) : undefined;
        const r = decideAppeal({ appeal_id: a.id, evaluation_id: String(a.data.evaluation_id), reviewer_id: str(i, "reviewer_id"), assigned_reviewer_id: s(a.data.reviewer_id), decision, decided_on: decidedOn, provided_on: now, notice_id: n.id, tpp: flag(i, "tpp"), state: s(a.data.state),
          original_offer: orig ? { offer_id: orig.id, accept_by: D(String(orig.data.previous_accept_by ?? orig.data.accept_by)), option: (orig.data.option as string | undefined) ?? null } : null, ai_reeval_run_id: s(a.data.ai_reeval_run_id), human_edits: strs(i.human_edits) });
        rt.store.put("lossmit_appeals", a.id, { notice_id: n.id, provided_at: now, accept_by: r.accept_by, tpp_first_due: r.tpp_first_due, ca_no_nod_nos_before: r.ca_no_nod_nos_before, status: r.status }, ctx.actor, ctx.now);
        if (r.outcome === "granted" && decision === "granted_new_offer") rt.store.put("lossmit_offers", str(i, "offer_id") || `offer-${a.id}`, { loan_id: loanId, evaluation_id: a.data.evaluation_id, appeal_id: a.id, origin: "appeal", option: str(i, "option") || (flag(i, "tpp") ? "flex_mod" : null), status: "offered", accept_by: r.accept_by, accept_by_basis: "h4_notice_plus_14", tpp_first_due: r.tpp_first_due }, ctx.actor, ctx.now);
        if (orig && r.original_offer_accept_by) rt.store.put("lossmit_offers", orig.id, { accept_by: r.original_offer_accept_by, accept_by_basis: "e2iii_extension", status: "offered" }, ctx.actor, ctx.now);
        emitAll(ctx, loanId, r.events);
        return { appeal_id: a.id, decision, outcome: r.outcome, template, notice_id: n.id, provided_at: now, accept_by: r.accept_by, tpp_first_due: r.tpp_first_due, original_offer_accept_by: r.original_offer_accept_by, ca_no_nod_nos_before: r.ca_no_nod_nos_before, status: r.status, no_further_appeal: true };
      })();
    }
    case "appeal_release_holds": {
      need(i, "reason"); const a = appealOf(i, rt, loanId); if (!a) throw new RangeError(`no appeal on loan ${loanId}`);
      const confirmation = s(i.reviewer_id) ? { reviewer_id: str(i, "reviewer_id"), confirmed_on: optDate(i, "confirmed_on") ?? now } : null;
      const r = releaseAppealHold({ appeal_id: a.id, hold_id: String(a.data.hold_id), reason: str(i, "reason") as HoldReleaseReason, eligible: a.data.eligible === true, reviewer_confirmation: confirmation, ca_ny_tail_lapsed: flag(i, "tail_lapsed"), state: s(a.data.state) });
      rt.store.put("foreclosure_holds", String(a.data.hold_id), { status: "released", released_on: now, reason: str(i, "reason"), reviewer_id: confirmation?.reviewer_id ?? null }, ctx.actor, ctx.now);
      rt.store.put("lossmit_appeals", a.id, { holds_released_on: now, ...(str(i, "reason") === "ineligible" ? { ineligibility_confirmed_by: confirmation?.reviewer_id ?? null, status: "closed" } : {}) }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { appeal_id: a.id, hold_id: String(a.data.hold_id), released: r.released, reason: str(i, "reason"), reviewer_id: confirmation?.reviewer_id ?? null };
    }
    case "appeal_denial_postmarked": {
      need(i, "notice_id", "postmark_on"); const ev = evaluationOf(i, rt, loanId);
      const printed = optDate(i, "printed_on") ?? (s(ev?.data.provided_at) ? D(String(ev!.data.provided_at).slice(0, 10)) : null); if (!printed) throw new RangeError("printed_on is required (the denial's print date)");
      const r = denialPostmarked({ notice_id: str(i, "notice_id"), evaluation_id: ev?.id ?? null, state: s(i.state) ?? s(ev?.data.state), printed_on: printed, postmark_on: date(i, "postmark_on"), mailing_proof_document_id: s(i.mailing_proof_document_id) });
      if (ev) rt.store.put("lossmit_evaluations", ev.id, { postmark_on: str(i, "postmark_on"), appeal_by: r.appeal_window_ends }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { notice_id: str(i, "notice_id"), postmark_on: str(i, "postmark_on"), appeal_window_ends: r.appeal_window_ends };
    }
    case "appeal_breach_sweep": {
      const breaches = ctx.timers.evaluate(ctx.now).filter((b) => DECIDE_CODES.has(b.instance.code) && (!b.instance.loanId || b.instance.loanId === loanId));
      const handled: Record<string, unknown>[] = [];
      for (const b of breaches) {
        const a = rt.store.list("lossmit_appeals", (d) => d.loan_id === (b.instance.loanId ?? loanId) && typeof d.decision !== "string").at(-1); if (!a) continue;
        const r = appealBreach({ appeal_id: a.id, appeal_received_on: D(String(a.data.received_date)), decision_anchor_date: s(a.data.decision_anchor_date) ? D(String(a.data.decision_anchor_date)) : null, decided_on: null, today: now, timer_id: b.instance.id, code: b.instance.code });
        if (!r.breached || !r.escalation) continue;
        // §1024.41(h)(4) breach: officer sev-1 + borrower status notice (12.3-T10); the dual-cited D2-2-07 clock breaching on the same day is the registry's sev-2 (no second status notice).
        const dual = b.instance.code === "FNMA_D2207_APPEAL_DECIDE_30";
        const esc = rt.escalations.open({ kind: "officer", severity: dual ? "sev2" : "sev1", loanId: a.data.loan_id as string, slaTimerId: b.instance.id, payload: { appeal_id: a.id, code: b.instance.code, decision_due: r.decision_due, reason: r.escalation.reason, borrower_status_notice: !dual, holds_maintained: true } }, ctx.actor);
        if (!dual) { rt.store.put("lossmit_appeals", a.id, { breach_escalation_id: esc.id, breached_on: now, borrower_status_notice_due: true }, ctx.actor, ctx.now); emitAll(ctx, a.data.loan_id as string, r.events.map((e) => ({ ...e, payload: { ...e.payload, escalation_id: esc.id } }))); }
        handled.push({ appeal_id: a.id, code: b.instance.code, timer_id: b.instance.id, escalation_id: esc.id, escalation: "officer", severity: dual ? "sev2" : "sev1", decision_due: r.decision_due, borrower_status_notice: !dual && r.borrower_status_notice, holds_maintained: r.holds_maintained });
      }
      return { breached: handled };
    }
    default: return undefined;
  }
}
