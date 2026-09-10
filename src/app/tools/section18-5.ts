/**
 * §18.5 tools — the fraud module of `qc-audit` (with `security-records` for screening/incident overlap). The spec's
 * "Tools:" line is prose ("read access to loan/case/document data; forensic utilities; screening APIs; `cases.create/merge`,
 * `loans.set_hold`, `escalations.create`, `human_portal_task.create`, report renderer"), and the AI-first end-to-end flow —
 * monitor red-flag events → open/merge cases → triage and apply protective actions → run investigation steps → draft the
 * determination memo for the fraud officer → draft reports → escalate for signatures → create portal/email tasks → track
 * filings — is the surface below. Every state change the §18.5 timer table is armed or satisfied by is appended to the
 * event store by one of these handlers (the `*Event` builders in src/domain/qc-audit/ops-18-5.ts shape them):
 *   `screening.ofac_match.ingest` → `ofac.match.confirmed` (arms FNMA_A3201_OFAC_MATCH_24H at the confirmation timestamp)
 *   `cases.create` → `fraud.case.opened` (+ `loan.fraud_hold.set`; arms SM_FRAUD_TRIAGE_2BD, SM_FRAUD_DUE_DILIGENCE_15, SM_FRAUD_PARTNER_NOTIFY_1BD)
 *   `cases.triage` → `fraud.case.status_changed{status=triaged}`;  `cases.transition` → the other state-machine steps
 *   `loans.set_hold` → `loan.fraud_hold.set` / `loan.fraud_hold.released`;  `partner.notify` → `partner.notified{kind=fraud_case}`
 *   `determination.propose` (agent memo, never a determination) ; `determination.record` (fraud officer) → `fraud.determination.recorded`
 *     (+ `fraud.covered_loss.discovered` for an employee-dishonesty determination, rule 7)
 *   `report.file` (officer) → `fraud.report.filed{channel}`;  `le_referral.decide` (attorney) → `fraud.le_referral.decided`
 *   `lawfirm.fraud.record` → `lawfirm.fraud.alleged`;  `covered_loss.record` → `fraud.covered_loss.discovered`
 *   `self_report.require` → `fraud.self_report.required`;  `incident.notice.record` (officer) → `incident.notice.sent{recipient=fannie_mae_supplement}`
 *   `fairness.review` → `fraud.fairness.finding.opened` (routed via counsel);  `escalations.create`, `human_portal_task.create`
 *
 * Guardrails encode spec/registry/agents.json for 18.5: "determinations, external reports and referrals are human acts
 * (`officer:fraud_officer`, `officer`, `attorney`)" → DETERMINATION_HUMAN_ACT / REPORT_OFFICER_SIGNS / REFERRAL_ATTORNEY_DECIDES
 * (humanOnly tools with the role in `humanRoles`, plus the role check inside the builders); "the agent never contacts
 * suspected perpetrators" → AGENT_NEVER_CONTACTS_PERPETRATOR on `human_portal_task.create`; "protective actions are
 * time-boxed (auto-expire in 30 days unless renewed by the officer)" → the hold's renewals are officer-only inside
 * protectiveHold (HOLD_RENEWAL_OFFICER_ONLY refuses an agent's attempt outright); "fairness monitoring of red-flag rates by
 * protected class" → `fairness.review` routes every finding to the attorney.
 *
 * `TOOLS_18_5` — the slice ./section18.ts spreads onto the bus — is the subset whose names spec/registry/agents.json lists
 * for 18.5 (src/app/tools.test.ts refuses any other name on the bus); the extractor reads no tool names from the 18.5
 * "Tools:" line, so the full surface is exported as `FRAUD_TOOLS_18_5` and bound by 18-5.spec.test.ts exactly as
 * ./index.ts would bind it once the registry names them (the same arrangement as ./section18-4.ts and ./section18-6.ts).
 */
import { defineTools, escalate, compute, never, needsRole, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import type { QcEscalation } from "../../domain/qc-audit/ops.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { EventInput } from "../../kernel/events/types.ts";
import {
  DETERMINATION_ROLES, REPORT_SIGNING_ROLE, REFERRAL_ROLE, PROTECTIVE_HOLD_DAYS,
  ofacMatchConfirmedEvent, ofacEthicsNotice, openFraudCase, caseStatusChangedEvent, protectiveHold, fraudPartnerNotifiedEvent, agentDeterminationProposal, determinationRecordedEvent, employeeDishonestyFollowUp,
  fraudReportFiledEvent, reportFilingOutcome, fnmaSelfReportPackage, leReferralDecidedEvent, lawFirmFraudEscalation, coveredLossDiscoveredEvent, selfReportRequiredEvent, cyberIncidentNoticeEvent, quarterlyFlagFairnessReview, caseAssignment,
  type RedFlag, type ScreeningResult, type Determination, type SubjectKind, type ReportChannel, type HoldRenewal, type ProtectiveActionCode, type FraudDecisionRecord, type OfficerDetermination, type SelfReportContent, type FlagRateByClass,
} from "../../domain/qc-audit/ops-18-5.ts";

const AGENT = "qc-audit";
const PROCESS = "18.5";
const GUARD = "18.5 guardrails (spec/registry/agents.json)";
/** The console workbench (AI-off path: "investigators use the console workbench; the same timers apply") plus the process's escalation roles. */
const WORKBENCH_ROLES: readonly string[] = ["ops_analyst", "officer", "fraud_officer", "deputy_fraud_officer", "board_designee", "attorney", "fnma_portal_operator", "human_agent"];
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : str(i, k));
const list = <T,>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const cents = (i: ToolInput, k: string): bigint => (i[k] === undefined || i[k] === null || i[k] === "" ? 0n : BigInt(String(i[k])));
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
/** A refusal a handler can only decide with the record in hand: the same `command.refused` row the bus writes, then the typed error. */
const refuseInHandler = (ctx: CommandContext, command: string, code: string, reason: string): never => {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation: GUARD, reason, subject_id: null } });
  throw new CommandRefused(command, code, GUARD, reason);
};
/** Append a builder's event as the acting context's own append (the builder's actor/loan/aggregate/occurredAt are kept). */
const emit = <P extends Record<string, unknown>>(ctx: CommandContext, ev: EventInput<P>) => ctx.events.append(ev);
/** The determination role of a human actor on the bus (`fraud_officer` → the spec's `officer:fraud_officer`; rule 7 designees). */
const DETERMINATION_ROLE_OF_ACTOR: Record<string, string> = { fraud_officer: "officer:fraud_officer", deputy_fraud_officer: "officer:deputy_fraud_officer", board_designee: "board_designee" };
const DETERMINATION_ACTOR_ROLES = Object.keys(DETERMINATION_ROLE_OF_ACTOR);
const determinationOf = (i: ToolInput): Determination => { const d = str(i, "determination"); if (d !== "reasonable_basis" && d !== "unfounded" && d !== "inconclusive") throw new RangeError("determination is reasonable_basis, unfounded or inconclusive"); return d; };
const subjectKindOf = (i: ToolInput): SubjectKind | undefined => { const s = optStr(i, "subject_kind"); if (s === null) return undefined; if (!["borrower", "third_party", "employee", "vendor", "law_firm", "unknown"].includes(s)) throw new RangeError(`subject_kind ${s} is not a fraud_cases.subject_kind`); return s as SubjectKind; };
const CHANNELS: readonly ReportChannel[] = ["lqc_self_report", "ethics_email_ofac", "fraud_tip_form", "fraud_hotline", "fnma_legal_email", "law_enforcement", "state_regulator", "carrier"];
const channelOf = (i: ToolInput): ReportChannel => { const c = str(i, "channel"); if (!CHANNELS.includes(c as ReportChannel)) throw new RangeError(`channel ${c || "(none)"} is not a fraud_reports.channel (${CHANNELS.join(", ")})`); return c as ReportChannel; };
const HOLD_ACTIONS: readonly ProtectiveActionCode[] = ["hold_payoff_disbursement", "short_sale_human_review", "id_verified_authentication", "suspend_credit_reporting", "freeze_vendor_payments"];
/** A QcEscalation kind on the escalation service: the spec's `fnma_portal_operator` / partner submitter is the `human_portal_task` owner. */
const escKind = (k: QcEscalation["kind"]): EscalationKind => (k === "fnma_portal_operator" ? "human_portal_task" : k);
const caseRow = (rt: ToolRuntime, id: string): Record<string, unknown> | null => rt.store.get("fraud_cases", id)?.data ?? null;

/** The whole 18.5 tool surface (see the header for why the bus slice below is narrower). */
export const FRAUD_TOOLS_18_5: readonly ToolDef[] = defineTools(PROCESS, AGENT, [
  // ---- inputs: the Section 19 screening feed and the red-flag events ---------------------------------------------------
  { name: "screening.ofac_match.ingest", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    const result = i.result as ScreeningResult | undefined;
    if (!result || typeof result !== "object") throw new RangeError("result is required (a Section 19 screening_results row: subject, list, match_score, disposition, confirmed_at)");
    const case_id = str(i, "case_id") || `FR-OFAC-${result.screening_result_id}`;
    const m = ofacMatchConfirmedEvent({ result, case_id });
    if (!m.event || !m.flag) return refuseInHandler(ctx, "screening.ofac_match.ingest", "OFAC_MATCH_NOT_CONFIRMED", m.refusal ?? "no confirmed OFAC match");
    rt.store.put("screening_results", result.screening_result_id, { ...result, fraud_case_id: case_id }, ctx.actor, ctx.now);
    rt.store.put("fraud_red_flags", `${case_id}:OFAC_MATCH:${result.screening_result_id}`, { ...m.flag, case_id }, ctx.actor, ctx.now);
    const prev = caseRow(rt, case_id);
    rt.store.put("fraud_cases", case_id, { case_id, status: prev?.status ?? "ofac_match_confirmed", subject_kind: result.subject.kind === "borrower" ? "borrower" : result.subject.kind === "vendor" ? "vendor" : result.subject.kind === "employee" ? "employee" : "third_party", scheme_code: "ofac_match", loans: result.loan_id ? [result.loan_id] : [], ofac_confirmed_at: m.event.payload.confirmed_at, ofac_report_due_at: m.due_at }, ctx.actor, ctx.now);
    const ev = emit(ctx, m.event);
    const n = ofacEthicsNotice({ case_id, confirmed_at: m.event.payload.confirmed_at, borrower_name: result.subject.name, fnma_loan_number: result.fnma_loan_number ?? "", servicer_contact: str(i, "servicer_contact") });
    rt.escalations.open({ kind: "officer", severity: "sev1", caseId: case_id, ...(result.loan_id ? { loanId: result.loan_id } : {}), payload: { reason: n.escalation.reason, timer: n.timer, due_at: n.due_at, template: n.template, recipient: n.recipient, content: n.content, blocking: n.blocking } }, ctx.actor);
    return { case_id, event_id: ev.id, event_type: ev.type, confirmed_at: m.event.payload.confirmed_at, timer: n.timer, due_at: n.due_at, due_et: n.due_et, flag: m.flag, channel: n.channel, template: n.template };
  }) },
  { name: "cases.create", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id");
    const flags = list<RedFlag>(i, "flags");
    if (flags.length === 0) throw new RangeError("flags is required (the fraud_red_flags rows the case opens on)");
    for (const f of flags) if (!f.flag_code || typeof f.score !== "number" || !f.detector) throw new RangeError("every red flag carries flag_code, score and detector");
    const c = openFraudCase({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), flags, opened_on: optDate(i, "opened_on") ?? today(ctx) });
    for (const f of flags) rt.store.put("fraud_red_flags", `${c.case_id}:${f.flag_code}:${f.source_event}`, { ...f, case_id: c.case_id }, ctx.actor, ctx.now);
    rt.store.put("fraud_cases", c.case_id, { case_id: c.case_id, status: c.status, score: c.score, priority: c.priority, flags: c.flags, opened_at: c.opened_on, loans: c.loan_fraud_hold ? [c.loan_fraud_hold.loan_id] : optStr(i, "loan_id") ? [str(i, "loan_id")] : [], subject_kind: subjectKindOf(i) ?? "unknown", exposure_cents: cents(i, "exposure_cents"), protective_holds: c.protective_actions, partner_notified_at: null }, ctx.actor, ctx.now);
    const ev = emit(ctx, c.event);
    if (c.loan_fraud_hold && c.loan_fraud_hold_event) { rt.store.put("loans", c.loan_fraud_hold.loan_id, { ...c.loan_fraud_hold }, ctx.actor, ctx.now); emit(ctx, c.loan_fraud_hold_event); }
    for (const e of c.escalations) rt.escalations.open({ kind: escKind(e.kind), caseId: c.case_id, ...(e.severity ? { severity: e.severity } : {}), ...(optStr(i, "loan_id") ? { loanId: str(i, "loan_id") } : {}), payload: { reason: e.reason, due: e.due ?? null } }, ctx.actor);
    return { case_id: c.case_id, event_id: ev.id, status: c.status, score: c.score, priority: c.priority, protective_actions: c.protective_actions, loan_fraud_hold: c.loan_fraud_hold, tasks: c.tasks, partner_notice: c.partner_notice, timers: c.timers };
  }) },
  { name: "cases.triage", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id");
    const row = caseRow(rt, str(i, "case_id")); if (!row) throw new RangeError(`no fraud_cases ${str(i, "case_id")}`);
    if (row.status !== "flagged") return refuseInHandler(ctx, "cases.triage", "CASE_NOT_FLAGGED", `case ${str(i, "case_id")} is ${String(row.status)}: triage is the flagged → triaged transition`);
    const ev = emit(ctx, caseStatusChangedEvent({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id") ?? ((row.loans as string[] | undefined)?.[0] ?? null), status: "triaged", score: Number(row.score ?? 0), priority: row.priority as "P1" | "P2" | "P3", rationale: optStr(i, "rationale") }));
    rt.store.put("fraud_cases", str(i, "case_id"), { status: "triaged", triaged_at: ctx.now }, ctx.actor, ctx.now);
    return { case_id: str(i, "case_id"), status: "triaged", event_id: ev.id, priority: row.priority };
  }) },
  { name: "cases.transition", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id", "status");
    const s = str(i, "status");
    if (!["investigating", "determined", "reported", "remediating", "closed", "unfounded_closed", "merged", "on_hold_law_enforcement"].includes(s)) throw new RangeError(`status ${s} is not a fraud_cases.status transition`);
    if (s === "unfounded_closed" && !optStr(i, "rationale")) throw new RangeError("unfounded_closed needs a rationale (state machine: `unfounded_closed` with rationale)");
    const row = caseRow(rt, str(i, "case_id")); if (!row) throw new RangeError(`no fraud_cases ${str(i, "case_id")}`);
    const ev = emit(ctx, caseStatusChangedEvent({ case_id: str(i, "case_id"), loan_id: (row.loans as string[] | undefined)?.[0] ?? null, status: s as "investigating", rationale: optStr(i, "rationale") }));
    rt.store.put("fraud_cases", str(i, "case_id"), { status: s, ...(s === "unfounded_closed" || s === "closed" ? { closed_at: ctx.now } : {}) }, ctx.actor, ctx.now);
    return { case_id: str(i, "case_id"), status: s, event_id: ev.id };
  }) },
  { name: "cases.assign", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id", "officer_id");
    const a = caseAssignment({ case_id: str(i, "case_id"), subject_kind: subjectKindOf(i) ?? "unknown", officer_id: str(i, "officer_id"), subjects: list<string>(i, "subjects"), deputy_designee: optStr(i, "deputy_designee") });
    rt.store.put("fraud_cases", str(i, "case_id"), { assigned_to: a.assigned_to, rescreen_required: a.rescreen_required }, ctx.actor, ctx.now);
    if (a.escalation) rt.escalations.open({ kind: escKind(a.escalation.kind), caseId: str(i, "case_id"), ...(a.escalation.severity ? { severity: a.escalation.severity } : {}), payload: { reason: a.escalation.reason } }, ctx.actor);
    return a;
  }) },
  // ---- protective actions (rule 2; time-boxed, guardrail) ------------------------------------------------------------
  { name: "loans.set_hold", kind: "act", humanRoles: WORKBENCH_ROLES, guardrails: [never("HOLD_RENEWAL_OFFICER_ONLY", GUARD, (i) => list<HoldRenewal>(i, "renewals").some((r) => r.renewed_by_role !== "officer:fraud_officer" && r.renewed_by_role !== "officer"), "protective actions auto-expire in 30 days unless renewed by the officer — a renewal by anyone else is refused")], handler: compute((i, ctx, rt) => {
    need(i, "loan_id", "action", "placed_on", "reason");
    const action = str(i, "action"); if (!HOLD_ACTIONS.includes(action as ProtectiveActionCode)) throw new RangeError(`action ${action} is not a protective action`);
    const h = protectiveHold({ loan_id: str(i, "loan_id"), case_id: optStr(i, "case_id"), action: action as ProtectiveActionCode, placed_on: date(i, "placed_on"), reason: str(i, "reason"), renewals: list<HoldRenewal>(i, "renewals"), today: optDate(i, "today") ?? today(ctx) });
    rt.store.put("loans", str(i, "loan_id"), { ...h.loan_row }, ctx.actor, ctx.now);
    const ev = emit(ctx, h.event);
    return { ...h, event_id: ev.id, time_box_days: PROTECTIVE_HOLD_DAYS };
  }) },
  { name: "partner.notify", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id", "leg");
    const leg = str(i, "leg"); if (leg !== "open" && leg !== "determination") throw new RangeError("leg is open or determination");
    const ev = fraudPartnerNotifiedEvent({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), leg, evidence_document_id: optStr(i, "evidence_document_id"), notified_on: optDate(i, "notified_on") ?? today(ctx) });
    if (!ev) return refuseInHandler(ctx, "partner.notify", "PARTNER_NOTICE_UNEVIDENCED", `partner notice for case ${str(i, "case_id")} (${leg} leg) carries no evidence document — an unevidenced notice is no notice (SM_FRAUD_PARTNER_NOTIFY_1BD 'partner notified (evidence)')`);
    const out = emit(ctx, ev);
    rt.store.put("fraud_cases", str(i, "case_id"), { partner_notified_at: ev.payload.notified_on, [`partner_notified_${leg}_evidence`]: ev.payload.evidence_document_id }, ctx.actor, ctx.now);
    return { case_id: str(i, "case_id"), leg, notified_on: ev.payload.notified_on, evidence_document_id: ev.payload.evidence_document_id, event_id: out.id };
  }) },
  // ---- determination: the agent's memo, the fraud officer's act (rule 3, guardrail) -------------------------------------
  { name: "determination.propose", kind: "write", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    const record = i.record as FraudDecisionRecord | undefined;
    if (!record || typeof record !== "object" || !record.case_id) throw new RangeError("record is required (the decision record: case_id, flags[], score, hypotheses[], evidence_refs[], recommended_determination, confidence, model_version, prompt_version)");
    const p = agentDeterminationProposal({ record, officer_determination: null });
    rt.store.put("fraud_decision_records", `${record.case_id}:${record.model_version}:${record.prompt_version}`, { ...record }, ctx.actor, ctx.now);
    ctx.events.append({ type: "fraud.determination.proposed", actor: ctx.actor, aggregate: { kind: "fraud_case", id: record.case_id }, payload: { case_id: record.case_id, recommended_determination: record.recommended_determination, confidence: record.confidence, model_version: record.model_version, prompt_version: record.prompt_version, package: p.package, determination_recorded: false } });
    if (p.escalation) rt.escalations.open({ kind: escKind(p.escalation.kind), caseId: record.case_id, payload: { reason: p.escalation.reason, package: p.package, memo: p.memo } }, ctx.actor);
    return p;
  }) },
  { name: "determination.record", kind: "act", humanOnly: true, humanRoles: DETERMINATION_ACTOR_ROLES, guardrails: [needsRole("DETERMINATION_HUMAN_ACT", GUARD, () => true, DETERMINATION_ACTOR_ROLES, "a determination is the officer:fraud_officer's act (deputy/board designee under rule 7), never the agent's")], handler: compute((i, ctx, rt) => {
    need(i, "case_id");
    const role = DETERMINATION_ROLE_OF_ACTOR[ctx.actor.role ?? ""] ?? "";
    if (!DETERMINATION_ROLES.includes(role)) return refuseInHandler(ctx, "determination.record", "DETERMINATION_HUMAN_ACT", `determination by ${ctx.actor.kind}:${ctx.actor.id} (${ctx.actor.role ?? "no role"}) refused — determinations are human acts of the fraud officer`);
    const officer: OfficerDetermination = { determination: determinationOf(i), determined_by_officer_id: ctx.actor.id, determined_by_role: role, determined_at: optDate(i, "determined_at") ?? today(ctx) };
    const subject_kind = subjectKindOf(i);
    const ev = determinationRecordedEvent({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), officer, exposure_cents: cents(i, "exposure_cents"), flags: list<string>(i, "flags"), ...(subject_kind ? { subject_kind } : {}), scheme_code: optStr(i, "scheme_code") });
    if (!ev) return refuseInHandler(ctx, "determination.record", "DETERMINATION_HUMAN_ACT", `determination under role ${role || "(none)"} is no determination`);
    const out = emit(ctx, ev);
    const proposal = agentDeterminationProposal({ record: (i.record as FraudDecisionRecord | undefined) ?? { case_id: str(i, "case_id"), flags: list<string>(i, "flags"), score: 0, hypotheses: [], evidence_refs: [], recommended_determination: officer.determination, confidence: 0, model_version: "none", prompt_version: "none" }, officer_determination: officer });
    rt.store.put("fraud_cases", str(i, "case_id"), { status: proposal.case_status, determination: officer.determination, determination_at: officer.determined_at, determined_by_officer_id: officer.determined_by_officer_id, fnma_report_due_at: proposal.fnma_report_due, exposure_cents: cents(i, "exposure_cents") }, ctx.actor, ctx.now);
    if (proposal.escalation) rt.escalations.open({ kind: escKind(proposal.escalation.kind), caseId: str(i, "case_id"), payload: { reason: proposal.escalation.reason, due: proposal.escalation.due ?? null } }, ctx.actor);
    // rule 7: an employee-dishonesty determination notifies the board/partner, re-runs screening and discovers the covered loss (arms SM_FRAUD_CARRIER_NOTICE_IMMEDIATE)
    const fu = employeeDishonestyFollowUp({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), subject_kind: subject_kind ?? "unknown", determination: officer.determination, determined_at: officer.determined_at, exposure_cents: cents(i, "exposure_cents") });
    let covered_loss_event_id: string | null = null;
    if (fu.carrier) { covered_loss_event_id = emit(ctx, fu.carrier.event).id; rt.escalations.open({ kind: escKind(fu.carrier.escalation.kind), severity: "sev1", caseId: str(i, "case_id"), payload: { reason: fu.carrier.escalation.reason, due: fu.carrier.due, timer: fu.carrier.timer } }, ctx.actor); }
    return { case_id: str(i, "case_id"), event_id: out.id, determination: officer.determination, determined_at: officer.determined_at, reasonable_basis: ev.payload.reasonable_basis, le_referral_candidate: ev.payload.le_referral_candidate, case_status: proposal.case_status, fnma_report_due: proposal.fnma_report_due, internal_target: proposal.internal_target, partner_notice_due: proposal.partner_notice_due, package: proposal.package, employee_dishonesty: { board_partner_notice: fu.board_partner_notice, rescreen: fu.rescreen, carrier_notice: fu.carrier_notice, covered_loss_event_id } };
  }) },
  // ---- reports and referrals: the officer signs, the attorney refers (guardrail) -----------------------------------------
  { name: "report.package", kind: "write", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id");
    const row = caseRow(rt, str(i, "case_id"));
    const od: OfficerDetermination | null = row?.determination ? { determination: row.determination as Determination, determined_by_officer_id: String(row.determined_by_officer_id ?? ""), determined_by_role: DETERMINATION_ROLE_OF_ACTOR[String(row.determined_by_role ?? "fraud_officer")] ?? String(row.determined_by_role ?? "officer:fraud_officer"), determined_at: D(String(row.determination_at)) } : null;
    const pkg = fnmaSelfReportPackage({ case_id: str(i, "case_id"), officer_determination: od, agent_recommendation: (i.agent_recommendation as { determination: Determination; confidence: number } | undefined) ?? null, content: ((i.content as Partial<SelfReportContent> | undefined) ?? {}) });
    if (pkg.ready_for_signature) rt.store.put("documents", str(i, "package_document_id") || `${str(i, "case_id")}:FRAUD-FNMA-SR-v1`, { kind: "FRAUD-FNMA-SR-v1", case_id: str(i, "case_id"), content: pkg.content, drafted_by: `${ctx.actor.kind}:${ctx.actor.id}`, signer: pkg.signer, submitter: pkg.submitter }, ctx.actor, ctx.now);
    return pkg;
  }) },
  { name: "report.file", kind: "act", humanOnly: true, humanRoles: [REPORT_SIGNING_ROLE], guardrails: [needsRole("REPORT_OFFICER_SIGNS", GUARD, () => true, [REPORT_SIGNING_ROLE], "external reports are human acts signed by the officer")], handler: compute((i, ctx, rt) => {
    need(i, "case_id");
    const channel = channelOf(i);
    const kind = str(i, "kind") === "breach_self_report" ? "breach_self_report" as const : "case_report" as const;
    const ev = fraudReportFiledEvent({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), channel, signed_by_officer_id: ctx.actor.id, signed_by_role: ctx.actor.role ?? "", evidence_document_id: optStr(i, "evidence_document_id"), sent_on: optDate(i, "sent_on") ?? today(ctx), lqc_reference: optStr(i, "lqc_reference"), kind, ...(i.subject && typeof i.subject === "object" ? { subject: i.subject as { kind: string; id: string } } : {}) });
    if (!ev) return refuseInHandler(ctx, "report.file", "REPORT_UNEVIDENCED", `${channel} report for case ${str(i, "case_id")} carries no sent evidence — a report without its evidence is no filing`);
    const out = emit(ctx, ev);
    rt.store.put("fraud_reports", `${str(i, "case_id")}:${channel}:${ev.payload.sent_on}`, { case_id: str(i, "case_id"), channel, kind, package_document_id: optStr(i, "package_document_id"), signed_by_officer_id: ctx.actor.id, sent_at: ev.payload.sent_on, evidence: ev.payload.evidence_document_id, lqc_reference: ev.payload.lqc_reference ?? null }, ctx.actor, ctx.now);
    const row = caseRow(rt, str(i, "case_id"));
    const outcome = channel === "lqc_self_report" && kind === "case_report" && row?.determination_at ? reportFilingOutcome({ case_id: str(i, "case_id"), determination_at: D(String(row.determination_at)), filed_on: ev.payload.sent_on, lqc_reference: ev.payload.lqc_reference ?? null }) : null;
    if (outcome) {
      rt.store.put("fraud_cases", str(i, "case_id"), { fnma_report_filed_at: ev.payload.sent_on, fnma_report_ref: ev.payload.lqc_reference ?? null, status: outcome.satisfies_timer ? "reported" : row?.status }, ctx.actor, ctx.now);
      for (const e of outcome.escalations) rt.escalations.open({ kind: escKind(e.kind), caseId: str(i, "case_id"), ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason } }, ctx.actor);
    } else if (channel === "ethics_email_ofac") rt.store.put("fraud_cases", str(i, "case_id"), { ofac_reported_at: ev.payload.sent_on, status: "ethics_notified" }, ctx.actor, ctx.now);
    else if (channel === "carrier") rt.store.put("fraud_cases", str(i, "case_id"), { carrier_claim_at: ev.payload.sent_on }, ctx.actor, ctx.now);
    else if (channel === "state_regulator") rt.store.put("fraud_cases", str(i, "case_id"), { regulator_report_at: ev.payload.sent_on }, ctx.actor, ctx.now);
    return { case_id: str(i, "case_id"), channel, kind, sent_on: ev.payload.sent_on, lqc_reference: ev.payload.lqc_reference ?? null, event_id: out.id, outcome };
  }) },
  { name: "le_referral.decide", kind: "act", humanOnly: true, humanRoles: [REFERRAL_ROLE], guardrails: [needsRole("REFERRAL_ATTORNEY_DECIDES", GUARD, () => true, [REFERRAL_ROLE], "law-enforcement/regulator referrals are the attorney's act")], handler: compute((i, ctx, rt) => {
    need(i, "case_id", "decision");
    const decision = str(i, "decision"); if (decision !== "refer" && decision !== "not_refer") throw new RangeError("decision is refer or not_refer");
    const ev = leReferralDecidedEvent({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), decision, decided_by_role: ctx.actor.role ?? "", attorney_id: ctx.actor.id, reason: optStr(i, "reason"), decided_on: optDate(i, "decided_on") ?? today(ctx) });
    if (!ev) return refuseInHandler(ctx, "le_referral.decide", "REFERRAL_REASON_REQUIRED", `a not-refer decision for case ${str(i, "case_id")} records its reason (timer table: 'refer / not refer with reason')`);
    const out = emit(ctx, ev);
    if (decision === "refer") { ctx.events.append({ type: "fraud.referral.sent", actor: ctx.actor, ...(optStr(i, "loan_id") ? { loanId: str(i, "loan_id") } : {}), aggregate: { kind: "fraud_case", id: str(i, "case_id") }, payload: { case_id: str(i, "case_id"), to: "law_enforcement", attorney_id: ctx.actor.id, sent_on: ev.payload.decided_on, agency: optStr(i, "agency") } }); rt.store.put("fraud_cases", str(i, "case_id"), { law_enforcement_referral_at: ev.payload.decided_on }, ctx.actor, ctx.now); }
    return { case_id: str(i, "case_id"), decision, decided_on: ev.payload.decided_on, event_id: out.id };
  }) },
  { name: "lawfirm.fraud.record", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id", "firm_id");
    const e = lawFirmFraudEscalation({ case_id: str(i, "case_id"), firm_id: str(i, "firm_id"), discovered_on: optDate(i, "discovered_on") ?? today(ctx) });
    const out = emit(ctx, e.arms);
    rt.store.put("fraud_cases", str(i, "case_id"), { case_id: str(i, "case_id"), subject_kind: "law_firm", firm_id: str(i, "firm_id"), status: caseRow(rt, str(i, "case_id"))?.status ?? "flagged", lawfirm_fraud_discovered_on: e.arms.payload.discovered_on, fnma_legal_due: e.due }, ctx.actor, ctx.now);
    rt.escalations.open({ kind: escKind(e.escalation.kind), severity: "sev1", caseId: str(i, "case_id"), payload: { reason: e.escalation.reason, due: e.due, timer: e.timer, template: e.template, co_owner: e.co_owner } }, ctx.actor);
    return { case_id: str(i, "case_id"), timer: e.timer, due: e.due, calendar: e.calendar, channel: e.channel, template: e.template, event_id: out.id };
  }) },
  { name: "covered_loss.record", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "case_id", "loss_kind");
    const loss_kind = str(i, "loss_kind"); if (loss_kind !== "employee_dishonesty" && loss_kind !== "covered_loss") throw new RangeError("loss_kind is employee_dishonesty or covered_loss");
    const c = coveredLossDiscoveredEvent({ case_id: str(i, "case_id"), loan_id: optStr(i, "loan_id"), discovered_on: optDate(i, "discovered_on") ?? today(ctx), loss_kind, exposure_cents: cents(i, "exposure_cents") });
    const out = emit(ctx, c.event);
    rt.escalations.open({ kind: escKind(c.escalation.kind), severity: "sev1", caseId: str(i, "case_id"), payload: { reason: c.escalation.reason, due: c.due, timer: c.timer } }, ctx.actor);
    return { case_id: str(i, "case_id"), timer: c.timer, due: c.due, event_id: out.id };
  }) },
  { name: "self_report.require", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx) => {
    const source = str(i, "source");
    const ev = source === "qc.finding.validated"
      ? selfReportRequiredEvent({ source, finding_id: (need(i, "finding_id", "population", "prior_year_deliveries"), str(i, "finding_id")), population: Number(i.population), prior_year_deliveries: Number(i.prior_year_deliveries), quarter_end: date(i, "quarter_end"), discovered_on: date(i, "discovered_on"), validated_on: optDate(i, "validated_on") ?? today(ctx) })
      : source === "repurchase_risk_breach.determined" ? selfReportRequiredEvent({ source, breach_id: (need(i, "breach_id"), str(i, "breach_id")), determined_on: optDate(i, "determined_on") ?? today(ctx) })
      : (() => { throw new RangeError("source is qc.finding.validated or repurchase_risk_breach.determined"); })();
    if (!ev) return { required: false, event_id: null, basis: null, self_report_anchor_on: null, due: null };
    const out = emit(ctx, ev);
    return { required: true, event_id: out.id, basis: ev.payload.basis, self_report_anchor_on: ev.payload.self_report_anchor_on, due: ev.payload.due };
  }) },
  { name: "incident.notice.record", kind: "act", humanOnly: true, humanRoles: [REPORT_SIGNING_ROLE], handler: compute((i, ctx, rt) => {
    need(i, "incident_id");
    const n = cyberIncidentNoticeEvent({ incident_id: str(i, "incident_id"), case_id: optStr(i, "case_id"), sent_at: optStr(i, "sent_at") ?? ctx.now, sent_by_role: ctx.actor.role ?? "", sent_by_id: ctx.actor.id, evidence_document_id: optStr(i, "evidence_document_id"), bec_payoff_diversion: flag(i, "bec_payoff_diversion") });
    if (!n.event || !n.row) return refuseInHandler(ctx, "incident.notice.record", "INCIDENT_NOTICE_UNEVIDENCED", n.refusal ?? "no notice");
    const out = emit(ctx, n.event);
    rt.store.put("incident_notices", `${str(i, "incident_id")}:fannie_mae_supplement`, n.row, ctx.actor, ctx.now);
    return { incident_id: str(i, "incident_id"), recipient: "fannie_mae_supplement", event_id: out.id };
  }) },
  { name: "fairness.review", kind: "act", humanRoles: WORKBENCH_ROLES, handler: compute((i, ctx, rt) => {
    need(i, "quarter");
    const rates = list<FlagRateByClass>(i, "rates"); if (rates.length === 0) throw new RangeError("rates is required (quarterly flag rates by class, one marked reference)");
    const r = quarterlyFlagFairnessReview({ quarter: str(i, "quarter"), rates });
    for (const f of r.findings) {
      const id = `${f.quarter}:${f.protected_class}`;
      rt.store.put("qc_findings", `fairness:${id}`, { id: `fairness:${id}`, kind: f.kind, scope: f.scope, route: f.route, privileged: f.privileged, quarter: f.quarter, protected_class: f.protected_class, protected_flag_rate: f.protected_flag_rate, reference_flag_rate: f.reference_flag_rate, ratio: f.ratio }, ctx.actor, ctx.now);
      ctx.events.append({ type: "fraud.fairness.finding.opened", actor: ctx.actor, aggregate: { kind: "qc_finding", id: `fairness:${id}` }, payload: { quarter: f.quarter, protected_class: f.protected_class, ratio: f.ratio, route: f.route, privileged: f.privileged } });
      rt.escalations.open({ kind: "attorney", payload: { reason: f.escalation.reason, finding_id: `fairness:${id}`, privileged: true } }, ctx.actor);
    }
    return r;
  }) },
  // ---- the spec's named escalation/portal tools -------------------------------------------------------------------------
  { name: "escalations.create", kind: "act", humanRoles: WORKBENCH_ROLES, handler: escalate("fraud_officer") },
  { name: "human_portal_task.create", kind: "act", humanRoles: WORKBENCH_ROLES, guardrails: [never("AGENT_NEVER_CONTACTS_PERPETRATOR", GUARD, (i) => str(i, "target") === "suspected_perpetrator", "the agent never contacts suspected perpetrators — no task may direct contact with a suspected perpetrator")], handler: escalate("human_portal_task") },
]);

/** The bus slice: spec/registry/agents.json names no tools for 18.5, so nothing is spread onto the bus (see the header). */
export const TOOLS_18_5: readonly ToolDef[] = [];
