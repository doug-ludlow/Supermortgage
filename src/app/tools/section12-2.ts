/**
 * §12.2 process-owned tools — additional bus tools for 12.2 defined with `defineTools("12.2", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section12.ts). Every tool string must be one
 * spec/registry/agents.json names for 12.2; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * The 12.2 tool names are all declared once in section12.ts (a second `lossmit.evaluation.*` would be a duplicate on
 * the bus), so the lifecycle ops this process adds run through the handlers exported here and called from those
 * definitions: `evaluationOps_12_2` (the `lossmit.evaluation.*` ops third_party_request / draft / review /
 * trial_payment_received / acceptance_items_received / smdu_decision / deemed_rejection), `timerOps_12_2`
 * (`timers.*` op=lapse — the not_before_gate sweep that records `timer.lapsed{code}`) and `afterDenialSent`
 * (`notice.render_send` on a denial template → `lossmit.denial.provided{state, provided_at}`). Each validates its
 * inbound record in src/domain/lossmit/ops-12-2.ts and appends the events the 12.2 timer rows arm and satisfy on.
 */
import { timerOps, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Option } from "../../domain/lossmit/evaluation.ts";
import { thirdPartyRequests, draftDecision, reviewDecision, trialFirstPayment, acceptanceItemsReceived, ingestSmduDecision, denialProvided, gateLapses, deemedRejectionSweep, type DraftDetermination, type EmittedEvent } from "../../domain/lossmit/ops-12-2.ts";

export const TOOLS_12_2: readonly ToolDef[] = [];

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const emitAll = (ctx: CommandContext, loanId: string, events: readonly EmittedEvent[]): void => { for (const e of events) ctx.events.append({ type: e.type, loanId, actor: ctx.actor, payload: e.payload }); };
const latestEvaluation = (rt: ToolRuntime, loanId: string) => rt.store.list("lossmit_evaluations", (d) => d.loan_id === loanId).at(-1) ?? null;
const evaluationOf = (i: ToolInput, rt: ToolRuntime) => { const id = str(i, "evaluation_id") || str(i, "id"); return id ? rt.store.require("lossmit_evaluations", id) : latestEvaluation(rt, str(i, "loan_id")); };
const offerOf = (i: ToolInput, rt: ToolRuntime) => { const id = str(i, "offer_id"); return id ? rt.store.get("lossmit_offers", id) ?? null : rt.store.list("lossmit_offers", (d) => d.loan_id === str(i, "loan_id")).at(-1) ?? null; };

/** The 12.2 `lossmit.evaluation.*` ops this process owns; returns undefined for the ops section12.ts handles itself. */
export function evaluationOps_12_2(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const loanId = str(i, "loan_id"); const now = today(ctx);
  switch (i.op) {
    case "third_party_request": {
      const ev = evaluationOf(i, rt); if (!ev) throw new RangeError("no evaluation to request third-party items for");
      const r = thirdPartyRequests({ evaluation_id: ev.id, outstanding: strs(ev.data.third_party_items), items: strs(i.items), requested_on: str(i, "requested_on") ? date(i, "requested_on") : now, started_on: D(String(ev.data.started_at ?? ctx.now).slice(0, 10)) });
      rt.store.put("lossmit_evaluations", ev.id, { third_party_requested_on: r.events.map((e) => e.payload.requested_on).at(-1) ?? now, third_party_request_by: r.request_by }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { evaluation_id: ev.id, requested: r.events.map((e) => ({ item: e.payload.item, adapter: e.payload.adapter })), request_by: r.request_by, on_time: r.on_time };
    }
    case "draft": {
      const ev = evaluationOf(i, rt); if (!ev) throw new RangeError("no evaluation to draft a decision for");
      const complete = str(i, "complete_on") ? date(i, "complete_on") : ev.data.complete_at ? D(String(ev.data.complete_at)) : null; if (!complete) throw new RangeError("complete_on is required (the 30-day clock anchor)");
      const r = draftDecision({ evaluation_id: ev.id, complete_on: complete, drafted_on: now, determinations: (Array.isArray(i.determinations) ? i.determinations : []) as DraftDetermination[], discretionary_c2ii: flag(i, "discretionary_c2ii"), duplicative: flag(i, "duplicative"), reg_b_adverse: flag(i, "reg_b_adverse") });
      const rec = rt.store.put("lossmit_evaluations", ev.id, { status: r.status, has_denial: r.has_denial, reviewer_required: r.reviewer_required, drafted_on: now, review_due: r.review_due, determinations: i.determinations, ...(str(i, "evaluator_run_id") ? { evaluator_run_id: str(i, "evaluator_run_id") } : {}), ...(str(i, "evaluator_run_owner") ? { evaluator_run_owner: str(i, "evaluator_run_owner") } : {}) }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, review_business_days: r.review_business_days, days_remaining: r.days_remaining };
    }
    case "review": {
      need(i, "decision"); const ev = evaluationOf(i, rt); if (!ev) throw new RangeError("no evaluation to review");
      const reviewer = (i.reviewer as { id: string; role: string; supervisory?: boolean; involved_in_evaluation?: boolean } | undefined) ?? { id: str(i, "reviewer_id"), role: str(i, "reviewer_role") || "lossmit_reviewer", supervisory: flag(i, "supervisory"), involved_in_evaluation: flag(i, "involved_in_evaluation") };
      if (!reviewer.id) throw new RangeError("reviewer id is required");
      const decision = str(i, "decision"); if (decision !== "approved" && decision !== "edited" && decision !== "returned") throw new RangeError("decision must be approved, edited or returned");
      const r = reviewDecision({ evaluation_id: ev.id, reviewer, evaluator_run_owner: (ev.data.evaluator_run_owner as string | undefined) ?? null, decision, state: str(i, "state") || (ev.data.state as string | undefined) || null, reviewed_on: now, edits: strs(i.edits) });
      const rec = rt.store.put("lossmit_evaluations", ev.id, { status: r.status, reviewer_id: reviewer.id, reviewer_decision: decision, reviewer_at: ctx.now, reviewer_supervisory: r.supervisory_reviewer_recorded, ...(decision === "returned" ? {} : { reviewer_approval_id: str(i, "reviewer_approval_id") || `rev-${ev.id}-${reviewer.id}`, decided_at: ctx.now }) }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return rec.data;
    }
    case "trial_payment_received": {
      need(i, "payment_date", "due_on", "amount_cents", "required_cents"); const offer = offerOf(i, rt); const ev = offer ? (offer.data.evaluation_id ? rt.store.get("lossmit_evaluations", String(offer.data.evaluation_id)) ?? null : null) : evaluationOf(i, rt);
      const option = str(i, "option") || (offer?.data.option as string | undefined) || (ev?.data.option as string | undefined) || ""; if (!option) throw new RangeError("option is required");
      const offerId = offer?.id || str(i, "offer_id") || `offer-${loanId}-${option}`;
      const r = trialFirstPayment({ offer_id: offerId, evaluation_id: ev?.id ?? (offer?.data.evaluation_id as string | undefined) ?? null, option: option as Option, payment_date: date(i, "payment_date"), due_on: date(i, "due_on"), amount_cents: cents(i.amount_cents), required_cents: cents(i.required_cents), acceptance_items_outstanding: strs(i.acceptance_items_outstanding), tier: str(i, "tier") || (ev?.data.tier as string | undefined) || null, state: str(i, "state") || (ev?.data.state as string | undefined) || null });
      const rec = rt.store.put("lossmit_offers", offerId, { loan_id: loanId, evaluation_id: ev?.id ?? null, option, ...(r.accepted_by_payment ? { status: "accepted", accepted_via: "payment", accepted_at: ctx.now, responded_on: str(i, "payment_date") } : {}), first_trial_payment_on: str(i, "payment_date"), acceptance_items_outstanding: strs(i.acceptance_items_outstanding), grace_until: r.reasonable_period_by }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, accepted_by_payment: r.accepted_by_payment, other_acceptance_items_missing: r.other_acceptance_items_missing };
    }
    case "acceptance_items_received": {
      const offer = offerOf(i, rt); if (!offer) throw new RangeError("no offer to receive acceptance items for");
      const r = acceptanceItemsReceived({ offer_id: offer.id, outstanding: strs(offer.data.acceptance_items_outstanding), items: strs(i.items), received_on: str(i, "received_on") ? date(i, "received_on") : now });
      const rec = rt.store.put("lossmit_offers", offer.id, { acceptance_items_outstanding: r.items_remaining, ...(r.complete ? { grace_until: null } : {}) }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, complete: r.complete };
    }
    case "smdu_decision": {
      need(i, "case_id", "case_type", "decision"); if (typeof i.borrower_current !== "boolean") throw new RangeError("borrower_current is required");
      const ev = str(i, "evaluation_id") ? rt.store.require("lossmit_evaluations", str(i, "evaluation_id")) : latestEvaluation(rt, loanId);
      const r = ingestSmduDecision({ case_id: str(i, "case_id"), case_type: str(i, "case_type"), decision: str(i, "decision"), borrower_current: i.borrower_current, decided_on: str(i, "decided_on") ? date(i, "decided_on") : now, evaluation_id: ev?.id ?? null, reasons: strs(i.reasons), non_delegated: flag(i, "non_delegated") });
      const rec = rt.store.put("smdu_cases", str(i, "case_id"), { loan_id: loanId, case_type: str(i, "case_type"), fnma_case_id: str(i, "case_id"), status: r.status, decision: { decision: str(i, "decision"), reasons: strs(i.reasons), borrower_current: i.borrower_current, decided_on: r.events[0]!.payload.decided_on }, evaluation_id: ev?.id ?? null, rep_warrant_relief: r.rep_warrant_relief }, ctx.actor, ctx.now);
      if (ev) rt.store.put("lossmit_evaluations", ev.id, { smdu_case_ids: [...new Set([...strs(ev.data.smdu_case_ids), str(i, "case_id")])], ...(r.status === "fnma_referral_pending" ? { status: "fnma_referral_pending" } : {}), ...(r.form182_required ? { reg_b_adverse: true, form182_by: r.form182_by } : {}) }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, form182_required: r.form182_required, form182_by: r.form182_by };
    }
    case "deemed_rejection": {
      // The pending offer row: recorded at provision (op=offer_response / trial payment create it on response); an offer still awaiting any response is opened here from the evaluation's option.
      const known = offerOf(i, rt); const evForOffer = known?.data.evaluation_id ? rt.store.get("lossmit_evaluations", String(known.data.evaluation_id)) ?? null : evaluationOf(i, rt);
      const pendingOption = str(i, "option") || (known?.data.option as string | undefined) || (evForOffer?.data.option as string | undefined) || ""; if (!known && !pendingOption) throw new RangeError("no pending offer (option is required to open one)");
      const offer = known ?? rt.store.put("lossmit_offers", str(i, "offer_id") || `offer-${loanId}-${pendingOption}`, { loan_id: loanId, evaluation_id: evForOffer?.id ?? null, option: pendingOption, status: "pending", provided_at: evForOffer?.data.provided_at ?? null }, ctx.actor, ctx.now);
      const ev = offer.data.evaluation_id ? rt.store.get("lossmit_evaluations", String(offer.data.evaluation_id)) ?? null : null;
      const acceptBy = str(i, "accept_by") ? date(i, "accept_by") : ev?.data.accept_by ? D(String(ev.data.accept_by)) : null; if (!acceptBy) throw new RangeError("accept_by is required");
      const r = deemedRejectionSweep({ offer_id: offer.id, evaluation_id: ev?.id ?? null, option: (offer.data.option as string | undefined) ?? null, accept_by: acceptBy, window_days: Number(i.window_days ?? ev?.data.window_days ?? 14), today: now, responded: offer.data.status === "accepted" || offer.data.status === "rejected", other_pending_offer: flag(i, "other_pending_offer"), appeal_pending: flag(i, "appeal_pending"), all_options_rejected: i.all_options_rejected === undefined ? true : flag(i, "all_options_rejected") });
      if (r.deemed_rejected) { rt.store.put("lossmit_offers", offer.id, { status: "deemed_rejected", deemed_rejected_on: r.deemed_rejected_on }, ctx.actor, ctx.now); if (r.hold_released) for (const h of rt.store.list("foreclosure_holds", (d) => d.loan_id === loanId && d.kind === "lm_offer_pending" && d.status === "active")) rt.store.put("foreclosure_holds", h.id, { status: "released", reason: `deemed rejected ${r.deemed_rejected_on}` }, ctx.actor, ctx.now); }
      emitAll(ctx, loanId, r.events); return { offer_id: offer.id, ...r, events: undefined };
    }
    default: return undefined;
  }
}

/** `timers.*` for 12.2: the section's list/open/arm/cancel plus op=lapse — the not_before_gate sweep (`timer.lapsed{code}`). */
export const timerOps_12_2 = () => (i: ToolInput, ctx: CommandContext): unknown => {
  if (i.op !== "lapse") return timerOps()(i, ctx);
  need(i, "code");
  const r = gateLapses(ctx.timers.open(), str(i, "code"), ctx.now);
  for (const e of r.events) { const inst = ctx.timers.open().find((t) => t.id === e.payload.timer_id); ctx.events.append({ type: e.type, ...(inst?.loanId ? { loanId: inst.loanId } : {}), actor: ctx.actor, payload: e.payload }); }
  return { code: str(i, "code"), lapsed: r.lapsed };
};

/** After a denial template is sent: `lossmit.denial.provided{state, provided_at, template}` — the CA NOD/NOS gate and the appeal window key on it. */
export async function afterDenialSent(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, sent: unknown): Promise<unknown> {
  const n = (await sent) as { id: string; status?: string; templateCode?: string; payload?: Record<string, unknown> };
  if (n.status !== "sent") return n;
  const loanId = (i.loan_id as string | undefined) ?? ctx.loanId; const ev = latestEvaluation(rt, loanId);
  const state = str(i, "state") || (ev?.data.state as string | undefined) || (typeof n.payload?.state === "string" ? n.payload.state : "") || null;
  const r = denialProvided({ notice_id: n.id, template: str(i, "template_code") || n.templateCode || "", state, provided_on: today(ctx), tier: str(i, "tier") || (ev?.data.tier as string | undefined) || null, evaluation_id: ev?.id ?? null, option: str(i, "option") || null });
  if (ev) rt.store.put("lossmit_evaluations", ev.id, { status: "notice_provided", notice_id: n.id, provided_at: ctx.now, appeal_by: r.appeal_by, ...(r.ca_nod_nos_hold_until ? { ca_nod_nos_hold_until: r.ca_nod_nos_hold_until } : {}) }, ctx.actor, ctx.now);
  emitAll(ctx, loanId, r.events);
  return n;
}
