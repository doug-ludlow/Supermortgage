/**
 * §22.2 process-owned tools — bus tools for 22.2 defined with `defineTools("22.2", "verification", defs)` from
 * ../tools.ts. Every tool string is one spec/registry/agents.json names for 22.2; src/app/tools.test.ts refuses the
 * rest. Spread by ./index.ts. The handlers are thin: the rules live in src/domain/verification/ops-22-2.ts; the store
 * keeps `credit_reports`, `credit_alerts`, `credit_freeze_actions`, `inquiry_explanations` (migration 0079),
 * `application_liabilities` (0057), `fee_items` (0064) and `conditions`; the reseller is the `credit_bureau` service
 * (a CreditBureauPort — src/infra wires the Xactus360-class adapter; tests use a fake). Guardrails encode the AI-design
 * sentences: never pull without a recorded permissible purpose and borrower authorization; never a hard pull before the
 * six items and the credit-report-fee handling; never change `score_model` mid-loan without a full re-pull and a
 * written decision; never request a two-repository report; never a soft pre-qualification report for DU; never advise
 * the borrower on raising a score or picking a model on price; never contact a creditor to "fix" a tradeline; never
 * reuse origination reports for marketing; never disclose one borrower's score to another.
 */
import { defineTools, compute, decision, escalate, never, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { scoreBand } from "../../domain/leads-pricing/ops-20-4.ts";
import {
  CreditRefused, CreditGateClosed, SCORE_MODELS, assertDuSubmittable, assertGateOpen, buildReport, computeScores, decisionRecord, declineLift, detectFraudAlerts, detectFreezes, emitScoreDisclosureData, explainInquiry, liftFreeze,
  mapDuCreditMessages, markExpired, matchesKnownTradeline, openInquiryItems, parseReport, placeOrder, receiveRefresh, receiveUdmAlert, recordUdmHeartbeat, refreshPrecloseGate, resolveDispute, scheduleRepull, sfcAssertion, triageUdmAlert, validateOrder, waitingPeriod,
  type AlertType, type BorrowerCredit, type CreditAlert, type CreditBureauPort, type CreditReport, type DerogatoryKind, type DisputeDetermination, type DuCreditMessage, type FreezeAction, type IdentityHeader, type InquiryItem, type Occupancy, type OrderType, type Repository, type ScoreModel, type TriageInput,
} from "../../domain/verification/ops-22-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const strs = (i: ToolInput, k: string): string[] => (Array.isArray(i[k]) ? (i[k] as unknown[]).map(String) : []);
const appRecord = (rt: ToolRuntime, app: string): Record<string, unknown> => rt.store.get("applications", app)?.data ?? {};
const reportOf = (rt: ToolRuntime, i: ToolInput, k = "report_id"): CreditReport => { need(i, k); return rt.store.require("credit_reports", str(i, k)).data as unknown as CreditReport; };
const putReport = (rt: ToolRuntime, r: CreditReport, ctx: CommandContext): void => { rt.store.put("credit_reports", r.report_id, { ...r }, ctx.actor, ctx.now); };
const putAlert = (rt: ToolRuntime, a: CreditAlert, ctx: CommandContext): void => { rt.store.put("credit_alerts", a.alert_id, { ...a }, ctx.actor, ctx.now); };
const alertsOf = (rt: ToolRuntime, app: string): CreditAlert[] => rt.store.list("credit_alerts", (d) => d.application_id === app).map((r) => r.data as unknown as CreditAlert);
const bureauOf = (rt: ToolRuntime): CreditBureauPort => { const p = rt.services.credit_bureau as CreditBureauPort | undefined; if (!p) throw new RangeError("the credit_bureau service (reseller adapter) is not wired into this runtime"); return p; };
const occupancyOf = (i: ToolInput, rt: ToolRuntime, app: string): { occupancy: Occupancy; units: number } => {
  const a = appRecord(rt, app); const occupancy = (str(i, "occupancy") || String(a.occupancy ?? "")) as Occupancy; const units = Number(i.units ?? a.units ?? 1);
  if (!["primary", "second_home", "investment"].includes(occupancy)) throw new RangeError("occupancy (primary/second_home/investment) is required");
  return { occupancy, units };
};
/** The relied-upon report for the application: the input's report_id, else the latest non-superseded hard report. */
const reliedReport = (rt: ToolRuntime, i: ToolInput, app: string): CreditReport => {
  if (typeof i.report_id === "string" && i.report_id) return reportOf(rt, i);
  const r = rt.store.list("credit_reports", (d) => d.application_id === app && (d.report_type === "tri_merge_infile" || d.report_type === "rmcr") && d.state !== "superseded" && d.state !== "expired").map((x) => x.data as unknown as CreditReport).sort((a, b) => a.report_date < b.report_date ? 1 : -1)[0];
  if (!r) throw new RangeError("no credit report on file for the application (report_id)");
  return r;
};
/** Six items + fee handling from the event log (21.1's `application.trid_received`; 21.4's `fee.gate.checked{fee_kind=credit_report}`) or the caller's asserted facts. */
const prerequisites = (i: ToolInput, ctx: CommandContext, app: string): { trid_received: boolean; fee_handled: boolean } => {
  const forApp = (type: string) => ctx.events.ofType(type).filter((e) => e.applicationId === app || (e.payload as Record<string, unknown>).application_id === app);
  const trid_received = flag(i, "trid_received") || forApp("application.trid_received").length > 0;
  const fee_handled = flag(i, "fee_handled") || forApp("fee.gate.checked").some((e) => { const p = e.payload as Record<string, unknown>; return p.fee_kind === "credit_report" && (p.result === "exempt_credit_report" || p.result === "open"); }) || flag(i, "fee_sm_borne");
  return { trid_received, fee_handled };
};
/** Shared by orderCreditReport, detectFreezes op=repull and orderRefresh: validate → reseller → store → events. */
async function order(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, order_type: OrderType, supersedes: CreditReport | null): Promise<Record<string, unknown>> {
  const app = appOf(i, ctx); const a = appRecord(rt, app);
  const borrower_ids = strs(i, "borrower_ids").length ? strs(i, "borrower_ids") : supersedes ? [...supersedes.borrower_ids] : strs(a as ToolInput, "borrower_ids");
  const app_score_model = (typeof a.score_model === "string" && a.score_model ? a.score_model : null) as ScoreModel | null;
  const score_model = (str(i, "score_model") || supersedes?.score_model || app_score_model || str(i, "score_model_default") || "classic_fico") as ScoreModel;
  const pre = prerequisites(i, ctx, app);
  const o = validateOrder({ application_id: app, borrower_ids, order_type, score_model, app_score_model, requested_model_codes: (i.requested_model_codes as Partial<Record<Repository, string>> | undefined) ?? null, ...(Array.isArray(i.repositories) ? { repositories: i.repositories as Repository[] } : {}),
    permissible_purpose: str(i, "permissible_purpose") || supersedes?.permissible_purpose || "", certification_ref: str(i, "certification_ref") || supersedes?.certification_ref || "", borrower_authorization_ref: str(i, "borrower_authorization_ref"), subscriber_code: str(i, "subscriber_code"),
    trid_received: pre.trid_received, fee_handled: pre.fee_handled, joint_intent_facts: (i.joint_intent_facts as Record<string, unknown> | undefined) ?? (a.joint_intent_facts as Record<string, unknown> | undefined) ?? null, ...(i.bi_merge_flag !== undefined ? { bi_merge_flag: flag(i, "bi_merge_flag") } : {}), ordering_agent: `${ctx.actor.kind}:${ctx.actor.id}`, attempt: Number(i.attempt ?? 1) });
  const res = await placeOrder(ctx.events, bureauOf(rt), o, { at: at(i, "at", ctx), app_score_model, fee_item_id: typeof i.fee_item_id === "string" ? i.fee_item_id : null, supersedes }, ctx.actor);
  const report = res.report, superseded = res.superseded;
  if (superseded) putReport(rt, superseded, ctx);
  putReport(rt, report, ctx);
  if (order_type === "tri_merge" || order_type === "rmcr") rt.store.put("applications", app, { ...a, score_model: res.score_model }, ctx.actor, ctx.now);
  return { report, report_id: report.report_id, report_date: report.report_date, expires_at: report.expires_at, score_model: res.score_model, credit_reference_number: report.credit_reference_number, order: o, superseded_report_id: superseded?.report_id ?? null, events: [res.ordered.type, res.received.type, ...(res.score_model_event ? [res.score_model_event.type] : [])] };
}
/** ops-22-2 refusals surface as CommandRefused with the same code and citation; a closed gate as its code. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof CreditRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); if (e instanceof CreditGateClosed) throw new CommandRefused(d.name, e.code, "22.2 timers and gates", e.reason); throw e; } } }));
const NO_MARKETING = never("NO_MARKETING_REUSE", "22.2 guardrail; FCRA use limitation (transaction-only; pii_flags ⊇ {consumer_report})", (i) => /marketing/i.test(str(i, "purpose")) || /marketing/i.test(str(i, "use")), "origination credit reports are never reused for marketing (20.1 may not read them)");
const NO_SCORE_ADVICE = never("NO_SCORE_OR_MODEL_ADVICE", "22.2 guardrail: only factual statements — the loan's model, that a freeze must be lifted, that pricing is based on the representative score", (i) => typeof i.borrower_message === "string" && /(will (improve|raise|lower)|choose (classic|vantage)|better (price|score))/i.test(i.borrower_message), "never advise the borrower on how to raise a score or which model to choose based on price");

export const TOOLS_22_2: readonly ToolDef[] = defineTools("22.2", "verification", refusing([
  // R1: the hard tri-merge (or RMCR / soft pre-qualification) order — validated before transmission, then the reseller, then credit.report.ordered / credit.report.received / credit.score.model.selected.
  { name: "orderCreditReport", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "permissible_purpose", "certification_ref", "borrower_authorization_ref", "subscriber_code");
      const order_type = (str(i, "order_type") || "tri_merge") as OrderType;
      return order(i, ctx, rt, order_type, null); }),
    guardrails: [never("NO_PULL_WITHOUT_PURPOSE_AND_AUTHORIZATION", "15 U.S.C. 1681b(f); §1681e; 22.2 guardrail", (i) => !str(i, "permissible_purpose") || !str(i, "borrower_authorization_ref"), "never pull without a recorded permissible purpose and the borrower's authorization"),
      never("NO_TWO_REPOSITORY_REQUEST", "B3-5.2-01; credit.bi_merge = false (R11)", (i) => Array.isArray(i.repositories) && (i.repositories as unknown[]).length < 3, "never request a two-repository report"),
      never("SOFT_REPORT_NOT_FOR_DU", "22.2 guardrail", (i) => str(i, "order_type") === "soft_prequal" && flag(i, "for_du"), "a soft pre-qualification report is never used for DU"),
      never("SCORE_MODEL_CHANGE_NEEDS_DECISION", "22.2 R11; LL-2026-06", (i) => flag(i, "change_score_model") && !(str(i, "written_decision_id") && flag(i, "full_repull")), "never change score_model mid-loan without a full re-pull and a written decision"), NO_MARKETING] },
  // R4: classify (usable | freeze_blocked | two_repository | no_score | error) and record the representative score; a thin file escalates to underwriting_reviewer.
  { name: "parseCreditReport", kind: "write", handler: compute((i, ctx, rt) => {
      const r = reportOf(rt, i); const p = parseReport(ctx.events, r, at(i, "at", ctx), ctx.actor); putReport(rt, p.report, ctx);
      if (p.classification.escalate_underwriting_reviewer) rt.escalations.open({ kind: "underwriting_reviewer", loanId: ctx.loanId, payload: { application_id: r.application_id, report_id: r.report_id, reason: p.classification.reason } }, ctx.actor);
      const du = (() => { try { assertDuSubmittable(p.report, (appRecord(rt, r.application_id).score_model as ScoreModel | undefined) ?? r.score_model); return { submittable: true, reason: null }; } catch (e) { return { submittable: false, reason: (e as Error).message }; } })();
      return { report_id: r.report_id, state: p.report.state, state_reason: p.report.state_reason, representative_score: p.report.representative_score, borrower_applicable_scores: p.report.borrower_applicable_scores, du, classification: p.classification }; }) },
  // R2: applicable (middle / lower / single) and representative (lowest applicable) scores, with 20.4's LLPA band for the loan's model.
  { name: "computeScores", kind: "read", handler: compute((i, ctx, rt) => {
      const borrowers = Array.isArray(i.borrowers) ? (i.borrowers as BorrowerCredit[]) : typeof i.report_id === "string" && i.report_id ? reportOf(rt, i).borrowers : null;
      if (!borrowers) throw new RangeError("borrowers[] or report_id is required");
      const model = (str(i, "score_model") || (typeof i.report_id === "string" && i.report_id ? reportOf(rt, i).score_model : "classic_fico")) as ScoreModel;
      if (!(SCORE_MODELS as readonly string[]).includes(model)) throw new RangeError(`score_model ${model} is not one of ${SCORE_MODELS.join("/")}`);
      const s = computeScores(borrowers); void ctx;
      return { ...s, score_model: model, llpa_band: scoreBand(model, s.representative_score) }; }) },
  // R4: freeze workflow — detect (credit.freeze.detected + borrower notice), lift (credit.freeze.lifted), decline (21.6 incompleteness), repull (supersedes the report inside the lift window).
  { name: "detectFreezes", kind: "write", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "detect";
      if (op === "detect") { const r = reportOf(rt, i); const d = detectFreezes(ctx.events, r, at(i, "at", ctx), ctx.actor); for (const a of d.actions) rt.store.put("credit_freeze_actions", a.action_id, { ...a }, ctx.actor, ctx.now); return { report_id: r.report_id, actions: d.actions, blocks_du: d.blocks_du, frozen_repositories: r.frozen_repositories, notices: d.events.map((e) => (e.payload as Record<string, unknown>).borrower_notice) }; }
      if (op === "lift") { need(i, "action_id", "lifted_at", "lift_window_start", "lift_window_end"); const a = rt.store.require("credit_freeze_actions", str(i, "action_id")).data as unknown as FreezeAction; const l = liftFreeze(ctx.events, a, { lifted_at: str(i, "lifted_at"), lift_window_start: D(str(i, "lift_window_start")), lift_window_end: D(str(i, "lift_window_end")), method: (str(i, "method") || "electronic") as "electronic" | "telephone" | "mail" }, ctx.actor); rt.store.put("credit_freeze_actions", a.action_id, { ...l.action }, ctx.actor, ctx.now); return { action: l.action, event: l.event.type }; }
      if (op === "decline") { need(i, "action_id"); const a = rt.store.require("credit_freeze_actions", str(i, "action_id")).data as unknown as FreezeAction; const d = declineLift(ctx.events, a, at(i, "at", ctx), ctx.actor); rt.store.put("credit_freeze_actions", a.action_id, { ...d.action }, ctx.actor, ctx.now); return { action: d.action, incompleteness_path: d.incompleteness_path }; }
      if (op === "repull") { const old = reportOf(rt, i); need(i, "borrower_authorization_ref", "subscriber_code"); const res = await order({ ...i, permissible_purpose: str(i, "permissible_purpose") || old.permissible_purpose, certification_ref: str(i, "certification_ref") || old.certification_ref }, ctx, rt, "tri_merge", old);
        for (const rec of rt.store.list("credit_freeze_actions", (d) => d.report_id === old.report_id && d.status === "lifted")) rt.store.put("credit_freeze_actions", rec.id, { ...rec.data, status: "re_pulled", re_pull_at: at(i, "at", ctx) }, ctx.actor, ctx.now);
        return res; }
      throw new RangeError(`op ${op} is not one of detect/lift/decline/repull`); }),
    guardrails: [NO_SCORE_ADVICE, never("NO_CREDITOR_TRADELINE_FIX", "22.2 guardrail; FCRA §611/§623 (the borrower disputes with the furnisher/CRA)", (i) => flag(i, "contact_creditor_to_fix"), "never contact a creditor to \"fix\" a tradeline")] },
  // R5: fraud/active-duty alerts and identity mismatches → credit.fraud_alert.detected (22.6's contact gate) and the fraud-risk hand-off; op=clear records 22.6's completion.
  { name: "detectFraudAlerts", kind: "write", handler: compute((i, ctx, rt) => {
      const r = reportOf(rt, i);
      if (str(i, "op") === "clear") { need(i, "contact_completed_event_id"); putReport(rt, { ...r, fraud_alert_cleared: true }, ctx); return { report_id: r.report_id, fraud_alert_cleared: true }; }
      const ids = Array.isArray(i.application_identities) ? (i.application_identities as IdentityHeader[]) : (rt.store.list("application_borrowers", (d) => d.application_id === r.application_id).map((x) => x.data as unknown as IdentityHeader));
      const d = detectFraudAlerts(ctx.events, r, ids, at(i, "at", ctx), ctx.actor);
      return { report_id: r.report_id, alerts: d.alerts, mismatches: d.mismatches, blocks_du: d.blocks_du, handoff: d.handoff, events: d.events.map((e) => e.type) }; }) },
  // R6: DU credit messages → dispute items (SM_CREDIT_DISPUTE_RESOLUTION_5), collections/public-record conditions by occupancy, mortgage-delinquency ineligibility; op=resolve_dispute records the written determination; op=waiting_period runs R7.
  { name: "mapDuCreditMessages", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "map";
      if (op === "resolve_dispute") { need(i, "dispute_id", "borrower_id", "determination", "rationale"); const app = appOf(i, ctx);
        const r = resolveDispute(ctx.events, { application_id: app, dispute_id: str(i, "dispute_id"), borrower_id: str(i, "borrower_id"), determination: str(i, "determination") as DisputeDetermination, documentation_ids: strs(i, "documentation_ids"), rationale: str(i, "rationale"), resolved_at: at(i, "resolved_at", ctx) }, ctx.actor);
        if (r.escalate) rt.escalations.open({ kind: "underwriting_reviewer", loanId: ctx.loanId, payload: { application_id: app, dispute_id: str(i, "dispute_id"), reason: "dispute investigation concluded responsible and accurate: not eligible for delivery as a DU loan (B3-5.3-09)" } }, ctx.actor);
        return { eligible_as_du: r.eligible_as_du, escalated_to: r.escalate, event: r.event.type }; }
      if (op === "waiting_period") { need(i, "kind", "event_date", "report_date", "scheduled_disbursement_date"); return waitingPeriod({ kind: str(i, "kind") as DerogatoryKind, event_date: D(str(i, "event_date")), extenuating: flag(i, "extenuating"), report_date: D(str(i, "report_date")), scheduled_disbursement_date: D(str(i, "scheduled_disbursement_date")) }); }
      const r = reportOf(rt, i); need(i, "du_findings_received_at");
      const m = mapDuCreditMessages(ctx.events, r, { occupancy: occupancyOf(i, rt, r.application_id), du_messages: Array.isArray(i.du_messages) ? (i.du_messages as DuCreditMessage[]) : [], du_findings_received_at: str(i, "du_findings_received_at"), du_recommendation: typeof i.du_recommendation === "string" ? i.du_recommendation : null }, ctx.actor);
      m.conditions.forEach((c, n) => rt.store.put("conditions", `${r.report_id}-c${n + 1}`, { application_id: r.application_id, source: "22.2", ...c, amount_cents: c.amount_cents === null ? null : String(c.amount_cents), status: "proposed" }, ctx.actor, ctx.now));
      return { report_id: r.report_id, conditions: m.conditions, disputes: m.disputes, du_ineligible: m.du_ineligible, relief_message_3941: m.relief_message_3941, needs_list_items: m.disputes.map((d) => d.needs_list_item).filter(Boolean) }; }),
    guardrails: [never("NO_CREDITOR_TRADELINE_FIX", "22.2 guardrail; the borrower disputes with the furnisher/CRA", (i) => flag(i, "contact_creditor_to_fix"), "never contact a creditor to \"fix\" a tradeline")] },
  // R8: inquiries in the last 90 days not matching the partner's pull / DU reissue open `inquiry_explanations`; op=explain records the borrower's answer and, on new credit, the liability (22.5), the DTI move and 23.1's B3-2-10 check.
  { name: "openInquiryItems", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "open";
      if (op === "explain") { need(i, "inquiry_id", "explanation"); const item = rt.store.require("inquiry_explanations", str(i, "inquiry_id")).data as unknown as InquiryItem;
        const x = explainInquiry(ctx.events, item, { explanation: str(i, "explanation"), new_credit_obtained: flag(i, "new_credit_obtained"), explained_at: at(i, "explained_at", ctx), evidence_document_id: typeof i.evidence_document_id === "string" ? i.evidence_document_id : null, creditor_name: typeof i.creditor_name === "string" ? i.creditor_name : null, liability_kind: typeof i.liability_kind === "string" ? i.liability_kind : null,
          monthly_payment_cents: optCents(i, "monthly_payment_cents"), balance_cents: optCents(i, "balance_cents"), qualifying_income_cents: optCents(i, "qualifying_income_cents"), obligations_cents: optCents(i, "obligations_cents") }, ctx.actor);
        rt.store.put("inquiry_explanations", item.inquiry_id, { ...x.item }, ctx.actor, ctx.now);
        if (x.impact) rt.store.put("application_liabilities", x.impact.liability.liability_id, { ...x.impact.liability, monthly_payment_cents: String(x.impact.liability.monthly_payment_cents), balance_cents: String(x.impact.liability.balance_cents) }, ctx.actor, ctx.now);
        return { item: x.item, impact: x.impact, tolerance: x.impact?.tolerance ?? null, events: x.events.map((e) => e.type) }; }
      const r = reportOf(rt, i); need(i, "subscriber_code");
      const items = openInquiryItems(r, { subscriber_code: str(i, "subscriber_code"), du_reissue_refs: strs(i, "du_reissue_refs") });
      for (const it of items) rt.store.put("inquiry_explanations", it.inquiry_id, { ...it }, ctx.actor, ctx.now);
      return { report_id: r.report_id, items, needs_list_items: items.map((it) => `inquiry explanation: ${it.creditor_name} (${it.inquiry_date})`) }; }) },
  // R9: UDM loop — op=receive (credit.udm.alert.received), op=triage (false_positive | explained | verified_new_debt → 22.5/23.1, relief note), op=heartbeat (SM_UDM_MONITOR_ACTIVE), op=stop (closing.consummated).
  { name: "triageUdmAlert", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "triage"; const app = appOf(i, ctx);
      if (op === "receive") { need(i, "borrower_id", "alert_type"); const r = receiveUdmAlert(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), alert_type: str(i, "alert_type") as AlertType, payload: (i.payload as Record<string, unknown> | undefined) ?? {}, received_at: at(i, "received_at", ctx), vendor_alert_id: typeof i.vendor_alert_id === "string" ? i.vendor_alert_id : null }, ctx.actor); putAlert(rt, r.alert, ctx);
        const known = rt.store.list("credit_reports", (d) => d.application_id === app).flatMap((x) => (x.data as unknown as CreditReport).tradelines ?? []);
        return { alert: r.alert, suggested_status: matchesKnownTradeline(r.alert, known) ? "false_positive" : "open" }; }
      if (op === "heartbeat") { need(i, "vendor"); const e = recordUdmHeartbeat(ctx.events, { application_id: app, vendor: str(i, "vendor"), at: at(i, "at", ctx), alerts_delivered: Number(i.alerts_delivered ?? 0) }, ctx.actor); return { event: e.type, at: e.occurredAt }; }
      if (op === "stop") { const cancelled: string[] = []; for (const t of ctx.timers.forSubject("application", app)) if (t.code === "SM_UDM_MONITOR_ACTIVE" && (t.status === "armed" || t.status === "breached")) { ctx.timers.cancel(t.id, "closing.consummated: monitoring ends", ctx.actor); cancelled.push(t.id); } return { cancelled }; }
      need(i, "alert_id", "status", "rationale"); const a = rt.store.require("credit_alerts", str(i, "alert_id")).data as unknown as CreditAlert;
      const t = triageUdmAlert(ctx.events, a, { status: str(i, "status") as TriageInput["status"], triaged_at: at(i, "triaged_at", ctx), rationale: str(i, "rationale"), explanation: typeof i.explanation === "string" ? i.explanation : null, evidence_document_id: typeof i.evidence_document_id === "string" ? i.evidence_document_id : null, monthly_payment_cents: optCents(i, "monthly_payment_cents"), balance_cents: optCents(i, "balance_cents"),
        liability_kind: typeof i.liability_kind === "string" ? i.liability_kind : null, creditor_name: typeof i.creditor_name === "string" ? i.creditor_name : null, qualifying_income_cents: optCents(i, "qualifying_income_cents"), obligations_cents: optCents(i, "obligations_cents") }, ctx.actor);
      putAlert(rt, t.alert, ctx);
      if (t.impact) rt.store.put("application_liabilities", t.impact.liability.liability_id, { ...t.impact.liability, monthly_payment_cents: String(t.impact.liability.monthly_payment_cents), balance_cents: String(t.impact.liability.balance_cents) }, ctx.actor, ctx.now);
      return { alert: t.alert, impact: t.impact, relief_note: t.relief_note, next: t.next, events: t.events.map((e) => e.type) }; }) },
  // R9: the pre-closing soft refresh (or UDM snapshot) — reseller order, compare against the relied report, alerts for new tradelines, credit.refresh.received, and the gate result; op=assert_gate asserts SM_CREDIT_REFRESH_PRECLOSE_GATE.
  { name: "orderRefresh", kind: "act", handler: compute(async (i, ctx, rt) => {
      const app = appOf(i, ctx); const a = appRecord(rt, app);
      const consummation = optDate(i, "scheduled_consummation_date") ?? (typeof a.scheduled_consummation_date === "string" ? D(a.scheduled_consummation_date) : null);
      const facts = (refresh_report_date: PlainDate | null, refresh_report_type: string | null) => ({ scheduled_consummation_date: consummation, refresh_report_date, refresh_report_type, alerts: alertsOf(rt, app).map((x) => ({ alert_id: x.alert_id, status: x.status })) });
      if (str(i, "op") === "assert_gate") { const latest = rt.store.list("credit_reports", (d) => d.application_id === app && (d.report_type === "soft_refresh" || d.report_type === "udm_snapshot")).map((x) => x.data as unknown as CreditReport).sort((x, y) => (x.report_date < y.report_date ? 1 : -1))[0] ?? null;
        const f = facts(optDate(i, "refresh_report_date") ?? latest?.report_date ?? null, str(i, "refresh_report_type") || latest?.report_type || null); assertGateOpen("SM_CREDIT_REFRESH_PRECLOSE_GATE", f); return { open: true, facts: f }; }
      need(i, "permissible_purpose", "certification_ref", "borrower_authorization_ref", "subscriber_code");
      const relied = reliedReport(rt, i, app);
      const o = validateOrder({ application_id: app, borrower_ids: [...relied.borrower_ids], order_type: "soft_refresh", score_model: relied.score_model, app_score_model: relied.score_model, permissible_purpose: str(i, "permissible_purpose"), certification_ref: str(i, "certification_ref"), borrower_authorization_ref: str(i, "borrower_authorization_ref"), subscriber_code: str(i, "subscriber_code"), trid_received: true, fee_handled: true, ordering_agent: `${ctx.actor.kind}:${ctx.actor.id}`, attempt: Number(i.attempt ?? 1) });
      const resp = await bureauOf(rt).order(o); const refresh = buildReport(o, resp, null); putReport(rt, refresh, ctx);
      const known = new Set(relied.tradelines.map((t) => `${t.borrower_id}|${t.account_ref}`)); const fresh = refresh.tradelines.filter((t) => !known.has(`${t.borrower_id}|${t.account_ref}`));
      for (const t of fresh) { const r = receiveUdmAlert(ctx.events, { application_id: app, borrower_id: t.borrower_id, alert_type: "new_tradeline", payload: { creditor_name: t.creditor_name, account_ref: t.account_ref, monthly_payment_cents: String(t.monthly_payment_cents) }, received_at: resp.received_at, source: "refresh_compare" }, ctx.actor); putAlert(rt, r.alert, ctx); }
      const open = alertsOf(rt, app).filter((x) => x.status === "open" || x.status === "verified_new_debt").length;
      const ev = receiveRefresh(ctx.events, { application_id: app, report_id: refresh.report_id, report_type: "soft_refresh", report_date: refresh.report_date, received_at: resp.received_at, alerts_open: open, new_tradelines: fresh.length, scheduled_consummation_date: consummation }, ctx.actor);
      const gate = refreshPrecloseGate(facts(refresh.report_date, "soft_refresh"));
      return { report_id: refresh.report_id, report_date: refresh.report_date, new_tradelines: fresh.length, alerts_open: open, gate, event: ev.type }; }),
    guardrails: [NO_MARKETING] },
  // R3: the four-month clock — schedule the re-pull (≥ 10 days before the note date), assert FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M (op=assert_gate), or mark the report expired (op=expire); the warning timer is cancelled when closing is confirmed before expires_at.
  { name: "scheduleRepull", kind: "write", handler: compute((i, ctx, rt) => {
      const r = reportOf(rt, i); need(i, "scheduled_note_date"); const note = D(str(i, "scheduled_note_date")); const op = str(i, "op") || "schedule";
      if (op === "assert_gate") { assertGateOpen("FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M", { report_date: r.report_date, expires_at: r.expires_at, scheduled_note_date: note, state: r.state }); return { open: true, expires_at: r.expires_at, scheduled_note_date: note }; }
      if (op === "expire") { const x = markExpired(ctx.events, r, note, at(i, "at", ctx), ctx.actor); putReport(rt, x.report, ctx); return { report_id: r.report_id, state: x.report.state, event: x.event.type }; }
      const s = scheduleRepull(ctx.events, r, note, at(i, "at", ctx), ctx.actor);
      if (s.gate_open) for (const t of ctx.timers.forSubject("application", r.application_id)) if (t.code === "SM_CREDIT_EXPIRY_WARN_21" && (t.status === "armed" || t.status === "breached")) ctx.timers.cancel(t.id, `closing ${note} confirmed before expires_at ${r.expires_at}`, ctx.actor);
      return { report_id: r.report_id, expires_at: s.expires_at, warn_on: s.warn_on, repull_by: s.repull_by, gate_open: s.gate_open, scheduled_note_date: note, same_score_model: r.score_model }; }) },
  // R10: per-borrower score/key-factor/range/date/CRA payloads for 21.3 (§609(g), Reg V H-3) and 21.6 (§615(a)); the HMDA feed for 28.3; op=sfc asserts the LL-2026-06 SFC 067 invariant for 29.3.
  { name: "emitScoreDisclosureData", kind: "write", handler: compute((i, ctx, rt) => {
      if (str(i, "op") === "sfc") { need(i, "score_model"); return sfcAssertion(str(i, "score_model") as ScoreModel, strs(i, "sfc_codes")); }
      const r = reportOf(rt, i); const d = emitScoreDisclosureData(ctx.events, r, at(i, "at", ctx), ctx.actor);
      return { report_id: r.report_id, payloads: d.payloads, hmda: d.hmda, events: d.events.length }; }),
    guardrails: [never("NO_CROSS_BORROWER_DISCLOSURE", "Reg V §1022.75(c); 22.2 guardrail: never disclose one borrower's score to another", (i) => typeof i.recipient_borrower_id === "string" && typeof i.borrower_id === "string" && i.recipient_borrower_id !== i.borrower_id, "each borrower receives only their own scores")] },
  // Decision record per report: {report_id, order_inputs, permissible_purpose, certification_ref, repositories_returned, frozen, scores, applicable_scores, representative_score, model, du_messages_mapped, conditions_proposed, alerts_triaged, rationale, confidence}.
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "action", "rationale");
      const record = typeof i.report_id === "string" && i.report_id ? decisionRecord(reportOf(rt, i), { rationale: str(i, "rationale"), confidence: Number(i.confidence ?? 1), du_messages_mapped: Number(i.du_messages_mapped ?? 0), conditions_proposed: strs(i, "conditions_proposed"), alerts_triaged: Number(i.alerts_triaged ?? 0) }) : null;
      decision()({ ...i, rule_set_version: str(i, "rule_set_version") || record?.rule_set_version || "fnma.selling.2026-09-02", ...(record ? { subject: { kind: "credit_report", id: record.report_id } } : {}) }, ctx);
      return { recorded: true, record }; }) },
  // underwriting_reviewer (credit-driven denial/counteroffer/NOIA, SLA 2 business_days_creditor; "responsible and accurate" disputes), human_agent on request / after three unanswered freeze reminders, fraud-risk hand-off via credit.fraud_alert.detected.
  { name: "escalate", kind: "act", handler: escalate("underwriting_reviewer") },
]));
