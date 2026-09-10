/**
 * §13.7 process-owned tool handlers. The spec names four tools for `foreclosure-ops` on 13.7 — `documents.extract`,
 * `litigation.classify`, `foreclosure.case.get`, `attorney.message.send` — and src/app/tools.test.ts refuses any other
 * name, so the litigation/environmental lifecycle runs as ops on those two act tools (the §13 `scra.case.get/open/close`
 * idiom), registered in ./section13.ts and executed here:
 *
 *   litigation.classify — the litigation-intake sub-agent's classification surface (rules + model) for both matter
 *     kinds. `op` (default `classify`): `classify` (notice received → classified; the 2-BD Form 20 clock, the portal
 *     task and LITIGATION_HOLD), `confirm` (attorney), `trigger` (E-1.3-02 exception trigger), `form20_submitted` /
 *     `form20_portal_filed` (fnma_portal_operator; the quatro-outage email fallback keeps both timestamps),
 *     `form20_responded` (Fannie Mae's direction; the officer's acknowledgment releases the hold), `status_update`
 *     (monthly E-1.3-01 update), `hazard_suspected` / `hazard_confirmed` / `servicing_rep_report` /
 *     `lead_paint_notification` / `hazard_direction` (officer) / `hazard_cleared` (human-reviewed evidence) /
 *     `ma_citation_search` — the F-1-08 environmental path.
 *   attorney.message.send — the attorney-network channel: `kind` `message` (default), `pleading_due`, `draft_to_fnma`,
 *     `review_closed`, `file_pleading` (attorney; FNMA_E1301_PLEADING_REVIEW_GATE), `removal_or_appeal_proposed`,
 *     `approval_granted` (officer), `file_removal_or_appeal` (attorney; FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE),
 *     `workout_notice`, `counsel_ack` (attorney), `workout_offer_release` (FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE).
 *
 * Gate facts are the store's (`litigation_matters`, `litigation_pleadings`, `environmental_hazards`,
 * `foreclosure_holds`), never the caller's; a closed gate leaves `foreclosure.gate.refused{command, code}` and throws
 * `GateClosed`. Every event a 13.7 timer is armed or satisfied by is built by src/domain/foreclosure/ops-13-7.ts and
 * appended here. `TOOLS_13_7` stays empty: the names are already registered by ./section13.ts for 13.7.
 */
import { compute, never, needsRole, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { assertGate, GateClosed } from "../evaluators.ts";
import type { CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Escalation as DomainEscalation } from "../../domain/foreclosure/ops.ts";
import { litigationNoticeIntake, classificationConfirmed, exceptionTriggerDetected, form20Submission, form20PortalFiled, form20Response, statusUpdateSent, pleadingDue, draftGivenToFnma, pleadingReviewClosed, pleadingFilingGate, removalOrAppealProposed, approvalGranted, removalOrAppealFilingGate, workoutCounselNotice, counselAcknowledged, workoutOfferReleaseGate, hazardSuspected, hazardConfirmed, servicingRepReport, leadPaintNotice, hazardDirection, hazardCleared, maCitationSearchCompleted, classifyClaims, RULE_SET_VERSION_13_7, type EmittedEvent, type Claims, type NoticeSource, type ExceptionCategory, type ExceptionEvent, type Form20Kind, type FnmaDirection, type HazardKind, type HazardSource, type PleadingKind, type EnvironmentalReport } from "../../domain/foreclosure/ops-13-7.ts";

type Row = Record<string, unknown>;
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const at = (i: ToolInput, k: string, ctx: CommandContext): string => str(i, k) || ctx.now;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const money = (v: unknown): bigint | undefined => (v === undefined || v === null || v === "" ? undefined : typeof v === "bigint" ? v : BigInt(String(v)));
const by = (ctx: CommandContext) => ({ kind: ctx.actor.kind, id: ctx.actor.id, ...(ctx.actor.role ? { role: ctx.actor.role } : {}) });
const loanOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "loan_id") || ctx.loanId; if (!id) throw new RangeError("loan_id is required"); return id; };
const emitAll = (ctx: CommandContext, loanId: string, events: readonly EmittedEvent[]): void => { for (const e of events) ctx.events.append({ type: e.type, loanId, actor: ctx.actor, ...(e.occurred_at ? { occurredAt: e.occurred_at } : {}), payload: e.payload }); };
const ESCALATION_KIND: Record<DomainEscalation["kind"], { kind: EscalationKind; ownerRole?: string }> = { officer: { kind: "officer" }, attorney: { kind: "attorney" }, human_agent: { kind: "human_agent" }, fnma_portal_operator: { kind: "human_portal_task" }, signing_officer: { kind: "signing_officer" }, lossmit_reviewer: { kind: "lossmit_reviewer" }, compliance_sentinel: { kind: "sev1", ownerRole: "compliance_sentinel" } };
const openAll = (rt: ToolRuntime, ctx: CommandContext, loanId: string, escalations: readonly DomainEscalation[], payload: Row): string[] =>
  escalations.map((e) => { const m = ESCALATION_KIND[e.kind]; return rt.escalations.open({ kind: m.kind, loanId, ...(m.ownerRole ? { ownerRole: m.ownerRole } : {}), ...(e.severity ? { severity: e.severity } : {}), payload: { ...payload, reason: e.reason, ...(e.kind === "fnma_portal_operator" ? { kind: "form20" } : {}) } }, ctx.actor).id; });
/** A closed gate leaves its trail (13.1 Outputs: `foreclosure.gate.refused{command, code}`) before the command throws. */
const refuseGate = (ctx: CommandContext, loanId: string, command: string, code: string, reason: string, extra: Row = {}): never => {
  ctx.events.append({ type: "foreclosure.gate.refused", loanId, actor: ctx.actor, payload: { command, code, reason, ...extra } });
  throw new GateClosed(code, reason);
};
const matterOf = (rt: ToolRuntime, i: ToolInput, loanId: string): (Row & { id: string }) | null => {
  const id = str(i, "matter_id"); const r = id ? rt.store.get("litigation_matters", id) : rt.store.list("litigation_matters").filter((m) => m.data.loan_id === loanId && m.data.status !== "closed").at(-1);
  return r ? { ...r.data, id: r.id } : null;
};
const requireMatter = (rt: ToolRuntime, i: ToolInput, loanId: string): Row & { id: string } => { const m = matterOf(rt, i, loanId); if (!m) throw new RangeError(`no open litigation matter for ${loanId}${str(i, "matter_id") ? ` (${str(i, "matter_id")})` : ""}`); return m; };
const requireHazard = (rt: ToolRuntime, i: ToolInput): Row & { id: string } => { need(i, "hazard_id"); const r = rt.store.require("environmental_hazards", str(i, "hazard_id")); return { ...r.data, id: r.id }; };
const holdOpen = (d: Row): boolean => d.status !== "released" && d.status !== "closed" && (d.closed_at === undefined || d.closed_at === null);
const litigatedLoan = (rt: ToolRuntime, loanId: string): boolean => rt.store.list("litigation_matters").some((m) => m.data.loan_id === loanId && m.data.status !== "closed");
const claimsOf = (i: ToolInput): Claims => { const c = (i.claims as Claims | undefined) ?? {}; return { damages_against_fnma: flag(i, "damages_against_fnma") || c.damages_against_fnma === true, attacks_validity_priority_enforceability: flag(i, "attacks_validity_priority_enforceability") || c.attacks_validity_priority_enforceability === true, enumerated_risk: flag(i, "enumerated_risk") || c.enumerated_risk === true, damages_claim: flag(i, "damages_claim") || c.damages_claim === true, seeks_injunction: flag(i, "seeks_injunction") || c.seeks_injunction === true, damages_only: flag(i, "damages_only") || c.damages_only === true, environmental: flag(i, "environmental") || c.environmental === true, putative_class: flag(i, "putative_class") || c.putative_class === true }; };

// ---- litigation.classify ------------------------------------------------------------------------------------------
export const litigationClassifyHandler = compute((i, ctx, rt) => {
  const op = str(i, "op") || "classify"; const loanId = loanOf(i, ctx);
  switch (op) {
    case "classify": {
      const matterId = str(i, "matter_id") || `lit-${loanId}-${ctx.now}`;
      const r = litigationNoticeIntake({ matter_id: matterId, loan_id: loanId, source: (str(i, "source") || "service_of_process") as NoticeSource, served_on: optDate(i, "served_on"), firm_notice_on: optDate(i, "firm_notice_on"), docket_alert_on: optDate(i, "docket_alert_on"), documents: ids(i.documents), claims: claimsOf(i), confidence: Number(i.confidence ?? 1), ...(str(i, "exception_category") ? { exception_category: str(i, "exception_category") as ExceptionCategory } : {}), ...(str(i, "court") ? { court: str(i, "court") } : {}), ...(str(i, "docket_no") ? { docket_no: str(i, "docket_no") } : {}), ...(str(i, "caption") ? { caption: str(i, "caption") } : {}), counsel_firm_id: optStr(i, "counsel_firm_id") });
      const rec = rt.store.put("litigation_matters", matterId, r.row, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events);
      let holdId: string | null = null;
      if (r.hold) { const h = rt.store.put("foreclosure_holds", `hold-${loanId}-litigation`, { loan_id: loanId, kind: "litigation", status: "active", scope: [...r.hold.steps], from: r.hold.opened_on, reason: `${r.hold.code}: ${r.classification} category ${r.category}`, source_matter_id: rec.id }, ctx.actor, ctx.now); holdId = h.id; rt.store.put("litigation_matters", matterId, { fc_hold_id: holdId }, ctx.actor, ctx.now); }
      const escalationIds = openAll(rt, ctx, loanId, r.escalations, { matter_id: rec.id, classification: r.classification, category: r.category, form20_due: r.form20.due });
      ctx.decide({ agent: ctx.actor.id, action: "litigation.classify", rationale: r.decision.rationale, ruleSetVersion: RULE_SET_VERSION_13_7, loanId, subject: { kind: "litigation_matter", id: rec.id }, ruleCode: "13.7:rules1-4", confidence: r.decision.confidence, evidenceDocumentIds: ids(i.documents) });
      return { ...rec.data, hold: r.hold, hold_id: holdId, form20: r.form20, notice_received_at: r.notice_received_at, escalation_id: escalationIds.at(-1) ?? null, escalation_ids: escalationIds, decision: r.decision };
    }
    case "classify_only": return classifyClaims(claimsOf(i), Number(i.confidence ?? 1));
    case "confirm": {
      const m = requireMatter(rt, i, loanId); need(i, "classification");
      const r = classificationConfirmed({ matter_id: m.id, loan_id: loanId, classification: str(i, "classification") as "routine" | "non_routine", ...(i.category !== undefined ? { category: Number(i.category) as 1 | 2 | 3 } : {}), confirmed_by: by(ctx), confirmed_on: D(at(i, "confirmed_at", ctx).slice(0, 10)), notice_received_at: D(String(m.notice_received_at)) });
      const rec = rt.store.put("litigation_matters", m.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      // a routine confirmation ends the conservative 2-BD clock (E-1.3-02 applies to non-routine litigation only)
      const cancelled = r.cancel_form20_clock ? ctx.timers.forSubject("loan", loanId).filter((t) => t.code === "FNMA_E1302_FORM20_2BD" && (t.status === "armed" || t.status === "breached")).map((t) => { ctx.timers.cancel(t.id, "attorney confirmed the matter routine (13.7 rule 1)", ctx.actor); return t.id; }) : [];
      return { ...rec.data, cancelled_timer_ids: cancelled };
    }
    case "trigger": {
      const m = requireMatter(rt, i, loanId); need(i, "event", "on");
      const r = exceptionTriggerDetected({ matter_id: m.id, loan_id: loanId, matter: (str(i, "matter") || String(m.exception_category ?? "")) as "standing" | "mers" | "hamp", event: str(i, "event") as ExceptionEvent, on: date(i, "on"), ...(str(i, "source") ? { source: str(i, "source") as "docket" | "firm" } : {}) });
      const rec = rt.store.put("litigation_matters", m.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      const escalationIds = openAll(rt, ctx, loanId, r.escalations, { matter_id: m.id, form20_due: r.due });
      return { ...rec.data, form20_required: r.form20_required, form20_due: r.due, timer: r.timer, escalation_ids: escalationIds };
    }
    case "form20_submitted": {
      const m = matterOf(rt, i, loanId); need(i, "kind", "package_document_id", "channel");
      const r = form20Submission({ submission_id: str(i, "submission_id") || `f20-${loanId}-${ctx.now}`, matter_id: m?.id ?? null, loan_id: loanId, kind: str(i, "kind") as Form20Kind, environmental: flag(i, "environmental") || m?.environmental === true, package_document_id: str(i, "package_document_id"), submitted_at: at(i, "submitted_at", ctx), submitted_by: by(ctx), channel: str(i, "channel") as "quatro" | "email", quatro_reference: optStr(i, "quatro_reference"), outage_note: flag(i, "outage_note"), notice_received_at: m?.notice_received_at ? D(String(m.notice_received_at)) : null, form20_due: m?.form20_due_at ? D(String(m.form20_due_at)) : null });
      const rec = rt.store.put("form20_submissions", String(r.row.id), r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      if (m) rt.store.put("litigation_matters", m.id, { form20_submission_id: rec.id, form20_submitted_at: r.row.submitted_at }, ctx.actor, ctx.now);
      return { ...rec.data, submitted_on: r.submitted_on, due: r.due, on_time: r.on_time };
    }
    case "form20_portal_filed": {
      need(i, "submission_id", "quatro_reference"); const s = rt.store.require("form20_submissions", str(i, "submission_id"));
      const r = form20PortalFiled({ submission_id: s.id, matter_id: (s.data.matter_id as string | null) ?? null, loan_id: loanId, filed_at: at(i, "filed_at", ctx), quatro_reference: str(i, "quatro_reference"), emailed_at: String(s.data.emailed_at ?? "") });
      const rec = rt.store.put("form20_submissions", s.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      return { ...rec.data, timestamps: r.timestamps };
    }
    case "form20_responded": {
      need(i, "submission_id", "direction", "response_document_id"); const s = rt.store.require("form20_submissions", str(i, "submission_id")); const m = s.data.matter_id ? rt.store.get("litigation_matters", String(s.data.matter_id)) : undefined;
      const hold = rt.store.get("foreclosure_holds", `hold-${loanId}-litigation`); const open = hold !== undefined && holdOpen(hold.data);
      const r = form20Response({ submission_id: s.id, matter_id: m?.id ?? null, loan_id: loanId, direction: str(i, "direction") as FnmaDirection, response_document_id: str(i, "response_document_id"), responded_at: at(i, "responded_at", ctx), recorded_by: by(ctx), hold_open: open });
      const rec = rt.store.put("form20_submissions", s.id, r.row, ctx.actor, ctx.now); if (m) rt.store.put("litigation_matters", m.id, r.matter, ctx.actor, ctx.now);
      if (r.hold_released && hold) rt.store.put("foreclosure_holds", hold.id, { status: "released", released_at: ctx.now, released_by: `${ctx.actor.kind}:${ctx.actor.id}`, release_reason: `Fannie Mae direction ${str(i, "direction")}` }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); const escalationIds = openAll(rt, ctx, loanId, r.escalations, { submission_id: s.id, direction: str(i, "direction") });
      return { ...rec.data, hold_released: r.hold_released, escalation_ids: escalationIds };
    }
    case "status_update": {
      const m = requireMatter(rt, i, loanId); need(i, "period", "document_id");
      const r = statusUpdateSent({ matter_id: m.id, loan_id: loanId, period: str(i, "period"), sent_at: at(i, "sent_at", ctx), document_id: str(i, "document_id"), ...(str(i, "channel") ? { channel: str(i, "channel") as "fnma_legal_email" | "quatro" } : {}) });
      emitAll(ctx, loanId, r.events); rt.store.put("litigation_matters", m.id, { last_status_update_period: str(i, "period"), last_status_update_at: at(i, "sent_at", ctx) }, ctx.actor, ctx.now);
      return { matter_id: m.id, period: str(i, "period"), sent: true };
    }
    // ---- environmental (F-1-08)
    case "hazard_suspected": {
      need(i, "hazard_id", "kind", "source", "detected_on", "note");
      const r = hazardSuspected({ hazard_id: str(i, "hazard_id"), loan_id: loanId, property_id: optStr(i, "property_id"), kind: str(i, "kind") as HazardKind, source: str(i, "source") as HazardSource, detected_on: date(i, "detected_on"), note: str(i, "note"), inspection_id: optStr(i, "inspection_id") });
      const rec = rt.store.put("environmental_hazards", str(i, "hazard_id"), r.row, ctx.actor, ctx.now);
      const h = rt.store.put("foreclosure_holds", `hold-${loanId}-environmental`, { loan_id: loanId, kind: "environmental", status: "active", scope: ["refer", "first_notice", "judgment_motion", "sale_conduct"], from: str(i, "detected_on"), reason: `FNMA_F108_ENV_NO_FORECLOSURE_GATE: ${str(i, "kind")} suspected — hold on suspicion (13.7 decision 3)`, source_hazard_id: rec.id }, ctx.actor, ctx.now);
      rt.store.put("environmental_hazards", rec.id, { fc_hold_id: h.id }, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      const escalationIds = openAll(rt, ctx, loanId, r.escalations, { hazard_id: rec.id, confirm_by: r.confirmation_due });
      return { ...rec.data, fc_hold_id: h.id, confirmation_task: { due: r.confirmation_due, escalation_id: escalationIds[0] ?? null }, gate_closed: false, referral_allowed: false, hold_policy: r.hold.policy };
    }
    case "hazard_confirmed": {
      need(i, "hazard_id", "kind", "source", "confirmed_on", "evidence_document_id"); const prev = rt.store.get("environmental_hazards", str(i, "hazard_id"))?.data;
      const r = hazardConfirmed({ hazard_id: str(i, "hazard_id"), loan_id: loanId, kind: str(i, "kind") as HazardKind, source: str(i, "source") as HazardSource, confirmed_on: date(i, "confirmed_on"), evidence_document_id: str(i, "evidence_document_id"), referred: flag(i, "referred"), referral_on: optDate(i, "referral_on"), units: i.units === undefined || i.units === null ? null : Number(i.units), citation_document_id: optStr(i, "citation_document_id") });
      const rec = rt.store.put("environmental_hazards", str(i, "hazard_id"), { ...(prev ? {} : { detected_at: str(i, "confirmed_on") }), ...r.row }, ctx.actor, ctx.now);
      const h = rt.store.put("foreclosure_holds", `hold-${loanId}-environmental`, { loan_id: loanId, kind: "environmental", status: "active", scope: ["refer", "first_notice", "judgment_motion", "sale_conduct"], from: prev?.detected_at ?? str(i, "confirmed_on"), reason: `FNMA_F108_ENV_NO_FORECLOSURE_GATE: ${str(i, "kind")} confirmed (F-1-08)`, source_hazard_id: rec.id }, ctx.actor, ctx.now);
      rt.store.put("environmental_hazards", rec.id, { fc_hold_id: h.id }, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      const escalationIds = openAll(rt, ctx, loanId, r.escalations, { hazard_id: rec.id, report_by: r.report_by });
      return { ...rec.data, fc_hold_id: h.id, gate: r.gate, gate_closed: r.gate_closed, referral_allowed: false, refusal: r.refusal, report_by: r.report_by, lead_paint_notification_due: r.lead_paint_notification_due, escalation_ids: escalationIds };
    }
    case "servicing_rep_report": {
      const hz = requireHazard(rt, i); need(i, "servicing_rep"); if (hz.severity !== "confirmed") throw new RangeError(`hazard ${hz.id} is ${String(hz.severity)}: the Servicing Representative report follows confirmation (13.7 rule 5)`);
      const rep = (i.report as Partial<EnvironmentalReport> | undefined) ?? null;
      const r = servicingRepReport({ hazard_id: hz.id, loan_id: loanId, confirmed_on: D(String(hz.confirmed_at)), report: rep ? { ...rep, ...(money(rep.value) !== undefined ? { value: money(rep.value)! } : {}), ...(money(rep.debt) !== undefined ? { debt: money(rep.debt)! } : {}) } : null, sent_at: at(i, "sent_at", ctx), servicing_rep: str(i, "servicing_rep") });
      const rec = rt.store.put("environmental_hazards", hz.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      return { ...rec.data, due: r.due, sent_on: r.sent_on, on_time: r.on_time };
    }
    case "lead_paint_notification": {
      const hz = requireHazard(rt, i); need(i, "servicing_rep"); if (hz.kind !== "lead_paint") throw new RangeError(`hazard ${hz.id} is ${String(hz.kind)}, not a lead-paint citation`);
      const n = (i.notification as Row | undefined) ?? null;
      const r = leadPaintNotice({ hazard_id: hz.id, loan_id: loanId, referral_on: optDate(i, "referral_on") ?? D(String(hz.referral_on ?? "")), units: i.units === undefined ? Number(hz.units) : Number(i.units), notification: n ? { ...(money(n.property_value_cents) !== undefined ? { property_value_cents: money(n.property_value_cents)! } : {}), ...(money(n.total_debt_cents) !== undefined ? { total_debt_cents: money(n.total_debt_cents)! } : {}), ...(n.children_under_8 !== undefined ? { children_under_8: n.children_under_8 === true } : {}), ...(n.documentation_ids !== undefined ? { documentation_ids: ids(n.documentation_ids) } : {}) } : null, sent_at: at(i, "sent_at", ctx), servicing_rep: str(i, "servicing_rep") });
      const rec = rt.store.put("environmental_hazards", hz.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      return { ...rec.data, due: r.due, sent_on: r.sent_on, on_time: r.on_time, timer: "FNMA_F108_LEAD_PAINT_NOTIFY_30" };
    }
    case "hazard_direction": {
      const hz = requireHazard(rt, i); need(i, "direction", "document_id");
      const r = hazardDirection({ hazard_id: hz.id, loan_id: loanId, direction: str(i, "direction") as FnmaDirection, document_id: str(i, "document_id"), received_on: D(at(i, "received_at", ctx).slice(0, 10)), recorded_by: by(ctx) });
      const rec = rt.store.put("environmental_hazards", hz.id, r.row, ctx.actor, ctx.now);
      if (r.hold_released) { const h = rt.store.get("foreclosure_holds", `hold-${loanId}-environmental`); if (h && holdOpen(h.data)) rt.store.put("foreclosure_holds", h.id, { status: "released", released_at: ctx.now, released_by: `${ctx.actor.kind}:${ctx.actor.id}`, release_reason: "Fannie Mae directed the servicer to proceed (F-1-08)" }, ctx.actor, ctx.now); }
      emitAll(ctx, loanId, r.events);
      return { ...rec.data, hold_released: r.hold_released };
    }
    case "hazard_cleared": {
      const hz = requireHazard(rt, i); need(i, "reviewer", "evidence_document_id");
      const r = hazardCleared({ hazard_id: hz.id, loan_id: loanId, reviewer: str(i, "reviewer") as "attorney" | "licensed_inspector", evidence_document_id: str(i, "evidence_document_id"), cleared_on: D(at(i, "cleared_at", ctx).slice(0, 10)), recorded_by: by(ctx) });
      const rec = rt.store.put("environmental_hazards", hz.id, r.row, ctx.actor, ctx.now);
      const h = rt.store.get("foreclosure_holds", `hold-${loanId}-environmental`); if (h && holdOpen(h.data)) rt.store.put("foreclosure_holds", h.id, { status: "released", released_at: ctx.now, released_by: `${ctx.actor.kind}:${ctx.actor.id}`, release_reason: `cleared on ${str(i, "reviewer")} evidence ${str(i, "evidence_document_id")}` }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return rec.data;
    }
    case "ma_citation_search": {
      need(i, "search_document_id", "completed_on"); const state = str(i, "state") || String(rt.store.get("loans", loanId)?.data.state ?? "");
      const r = maCitationSearchCompleted({ loan_id: loanId, state, search_document_id: str(i, "search_document_id"), completed_on: date(i, "completed_on"), citations_found: Number(i.citations_found ?? 0) });
      emitAll(ctx, loanId, r.events); rt.store.put("loans", loanId, { ma_lead_paint_citation_search_document_id: str(i, "search_document_id"), ma_lead_paint_citation_search_completed_on: str(i, "completed_on") }, ctx.actor, ctx.now);
      return { loan_id: loanId, state: "MA", ma_lead_paint_citation_search_completed: true, citation_search_document_id: str(i, "search_document_id") };
    }
    default: throw new RangeError(`litigation.classify op ${op} is not one of classify/classify_only/confirm/trigger/form20_submitted/form20_portal_filed/form20_responded/status_update/hazard_suspected/hazard_confirmed/servicing_rep_report/lead_paint_notification/hazard_direction/hazard_cleared/ma_citation_search`);
  }
});
export const LITIGATION_CLASSIFY_GUARDRAILS_13_7 = [
  needsRole("ROUTINE_NEEDS_ATTORNEY_CONFIRMATION", "13.7 rule 1: confidence < 0.8 or any damages claim ⇒ attorney confirmation before \"routine\" is accepted", (i) => str(i, "op") === "confirm", ["attorney"], "the attorney confirms the classification"),
  needsRole("FORM20_FILED_BY_PORTAL_OPERATOR", "13.7 escalations: `fnma_portal_operator` (quatro filing)", (i) => str(i, "op") === "form20_submitted" || str(i, "op") === "form20_portal_filed", ["fnma_portal_operator", "officer"], "the agent prepares the Form 20 package; the portal operator files it and records the quatro reference"),
  needsRole("FNMA_DIRECTION_ACKNOWLEDGED_BY_OFFICER", "13.7 escalations: `officer` (partner) for any Fannie Mae direction requiring the servicer of record's acknowledgment", (i) => str(i, "op") === "hazard_direction", ["officer"], "the officer records Fannie Mae's direction"),
  never("ENV_CLEARED_NEEDS_HUMAN_EVIDENCE_OP", "13.7 guardrail: environmental 'cleared' requires human-reviewed evidence (`attorney` or licensed inspector report)", (i) => str(i, "op") === "hazard_cleared" && !str(i, "evidence_document_id"), "attorney or licensed inspector report"),
] as const;

// ---- attorney.message.send ----------------------------------------------------------------------------------------
export const attorneyMessageHandler137 = compute((i, ctx, rt) => {
  const kind = str(i, "kind") || "message"; const loanId = str(i, "loan_id") || ctx.loanId;
  if (kind === "message") { need(i, "firm_id", "subject"); return ctx.events.append({ type: "attorney.message.sent", ...(loanId ? { loanId } : {}), actor: ctx.actor, payload: { firm_id: str(i, "firm_id"), subject: str(i, "subject") } }); }
  if (!loanId) throw new RangeError("loan_id is required");
  const pleadingRow = (id: string): (Row & { id: string }) | null => { const r = rt.store.get("litigation_pleadings", id); return r ? { ...r.data, id: r.id } : null; };
  switch (kind) {
    case "pleading_due": {
      const m = requireMatter(rt, i, loanId); need(i, "pleading_id", "filing_deadline");
      const r = pleadingDue({ matter_id: m.id, loan_id: loanId, pleading_id: str(i, "pleading_id"), kind: (str(i, "pleading_kind") || "motion") as PleadingKind, filing_deadline: date(i, "filing_deadline") });
      const rec = rt.store.put("litigation_pleadings", str(i, "pleading_id"), { matter_id: m.id, loan_id: loanId, kind: str(i, "pleading_kind") || "motion", filing_deadline: str(i, "filing_deadline"), draft_due_to_fnma: r.draft_due_to_fnma, draft_given_on: null, review_closed: false, filed_on: null }, ctx.actor, ctx.now);
      rt.store.put("litigation_matters", m.id, { pleading_deadlines: [...((m.pleading_deadlines as unknown[] | undefined) ?? []), { pleading_id: rec.id, filing_deadline: str(i, "filing_deadline"), draft_due_to_fnma: r.draft_due_to_fnma }] }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, gate: "FNMA_E1301_PLEADING_REVIEW_GATE" };
    }
    case "draft_to_fnma": {
      need(i, "pleading_id", "document_id"); const p = pleadingRow(str(i, "pleading_id")); if (!p) throw new RangeError(`no pleading ${str(i, "pleading_id")}`);
      const r = draftGivenToFnma({ matter_id: String(p.matter_id), loan_id: loanId, pleading_id: p.id, filing_deadline: D(String(p.filing_deadline)), given_on: D(at(i, "given_at", ctx).slice(0, 10)), document_id: str(i, "document_id") });
      const rec = rt.store.put("litigation_pleadings", p.id, { draft_given_on: r.events[0]!.payload.given_on, draft_document_id: str(i, "document_id"), business_days_before_deadline: r.business_days_before_deadline }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, in_time: r.in_time };
    }
    case "review_closed": {
      need(i, "pleading_id", "result"); const p = pleadingRow(str(i, "pleading_id")); if (!p) throw new RangeError(`no pleading ${str(i, "pleading_id")}`);
      const r = pleadingReviewClosed({ matter_id: String(p.matter_id), loan_id: loanId, pleading_id: p.id, result: str(i, "result") as "comments_received" | "window_elapsed", on: D(at(i, "closed_at", ctx).slice(0, 10)), comments_document_id: optStr(i, "comments_document_id") });
      const rec = rt.store.put("litigation_pleadings", p.id, { review_closed: true, review_result: str(i, "result"), comments_document_id: optStr(i, "comments_document_id") }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return rec.data;
    }
    case "file_pleading": {
      need(i, "pleading_id"); const p = pleadingRow(str(i, "pleading_id")); if (!p) throw new RangeError(`no pleading ${str(i, "pleading_id")}`);
      const g = pleadingFilingGate({ filing_deadline: D(String(p.filing_deadline)), draft_given_on: p.draft_given_on ? D(String(p.draft_given_on)) : null, review_closed: p.review_closed === true });
      if (!g.allowed) refuseGate(ctx, loanId, "attorney.message.send:file_pleading", g.gate, g.refusal!, { pleading_id: p.id, draft_due: g.draft_due });
      assertGate("13.7.pleadingDraftGivenInTime", p.review_closed === true ? { business_days_before_deadline_when_given: Math.max(g.business_days_before_deadline_when_given, 5) } : { business_days_before_deadline_when_given: g.business_days_before_deadline_when_given });
      const rec = rt.store.put("litigation_pleadings", p.id, { filed_on: at(i, "filed_at", ctx).slice(0, 10), filed_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
      ctx.events.append({ type: "litigation.pleading.filed", loanId, actor: ctx.actor, payload: { matter_id: p.matter_id, pleading_id: p.id, filed_on: rec.data.filed_on, business_days_before_deadline_when_given: g.business_days_before_deadline_when_given } });
      return { ...rec.data, allowed: true, gate: g.gate };
    }
    case "removal_or_appeal_proposed": {
      const m = requireMatter(rt, i, loanId); need(i, "proposal", "basis");
      const r = removalOrAppealProposed({ matter_id: m.id, loan_id: loanId, kind: str(i, "proposal") as "removal" | "appeal", proposed_on: D(at(i, "proposed_at", ctx).slice(0, 10)), basis: str(i, "basis"), judgment_document_id: optStr(i, "judgment_document_id") });
      const rec = rt.store.put("litigation_matters", m.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events);
      const escalationIds = openAll(rt, ctx, loanId, r.escalations, { matter_id: m.id, proposal: str(i, "proposal") });
      return { ...rec.data, gate: "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE", escalation_ids: escalationIds };
    }
    case "approval_granted": {
      const m = requireMatter(rt, i, loanId); need(i, "proposal", "document_id");
      const r = approvalGranted({ matter_id: m.id, loan_id: loanId, kind: str(i, "proposal") as "removal" | "appeal", document_id: str(i, "document_id"), granted_on: D(at(i, "granted_at", ctx).slice(0, 10)), recorded_by: by(ctx) });
      const rec = rt.store.put("litigation_matters", m.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events); return rec.data;
    }
    case "file_removal_or_appeal": {
      const m = requireMatter(rt, i, loanId); need(i, "proposal");
      const g = removalOrAppealFilingGate({ kind: str(i, "proposal") as "removal" | "appeal", approval_document_id: (m.fnma_written_approval_document_id as string | null | undefined) ?? null, approval_kind: (m.fnma_written_approval_kind as string | null | undefined) ?? null });
      if (!g.allowed) refuseGate(ctx, loanId, `attorney.message.send:file_${str(i, "proposal")}`, g.gate, g.refusal!, { matter_id: m.id });
      assertGate("13.7.fannieMaePriorWrittenApproval", { fnma_written_approval_document_id: m.fnma_written_approval_document_id });
      ctx.events.append({ type: "litigation.removal_or_appeal.filed", loanId, actor: ctx.actor, payload: { matter_id: m.id, kind: str(i, "proposal"), approval_document_id: m.fnma_written_approval_document_id, filed_on: at(i, "filed_at", ctx).slice(0, 10) } });
      return { matter_id: m.id, kind: str(i, "proposal"), allowed: true, gate: g.gate, approval_document_id: m.fnma_written_approval_document_id };
    }
    case "workout_notice": {
      const m = requireMatter(rt, i, loanId); need(i, "firm_id", "option");
      const r = workoutCounselNotice({ matter_id: m.id, loan_id: loanId, firm_id: str(i, "firm_id"), option: str(i, "option"), notified_on: D(at(i, "notified_at", ctx).slice(0, 10)), evaluation_id: optStr(i, "evaluation_id") });
      const rec = rt.store.put("litigation_matters", m.id, { counsel_notified_workout_on: r.events[0]!.payload.notified_on, counsel_workout_window_ends: r.counsel_window_ends, counsel_acknowledged_workout_on: null }, ctx.actor, ctx.now);
      emitAll(ctx, loanId, r.events); return { ...rec.data, counsel_window_ends: r.counsel_window_ends, gate: "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE" };
    }
    case "counsel_ack": {
      const m = requireMatter(rt, i, loanId); need(i, "firm_id");
      const r = counselAcknowledged({ matter_id: m.id, loan_id: loanId, firm_id: str(i, "firm_id"), acknowledged_on: D(at(i, "acknowledged_at", ctx).slice(0, 10)), acknowledged_by: by(ctx), position: optStr(i, "position") });
      const rec = rt.store.put("litigation_matters", m.id, r.row, ctx.actor, ctx.now); emitAll(ctx, loanId, r.events); return rec.data;
    }
    case "workout_offer_release": {
      const m = matterOf(rt, i, loanId); const litigated = litigatedLoan(rt, loanId);
      const facts = { litigated, counsel_notified_on: m?.counsel_notified_workout_on ? D(String(m.counsel_notified_workout_on)) : null, counsel_acknowledged: Boolean(m?.counsel_acknowledged_workout_on) };
      const g = workoutOfferReleaseGate(facts);
      if (!g.allowed) refuseGate(ctx, loanId, "lossmit.offer.send", g.gate, g.refusal!, { matter_id: m?.id ?? null, option: str(i, "option") || null });
      assertGate("13.7.counselNotifiedOfWorkout", { litigated, counsel_acknowledged: facts.counsel_acknowledged });
      ctx.events.append({ type: "litigation.workout_offer.released", loanId, actor: ctx.actor, payload: { matter_id: m?.id ?? null, option: str(i, "option") || null, litigated, counsel_acknowledged: facts.counsel_acknowledged } });
      return { allowed: true, gate: g.gate, litigated, counsel_acknowledged: facts.counsel_acknowledged };
    }
    default: throw new RangeError(`attorney.message.send kind ${kind} is not one of message/pleading_due/draft_to_fnma/review_closed/file_pleading/removal_or_appeal_proposed/approval_granted/file_removal_or_appeal/workout_notice/counsel_ack/workout_offer_release`);
  }
});
export const ATTORNEY_MESSAGE_GUARDRAILS_13_7 = [
  needsRole("ATTORNEY_FILES", "13.7 guardrail: the agent never files pleadings — `attorney` (all substantive litigation; pleading drafts)", (i) => /^(file_pleading|file_removal_or_appeal)$/.test(str(i, "kind")), ["attorney"], "filings are the attorney's"),
  needsRole("APPROVAL_RECORDED_BY_OFFICER", "13.7 rule 7: removal/appeal approval is Fannie Mae's written approval recorded through the partner `officer`", (i) => str(i, "kind") === "approval_granted", ["officer"], "the officer transmits the request and records Fannie Mae's approval"),
  needsRole("COUNSEL_ACK_IS_COUNSELS", "13.7 timer table: `FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE` is satisfied by counsel's ack", (i) => str(i, "kind") === "counsel_ack", ["attorney"], "the acknowledgment is counsel's own"),
  never("NEVER_STATE_FNMA_POSITION_TO_COUNSEL", "13.7 guardrail: the agent never states Fannie Mae's position", (i) => typeof i.fnma_position === "string", "positions come from the officer/Fannie Mae"),
] as const;

export const TOOLS_13_7: readonly ToolDef[] = [];
