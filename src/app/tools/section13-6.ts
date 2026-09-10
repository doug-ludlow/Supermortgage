/**
 * §13.6 process-owned tool handlers. The spec names six tools for `foreclosure-ops` on 13.6 — `firm.get`,
 * `documents.extract`, `fee_schedule.get`, `invoice.review`, `dra.snapshot.import`, `attorney.message.send` — and
 * src/app/tools.test.ts refuses any other name, so the firm / matter / invoice / DRA lifecycles run as ops on the three
 * act/write tools (the §13.7 idiom), registered in ./section13.ts and executed here:
 *
 *   attorney.message.send — `kind` (default `message`, the plain attorney-network message): firm selection and
 *     retention (`firm_candidate`, `due_diligence`, `form200_submit` (officer), `form200_response` (portal operator /
 *     officer), `training_completed`, `lra_executed`, `retain` (officer), `eo_policy`); oversight (`review_completed`,
 *     `scorecard`, `escalation_discovered`, `escalation_sent`); suspensions / transfers / terminations
 *     (`suspension_proposed`, `fnma_notified`, `suspension_implement` (officer), `matter_transfer_requested`,
 *     `transfer_approval` (officer), `matter_transfer`, `terminate` (officer), `records_release`); matters (`refer`,
 *     `firm_ack`, `instruction_ack`, `matter_completed`, `claim_filed` (portal operator)).
 *   invoice.review — `op` `review` (default: the E-5-05 rules engine over attorney_fee_schedules and the matter's paid
 *     history), `received` (inbound INVOICE message), `pay` (AP run; books the corporate advance).
 *   dra.snapshot.import — the portal operator's daily export: rows validated into dra_snapshots / dra_events and
 *     reconciled against every open expectation on attorney_matters (dra.event.matched / dra.exception.raised).
 *
 * Gate facts are the store's (`attorney_firms`, `attorney_retentions`, `attorney_matters`, `attorney_invoices`), never
 * the caller's; a closed gate leaves `foreclosure.gate.refused{command, code}` and throws `GateClosed`. Every event a
 * 13.6 timer is armed or satisfied by is built by src/domain/foreclosure/ops-13-6.ts and appended here. `TOOLS_13_6`
 * stays empty: the names are already registered by ./section13.ts for 13.6.
 */
import { compute, never, needsRole, str, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { assertGate, evaluateGate, GateClosed } from "../evaluators.ts";
import type { CommandContext } from "../commands.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import type { TimerRegistry, TimerDef } from "../../kernel/timers/registry.ts";
let registryCache136: TimerRegistry | null = null;
const registryDef136 = (code: string): TimerDef => { registryCache136 ??= loadOverriddenRegistry(); const d = registryCache136.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { reviewInvoice, type Method as FirmMethod, type Confirmation } from "../../domain/foreclosure/firms.ts";
import type { Escalation as DomainEscalation } from "../../domain/foreclosure/ops.ts";
import { firmCandidateCreated, dueDiligenceCompleted, form200Submitted, form200Responded, trainingCompleted, lraExecuted, firmRetained, eoPolicyRecorded, retentionFacts, matterReferred, matterAcknowledged, instructionAcknowledged, matterCompleted, claimFiled, reviewCompleted, scorecardPublished, escalationDiscovered, escalationSent, suspensionProposed, fnmaNotified, suspensionImplemented, matterTransferRequested, transferApprovalRecorded, matterTransferred, firmTerminated, selectionRecordsReleased, invoiceReceived, invoiceReviewOutcome, invoicePaid, draSnapshotImported, reconcileDra, RULE_SET_VERSION_13_6, type EmittedEvent, type Form200Response, type EscalationCategory, type ReviewKind, type MatterKind, type ClaimMilestone, type FnmaNoticeKind, type DraExpectation, type DraRow } from "../../domain/foreclosure/ops-13-6.ts";

type Row = Record<string, unknown>;
export const FIRMS = "attorney_firms", RETENTIONS = "attorney_retentions", REVIEWS = "attorney_reviews", ESCALATIONS = "attorney_escalations", MATTERS = "attorney_matters", INVOICES = "attorney_invoices", SCHEDULES = "attorney_fee_schedules", SNAPSHOTS = "dra_snapshots", DRA_EVENTS = "dra_events", DRA_EXCEPTIONS = "dra_reconciliation_exceptions", SCORECARDS = "firm_scorecards", CREDITS = "fc_delay_credits";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const at = (i: ToolInput, k: string, ctx: CommandContext): PlainDate => D((str(i, k) || ctx.now).slice(0, 10));
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const optDate = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const money = (v: unknown): Cents | null => (v === undefined || v === null || v === "" ? null : cents(v));
const emitAll = (ctx: CommandContext, events: readonly EmittedEvent[]): void => { for (const e of events) ctx.events.append({ type: e.type, ...(e.loan_id ? { loanId: e.loan_id } : {}), ...(e.aggregate ? { aggregate: e.aggregate } : {}), actor: ctx.actor, payload: e.payload }); };
const ESCALATION_KIND: Record<DomainEscalation["kind"], { kind: EscalationKind; ownerRole?: string }> = { officer: { kind: "officer" }, attorney: { kind: "attorney" }, human_agent: { kind: "human_agent" }, fnma_portal_operator: { kind: "human_portal_task" }, signing_officer: { kind: "signing_officer" }, lossmit_reviewer: { kind: "lossmit_reviewer" }, compliance_sentinel: { kind: "sev1", ownerRole: "compliance_sentinel" } };
const openAll = (rt: ToolRuntime, ctx: CommandContext, escalations: readonly DomainEscalation[], payload: Row, loanId?: string | null): string[] =>
  escalations.map((e) => { const m = ESCALATION_KIND[e.kind]; return rt.escalations.open({ kind: m.kind, ...(loanId ? { loanId } : {}), ...(m.ownerRole ? { ownerRole: m.ownerRole } : {}), ...(e.severity ? { severity: e.severity } : {}), payload: { ...payload, reason: e.reason } }, ctx.actor).id; });
const refuseGate = (ctx: CommandContext, command: string, code: string, reason: string, extra: Row = {}, loanId?: string | null): never => {
  ctx.events.append({ type: "foreclosure.gate.refused", ...(loanId ? { loanId } : {}), actor: ctx.actor, payload: { command, code, reason, ...extra } });
  throw new GateClosed(code, reason);
};
const firmRow = (rt: ToolRuntime, id: string): Row & { id: string } => { const r = rt.store.get(FIRMS, id); if (!r) throw new RangeError(`no ${FIRMS} ${id}`); return { ...r.data, id: r.id }; };
const retentionId = (firmId: string, state: string): string => `${firmId}:${state.toUpperCase()}`;
const retentionRow = (rt: ToolRuntime, firmId: string, state: string): Row | null => rt.store.get(RETENTIONS, retentionId(firmId, state))?.data ?? null;
const requireRetention = (rt: ToolRuntime, firmId: string, state: string): Row => { const r = retentionRow(rt, firmId, state); if (!r) throw new RangeError(`no Form 200 submitted for ${firmId}/${state.toUpperCase()} (A4-2.2-01)`); return r; };
const matterRow = (rt: ToolRuntime, i: ToolInput): Row => { need(i, "matter_id"); const r = rt.store.get(MATTERS, str(i, "matter_id")); if (!r) throw new RangeError(`no ${MATTERS} ${str(i, "matter_id")}`); return { ...r.data, matter_id: r.id }; };
const put = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: Row): Row => rt.store.put(kind, id, data, ctx.actor, ctx.now).data;
const escalationRow = (rt: ToolRuntime, i: ToolInput): Row => { need(i, "escalation_id"); const r = rt.store.get(ESCALATIONS, str(i, "escalation_id")); if (!r) throw new RangeError(`no ${ESCALATIONS} ${str(i, "escalation_id")}`); return { ...r.data, escalation_id: r.id }; };
const scheduleFor = (rt: ToolRuntime, state: string, method: string, today: string) => rt.store.list(SCHEDULES).filter((r) => String(r.data.state).toUpperCase() === state && r.data.method === method && String(r.data.effective_from ?? "0000") <= today).sort((a, b) => (String(a.data.effective_from) < String(b.data.effective_from) ? 1 : -1))[0] ?? null;
const paidOnMatter = (rt: ToolRuntime, matterId: string, exceptInvoice?: string): Cents => rt.store.list(INVOICES).filter((r) => r.data.matter_id === matterId && r.id !== exceptInvoice && ["reviewed", "approved", "paid", "claimed"].includes(String(r.data.status))).reduce((s, r) => s + cents(r.data.fee_approved_cents), 0n);
const expectationsOf = (rt: ToolRuntime, loanId?: string | null): DraExpectation[] => rt.store.list(MATTERS, (d) => !loanId || d.loan_id === loanId).flatMap((r) => rows(r.data.expected_dra_events).map((x) => ({ matter_id: r.id, loan_id: String(r.data.loan_id), instruction: String(x.instruction), expected_event: String(x.expected_event), event_date: D(String(x.event_date)), expected_by: D(String(x.expected_by)), matched_on: optDate(x.matched_on) })));

/** Rule 6 reconciliation over the store: matched expectations are closed on the matter; exceptions open the firm-call task and flag the loan's 13.5 credits "DRA unverified". */
function reconcileStore(rt: ToolRuntime, ctx: CommandContext, draRows: readonly DraRow[], today: PlainDate, loanId?: string | null): { matched: number; exceptions: string[]; escalation_ids: string[] } {
  const r = reconcileDra({ expectations: expectationsOf(rt, loanId), dra_rows: draRows, today });
  for (const m of r.matched) { const mr = rt.store.require(MATTERS, m.matter_id); put(rt, ctx, MATTERS, m.matter_id, { expected_dra_events: rows(mr.data.expected_dra_events).map((x) => (x.expected_event === m.expected_event && !x.matched_on ? { ...x, matched_on: today, dra_event_date: m.dra_event_date, difference_days: m.difference_days } : x)) });
    for (const ex of rt.store.list(DRA_EXCEPTIONS, (d) => d.matter_id === m.matter_id && d.expected_event === m.expected_event && !d.resolved_at)) { put(rt, ctx, DRA_EXCEPTIONS, ex.id, { resolved_at: ctx.now, found: true, difference_days: m.difference_days }); ctx.events.append({ type: "dra.exception.resolved", loanId: m.loan_id, actor: ctx.actor, payload: { matter_id: m.matter_id, expected_event: m.expected_event, resolved_on: today, dra_event_date: m.dra_event_date } }); } }
  const ids: string[] = []; const alreadyOpen = new Set<string>();
  for (const x of r.exceptions) { const id = `${x.matter_id}:${x.expected_event}:${x.expected_by}`; const existing = rt.store.get(DRA_EXCEPTIONS, id); if (existing && !existing.data.resolved_at) { alreadyOpen.add(`${x.matter_id}:${x.expected_event}`); continue; }   // an open exception is not raised twice per import
    put(rt, ctx, DRA_EXCEPTIONS, id, { matter_id: x.matter_id, loan_id: x.loan_id, case_id: rt.store.get(MATTERS, x.matter_id)?.data.case_id ?? null, expected_event: x.expected_event, expected_by: x.expected_by, found: x.found, difference_days: x.difference_days, reason: x.reason, raised_at: ctx.now, resolved_at: null, credit_status: "DRA unverified" }); ids.push(id);
    for (const c of rt.store.list(CREDITS, (d) => d.loan_id === x.loan_id || d.case_id === x.matter_id)) put(rt, ctx, CREDITS, c.id, { dra_verified: false, dra_status: "DRA unverified", dra_exception_id: id }); }
  const fresh = (matterId: string, event: string) => !alreadyOpen.has(`${matterId}:${event}`);
  emitAll(ctx, r.events.filter((e) => e.type !== "dra.exception.raised" || fresh(String(e.payload.matter_id), String(e.payload.expected_event))));
  const escalationIds = r.escalations.filter((e) => fresh(e.matter_id, String(e.escalation.reason.match(/no "([^"]+)"/)?.[1] ?? ""))).map((e) => openAll(rt, ctx, [e.escalation], { task: "firm_call", matter_id: e.matter_id, credit_status: "DRA unverified", rule_set_version: RULE_SET_VERSION_13_6 }, e.loan_id)[0]!);
  return { matched: r.matched.length, exceptions: ids, escalation_ids: escalationIds };
}

export const attorneyMessageHandler136 = compute((i, ctx, rt) => {
  const kind = str(i, "kind") || "message"; const loanId = str(i, "loan_id") || ctx.loanId || null; const today = at(i, "at", ctx);
  if (kind === "message") { need(i, "firm_id", "subject"); return ctx.events.append({ type: "attorney.message.sent", ...(loanId ? { loanId } : {}), actor: ctx.actor, payload: { firm_id: str(i, "firm_id"), subject: str(i, "subject"), ...(flag(i, "form200_certification") ? { form200_certification: true, certified_by: `${ctx.actor.kind}:${ctx.actor.id}` } : {}) } }); }
  switch (kind) {
    // ---- selection and retention (A4-2.2-01, F-2-04)
    case "firm_candidate": { need(i, "firm_id", "legal_name"); const r = firmCandidateCreated({ firm_id: str(i, "firm_id"), legal_name: str(i, "legal_name"), offices: list(i.offices), created_on: today }); const row = put(rt, ctx, FIRMS, str(i, "firm_id"), r.row); emitAll(ctx, r.events); return row; }
    case "due_diligence": { const f = firmRow(rt, str(i, "firm_id")); need(i, "annual_foreclosures", "eo_per_occurrence_cents", "eo_aggregate_cents");
      const r = dueDiligenceCompleted({ firm_id: f.id, annual_foreclosures: Number(i.annual_foreclosures), eo_per_occurrence_cents: cents(i.eo_per_occurrence_cents), eo_aggregate_cents: cents(i.eo_aggregate_cents), eo_expires_on: optDate(i.eo_expires_on), ...(i.qualifying_attorneys !== undefined ? { qualifying_attorneys: Number(i.qualifying_attorneys) } : {}), completed_on: today });
      const row = put(rt, ctx, FIRMS, f.id, { ...r.row, ...(r.passed ? {} : { selection_decided_on: today, selection_decision: "rejected" }) }); emitAll(ctx, r.events); return { ...row, passed: r.passed, tier: r.tier, failing: r.failing }; }
    case "form200_submit": { const f = firmRow(rt, str(i, "firm_id")); need(i, "state", "package_document_id"); const dd = (f.due_diligence as Row | undefined) ?? null;
      const r = form200Submitted({ firm_id: f.id, state: str(i, "state"), due_diligence_passed: dd?.passed === true, submitted_on: today, package_document_id: str(i, "package_document_id"), certified_by: `${ctx.actor.kind}:${ctx.actor.id}${ctx.actor.role ? ` (${ctx.actor.role})` : ""}` });
      const row = put(rt, ctx, RETENTIONS, retentionId(f.id, str(i, "state")), r.row); put(rt, ctx, FIRMS, f.id, { status: "form200_pending" }); emitAll(ctx, r.events); return { ...row, expectation_due: r.expectation_due, timer: "FNMA_A4201_FORM200_RESPONSE_15BD" }; }
    case "form200_response": { const f = firmRow(rt, str(i, "firm_id")); need(i, "state", "response"); const ret = requireRetention(rt, f.id, str(i, "state"));
      const r = form200Responded({ firm_id: f.id, state: str(i, "state"), submitted_on: D(String(ret.form200_submitted_at)), response: str(i, "response") as Form200Response, responded_on: today, note: optStr(i, "note") });
      const row = put(rt, ctx, RETENTIONS, retentionId(f.id, str(i, "state")), r.row); put(rt, ctx, FIRMS, f.id, { status: r.row.status, ...(r.row.status === "rejected" ? { selection_decided_on: today, selection_decision: "rejected" } : {}) }); emitAll(ctx, r.events); return { ...row, on_time: r.on_time }; }
    case "training_completed": { const f = firmRow(rt, str(i, "firm_id")); need(i, "state"); requireRetention(rt, f.id, str(i, "state")); const r = trainingCompleted({ firm_id: f.id, state: str(i, "state"), completed_on: today }); const row = put(rt, ctx, RETENTIONS, retentionId(f.id, str(i, "state")), r.row); emitAll(ctx, r.events); return row; }
    case "lra_executed": { const f = firmRow(rt, str(i, "firm_id")); need(i, "state", "document_id"); requireRetention(rt, f.id, str(i, "state")); const r = lraExecuted({ firm_id: f.id, state: str(i, "state"), executed_on: today, document_id: str(i, "document_id") }); const row = put(rt, ctx, RETENTIONS, retentionId(f.id, str(i, "state")), r.row); emitAll(ctx, r.events); return row; }
    case "retain": { const f = firmRow(rt, str(i, "firm_id")); need(i, "state"); const ret = requireRetention(rt, f.id, str(i, "state"));
      const r = firmRetained({ firm_id: f.id, state: str(i, "state"), submitted_on: D(String(ret.form200_submitted_at)), response: (ret.form200_response as Form200Response | null) ?? null, training_completed_on: optDate(ret.training_completed_at), lra_executed_on: optDate(ret.lra_executed_at), eo_expires_on: optDate(f.eo_expires_on), retained_from: today, ...(str(i, "risk_band") ? { risk_band: str(i, "risk_band") as "low" | "medium" | "high" } : {}) });
      const row = put(rt, ctx, RETENTIONS, retentionId(f.id, str(i, "state")), r.row); put(rt, ctx, FIRMS, f.id, { status: "retained", selection_decided_on: today, selection_decision: "retained", next_review_due: r.review_due }); emitAll(ctx, r.events); return { ...row, review_due: r.review_due }; }
    case "eo_policy": { const f = firmRow(rt, str(i, "firm_id")); need(i, "per_occurrence_cents", "aggregate_cents", "expires_on", "certificate_document_id");
      const r = eoPolicyRecorded({ firm_id: f.id, annual_foreclosures: Number(i.annual_foreclosures ?? f.annual_foreclosures ?? 0), per_occurrence_cents: cents(i.per_occurrence_cents), aggregate_cents: cents(i.aggregate_cents), expires_on: date(i, "expires_on"), recorded_on: today, previous_expires_on: optDate(f.eo_expires_on), certificate_document_id: str(i, "certificate_document_id") });
      const row = put(rt, ctx, FIRMS, f.id, r.row); emitAll(ctx, r.events); return { ...row, tier: r.tier, warn_on: r.warn_on, timer: "SM_FIRM_EO_EXPIRY_30" }; }
    // ---- matters
    case "refer": { const f = firmRow(rt, str(i, "firm_id")); need(i, "matter_id", "state", "case_id"); if (!loanId) throw new RangeError("loan_id is required"); const state = str(i, "state").toUpperCase();
      const r = matterReferred({ matter_id: str(i, "matter_id"), loan_id: loanId, case_id: str(i, "case_id"), firm_id: f.id, state, kind: (str(i, "matter_kind") || "foreclosure") as MatterKind, referred_on: today });
      emitAll(ctx, [r.events[0]!]);   // the referral command — the gate is asserted on the store's facts
      const facts = retentionFacts({ firm_status: (f.status as string | undefined) ?? null, retention: retentionRow(rt, f.id, state), eo_expires_on: optDate(f.eo_expires_on), today });
      const g = evaluateGate("13.6.firmRetainedAndCurrent", facts);
      if (!g.open) refuseGate(ctx, "attorney.message.send:refer", "FNMA_A4201_RETAINED_FIRM_GATE", `referral to ${f.id} (${state}) refused — ${g.reason} (A4-2.2-01; reimbursement denial risk)`, { firm_id: f.id, state, facts, evaluator: "13.6.firmRetainedAndCurrent" }, loanId);
      assertGate("13.6.firmRetainedAndCurrent", facts);
      const row = put(rt, ctx, MATTERS, str(i, "matter_id"), r.row); emitAll(ctx, r.events.slice(1)); return { ...row, ack_due: r.ack_due, facts, gate: "FNMA_A4201_RETAINED_FIRM_GATE" }; }
    case "firm_ack": { const m = matterRow(rt, i); const r = matterAcknowledged({ matter: m, acknowledged_on: today, ack_complete: i.ack_complete !== false, ...(i.seq !== undefined ? { seq: Number(i.seq) } : {}) }); const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); emitAll(ctx, r.events); return { ...row, on_time: r.on_time }; }
    case "instruction_ack": { const m = matterRow(rt, i); need(i, "instruction"); const r = instructionAcknowledged({ matter: m, instruction: str(i, "instruction"), acknowledged_on: today, ...(i.seq !== undefined ? { seq: Number(i.seq) } : {}) }); const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); emitAll(ctx, r.events); return { ...row, expected_dra_event: r.expected_dra_event, expected_by: r.expected_by, timer: r.expected_dra_event ? "SM_DRA_EVENT_EXPECTED_2BD" : null }; }
    case "matter_completed": { const m = matterRow(rt, i); need(i, "outcome"); const r = matterCompleted({ matter: m, outcome: str(i, "outcome") as ClaimMilestone, completed_on: today, confirmation_completed: flag(i, "confirmation_completed") }); const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); emitAll(ctx, r.events); return { ...row, claim_due: r.claim_due, timer: "FNMA_F105_EXPENSE_CLAIM_60" }; }
    case "claim_filed": { const m = matterRow(rt, i); need(i, "claim_id"); const r = claimFiled({ matter: m, claim_id: str(i, "claim_id"), filed_on: today, claimable_cents: money(i.claimable_cents) ?? rt.store.list(INVOICES, (d) => d.matter_id === m.matter_id && d.status === "paid").reduce((s, x) => s + cents(x.data.claimable_cents), 0n) }); const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); for (const inv of rt.store.list(INVOICES, (d) => d.matter_id === m.matter_id && d.status === "paid")) put(rt, ctx, INVOICES, inv.id, { status: "claimed", claim_id: str(i, "claim_id") }); emitAll(ctx, r.events); return { ...row, on_time: r.on_time }; }
    // ---- oversight (A4-2.2-02)
    case "review_completed": { const f = firmRow(rt, str(i, "firm_id")); need(i, "review_id", "review_kind");
      const r = reviewCompleted({ firm_id: f.id, review_id: str(i, "review_id"), kind: str(i, "review_kind") as ReviewKind, completed_on: today, elements: (i.elements as Row | undefined) ?? {}, findings: list(i.findings), remediation_plan_document_id: optStr(i, "remediation_plan_document_id"), fnma_requested: flag(i, "fnma_requested") });
      const row = put(rt, ctx, REVIEWS, str(i, "review_id"), r.row); put(rt, ctx, FIRMS, f.id, { last_review_id: str(i, "review_id"), last_review_on: today, next_review_due: r.next_review_due }); emitAll(ctx, r.events); return { ...row, next_review_due: r.next_review_due }; }
    case "scorecard": { const f = firmRow(rt, str(i, "firm_id")); need(i, "state", "month", "band"); const id = `${f.id}:${str(i, "state").toUpperCase()}`; const prior = rows(rt.store.get(SCORECARDS, id)?.data.history) as { month: string; band: "top" | "middle" | "bottom" }[];
      const r = scorecardPublished({ firm_id: f.id, state: str(i, "state"), month: str(i, "month"), band: str(i, "band") as "top" | "middle" | "bottom", history: prior, published_on: today, metrics: (i.metrics as Row | undefined) ?? {} });
      const row = put(rt, ctx, SCORECARDS, id, r.row); const escalationIds = openAll(rt, ctx, r.escalations, { firm_id: f.id, state: str(i, "state").toUpperCase(), month: str(i, "month"), review: "risk_triggered" });
      if (r.review_triggered) { const sched = r.events.find((e) => e.type === "firm.review.scheduled")!; put(rt, ctx, REVIEWS, `${f.id}:risk:${str(i, "month")}`, { firm_id: f.id, kind: "risk_triggered", scheduled_for: sched.payload.scheduled_for, completed_at: null, elements: {}, findings: [], reason: sched.payload.reason }); }
      emitAll(ctx, r.events); return { ...row, review_triggered: r.review_triggered, review: r.review_triggered ? { kind: "risk_triggered", scheduled: true } : null, escalation_ids: escalationIds }; }
    case "escalation_discovered": { const f = firmRow(rt, str(i, "firm_id")); need(i, "escalation_id", "category");
      const r = escalationDiscovered({ escalation_id: str(i, "escalation_id"), firm_id: f.id, category: str(i, "category") as EscalationCategory, discovered_on: date(i, "discovered_on"), pocs: list(i.pocs), litigation: flag(i, "litigation"), ...(optStr(i, "description") ? { description: str(i, "description") } : {}) });
      const row = put(rt, ctx, ESCALATIONS, str(i, "escalation_id"), r.row); emitAll(ctx, r.events); return { ...row, message_id_proposed: r.message_id, timer: "FNMA_A4202_FIRM_ESCALATION_2BD" }; }
    case "escalation_sent": { const e = escalationRow(rt, i); const r = escalationSent({ escalation: e, sent_on: today, message_id: optStr(i, "message_id"), pocs: list(i.pocs) }); const row = put(rt, ctx, ESCALATIONS, String(e.escalation_id), r.row); emitAll(ctx, r.events); return { ...row, on_time: r.on_time }; }
    // ---- suspensions, transfers, terminations (A4-2.2-04, E-1.1-01)
    case "suspension_proposed": { const f = firmRow(rt, str(i, "firm_id")); need(i, "reason", "package_document_id"); const r = suspensionProposed({ firm_id: f.id, proposed_on: today, reason: str(i, "reason"), package_document_id: str(i, "package_document_id") }); const row = put(rt, ctx, FIRMS, f.id, r.row); const ids = openAll(rt, ctx, r.escalations, { firm_id: f.id, package_document_id: str(i, "package_document_id") }); emitAll(ctx, r.events); return { ...row, escalation_ids: ids, gate: "FNMA_A4204_SUSPENSION_NOTICE_5BD" }; }
    case "fnma_notified": { const f = firmRow(rt, str(i, "firm_id")); need(i, "notice_kind");
      const r = fnmaNotified({ firm_id: f.id, kind: str(i, "notice_kind") as FnmaNoticeKind, notified_on: today, plan_document_id: optStr(i, "plan_document_id"), lane: optStr(i, "lane"), message_id: optStr(i, "message_id") });
      const s = (f.suspension as Row | undefined) ?? null; const row = put(rt, ctx, FIRMS, f.id, { ...r.row, ...(s && str(i, "notice_kind") === "firm_suspension" ? { suspension: { ...s, fnma_notified_on: today, plan_attached: Boolean(optStr(i, "plan_document_id")), plan_document_id: optStr(i, "plan_document_id") } } : {}), ...(str(i, "notice_kind") === "bulk_matter_transfer" ? { lane_notices: { ...((f.lane_notices as Row | undefined) ?? {}), [str(i, "lane")]: today } } : {}) });
      emitAll(ctx, r.events); return { ...row, earliest_implementation: r.earliest_implementation }; }
    case "suspension_implement": { const f = firmRow(rt, str(i, "firm_id")); const r = suspensionImplemented({ firm_id: f.id, suspension: (f.suspension as Row | undefined) ?? null, implement_on: today });
      if (!r.allowed) refuseGate(ctx, "attorney.message.send:suspension_implement", r.gate, r.refusal!, { firm_id: f.id, earliest: r.earliest });
      const row = put(rt, ctx, FIRMS, f.id, r.row); emitAll(ctx, r.events); return { ...row, allowed: true, earliest: r.earliest, gate: r.gate }; }
    case "matter_transfer_requested": { const m = matterRow(rt, i); need(i, "to_firm", "reason"); firmRow(rt, str(i, "to_firm")); const lane = `${String(m.firm_id)}>${str(i, "to_firm")}:${String(m.state).toUpperCase()}`;
      const prior = rt.store.list(MATTERS, (d) => d.transfer_lane === lane && d.matter_id !== m.matter_id && typeof d.transfer_requested_on === "string").map((r) => D(String(r.data.transfer_requested_on)));
      const r = matterTransferRequested({ matter: m, to_firm: str(i, "to_firm"), requested_on: today, reason: str(i, "reason"), prior_lane_transfers_on: prior, sale_held: m.sale_held === true || flag(i, "sale_held") });
      const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); const ids = openAll(rt, ctx, r.escalations, { matter_id: m.matter_id, lane: r.lane }, String(m.loan_id)); emitAll(ctx, r.events);
      return { ...row, lane: r.lane, transfers_in_6m: r.transfers_in_6m, bulk_threshold_reached: r.bulk_threshold_reached, post_sale: r.post_sale, gate: r.post_sale ? "FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE" : r.bulk_threshold_reached ? "FNMA_E1101_BULK_TRANSFER_NOTICE_5BD" : null, escalation_ids: ids }; }
    case "transfer_approval": { const m = matterRow(rt, i); need(i, "document_id"); const r = transferApprovalRecorded({ matter: m, document_id: str(i, "document_id"), granted_on: today }); const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); emitAll(ctx, r.events); return row; }
    case "matter_transfer": { const m = matterRow(rt, i); need(i, "new_matter_id"); const t = (m.transfer as Row | undefined) ?? null; if (!t) throw new RangeError(`no transfer requested for matter ${String(m.matter_id)}`);
      const from = firmRow(rt, String(m.firm_id)); const laneNotice = optDate(((from.lane_notices as Row | undefined) ?? {})[String(t.lane)]);
      if (t.post_sale === true) assertGate("13.6.fannieMaePriorApproval", { fnma_approval_document_id: t.fnma_approval_document_id ?? "" });
      const sched = scheduleFor(rt, String(m.state).toUpperCase(), String(m.kind) === "foreclosure" ? String(m.method ?? "non_judicial") : String(m.method ?? "judicial"), ctx.now.slice(0, 10));
      const r = matterTransferred({ matter: m, transfer_on: today, lane_notified_on: laneNotice, allowable_cents: sched ? cents(sched.data.allowable_fee_cents) : null, paid_cents: paidOnMatter(rt, String(m.matter_id)), new_matter_id: str(i, "new_matter_id") });
      if (!r.allowed) refuseGate(ctx, "attorney.message.send:matter_transfer", r.gate!, r.refusal!, { matter_id: m.matter_id, lane: t.lane, earliest: r.earliest }, String(m.loan_id));
      const row = put(rt, ctx, MATTERS, String(m.matter_id), r.row); put(rt, ctx, MATTERS, str(i, "new_matter_id"), r.new_matter); emitAll(ctx, r.events); return { ...row, allowed: true, gate: r.gate, earliest: r.earliest, new_matter_id: str(i, "new_matter_id") }; }
    case "terminate": { const f = firmRow(rt, str(i, "firm_id")); const open = rt.store.list(MATTERS, (d) => d.firm_id === f.id && !["completed", "transferred", "claimed"].includes(String(d.status))).length;
      const r = firmTerminated({ firm_id: f.id, open_matters: open, terminated_on: today, fnma_notified_on: optDate(f.suspension_fnma_notified_on ?? (f.suspension as Row | undefined)?.fnma_notified_on), plan_attached: f.suspension_plan_attached === true || (f.suspension as Row | undefined)?.plan_attached === true });
      const row = put(rt, ctx, FIRMS, f.id, r.row); emitAll(ctx, r.events); return row; }
    case "records_release": { const f = firmRow(rt, str(i, "firm_id")); const decidedOn = optDate(f.selection_decided_on); if (!decidedOn) throw new RangeError(`${f.id} has no selection decision on record`);
      const r = selectionRecordsReleased({ firm_id: f.id, decided_on: decidedOn, decision: String(f.selection_decision ?? f.status), released_on: today, legal_hold: f.legal_hold === true, longer_retention_until: optDate(f.retain_until) });
      const row = put(rt, ctx, FIRMS, f.id, r.row); emitAll(ctx, r.events); return { ...row, eligible_on: r.eligible_on }; }
    default: throw new RangeError(`attorney.message.send kind ${kind} is not one of message/firm_candidate/due_diligence/form200_submit/form200_response/training_completed/lra_executed/retain/eo_policy/refer/firm_ack/instruction_ack/matter_completed/claim_filed/review_completed/scorecard/escalation_discovered/escalation_sent/suspension_proposed/fnma_notified/suspension_implement/matter_transfer_requested/transfer_approval/matter_transfer/terminate/records_release`);
  }
});
export const ATTORNEY_MESSAGE_GUARDRAILS_13_6 = [
  needsRole("FORM200_OFFICER_SUBMITS", "13.6 guardrail: Form 200 certification is the partner officer's (legally the servicer's certification to Fannie Mae)", (i) => str(i, "kind") === "form200_submit", ["officer"], "the agent prepares the due-diligence file and the form; the officer certifies and submits"),
  needsRole("OFFICER_RETAINS", "13.6 state machine: only the partner officer can move a firm to `retained` or `terminated`", (i) => /^(retain|terminate)$/.test(str(i, "kind")), ["officer"], "the agent proposes with the package; the officer decides"),
  needsRole("OFFICER_IMPLEMENTS_SUSPENSION", "13.6 guardrail: suspension/termination decisions are officer decisions with the AI package", (i) => str(i, "kind") === "suspension_implement", ["officer"], "the AI prepares the package; the officer decides"),
  needsRole("TRANSFER_APPROVAL_RECORDED_BY_OFFICER", "13.6 rule 5 / E-1.1-01: Fannie Mae's prior approval of a post-sale transfer is recorded through the partner officer", (i) => str(i, "kind") === "transfer_approval", ["officer"], "the officer transmits the request and records the approval"),
  needsRole("FNMA_DETERMINATION_RECORDED_BY_HUMAN", "13.6 escalations: Form 200 determinations and P360 claims are the fnma_portal_operator's (or officer's) own records", (i) => /^(form200_response|claim_filed)$/.test(str(i, "kind")), ["fnma_portal_operator", "officer"], "the agent never records a Fannie Mae determination it did not receive"),
  never("NO_SERVICER_SPECIFIED_VENDORS", "13.6 A4-2.2-03: the servicer cannot directly or indirectly require or encourage law firms to use specified vendors, nor charge outsourcing/referral/packaging fees", (i) => flag(i, "require_vendor") || typeof i.required_vendor === "string" || (money(i.referral_fee_cents) ?? 0n) > 0n || (money(i.packaging_fee_cents) ?? 0n) > 0n, "firms choose their vendors; no fee may be charged to a firm"),
] as const;

/** E-5-05 rules engine + the invoice lifecycle: `op` review (default) / received / pay. */
export const invoiceReviewHandler136 = compute((i, ctx, rt) => {
  const op = str(i, "op") || "review"; const today = at(i, "at", ctx);
  if (op === "received") { const m = matterRow(rt, i); need(i, "invoice_id"); const r = invoiceReceived({ invoice_id: str(i, "invoice_id"), matter: m, received_on: today, period: optStr(i, "period"), lines: rows(i.lines).map((l) => ({ ...l, amount_cents: money(l.amount_cents) })), ...(i.seq !== undefined ? { seq: Number(i.seq) } : {}) }); const row = put(rt, ctx, INVOICES, str(i, "invoice_id"), r.row); emitAll(ctx, r.events); return { ...row, review_due: r.review_due, timer: "SM_INVOICE_REVIEW_10BD" }; }
  if (op === "pay") { need(i, "invoice_id", "payment_ref"); const inv = rt.store.get(INVOICES, str(i, "invoice_id")); if (!inv) throw new RangeError(`no ${INVOICES} ${str(i, "invoice_id")}`);
    const holds = rt.store.list(DRA_EXCEPTIONS, (d) => d.matter_id === inv.data.matter_id && !d.resolved_at && d.expected_event === String(inv.data.dra_event ?? "")).length > 0;
    const r = invoicePaid({ invoice: { ...inv.data, invoice_id: inv.id }, paid_on: today, paid_cents: money(i.paid_cents) ?? cents(inv.data.fee_approved_cents) + cents(inv.data.costs_approved_cents) + cents(inv.data.tech_fee_approved_cents), payment_ref: str(i, "payment_ref"), dra_hold: holds && !flag(i, "milestone_evidenced") });
    const row = put(rt, ctx, INVOICES, inv.id, r.row);
    // Ledger (Outputs): attorney fees/costs paid → corporate advance (expense-claim eligible, borrower-chargeable per 2.7); technology fees → corporate advance {tech_fee}; paid from corporate cash.
    if (r.advance.loan_id) { const lines = [{ account: { scope: "loan" as const, loanId: r.advance.loan_id, account: "corporate_advance" as const }, amountCents: r.advance.claim_eligible_cents, ruleRef: "13.6.E-5-05.pay_firm", memo: `attorney fees/costs invoice ${inv.id} (expense_claim_eligible; borrower_chargeable ${r.advance.borrower_chargeable_cents})` }, ...(r.advance.tech_fee_cents > 0n ? [{ account: { scope: "loan" as const, loanId: r.advance.loan_id, account: "corporate_advance" as const }, amountCents: r.advance.tech_fee_cents, ruleRef: "13.6.E-5-06.tech_fee", memo: `technology fee invoice ${inv.id} (tech_fee; never borrower-chargeable)` }] : []), { account: { scope: "corporate" as const, account: "corporate_cash" as const }, amountCents: -(r.advance.claim_eligible_cents + r.advance.tech_fee_cents), ruleRef: "13.6.E-5-05.pay_firm", memo: `Nacha CCD ${str(i, "payment_ref")} to ${String(inv.data.firm_id)}` }];
      ctx.ledger.post({ effectiveDate: today, description: `law-firm invoice ${inv.id} paid (E-5-05)`, lines }); }
    emitAll(ctx, r.events); return { ...row, advance: r.advance }; }
  if (op !== "review") throw new RangeError(`invoice.review op ${op} is not one of review/received/pay`);
  need(i, "invoice_id", "matter_id", "state", "method", "milestone"); const method = str(i, "method") as FirmMethod; const state = str(i, "state").toUpperCase();
  // Rule 3: the fee basis is the matter's state/method schedule (attorney_fee_schedules) and the matter's paid history (attorney_invoices) — never the caller's figures; an officer override travels in `changes` (moneyFields).
  const schedule = scheduleFor(rt, state, method, ctx.now.slice(0, 10)); const overrides = (i.changes as Row | undefined) ?? {};
  const allowableCents = overrides.allowable_cents !== undefined ? cents(overrides.allowable_cents) : schedule ? cents(schedule.data.allowable_fee_cents) : null;
  if (allowableCents === null) throw new RangeError(`no attorney_fee_schedules row for ${state}/${method} — load the Allowable Foreclosure Attorney Fees Exhibit before reviewing invoices (E-5-04)`);
  const previouslyPaid = overrides.previously_paid_cents !== undefined ? cents(overrides.previously_paid_cents) : paidOnMatter(rt, str(i, "matter_id"), str(i, "invoice_id"));
  const r = reviewInvoice({ method, milestone: str(i, "milestone"), allowable_cents: allowableCents, previously_paid_cents: previouslyPaid, costs: (i.costs as { kind: string; cents: bigint; receipt: boolean }[] | undefined) ?? [], ...(i.tech_fee_cents !== undefined ? { tech_fee_cents: cents(i.tech_fee_cents) } : {}), ...(i.fee_invoiced_cents !== undefined ? { fee_invoiced_cents: cents(i.fee_invoiced_cents) } : {}), continuance_caused_by_servicer: flag(i, "continuance_caused_by_servicer"), confirmation: (str(i, "confirmation") || "pending") as Confirmation });
  const prior = rt.store.get(INVOICES, str(i, "invoice_id"))?.data ?? {}; const matter = rt.store.get(MATTERS, str(i, "matter_id"))?.data ?? {};
  const reviewResult = r.rejected.length === 0 ? "approved" : r.fee_approved_cents > 0n || r.costs_approved_cents > 0n || r.tech_fee_approved_cents > 0n ? "partially_approved" : "rejected";
  const rec = rt.store.put(INVOICES, str(i, "invoice_id"), { ...r, matter_id: str(i, "matter_id"), loan_id: prior.loan_id ?? matter.loan_id ?? (i.loan_id as string | undefined) ?? ctx.loanId ?? null, firm_id: prior.firm_id ?? matter.firm_id ?? null, state, method, milestone: str(i, "milestone"), allowable_cents: allowableCents, previously_paid_cents: previouslyPaid, fee_schedule_id: schedule?.id ?? null, exhibit_version: schedule?.data.exhibit_version ?? null, reviewed_at: today, status: "reviewed", review_result: reviewResult, borrower_chargeable_cents: r.fee_approved_cents + r.costs_approved_cents, borrower_chargeable_tech_fee_cents: 0n, rule_set_version: RULE_SET_VERSION_13_6 }, ctx.actor, ctx.now);
  const out = invoiceReviewOutcome({ invoice_id: rec.id, loan_id: typeof rec.data.loan_id === "string" ? rec.data.loan_id : null, matter_id: str(i, "matter_id"), reviewed_on: today, review_result: reviewResult, fee_approved_cents: r.fee_approved_cents, costs_approved_cents: r.costs_approved_cents, tech_fee_approved_cents: r.tech_fee_approved_cents, rejected: r.rejected.length, cites: r.cites });
  emitAll(ctx, out.events); return { ...rec.data, approved_cents: out.approved_cents, pay_by: out.pay_by };
});

/** The fnma_portal_operator's daily DRA export (read-only; no scraping): rows into dra_snapshots / dra_events, then rule-6 reconciliation. */
export const draSnapshotImportHandler136 = compute((i, ctx, rt) => {
  need(i, "firm_id", "as_of"); const asOf = date(i, "as_of"); const id = str(i, "id") || `dra-${str(i, "firm_id")}-${str(i, "as_of")}`;
  const r = draSnapshotImported({ snapshot_id: id, firm_id: optStr(i, "firm_id"), as_of: asOf, source: (str(i, "source") || "portal_export") as "portal_export" | "manual", rows: rows(i.rows) });
  const row = put(rt, ctx, SNAPSHOTS, id, { ...r.row, rows: r.dra_rows });
  r.dra_rows.forEach((d, n) => put(rt, ctx, DRA_EVENTS, `${id}:${n}`, { snapshot_id: id, ...d, imported_at: ctx.now, source: r.row.source }));
  emitAll(ctx, r.events);
  // SM_DRA_RECONCILE_DAILY: the first import arms the daily clock (global subject, next servicer business day 07:00 ET); each later import satisfies it and the engine re-arms the recurring row.
  if (!ctx.timers.byCode("SM_DRA_RECONCILE_DAILY").some((t) => t.status === "armed")) { const imported = ctx.events.ofType("dra.snapshot.imported").at(-1); if (imported) ctx.timers.arm(registryDef136("SM_DRA_RECONCILE_DAILY"), imported, { subjectOverride: { kind: "global", id: "*" } }); }
  const all = rt.store.list(DRA_EVENTS).map((e) => ({ loan_id: String(e.data.loan_id), event_name: String(e.data.event_name), event_date: D(String(e.data.event_date)), entered_by_firm: typeof e.data.entered_by_firm === "string" ? e.data.entered_by_firm : null }));
  const recon = reconcileStore(rt, ctx, all, at(i, "today", ctx), optStr(i, "loan_id"));   // the export covers every matter unless one loan is named
  return { ...row, reconciliation: recon };
});

export const TOOLS_13_6: readonly ToolDef[] = [];
