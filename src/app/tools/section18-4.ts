/**
 * §18.4 tools — the filings module of `qc-audit` with `compliance-sentinel` timers. The spec's "Tools:" line is prose
 * (registry queries, document retrieval, insurance calculator, letter renderer, `escalations.create`,
 * `human_portal_task.create`), and the AI-first end-to-end flow it describes — open the cycle → assemble the snapshot →
 * run consistency checks → produce the diff and evidence index → classify org-change events as they occur → draft
 * notices → escalate for officer certification → create the portal task → track confirmation → file evidence — is the
 * surface below: `registry.query`, `documents.retrieve`, `insurance.calculate`, `letter.render`, `escalations.create`,
 * `human_portal_task.create`, plus the state-changing acts the §18.4 timer table is armed and satisfied by
 * (`filing.cycle.open`, `filing.transition`, `org_change.record`, `org_change.plan`, `org_change.gate.clear`,
 * `org_registry.write`, `pending_actions.file`, `regulatory_action.record`, `notice.record_sent`,
 * `insurance_policy.record`, `insurance_policy.renew`, `insurance.expiry_check`, `afs.receive`,
 * `partner.package.deliver`, `tech_provider.contract_event.record`, `tech_provider.change.declare`,
 * `notice_template.publish`, `form183.submit`, `notice.transition`, `filing.late_check`).
 *
 * The org-change / technology-provider notices are `regulatory_filings` rows (filing_type org_change_notice /
 * tech_provider_notice) walked through the spec's `detected → classified → drafted → officer_approved → filed → acknowledged`:
 * the recorders open the row (`detected` when the officer must decide the classification, else `classified`, stepped to `drafted`
 * when the same-day draft exists); `notice.transition` moves it a step at a time (NOTICE_OFFICER_APPROVES: only the officer
 * approves; NOTICE_FILED_EVIDENCE_REQUIRED / NOTICE_ACKNOWLEDGMENT_REQUIRED: filed and acknowledged carry their evidence);
 * `pending_actions.file` and `notice.record_sent` file it with the sent evidence — refused (NOTICE_NOT_OFFICER_APPROVED) when the
 * agent records a send the officer never approved, while the officer's own send is the approval; `org_change.gate.clear` with
 * Fannie Mae's approval/acknowledgment closes a filed A4-1-03 notice as `acknowledged`. `filing.late_check` sets the state
 * machine's `late` flag on every open row past `due_at`.
 *
 * Guardrails encode the three sentences of spec/registry/agents.json for 18.4: "the agent cannot certify or submit
 * (baseline §8 item 3 — Form 582 is an officer certification)" → FORM582_AGENT_CANNOT_SUBMIT / FORM582_DESIGNATED_SUBMITTER /
 * FORM582_PORTAL_TASK_NEEDS_APPROVAL / FORM582_LETTER_UNSIGNED / FORM183_HUMAN_ACT / FNMA_NOTICE_OFFICER_SENDS;
 * "any unresolved consistency check blocks `officer_review`" → FORM582_OFFICER_REVIEW_BLOCKED; "org-change classification
 * with confidence < 0.9 → `officer` decides within the 5-BD window" → ORG_CHANGE_LOW_CONFIDENCE_OFFICER_DECIDES. The
 * A4-1-03 breach action ("change blocked in the platform's own records until satisfied or `officer` waiver with
 * rationale") is ORG_CHANGE_GATE_BLOCKED on `org_registry.write` and ORG_CHANGE_WAIVER_OFFICER / ORG_CHANGE_WAIVER_RATIONALE /
 * ORG_CHANGE_CLEARANCE_DOCUMENT on `org_change.gate.clear`.
 *
 * `TOOLS_18_4` — the slice ./section18.ts spreads onto the bus — is the subset whose names spec/registry/agents.json lists
 * for 18.4 (src/app/tools.test.ts refuses any other name on the bus); the extractor reads no tool names from the 18.4
 * "Tools:" line, so the full surface is exported as `FORM582_TOOLS_18_4` and bound by 18-4.spec.test.ts exactly as
 * ./index.ts would bind it once the registry names them (the same arrangement as ./section18-6.ts).
 */
import { defineTools, escalate, compute, never, needsRole, humanWhen, guard, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { loadAgentsFile } from "../agents.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor, EventInput } from "../../kernel/events/types.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import {
  CONSISTENCY_CHECKS, FORM582_STATES, DESIGNATED_SUBMITTER_ROLES, ORG_CHANGE_CONFIDENCE_FLOOR, GATE_CLEARED_PATTERN,
  insuranceWorksheet, requiredInsurance, officerReviewGate, orgChangeRecorded, majorChangePlanned, majorChangeGateCleared, platformRecordWrite, corporateInsurancePolicyRecorded, insuranceExpiryCheck,
  filingSubmit, ecrmPortalTask, renderCorporateLetter, form582CycleOpen, recordRegulatoryAction, orgChangeDeadlines,
  NOTICE_STATES, FILING_CLOSED_STATES, lateFlag, noticeFilingOpen, noticeTransition,
  regulatoryActionNoticeEvent, pendingActionsFiledEvent, partnerNotifiedEvent, majorChangeGateClearedEvent, insuranceRenewalEvent, partnerDataPackageDeliveredEvent, afsReceivedEvent, techProviderContractEvent, techProviderChangeIntent, techProviderNoticeEvent, noticeTemplatePublishedEvent, form183SubmittedEvent,
  type Entity, type ConsistencyCheck, type CorporateTemplate, type FilingRow, type OrgChangeKind, type MajorChangeGateRecord, type GateClearedBy, type CorporatePolicyKind, type PlatformRecordWrite, type RegulatoryActionKind, type TechContractEventKind, type PolicyRenewal, type NoticeFilingRow, type NoticeState,
} from "../../domain/qc-audit/ops-18-4.ts";

const AGENT = "qc-audit";
const PROCESS = "18.4";
const GUARD = "18.4 guardrails (spec/registry/agents.json)";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : str(i, k));
const list = <T,>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const cents = (i: ToolInput, k: string): Cents => { need(i, k); return BigInt(String(i[k])); };
const entity = (i: ToolInput): Entity => { const e = str(i, "entity"); if (e !== "supermortgage" && e !== "partner") throw new RangeError("entity must be supermortgage or partner"); return e; };
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
/** A refusal a handler can only decide with the store in hand (the bus's own guardrails see input and context only): the same `command.refused` row the bus writes, then the typed error. */
const refuseInHandler = (ctx: CommandContext, command: string, code: string, reason: string): never => {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation: GUARD, reason, subject_id: null } });
  throw new CommandRefused(command, code, GUARD, reason);
};
const REGISTRIES: Record<string, string> = { org_registry: "org_registry", vendor_registry: "vendor_registry", insurance_policies: "corporate_insurance_policies", corporate_insurance_policies: "corporate_insurance_policies", licenses: "licenses", custodial_accounts: "custodial_accounts", warehouse_banks: "warehouse_banks", subservicing_arrangements: "subservicing_arrangements", pending_actions: "pending_actions", fiscal_years: "fiscal_years", regulatory_filings: "regulatory_filings", org_change_gates: "org_change_gates" };
const SUBMITTER_ROLES = [...DESIGNATED_SUBMITTER_ROLES.supermortgage, ...DESIGNATED_SUBMITTER_ROLES.partner];
const checksOf = (i: ToolInput): ConsistencyCheck[] => list<{ code: string; resolved: boolean; detail?: string }>(i, "checks").map((c) => { if (!(CONSISTENCY_CHECKS as readonly string[]).includes(c.code)) throw new RangeError(`unknown consistency check ${c.code}`); return { code: c.code as ConsistencyCheck["code"], resolved: c.resolved === true, ...(c.detail ? { detail: c.detail } : {}) }; });
const insuranceOf = (i: ToolInput): Parameters<typeof officerReviewGate>[0]["insurance"] => {
  const p = i.insurance as { policy_fidelity_cents?: unknown; policy_eo_cents?: unknown; highest_monthly_servicing_upb_cents?: unknown; annual_originations_upb_cents?: unknown; multifamily?: unknown } | undefined;
  if (!p || typeof p !== "object") return null;
  const required = requiredInsurance(BigInt(String(p.highest_monthly_servicing_upb_cents ?? 0)), BigInt(String(p.annual_originations_upb_cents ?? 0)), p.multifamily === true);
  return { policy_fidelity_cents: BigInt(String(p.policy_fidelity_cents ?? 0)), policy_eo_cents: BigInt(String(p.policy_eo_cents ?? 0)), required };
};
const filingOf = (i: ToolInput, rt: ToolRuntime): FilingRow => { need(i, "filing_id"); const r = rt.store.get("regulatory_filings", str(i, "filing_id")); if (!r) throw new RangeError(`no regulatory_filings ${str(i, "filing_id")}`); return r.data as unknown as FilingRow; };
const gatesOf = (rt: ToolRuntime, ent: Entity): MajorChangeGateRecord[] => rt.store.list("org_change_gates", (d) => d.entity === ent).map((r) => r.data as unknown as MajorChangeGateRecord);
const noticeOf = (rt: ToolRuntime, id: string): NoticeFilingRow | null => { const r = rt.store.get("regulatory_filings", id); return r && (r.data.filing_type === "org_change_notice" || r.data.filing_type === "tech_provider_notice") ? (r.data as unknown as NoticeFilingRow) : null; };
/** One step of the notice state machine on the stored regulatory_filings row (null when the subject has no notice row — e.g. a contract event 19.3 recorded); a refusal is the bus's typed `command.refused`. */
const stepNotice = (rt: ToolRuntime, ctx: CommandContext, command: string, id: string, to: NoticeState, i: { document_id?: string | null; submission_evidence?: string | null; acknowledgment_document_id?: string | null } = {}) => {
  const row = noticeOf(rt, id); if (!row) return null;
  const t = noticeTransition({ row, to, actor: ctx.actor, now: ctx.now, on: today(ctx), ...i });
  if (!t.allowed) return refuseInHandler(ctx, command, t.refusal_codes[0]!, t.refusal!);
  rt.store.put("regulatory_filings", id, { ...t.row }, ctx.actor, ctx.now); ctx.events.append(t.event!);
  return t;
};
/** Opens the notice's regulatory_filings row (Outputs: "`regulatory_filings` rows with submission evidence") and, when the recorder produced the same-day draft, steps it to `drafted`. Idempotent per subject. */
const openNotice = (rt: ToolRuntime, ctx: CommandContext, i: Parameters<typeof noticeFilingOpen>[0], drafted: boolean): string => {
  const row = noticeFilingOpen(i); if (rt.store.get("regulatory_filings", row.id)) return row.id;
  rt.store.put("regulatory_filings", row.id, { ...row }, ctx.actor, ctx.now);
  if (drafted && row.status === "classified") stepNotice(rt, ctx, "notice.transition", row.id, "drafted");
  return row.id;
};
const openEscalations = (rt: ToolRuntime, ctx: CommandContext, items: readonly { kind: string; severity?: string; reason: string; due?: PlainDate }[], payload: Record<string, unknown> = {}) =>
  items.map((e) => rt.escalations.open({ kind: e.kind as "officer" | "attorney" | "human_portal_task", ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason, due: e.due ?? null, ...payload } }, ctx.actor));

/** The whole 18.4 tool surface (see the header for why the bus slice below may be narrower). */
export const FORM582_TOOLS_18_4: readonly ToolDef[] = defineTools(PROCESS, AGENT, [
  // ---- registry queries, document retrieval, insurance calculator, letter renderer (spec "Tools:" line) -------------------
  { name: "registry.query", kind: "read", handler: compute((i, _c, rt) => {
    need(i, "registry"); const kind = REGISTRIES[str(i, "registry")]; if (!kind) throw new RangeError(`unknown registry ${str(i, "registry")} (${Object.keys(REGISTRIES).join(", ")})`);
    return rt.store.list(kind, (d) => (!str(i, "entity") || d.entity === str(i, "entity")) && (!str(i, "id") || d.id === str(i, "id"))).map((r) => r.data);
  }) },
  { name: "documents.retrieve", kind: "read", handler: compute((i, _c, rt) => { const ids = list<string>(i, "document_ids"); if (ids.length === 0) throw new RangeError("document_ids is required"); return ids.map((id) => rt.store.get("documents", id)?.data ?? { id, missing: true }); }) },
  { name: "insurance.calculate", kind: "read", handler: compute((i) => insuranceWorksheet({ highest_monthly_servicing_upb_cents: cents(i, "highest_monthly_servicing_upb_cents"), annual_originations_upb_cents: i.annual_originations_upb_cents === undefined ? 0n : BigInt(String(i.annual_originations_upb_cents)), multifamily: flag(i, "multifamily") })) },
  { name: "letter.render", kind: "act", handler: compute((i) => { need(i, "template"); const r = renderCorporateLetter(str(i, "template") as CorporateTemplate, (i.data as Record<string, unknown> | undefined) ?? {}); if (!r.allowed) throw new RangeError(r.refusal); return { ...r.letter, status: "draft_unsigned" }; }),
    guardrails: [never("FORM582_LETTER_UNSIGNED", GUARD, (i) => flag(i, "sign") || flag(i, "send") || flag(i, "submit") || flag(i, "certify"), "the renderer produces an unsigned draft only — the agent cannot certify or submit; the officer signs, the designated submitter files in ECRM")] },
  { name: "escalations.create", kind: "act", handler: escalate("officer") },
  // ---- the annual cycle: FYE + 1 opens the Form 582 / AFS rows and the tick arms the clocks ----------------------------------
  { name: "filing.cycle.open", kind: "act", handler: compute((i, ctx, rt) => {
    const ent = entity(i); const c = form582CycleOpen({ entity: ent, fye: date(i, "fye"), auditor: optStr(i, "auditor"), afs_expected_at: optDate(i, "afs_expected_at") });
    if (rt.store.get("regulatory_filings", c.filings[0]!.id)) return { ...c, idempotent: true };
    for (const f of c.filings) rt.store.put("regulatory_filings", f.id, { ...f, data_snapshot: null, submitted_at: null, submission_evidence: null, late: false }, ctx.actor, ctx.now);
    rt.store.put("fiscal_years", `${ent}:${c.fiscal_year.fye_date}`, { ...c.fiscal_year }, ctx.actor, ctx.now);
    ctx.events.append({ ...c.event, actor: ctx.actor });
    return c;
  }) },
  { name: "filing.transition", kind: "act", humanRoles: ["ops_analyst", "officer", "attorney", ...SUBMITTER_ROLES], handler: compute((i, ctx, rt) => {
    const f = filingOf(i, rt); need(i, "to"); const to = str(i, "to");
    if (!(FORM582_STATES as readonly string[]).includes(to)) throw new RangeError(`to must be one of ${FORM582_STATES.join(", ")}`);
    const order = FORM582_STATES as readonly string[]; const from = order.indexOf(f.status);
    if (to === "submitted") {
      const r = filingSubmit({ filing: f, actor: ctx.actor, ecrm_confirmation_document_id: optStr(i, "ecrm_confirmation_document_id"), submitted_on: optDate(i, "submitted_on") ?? today(ctx) });
      if (!r.allowed) return refuseInHandler(ctx, "filing.transition", r.refusal_codes[0]!, r.refusal!);
      rt.store.put("regulatory_filings", f.id, { status: "submitted", submitted_at: ctx.now, submission_evidence: r.submission_evidence, late: r.late }, ctx.actor, ctx.now);
      ctx.events.append(r.event!); return { filing_id: f.id, status: "submitted", late: r.late, submission_evidence: r.submission_evidence };
    }
    if (to === "officer_review") {
      const g = officerReviewGate({ checks: checksOf(i), insurance: insuranceOf(i) });
      if (!g.allowed) return refuseInHandler(ctx, "filing.transition", "FORM582_OFFICER_REVIEW_BLOCKED", g.refusal!);
    }
    if (to === "partner_delivered") {
      if (f.entity !== "partner") throw new RangeError("partner_delivered is a partner-filing state");
      const ev = partnerDataPackageDeliveredEvent({ filing_id: f.id, fye: f.period_end, package_document_id: optStr(i, "package_document_id"), delivered_on: optDate(i, "delivered_on") ?? today(ctx), receipt_document_id: optStr(i, "receipt_document_id") });
      if (!ev) throw new RangeError("partner_delivered needs package_document_id and the partner's receipt_document_id");
      ctx.events.append(ev);
    }
    const accepted = to === "accepted" || to === "corrected" ? f.status === "submitted" : order.indexOf(to) === from + 1 || (to === "officer_review" && f.status === "registry_verified" && f.entity === "supermortgage");
    if (!accepted) throw new RangeError(`${f.filing_type} ${f.id}: ${f.status} → ${to} is not a §18.4 state-machine step`);
    const patch: Record<string, unknown> = { status: to, ...(to === "officer_review" && optStr(i, "approved_by_officer_id") ? { approved_by_officer_id: str(i, "approved_by_officer_id") } : {}), ...(i.data_snapshot !== undefined ? { data_snapshot: i.data_snapshot } : {}) };
    rt.store.put("regulatory_filings", f.id, patch, ctx.actor, ctx.now);
    ctx.events.append({ type: "filing.status.changed", aggregate: { kind: "fiscal_year", id: `${f.entity}:${f.period_end}` }, actor: ctx.actor, payload: { filing_id: f.id, from: f.status, to } });
    return { filing_id: f.id, status: to };
  }), guardrails: [
    humanWhen("FORM582_AGENT_CANNOT_SUBMIT", GUARD, (i) => str(i, "to") === "submitted" || str(i, "to") === "accepted" || str(i, "to") === "corrected", "the agent cannot certify or submit — Form 582 is an officer certification and the ECRM submission is the designated submitter's human_portal_task (baseline §8 item 3)"),
    needsRole("FORM582_DESIGNATED_SUBMITTER", GUARD, (i) => str(i, "to") === "submitted", SUBMITTER_ROLES, "only the entity's designated ECRM submitter (FORM582_BUSINESS_ROLE) marks a filing submitted"),
    guard("FORM582_OFFICER_REVIEW_BLOCKED", GUARD, (i) => { if (str(i, "to") !== "officer_review") return undefined; try { const g = officerReviewGate({ checks: checksOf(i), insurance: insuranceOf(i) }); return g.allowed ? undefined : g.refusal!; } catch { return undefined; } }),
  ] },
  { name: "human_portal_task.create", kind: "act", handler: compute((i, ctx, rt) => {
    const f = filingOf(i, rt);
    const t = ecrmPortalTask({ filing: f, answer_sheet_document_id: optStr(i, "answer_sheet_document_id"), evidence_index_document_id: optStr(i, "evidence_index_document_id") });
    if (!t.allowed) return refuseInHandler(ctx, "human_portal_task.create", "FORM582_PORTAL_TASK_NEEDS_APPROVAL", t.refusal!);
    const [e] = openEscalations(rt, ctx, [{ kind: "human_portal_task", reason: `ECRM submission of ${f.filing_type} ${f.id} by ${t.task!.assignee_role} with officer approval ${t.task!.approved_by_officer_id}`, due: f.due_at }], { task: t.task });
    return { ...t.task, escalation_id: e!.id, owner_role: e!.ownerRole };
  }), guardrails: [never("FORM582_PORTAL_TASK_NEEDS_APPROVAL", GUARD, (i) => flag(i, "certify") || flag(i, "submit"), "the agent cannot certify or submit — the portal task carries the officer's approval record for the designated submitter")] },
  // ---- org changes (A4-1-02 / A4-1-03) -------------------------------------------------------------------------------------
  { name: "org_change.record", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "kind", "occurred_on", "confidence"); const conf = Number(i.confidence); if (Number.isNaN(conf)) throw new RangeError("confidence must be a number");
    const r = orgChangeRecorded({ entity: entity(i), kind: str(i, "kind") as OrgChangeKind, occurred_on: date(i, "occurred_on"), confidence: conf });
    const id = r.event.aggregate!.id;
    if (rt.store.get("org_changes", id)) return { org_change_id: id, idempotent: true };
    const status = r.classification.decided_by === "officer" ? "detected" : "classified";
    rt.store.put("org_changes", id, { id, ...r.event.payload, classes: r.classification.classes, decided_by: r.classification.decided_by, status }, ctx.actor, ctx.now);
    if (r.pending_action) rt.store.put("pending_actions", id, { id, ...r.pending_action }, ctx.actor, ctx.now);
    // the notice row: an A4-1-02 Pending Actions notice due on the 5-BD clock; an "immediate" kind on the 1-BD proxy; a 60-day-advance kind recorded after the fact was due before it occurred (edge case "Ownership change discovered late")
    const occurred = r.event.payload.occurred_at;
    const due_at = r.timer?.due ?? (r.classification.classes.includes("immediate") ? orgChangeDeadlines("immediate", occurred, null).fnma_due : occurred);
    const notice_id = openNotice(rt, ctx, { subject: { kind: "org_change", id }, entity: r.event.payload.entity, filing_type: "org_change_notice", template: r.draft ? "F582-PENDING-v1" : "ORG-CHG-NOTICE-v1", notice_kind: r.event.payload.kind, due_at, opened_on: today(ctx), status }, r.draft !== null && status === "classified");
    ctx.events.append(r.event); if (r.partner_event) ctx.events.append(r.partner_event);
    const esc = r.classification.escalation ? openEscalations(rt, ctx, [r.classification.escalation], { org_change_id: id }) : [];
    return { org_change_id: id, notice_id, classification: r.classification, material: r.material, timer: r.timer, partner_notice: r.partner_notice, draft: r.draft, escalations: esc.map((e) => e.id) };
  }), guardrails: [needsRole("ORG_CHANGE_LOW_CONFIDENCE_OFFICER_DECIDES", GUARD, (i) => flag(i, "decide") && Number(i.confidence) < ORG_CHANGE_CONFIDENCE_FLOOR, ["officer"], `org-change classification with confidence < ${ORG_CHANGE_CONFIDENCE_FLOOR} is the officer's decision within the 5-BD window — the agent records and escalates, it does not decide`)] },
  { name: "org_change.plan", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "kind", "planned_effective_on");
    const r = majorChangePlanned({ entity: entity(i), kind: str(i, "kind") as OrgChangeKind, planned_effective_on: date(i, "planned_effective_on"), recorded_on: optDate(i, "recorded_on") ?? today(ctx), ownership_pct_bps: i.ownership_pct_bps === undefined ? null : Number(i.ownership_pct_bps) });
    const id = r.gate_record.org_change_id;
    if (!rt.store.get("org_change_gates", id)) { rt.store.put("org_change_gates", id, { ...r.gate_record }, ctx.actor, ctx.now); ctx.events.append(r.event); }
    const notice_id = openNotice(rt, ctx, { subject: { kind: "org_change", id }, entity: r.event.payload.entity, filing_type: "org_change_notice", template: "ORG-CHG-NOTICE-v1", notice_kind: r.draft.kind, due_at: r.gate.notice_needed_by, opened_on: r.gate.recorded_on }, true);
    const esc = openEscalations(rt, ctx, r.escalations, { org_change_id: id });
    return { org_change_id: id, notice_id, gate: r.gate, breach: r.breach, draft: r.draft, pending_actions_after_occurrence: r.pending_actions_after_occurrence, escalations: esc.map((e) => e.id) };
  }) },
  { name: "org_change.gate.clear", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "org_change_id", "by"); const id = str(i, "org_change_id");
    const g = rt.store.get("org_change_gates", id); if (!g) throw new RangeError(`no org_change_gates ${id}`);
    const ev = majorChangeGateClearedEvent({ org_change_id: id, by: str(i, "by") as GateClearedBy, document_id: optStr(i, "document_id"), officer_id: ctx.actor.kind === "human" && ctx.actor.role === "officer" ? ctx.actor.id : optStr(i, "officer_id"), rationale: optStr(i, "rationale"), fnma_reference: optStr(i, "fnma_reference") });
    if (!ev) throw new RangeError(`gate not cleared: ${GATE_CLEARED_PATTERN} needs the document and, for a waiver, the officer's rationale (for an approval/acknowledgment, its fnma_reference)`);
    const cleared = majorChangeGateCleared(g.data as unknown as MajorChangeGateRecord, ev, today(ctx));
    rt.store.put("org_change_gates", id, { ...cleared }, ctx.actor, ctx.now); ctx.events.append(ev);
    // Fannie Mae's approval/acknowledgment closes the filed A4-1-03 notice (state machine: filed → acknowledged); a waiver is not an acknowledgment
    const n = noticeOf(rt, `notice-${id}`);
    const acknowledged = ev.payload.by !== "officer_waiver" && n?.status === "filed" ? stepNotice(rt, ctx, "org_change.gate.clear", n.id, "acknowledged", { acknowledgment_document_id: ev.payload.document_id }) !== null : false;
    return { org_change_id: id, cleared: cleared.cleared, blocked: false, notice_acknowledged: acknowledged };
  }), guardrails: [
    needsRole("ORG_CHANGE_WAIVER_OFFICER", GUARD, (i) => str(i, "by") === "officer_waiver", ["officer"], "an A4-1-03 gate is waived only by the officer"),
    never("ORG_CHANGE_WAIVER_RATIONALE", GUARD, (i) => str(i, "by") === "officer_waiver" && !str(i, "rationale"), "an officer waiver needs a rationale (breach column: 'until satisfied or `officer` waiver with rationale')"),
    never("ORG_CHANGE_CLEARANCE_DOCUMENT", GUARD, (i) => !str(i, "document_id"), "the Fannie Mae approval/acknowledgment letter or the signed waiver must be attached as document_id"),
    never("ORG_CHANGE_CLEARANCE_BY", GUARD, (i) => !!str(i, "by") && !["fnma_approval", "fnma_acknowledgment", "officer_waiver"].includes(str(i, "by")), "by must be fnma_approval, fnma_acknowledgment or officer_waiver — never an agent override"),
  ] },
  { name: "org_registry.write", kind: "write", handler: compute((i, ctx, rt) => {
    const ent = entity(i); const w = i.write as PlatformRecordWrite | undefined; if (!w || typeof w !== "object" || !w.record) throw new RangeError("write {record, …, effective_from} is required");
    const r = platformRecordWrite({ entity: ent, write: { ...w, effective_from: D(String(w.effective_from)) } as PlatformRecordWrite, gates: gatesOf(rt, ent) });
    if (!r.allowed) return refuseInHandler(ctx, "org_registry.write", "ORG_CHANGE_GATE_BLOCKED", r.refusal!);
    const id = str(i, "id") || `${ent}:${w.record}:${rt.store.list(w.record).length + 1}`;
    const rec = rt.store.put(w.record, id, { id, entity: ent, ...w }, ctx.actor, ctx.now);
    ctx.events.append({ type: `${w.record}.written`, aggregate: { kind: w.record, id }, actor: ctx.actor, payload: { id, entity: ent, ...w } });
    return rec.data;
  }) },
  { name: "pending_actions.file", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "org_change_id"); const id = str(i, "org_change_id"); const pa = rt.store.get("pending_actions", id); if (!pa) throw new RangeError(`no pending_actions ${id}`);
    const ev = pendingActionsFiledEvent({ org_change_id: id, entity: pa.data.entity as Entity, event_kind: pa.data.event_kind as OrgChangeKind, form582_updated_at: optStr(i, "form582_updated_at"), pending_actions_document_id: optStr(i, "pending_actions_document_id"), email_sent_at: optStr(i, "email_sent_at"), email_evidence_document_id: optStr(i, "email_evidence_document_id") });
    if (!ev) throw new RangeError("filed only when the Pending Actions update and the mailbox email are both evidenced");
    const notice = stepNotice(rt, ctx, "pending_actions.file", `notice-${id}`, "filed", { submission_evidence: `${ev.payload.pending_actions_document_id}; ${ev.payload.email_evidence_document_id}` });
    rt.store.put("pending_actions", id, { form582_updated_at: ev.payload.form582_updated_at, email_sent_at: ev.payload.email_sent_at, document_id: ev.payload.pending_actions_document_id, email_evidence_document_id: ev.payload.email_evidence_document_id, status: "filed" }, ctx.actor, ctx.now);
    ctx.events.append(ev); return { org_change_id: id, status: "filed", notice: notice ? { id: notice.row.id, status: notice.row.status, late: notice.row.late } : null };
  }), guardrails: [never("PENDING_ACTIONS_BOTH_EVIDENCED", GUARD, (i) => !str(i, "pending_actions_document_id") || !str(i, "email_evidence_document_id"), "FNMA_A4102_ORG_CHANGE_5BD is satisfied only by the Pending Actions update and the mailbox email, both evidenced")] },
  { name: "regulatory_action.record", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "kind", "regulator", "received_on");
    const r = recordRegulatoryAction({ entity: entity(i), kind: str(i, "kind") as RegulatoryActionKind, regulator: str(i, "regulator"), received_on: date(i, "received_on"), regulatory_action_id: optStr(i, "regulatory_action_id"), document_id: optStr(i, "document_id") });
    if (rt.store.get("regulatory_actions", r.regulatory_action_id)) return { regulatory_action_id: r.regulatory_action_id, idempotent: true };
    rt.store.put("regulatory_actions", r.regulatory_action_id, { id: r.regulatory_action_id, ...r.event.payload, status: "drafted", notice_sent_evidence: null }, ctx.actor, ctx.now);
    const notice_id = openNotice(rt, ctx, { subject: { kind: "regulatory_action", id: r.regulatory_action_id }, entity: r.event.payload.entity, filing_type: "org_change_notice", template: "ORG-CHG-NOTICE-v1", notice_kind: r.draft.kind, due_at: r.timer.due, opened_on: today(ctx) }, true);
    ctx.events.append(r.event); if (r.partner_event) ctx.events.append(r.partner_event);
    const esc = openEscalations(rt, ctx, r.escalations, { regulatory_action_id: r.regulatory_action_id });
    return { regulatory_action_id: r.regulatory_action_id, notice_id, draft: r.draft, timer: r.timer, partner_notice: r.partner_notice, escalations: esc.map((e) => e.id) };
  }) },
  // ---- notices: the officer signs and sends; the sent evidence is what the clocks wait for -----------------------------------
  { name: "notice.record_sent", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "notice", "evidence_document_id"); const sentOn = optDate(i, "sent_on") ?? today(ctx); const sentBy = ctx.actor.kind === "human" ? ctx.actor.id : str(i, "sent_by");
    const base = { sent: true, evidence_document_id: str(i, "evidence_document_id") };
    let ev: (EventInput<Record<string, unknown>> & { readonly aggregate?: { readonly kind: string; readonly id: string } }) | null;
    let noticeId: string | null = null; let after: (() => void) | null = null;
    switch (str(i, "notice")) {
      case "regulatory_action": { need(i, "regulatory_action_id"); const ra = rt.store.get("regulatory_actions", str(i, "regulatory_action_id")); if (!ra) throw new RangeError(`no regulatory_actions ${str(i, "regulatory_action_id")}`); ev = regulatoryActionNoticeEvent({ ...base, regulatory_action_id: ra.id, sent_on: sentOn, regulator: String(ra.data.regulator), entity: ra.data.entity as Entity, sent_by: sentBy }); noticeId = `notice-${ra.id}`; after = () => rt.store.put("regulatory_actions", ra.id, { status: "filed", notice_sent_evidence: base.evidence_document_id }, ctx.actor, ctx.now); break; }
      case "org_change": { need(i, "org_change_id"); const oc = str(i, "org_change_id"); ev = { type: "org_change.notice_sent", actor: ctx.actor, aggregate: { kind: "org_change", id: oc }, payload: { org_change_id: oc, evidence_document_id: base.evidence_document_id, recipient: "fnma_customer_account_team", sent_on: sentOn, sent_by: sentBy } }; noticeId = `notice-${oc}`; break; }
      case "partner": { need(i, "subject_kind", "subject_id", "event_kind"); ev = partnerNotifiedEvent({ ...base, subject: { kind: str(i, "subject_kind"), id: str(i, "subject_id") }, event_kind: str(i, "event_kind"), notified_on: sentOn }); break; }
      case "tech_provider_change": { need(i, "change_id", "provider", "loan_count"); ev = techProviderNoticeEvent({ ...base, kind: "planned_change", change_id: str(i, "change_id"), provider: str(i, "provider"), loan_count: Number(i.loan_count), sent_on: sentOn, sent_by: sentBy, entity: entity(i) }); noticeId = `notice-${str(i, "change_id")}`; break; }
      case "tech_provider_event": { need(i, "contract_event_id", "kind", "provider", "loan_count"); ev = techProviderNoticeEvent({ ...base, kind: str(i, "kind") as TechContractEventKind, contract_event_id: str(i, "contract_event_id"), provider: str(i, "provider"), loan_count: Number(i.loan_count), sent_on: sentOn, sent_by: sentBy, entity: entity(i) }); noticeId = `notice-${str(i, "contract_event_id")}`; break; }
      default: throw new RangeError("notice must be regulatory_action, org_change, partner, tech_provider_change or tech_provider_event");
    }
    if (!ev) throw new RangeError("a notice is recorded sent only with its evidence document");
    // the notice row (when this subject has one) moves to `filed` with the sent evidence — the officer's own send is the approval; the agent's record of a send the officer never approved is refused before anything is written
    const notice = noticeId ? stepNotice(rt, ctx, "notice.record_sent", noticeId, "filed", { submission_evidence: base.evidence_document_id }) : null;
    after?.(); ctx.events.append(ev);
    return { type: ev.type, aggregate: ev.aggregate ?? null, evidence_document_id: base.evidence_document_id, sent_on: sentOn, notice: notice ? { id: notice.row.id, status: notice.row.status, steps: notice.steps, late: notice.row.late } : null };
  }), guardrails: [
    humanWhen("FNMA_NOTICE_OFFICER_SENDS", GUARD, (i) => i.op === "send" || flag(i, "send"), "the agent drafts; the officer signs and sends the Fannie Mae / partner notice"),
    never("FNMA_NOTICE_SENT_EVIDENCE", GUARD, (i) => !str(i, "evidence_document_id"), "18.4-T6: a timer is satisfied only by sent evidence — never by a draft or an un-evidenced 'sent'"),
  ] },
  // ---- insurance (A3-5-01/02/03) -----------------------------------------------------------------------------------------------
  { name: "insurance_policy.record", kind: "write", handler: compute((i, ctx, rt) => {
    need(i, "policy_id", "kind", "expires_on");
    const r = corporateInsurancePolicyRecorded({ policy_id: str(i, "policy_id"), entity: entity(i), kind: str(i, "kind") as CorporatePolicyKind, expires_on: date(i, "expires_on"), ...(i.coverage_cents !== undefined ? { coverage_cents: BigInt(String(i.coverage_cents)) } : {}), fnma_loss_payee: flag(i, "fnma_loss_payee") });
    rt.store.put("corporate_insurance_policies", r.event.payload.policy_id, { id: r.event.payload.policy_id, ...r.event.payload, coverage_cents: i.coverage_cents ?? null, carrier: optStr(i, "carrier"), document_id: optStr(i, "document_id") }, ctx.actor, ctx.now);
    ctx.events.append(r.event); return { timer: r.timer, loss_payee_check: r.loss_payee_check };
  }) },
  { name: "insurance_policy.renew", kind: "write", handler: compute((i, ctx, rt) => {
    need(i, "policy_id", "renewal_effective_on"); const p = rt.store.get("corporate_insurance_policies", str(i, "policy_id")); if (!p) throw new RangeError(`no corporate_insurance_policies ${str(i, "policy_id")}`);
    const ev = insuranceRenewalEvent({ policy_id: p.id, kind: p.data.kind as CorporatePolicyKind, prior_expires_on: D(String(p.data.expires_on)), renewal_effective_on: date(i, "renewal_effective_on"), renewal_document_id: optStr(i, "document_id") });
    if (!ev) throw new RangeError("a renewal is recorded only with the renewal certificate or emergency binder document");
    const renewal: PolicyRenewal = { policy_id: p.id, renewal_effective_on: ev.payload.renewal_effective_on, recorded_on: today(ctx), document_id: ev.payload.document_id };
    rt.store.put("corporate_insurance_policies", p.id, { renewals: [...((p.data.renewals as PolicyRenewal[] | undefined) ?? []), renewal], ...(ev.payload.lapse ? {} : { expires_on: optStr(i, "new_expires_on") ?? p.data.expires_on }) }, ctx.actor, ctx.now);
    ctx.events.append(ev); return { renewal, lapse: ev.payload.lapse };
  }), guardrails: [never("INSURANCE_RENEWAL_EVIDENCED", GUARD, (i) => !str(i, "document_id"), "FNMA_A3501_INSURANCE_EXPIRY_30 is satisfied only by a renewal recorded with its document (no lapse)")] },
  { name: "insurance.expiry_check", kind: "read", handler: compute((i, ctx, rt) => {
    need(i, "policy_id"); const p = rt.store.get("corporate_insurance_policies", str(i, "policy_id")); if (!p) throw new RangeError(`no corporate_insurance_policies ${str(i, "policy_id")}`);
    const cycle = rt.store.list("regulatory_filings", (d) => d.entity === p.data.entity && d.filing_type === "form_582" && !["submitted", "accepted", "corrected"].includes(String(d.status)))[0];
    return insuranceExpiryCheck({ policy: { policy_id: p.id, entity: p.data.entity as Entity, kind: p.data.kind as CorporatePolicyKind, expires_on: D(String(p.data.expires_on)) }, renewals: (p.data.renewals as PolicyRenewal[] | undefined) ?? [], as_of: optDate(i, "as_of") ?? today(ctx), form582_cycle: cycle ? { filing_id: cycle.id, status: String(cycle.data.status) } : null });
  }) },
  // ---- AFS, partner package, technology provider, Form 183 ----------------------------------------------------------------
  { name: "afs.receive", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "fye", "auditor"); const ent = entity(i);
    const ev = afsReceivedEvent({ entity: ent, fye: date(i, "fye"), auditor: str(i, "auditor"), document_id: optStr(i, "document_id"), audit_opinion: flag(i, "audit_opinion"), received_on: optDate(i, "received_on") ?? today(ctx) });
    if (!ev) throw new RangeError("the auditor's upload is recorded only with its document");
    const afs = rt.store.get("regulatory_filings", `f-afs-${ent}-${ev.payload.fye}`); if (afs) rt.store.put("regulatory_filings", afs.id, { package_document_id: ev.payload.document_id }, ctx.actor, ctx.now);
    ctx.events.append(ev); return { received_on: ev.payload.received_on, document_id: ev.payload.document_id, audit_opinion: ev.payload.audit_opinion };
  }) },
  { name: "partner.package.deliver", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "fye"); const fye = date(i, "fye"); const id = str(i, "filing_id") || `f-582-partner-${fye}`;
    const ev = partnerDataPackageDeliveredEvent({ filing_id: id, fye, package_document_id: optStr(i, "package_document_id"), delivered_on: optDate(i, "delivered_on") ?? today(ctx), receipt_document_id: optStr(i, "receipt_document_id") });
    if (!ev) throw new RangeError("SM_FORM582_PARTNER_PACKAGE_FYE_60 is satisfied only by the delivery with the partner's receipt acknowledgment");
    const row = rt.store.get("regulatory_filings", id);   // the delivery advances a row that has not yet reached partner_delivered; a later state is never regressed
    if (row) rt.store.put("regulatory_filings", id, { package_document_id: ev.payload.package_document_id, ...(["open", "data_assembled", "registry_verified"].includes(String(row.data.status)) ? { status: "partner_delivered" } : {}) }, ctx.actor, ctx.now);
    ctx.events.append(ev); return ev.payload;
  }) },
  { name: "tech_provider.contract_event.record", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "contract_id", "provider", "kind", "occurred_on", "loan_count");
    const r = techProviderContractEvent({ contract_event_id: optStr(i, "contract_event_id"), contract_id: str(i, "contract_id"), entity: entity(i), provider: str(i, "provider"), kind: str(i, "kind") as TechContractEventKind, occurred_on: date(i, "occurred_on"), loan_count: Number(i.loan_count), document_id: optStr(i, "document_id") });
    if (rt.store.get("contract_events", r.contract_event_id)) return { contract_event_id: r.contract_event_id, idempotent: true };
    rt.store.put("contract_events", r.contract_event_id, { id: r.contract_event_id, ...r.event.payload, fnma_notice_due: r.timer.due }, ctx.actor, ctx.now);
    const notice_id = openNotice(rt, ctx, { subject: { kind: "contract_events", id: r.contract_event_id }, entity: r.event.payload.entity, filing_type: "tech_provider_notice", template: "TECH-PROV-NOTICE-v1", notice_kind: r.draft.kind, due_at: r.timer.due, opened_on: today(ctx) }, true);
    ctx.events.append(r.event); const esc = openEscalations(rt, ctx, [r.escalation], { contract_event_id: r.contract_event_id });
    return { contract_event_id: r.contract_event_id, notice_id, applies: r.applies, timer: r.timer, draft: r.draft, escalations: esc.map((e) => e.id) };
  }) },
  { name: "tech_provider.change.declare", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "provider", "planned_effective_date", "loan_count");
    const r = techProviderChangeIntent({ change_id: optStr(i, "change_id"), entity: entity(i), provider: str(i, "provider"), planned_effective_date: date(i, "planned_effective_date"), declared_on: optDate(i, "declared_on") ?? today(ctx), loan_count: Number(i.loan_count) });
    rt.store.put("tech_provider_changes", r.change_id, { id: r.change_id, entity: str(i, "entity"), provider: str(i, "provider"), planned_effective_date: r.gate.anchor, applies: r.applies, blocked: r.gate.blocked }, ctx.actor, ctx.now);
    const notice_id = r.event ? openNotice(rt, ctx, { subject: { kind: "tech_provider_change", id: r.change_id }, entity: r.event.payload.entity, filing_type: "tech_provider_notice", template: "TECH-PROV-NOTICE-v1", notice_kind: "planned_change", due_at: r.gate.notice_needed_by, opened_on: r.event.payload.declared_on }, true) : null;
    if (r.event) ctx.events.append(r.event); const esc = r.escalation ? openEscalations(rt, ctx, [r.escalation], { change_id: r.change_id }) : [];
    return { change_id: r.change_id, notice_id, applies: r.applies, gate: r.gate, escalations: esc.map((e) => e.id) };
  }) },
  { name: "notice_template.publish", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "template_code", "template_version", "notice_class");
    const r = noticeTemplatePublishedEvent({ template_code: str(i, "template_code"), template_version: str(i, "template_version"), notice_class: str(i, "notice_class") === "adverse_action" ? "adverse_action" : "other", published_on: optDate(i, "published_on") ?? today(ctx) });
    rt.store.put("notice_template_versions", `${r.event.payload.template_code}:${r.event.payload.template_version}`, { ...r.event.payload, form183_required: r.form183_required, blocked: r.form183_required }, ctx.actor, ctx.now);
    ctx.events.append(r.event); return r;
  }) },
  { name: "form183.submit", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "template_code", "template_version");
    const ev = form183SubmittedEvent({ template_code: str(i, "template_code"), template_version: str(i, "template_version"), submission_evidence_document_id: optStr(i, "submission_evidence_document_id"), submitted_on: optDate(i, "submitted_on") ?? today(ctx) });
    if (!ev) throw new RangeError("Form 183 is recorded submitted only with its submission evidence");
    const k = `${ev.payload.template_code}:${ev.payload.template_version}`; if (rt.store.get("notice_template_versions", k)) rt.store.put("notice_template_versions", k, { blocked: false, form183_evidence_document_id: ev.payload.evidence_document_id }, ctx.actor, ctx.now);
    ctx.events.append(ev); return ev.payload;
  }), guardrails: [humanWhen("FORM183_HUMAN_ACT", GUARD, () => true, "the Form 183 adverse-action certification is an officer/submitter act — the agent cannot certify or submit")] },
  // ---- the notice state machine and the late flag (state machine: detected → classified → drafted → officer_approved → filed → acknowledged; `late` when past due_at)
  { name: "notice.transition", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "notice_id", "to"); const to = str(i, "to");
    if (!(NOTICE_STATES as readonly string[]).includes(to)) throw new RangeError(`to must be one of ${NOTICE_STATES.join(", ")}`);
    if (!noticeOf(rt, str(i, "notice_id"))) throw new RangeError(`no org_change_notice / tech_provider_notice regulatory_filings ${str(i, "notice_id")}`);
    const t = stepNotice(rt, ctx, "notice.transition", str(i, "notice_id"), to as NoticeState, { document_id: optStr(i, "document_id"), submission_evidence: optStr(i, "submission_evidence"), acknowledgment_document_id: optStr(i, "acknowledgment_document_id") })!;
    return { notice_id: t.row.id, status: t.row.status, steps: t.steps, approved_by_officer_id: t.row.approved_by_officer_id, submission_evidence: t.row.submission_evidence, late: t.row.late };
  }), guardrails: [
    needsRole("NOTICE_OFFICER_APPROVES", GUARD, (i) => str(i, "to") === "officer_approved", ["officer"], "the officer approves and signs the Fannie Mae notice — the agent cannot certify or submit"),
    never("NOTICE_FILED_EVIDENCE_REQUIRED", GUARD, (i) => str(i, "to") === "filed" && !str(i, "submission_evidence"), "filed only with the submission evidence (sent-mail evidence; Pending Actions update + email for an A4-1-02 notice)"),
    never("NOTICE_ACKNOWLEDGMENT_REQUIRED", GUARD, (i) => str(i, "to") === "acknowledged" && !str(i, "acknowledgment_document_id"), "acknowledged only with Fannie Mae's acknowledgment/approval document"),
  ] },
  { name: "filing.late_check", kind: "act", handler: compute((i, ctx, rt) => {
    const as_of = optDate(i, "as_of") ?? today(ctx);
    const rows = rt.store.list("regulatory_filings", (d) => !FILING_CLOSED_STATES.includes(String(d.status)) && d.late !== true && lateFlag(D(String(d.due_at)), null, as_of));
    for (const r of rows) {
      rt.store.put("regulatory_filings", r.id, { late: true }, ctx.actor, ctx.now);
      const subject = (r.data.subject as { kind: string; id: string } | undefined) ?? { kind: "fiscal_year", id: `${String(r.data.entity)}:${String(r.data.period_end)}` };
      ctx.events.append({ type: "filing.late_flagged", aggregate: subject, actor: ctx.actor, payload: { filing_id: r.id, filing_type: r.data.filing_type, status: r.data.status, due_at: r.data.due_at, as_of } });
    }
    return { as_of, flagged: rows.map((r) => r.id) };
  }) },
]);

const SPEC_NAMES = new Set(loadAgentsFile().processes.find((p) => p.process === PROCESS)?.tools ?? []);
/** The bus slice: every 18.4 tool whose name spec/registry/agents.json lists for 18.4 (see the header). */
export const TOOLS_18_4: readonly ToolDef[] = FORM582_TOOLS_18_4.filter((t) => SPEC_NAMES.has(t.name));
/** For tests: who may act as which entity's submitter on the bus. */
export const FORM582_SUBMITTER_ACTORS: Record<Entity, Actor> = { supermortgage: { kind: "human", id: "op-7", role: "fnma_portal_operator" }, partner: { kind: "human", id: "partner-op-1", role: "partner_designated_submitter" } };
