/**
 * §15.1 tools — REOgram / conveyance to Fannie Mae (`claims-reo`). Every tool string is the
 * spec's verbatim, via `defineTools("15.1", "claims-reo", defs)` from ../tools.ts (see section13.ts).
 * Guardrails encode the Agents paragraph: never confirm a REOgram without the resale-restriction
 * gate and the MI data check — evaluated on the records (`properties.resale_restriction`, `mi_policies`,
 * the built package), refused by omission and on any conflict with the caller's facts; never remit more
 * than `amount_due_fnma` — the cap is the F-1-20 figure persisted on `tps_cases`, never the caller's number;
 * never order preservation after the sale for Fannie Mae-acquired property (`scheduleHandoffTasks{op=order_preservation}`);
 * confidence < 0.9 on purchaser type, bid amount or vesting date → hold and escalate (`human_agent`)
 * before deadline − 4 h. Portal work is opened as `human_portal_task` escalations and completed
 * through `openPortalTask{op=complete}`, which hashes the evidence capture into `documents`, emits
 * `human_portal_task.completed{task=…}` and the task's own event (`reogram.confirmed`,
 * `reogram.exception.resolved`, `elimination_rescission.request.submitted`) so the timer rows can move.
 * Section 13 emits no sale event: the post-sale clocks are armed by this process's own
 * `reo.case.opened` / `tps.case.opened`, the receipts it records (`tps.proceeds.received`) and the
 * remittances it settles (`remittance.special.settled{code, kind}`). Spread by ./section15.ts.
 */
import { createHash } from "node:crypto";
import { defineTools, compute, decision, guard, never, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { LiquidationKind, InsuredFlag } from "../../domain/investor/liquidation.ts";
import type { ChannelMode } from "../../domain/investor/types.ts";
import { larCode, caseKind, thirdPartySale, confirmDueAt, rescissionClocks, type Purchaser } from "../../domain/reo/reogram.ts";
import {
  reogramPackage, reogramConfirmGate, gateFactsFromRecords, confidenceHold, parseP360Notification, handoffTasks, requestedDocumentsDue, handoffCompletionEvent, carrierRefusal, crsBatchLines, closingStatement, surplusDisposition,
  eliminationTemplate, recoveryWaterfall, spreadInterest, postSalePreservationAllowed, postSalePreservationOrder, tenantIdentified, deedRecordDueRolled, failedThirdPartySale, tpsProceedsReceipt, tpsProceedsLedgerSets, compFeeExposure, matchCode313Draft, proposeExceptionCorrection,
  liquidationRail, rescissionReactivation,
  type AdvanceItem, type RescissionReason, type HandoffKind, type ForeclosedInNameOf, type SurplusDisposition,
} from "../../domain/reo/ops-15-1.ts";

const ET = "America/New_York";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id !== "" ? i.loan_id : ctx.loanId);
const rowCents = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : cents(v));
const AGENT = "claims-reo";
const ACQUISITION_TYPES = ["fcl_sale", "mortgage_release", "court_order", "redemption_expired"] as const;
const IN_NAME_OF = ["fnma", "servicer", "mers_assignee"] as const;
const GATE_CITATION = "15.1 guardrail: never confirm a REOgram without the resale-restriction gate and MI data check (E-4.1-01 representation; rule 4 `assertGateOpen(loanId, 'SM_RESALE_RESTRICTION_NOTICES')` on `properties.resale_restriction` / `mi_policies`)";
const CAP_CITATION = "15.1 guardrail: never remit more than `amount_due_fnma` (F-1-20; surplus is distributed per applicable law, never to Fannie Mae)";
/** Escalation kind for a domain escalation target (the `fnma_portal_operator` role is reached through a `human_portal_task`). */
const escKind = (k: "officer" | "attorney" | "fnma_portal_operator" | "human_agent"): EscalationKind => (k === "fnma_portal_operator" ? "human_portal_task" : k);
/** The facts the caller supplies for the confirmation gate: an explicit `facts` bag, else the package fields, else the flat input (the guardrail's first line — refused by omission). */
const suppliedFacts = (i: ToolInput): Record<string, unknown> => (i.facts as Record<string, unknown> | undefined) ?? (i.package as Record<string, unknown> | undefined) ?? i;
/** A handler-level refusal with a typed code: the same `command.refused` audit row the bus writes for a guardrail, then the typed error. */
function refuse(ctx: CommandContext, command: string, code: string, citation: string, reason: string): never {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation, reason, subject_id: null } });
  throw new CommandRefused(command, code, citation, reason);
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Spec Integrations: evidence captures and generated statements are hashed into `documents` (retention life_of_loan_plus_4y). */
function documentRow(rt: ToolRuntime, ctx: CommandContext, id: string, kind: string, loanId: string, content: string | null, metadata: Record<string, unknown>): { id: string; sha256: string } {
  const body = content ?? JSON.stringify({ id, kind, loan_id: loanId, ...metadata, captured_at: ctx.now });
  const hash = sha256(body);
  rt.store.put("documents", id, { loan_id: loanId, kind, sha256: hash, byte_size: Buffer.byteLength(body), storage_uri: `store://documents/${id}`, mime_type: content === null ? "application/json" : (metadata.mime_type as string | undefined) ?? "application/octet-stream", retention_class: "life_of_loan_plus_4y", hash_of: content === null ? "descriptor" : "content", metadata }, ctx.actor, ctx.now);
  return { id, sha256: hash };
}

/** Rule 4: the gate's facts come from the records — the loan's `properties` row, its `mi_policies` row and the built package — with the caller's facts only filling what the records do not hold. */
function storedGateFacts(rt: ToolRuntime, loanId: string, i: ToolInput): { facts: Record<string, unknown>; sources: readonly string[]; conflicts: readonly string[] } {
  const reoCase = (optStr(i, "reo_case_id") ? rt.store.get("reo_cases", str(i, "reo_case_id"))?.data : undefined) ?? rt.store.list("reo_cases", (d) => d.loan_id === loanId)[0]?.data ?? null;
  const propertyId = typeof reoCase?.property_id === "string" ? reoCase.property_id : optStr(i, "property_id");
  const property = (propertyId ? rt.store.get("properties", propertyId)?.data : undefined) ?? rt.store.list("properties", (d) => d.loan_id === loanId)[0]?.data ?? null;
  const miId = typeof reoCase?.mi_policy_id === "string" ? reoCase.mi_policy_id : optStr(i, "mi_policy_id");
  const mi = (miId ? rt.store.get("mi_policies", miId)?.data : undefined) ?? rt.store.get("mi_policies", loanId)?.data ?? rt.store.list("mi_policies", (d) => d.loan_id === loanId)[0]?.data ?? null;
  const rcRows = [optStr(i, "p360_case_id") ? rt.store.get("reogram_confirmations", `rc-${str(i, "p360_case_id")}`)?.data : undefined, rt.store.get("reogram_confirmations", optStr(i, "reogram_confirmation_id") ?? `rc-${loanId}`)?.data, ...rt.store.list("reogram_confirmations", (d) => d.loan_id === loanId).map((r) => r.data)];
  const pkg = (rcRows.find((r) => r && typeof r.package === "object" && r.package !== null)?.package as Record<string, unknown> | undefined) ?? null;
  return gateFactsFromRecords({ supplied: suppliedFacts(i), property, mi_policy: mi, package: pkg });
}
/** The confirmation gate on the records; refuses with the guardrail's own code when closed or when the caller's facts contradict the records. */
function assertConfirmGateOpen(rt: ToolRuntime, ctx: CommandContext, command: string, loanId: string, i: ToolInput): { gates_checked: readonly string[]; sources: readonly string[] } {
  const facts = storedGateFacts(rt, loanId, i);
  if (facts.conflicts.length) refuse(ctx, command, "REOGRAM_CONFIRM_GATES", GATE_CITATION, `supplied facts contradict the records (${facts.conflicts.join("; ")}) — the gate is evaluated on properties.resale_restriction / mi_policies, not on the caller's facts`);
  const g = reogramConfirmGate(facts.facts);
  if (!g.open) refuse(ctx, command, "REOGRAM_CONFIRM_GATES", GATE_CITATION, `${g.reason} — resolve before the confirmation task (gates: ${g.gates_checked.join(", ")}; sources: ${facts.sources.join(", ") || "caller"})`);
  return { gates_checked: g.gates_checked, sources: facts.sources };
}
/** Rule 11: `confirm_due_at` is the stored clock (parseP360Notification / buildReogramPackage) — never a figure the caller has to remember to pass. */
function confirmDueFor(rt: ToolRuntime, task: Record<string, unknown>, loanId: string): string | null {
  if (typeof task.due_at === "string" && task.due_at !== "") return task.due_at;
  const byCase = typeof task.p360_case_id === "string" ? rt.store.get("reogram_confirmations", `rc-${task.p360_case_id}`)?.data : undefined;
  const rc = byCase ?? rt.store.get("reogram_confirmations", `rc-${loanId}`)?.data ?? rt.store.list("reogram_confirmations", (d) => d.loan_id === loanId && typeof d.confirm_due_at === "string")[0]?.data;
  return typeof rc?.confirm_due_at === "string" ? rc.confirm_due_at : null;
}

/** Agents paragraph: a low-confidence act is held and a `human_agent` review is requested at deadline − 4 h; returns the hold when it applies (agents only — a human's own act is never held). */
function holdIfLowConfidence(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, deadlineMs: number, fields: readonly string[], what: string): Record<string, unknown> | null {
  const hold = confidenceHold({ confidence: typeof i.confidence === "number" ? i.confidence : null, deadline_ms: deadlineMs, fields });
  if (!hold.held || ctx.actor.kind === "human" || hold.review === null) return null;
  const e = rt.escalations.open({ kind: "human_agent", severity: "sev2", loanId: loanOf(i, ctx), payload: { reason: `15.1 guardrail: confidence ${String(i.confidence)} < 0.9 on ${fields.join("/")} — ${what} held`, fields, request_at: toIso(hold.review.request_at_ms), deadline_at: toIso(hold.review.deadline_ms), before_deadline_hours: 4 } }, ctx.actor);
  ctx.events.append({ type: "reo.confidence.held", loanId: loanOf(i, ctx), aggregate: { kind: "escalation", id: e.id }, actor: ctx.actor, payload: { what, fields, confidence: i.confidence, request_at: toIso(hold.review.request_at_ms), deadline_at: toIso(hold.review.deadline_ms) } });
  return { held: true, escalation_id: e.id, owner_role: e.ownerRole, review: { ...hold.review, request_at: toIso(hold.review.request_at_ms), deadline_at: toIso(hold.review.deadline_ms) } };
}

/** `openPortalTask{op=complete}`: the operator completes the escalation with the evidence capture (hashed into `documents`); the task's own event follows (rule 11 books the exposure on a late confirmation from the stored `confirm_due_at`). */
function completePortalTask(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "portal_task_id", "evidence_document_id");
  const id = str(i, "portal_task_id"); const evidence = str(i, "evidence_document_id");
  const task = rt.store.require("portal_tasks", id);
  const loanId = String(task.data.loan_id ?? loanOf(i, ctx));
  const taskType = String(task.data.task_type);
  // Rule 4: a confirmation is re-gated on the records at completion — the operator's click never confirms past a closed gate.
  if (taskType === "p360.reogram.confirm") assertConfirmGateOpen(rt, ctx, "openPortalTask", loanId, { ...i, p360_case_id: task.data.p360_case_id ?? null, facts: (task.data.package as Record<string, unknown> | undefined) ?? suppliedFacts(i) });
  rt.escalations.complete(id, ctx.actor, evidence);
  const doc = documentRow(rt, ctx, evidence, "p360_evidence_capture", loanId, optStr(i, "evidence_content"), { task_type: taskType, p360_case_id: task.data.p360_case_id ?? null, portal_task_id: id, operator: ctx.actor.id, mime_type: optStr(i, "evidence_mime_type") ?? "image/png", ...(optStr(i, "evidence_sha256") ? { declared_sha256: str(i, "evidence_sha256") } : {}) });
  rt.store.put("portal_tasks", id, { status: "completed", completed_at: ctx.now, completed_by: ctx.actor.id, evidence_document_id: doc.id, evidence_sha256: doc.sha256 }, ctx.actor, ctx.now);
  ctx.events.append({ type: "human_portal_task.completed", loanId, aggregate: { kind: "escalation", id }, actor: ctx.actor, payload: { task: taskType, evidence_document_id: doc.id, evidence_sha256: doc.sha256, completed_by: ctx.actor.id, p360_case_id: task.data.p360_case_id ?? null } });
  const completedOn = wallClock(Date.parse(ctx.now), ET).date;
  switch (taskType) {
    case "p360.reogram.confirm": {
      const dueIso = confirmDueFor(rt, task.data, loanId);
      if (dueIso === null) throw new RangeError("confirm_due_at unknown: parse the P360 notification (parseP360Notification) before confirming");
      const dueOn = wallClock(Date.parse(dueIso), ET).date;
      const exp = compFeeExposure({ due_on: dueOn, confirmed_on: completedOn, explanation: optStr(i, "explanation") });
      const confId = str(i, "reogram_confirmation_id") || `rc-${String(task.data.p360_case_id ?? loanId)}`;
      const conf = rt.store.put("reogram_confirmations", confId, { loan_id: loanId, p360_case_id: task.data.p360_case_id ?? null, confirm_due_at: dueIso, confirmed_at: ctx.now, confirmed_by: ctx.actor.id, p360_status: "confirmed", evidence_document_id: doc.id, late_days: exp.late_days, edit_window_ends_at: addBusinessDays(completedOn, 5, fannieEt) }, ctx.actor, ctx.now);
      const reoCaseId = typeof conf.data.reo_case_id === "string" ? conf.data.reo_case_id : rt.store.list("reo_cases", (d) => d.loan_id === loanId)[0]?.id;
      if (reoCaseId && rt.store.get("reo_cases", reoCaseId)) rt.store.put("reo_cases", reoCaseId, { status: "confirmed" }, ctx.actor, ctx.now);
      let exposureId: string | null = null; let sev1: string | null = null;
      if (exp.record && exp.escalation) {
        const x = rt.store.put("comp_fee_exposures", `cfe-${loanId}-${completedOn}`, { ...exp.record, loan_id: loanId, fnma_loan_number: task.data.fnma_loan_number ?? optStr(i, "fnma_loan_number"), reogram_confirmation_id: conf.id, confirm_due_at: dueIso }, ctx.actor, ctx.now);
        exposureId = x.id;
        sev1 = rt.escalations.open({ kind: "sev1", loanId, payload: { reason: exp.escalation.reason, comp_fee_exposure_id: x.id, crs_code: "313", rule: "A1-4.2-02", rebuttal_evidence: exp.rebuttal_evidence, notify: "officer" } }, ctx.actor).id;
        ctx.events.append({ type: "comp_fee.exposure.recorded", loanId, aggregate: { kind: "comp_fee_exposures", id: x.id }, actor: ctx.actor, payload: { late_days: exp.late_days, crs_code: "313", due_on: dueOn, confirmed_on: completedOn } });
      }
      ctx.events.append({ type: "reogram.confirmed", loanId, aggregate: { kind: "reogram_confirmations", id: conf.id }, actor: ctx.actor, payload: { confirmed_at: ctx.now, confirm_due_at: dueIso, late_days: exp.late_days, evidence_document_id: doc.id, p360_case_id: task.data.p360_case_id ?? null } });
      return { ...conf.data, late_days: exp.late_days, comp_fee_exposure_id: exposureId, sev1_escalation_id: sev1, evidence_sha256: doc.sha256 };
    }
    case "p360.reogram.exception":
      ctx.events.append({ type: "reogram.exception.resolved", loanId, actor: ctx.actor, payload: { code: task.data.exception_code ?? optStr(i, "exception_code"), resolved_at: ctx.now, evidence_document_id: doc.id, p360_case_id: task.data.p360_case_id ?? null } });
      return { task_type: taskType, resolved_at: ctx.now, evidence_document_id: doc.id };
    case "p360.tps.update_upload":
      if (typeof task.data.tps_case_id === "string") rt.store.put("tps_cases", task.data.tps_case_id, { p360_status: "recon_ready", documents: (i.documents as unknown[] | undefined) ?? [], status: "documented" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "tps.p360.documents_uploaded", loanId, actor: ctx.actor, payload: { uploaded_at: ctx.now, evidence_document_id: doc.id } });
      return { task_type: taskType, uploaded_at: ctx.now, evidence_document_id: doc.id };
    case "elimination_rescission.submit": {
      const reqId = typeof task.data.request_id === "string" ? task.data.request_id : null;
      if (reqId) rt.store.put("elimination_rescission_requests", reqId, { submitted_at: ctx.now, template_document_id: doc.id, status: "submitted" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "elimination_rescission.request.submitted", loanId, ...(reqId ? { aggregate: { kind: "elimination_rescission_requests", id: reqId } } : {}), actor: ctx.actor, payload: { request_id: reqId, submitted_at: ctx.now, template_document_id: doc.id } });
      return { task_type: taskType, request_id: reqId, submitted_at: ctx.now };
    }
    case "fnma.readd_request.email": {
      const reqId = typeof task.data.request_id === "string" ? task.data.request_id : null;
      if (reqId) rt.store.put("elimination_rescission_requests", reqId, { readd_request_sent_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: "fnma.readd_request.sent", loanId, actor: ctx.actor, payload: { request_id: reqId, mailbox: "readd_requests@fanniemae.com", sent_at: ctx.now, evidence_document_id: doc.id } });
      return { task_type: taskType, request_id: reqId, sent_at: ctx.now };
    }
    default: return { task_type: taskType, completed_at: ctx.now };
  }
}

/** Opens a `human_portal_task` escalation and its `portal_tasks` row (the operator's queue). */
function openPortalRow(rt: ToolRuntime, ctx: CommandContext, loanId: string, taskType: string, dueAt: string | null, payload: Record<string, unknown>, row: Record<string, unknown>): { id: string; ownerRole: string } {
  const e = rt.escalations.open({ kind: "human_portal_task", loanId, payload: { task_type: taskType, due_at: dueAt, ...payload } }, ctx.actor);
  rt.store.put("portal_tasks", e.id, { escalation_id: e.id, loan_id: loanId, task_type: taskType, due_at: dueAt, status: "open", opened_at: ctx.now, owner_role: e.ownerRole, ...row }, ctx.actor, ctx.now);
  ctx.events.append({ type: "human_portal_task.opened", loanId, aggregate: { kind: "escalation", id: e.id }, actor: ctx.actor, payload: { task: taskType, due_at: dueAt, ...(row.p360_case_id !== undefined ? { p360_case_id: row.p360_case_id } : {}) } });
  return { id: e.id, ownerRole: e.ownerRole };
}

/** `openReoCase{op=proceeds_received}` (and a final payment supplied at opening): the bidder's receipt on the TPS case — the spec's inbound `tps.proceeds.received` / `tps.deposit.received` — which arms the 5-BD remittance clock and the 14-day TPS insurance clock. */
function recordProceeds(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, tpsCaseId: string, kind: "final_payment" | "deposit", receivedOn: PlainDate, amount: bigint): Record<string, unknown> {
  const row = rt.store.require("tps_cases", tpsCaseId);
  const loanId = String(row.data.loan_id ?? loanOf(i, ctx));
  const r = tpsProceedsReceipt({ kind, received_on: receivedOn, amount_cents: amount, completion_date: optDate(i, "completion_date") });
  const patch: Record<string, unknown> = kind === "final_payment"
    ? { final_payment_received_at: receivedOn, gross_proceeds_cents: amount, remit_due_at: r.remit_due, completion_date: r.completion_date, status: r.tps_status }
    : { deposit_received_at: receivedOn, deposit_cents: amount, status: row.data.status === "sale_reported" ? r.tps_status : row.data.status };
  const rec = rt.store.put("tps_cases", tpsCaseId, patch, ctx.actor, ctx.now);
  ctx.events.append({ type: r.event, loanId, aggregate: { kind: "tps_cases", id: rec.id }, actor: ctx.actor, payload: { kind, receipt: receivedOn, amount_cents: amount.toString(), completion_date: r.completion_date, remit_due: r.remit_due, timer: r.timer, tps_case_id: rec.id, evidence_document_id: optStr(i, "evidence_document_id") } });
  return { ...rec.data, id: rec.id, receipt: r };
}

export const TOOLS_15_1: readonly ToolDef[] = defineTools("15.1", AGENT, [
  { name: "openReoCase", kind: "act",
    handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "open";
      if (op === "sale_failed") {
        need(i, "tps_case_id", "discovered_on", "deposit_cents");
        const f = failedThirdPartySale({ discovered_on: date(i, "discovered_on"), deposit_cents: cents(i.deposit_cents), over_remitted_cents: optCents(i, "over_remitted_cents") });
        const rec = rt.store.put("tps_cases", str(i, "tps_case_id"), { sale_failed_at: ctx.now, status: f.tps_status, deposit_cents: cents(i.deposit_cents), remit_due_at: f.deposit_remit_due }, ctx.actor, ctx.now);
        const loanId = String(rec.data.loan_id ?? loanOf(i, ctx));
        ctx.events.append({ type: "sale.failed_to_finalize", loanId, aggregate: { kind: "tps_cases", id: rec.id }, actor: ctx.actor, payload: { discovery: str(i, "discovered_on"), deposit_cents: cents(i.deposit_cents).toString(), remit_due: f.deposit_remit_due, crs_code: f.crs.code, kind: f.crs.kind } });
        ctx.events.append({ type: "foreclosure.case.reopened", loanId, actor: ctx.actor, payload: { reason: "tps_sale_failed", detail: f.foreclosure_case.reason, tps_case_id: rec.id } });
        return { ...rec.data, ...f };
      }
      if (op === "proceeds_received") {
        need(i, "tps_case_id", "received_on");
        const kind = (str(i, "kind") || "final_payment") as "final_payment" | "deposit";
        if (kind !== "final_payment" && kind !== "deposit") throw new RangeError("kind must be final_payment or deposit");
        const amount = optCents(i, kind === "deposit" ? "deposit_cents" : "gross_proceeds_cents") ?? optCents(i, "amount_cents");
        if (amount === null) throw new RangeError(`${kind === "deposit" ? "deposit_cents" : "gross_proceeds_cents"} is required`);
        return recordProceeds(i, ctx, rt, str(i, "tps_case_id"), kind, date(i, "received_on"), amount);
      }
      if (op === "liquidation_rail") {
        // Rule 12 / T12: under `investor_reporting.liquidation.mode = event` the same facts project the P360 liquidation event (api-clve in CIT) instead of LAR 70/71/72; the REOgram task stays until `p360.reogram.subsumed`.
        need(i, "mode", "kind", "principal_cents", "legal_date", "fnma_loan_number");
        const processedAt = optStr(i, "processed_at");
        const rail = liquidationRail({ mode: str(i, "mode") as ChannelMode, cit: flag(i, "cit"), reogram_subsumed: flag(i, "reogram_subsumed"), kind: str(i, "kind") as LiquidationKind, insured: (str(i, "insured") || "none") as InsuredFlag, principal_cents: cents(i.principal_cents), interest_cents: optCents(i, "interest_cents") ?? 0n, legal_date: date(i, "legal_date"), fnma_loan_number: str(i, "fnma_loan_number"), processed_at_ms: processedAt ? Date.parse(processedAt) : null });
        if (rail.p360_event) ctx.events.append({ type: "fnma.liquidation_event.projected", loanId: loanOf(i, ctx), actor: ctx.actor, payload: { env: rail.env, event_type: rail.p360_event["Liquidation Event Type"], action_code: rail.p360_event["Liquidation Action Code"] ?? null, rail: rail.rail, due_at: rail.event_due_ms === null ? null : toIso(rail.event_due_ms), diff: rail.diff, reogram_task: rail.reogram_task, fnma_loan_number: str(i, "fnma_loan_number") } });
        return { ...rail, event_due_at: rail.event_due_ms === null ? null : toIso(rail.event_due_ms) };
      }
      if (op === "liquidation_event_accepted") {
        // The `fnma-servicing-events` port's acknowledgment: Property 360 accepted the liquidation event (satisfies FNMA_LL202605_LIQ_EVENT_NEXTBD).
        need(i, "fnma_loan_number", "accepted_at");
        ctx.events.append({ type: "fnma.liquidation_event.accepted", loanId: loanOf(i, ctx), actor: ctx.actor, payload: { fnma_loan_number: str(i, "fnma_loan_number"), accepted_at: str(i, "accepted_at"), event_type: optStr(i, "event_type"), env: optStr(i, "env") ?? "api-clve", acknowledgment_id: optStr(i, "acknowledgment_id") } });
        return { accepted: true, accepted_at: str(i, "accepted_at"), fnma_loan_number: str(i, "fnma_loan_number") };
      }
      need(i, "loan_id", "purchaser", "legal_date");
      const purchaser = str(i, "purchaser") as Purchaser; const legal = date(i, "legal_date"); const insured = flag(i, "insured");
      const kind = caseKind(purchaser); const actionCode = larCode(purchaser, insured);
      const deadlineMs = str(i, "deadline_at") ? Date.parse(str(i, "deadline_at")) : zonedEpochMs(addBusinessDays(legal, 1, fannieEt), "17:00", ET);
      const held = holdIfLowConfidence(i, ctx, rt, deadlineMs, ["purchaser", "successful_bid_cents", "title_vests_at"], `${kind} creation`);
      if (held) return held;
      const id = str(i, "id") || `${kind}-${str(i, "loan_id")}-${legal}`;
      if (kind === "tps_cases") {
        need(i, "successful_bid_cents");
        const finalPaid = optDate(i, "final_payment_received_at");
        const row = { loan_id: str(i, "loan_id"), liquidation_fact_id: optStr(i, "liquidation_fact_id"), sale_date: legal, bid_type: optStr(i, "bid_type"), fnma_bid_cents: optCents(i, "fnma_bid_cents"), successful_bid_cents: cents(i.successful_bid_cents), judgment_cents: optCents(i, "judgment_cents"), purchaser_party_id: optStr(i, "purchaser_party_id"),
          deposit_cents: optCents(i, "deposit_cents"), deposit_received_at: optDate(i, "deposit_received_at"), final_payment_received_at: null, remit_due_at: null, surplus_disposition: "none", documents: [], status: "sale_reported" };
        const rec = rt.store.put(kind, id, row, ctx.actor, ctx.now);
        ctx.events.append({ type: "tps.case.opened", loanId: str(i, "loan_id"), aggregate: { kind, id: rec.id }, actor: ctx.actor, payload: { action_code: actionCode, legal_date: legal, sale_date: legal, purchaser, acquirer: "third_party", acquisition_type: "third_party_sale", successful_bid_cents: cents(i.successful_bid_cents).toString() } });
        const withProceeds = finalPaid ? recordProceeds(i, ctx, rt, rec.id, "final_payment", finalPaid, optCents(i, "gross_proceeds_cents") ?? cents(i.successful_bid_cents)) : null;
        return { ...(withProceeds ?? rec.data), id: rec.id, action_code: actionCode };
      }
      const inNameOf = (IN_NAME_OF as readonly string[]).includes(str(i, "foreclosed_in_name_of")) ? (str(i, "foreclosed_in_name_of") as ForeclosedInNameOf) : "fnma";
      const acq = (ACQUISITION_TYPES as readonly string[]).includes(str(i, "acquisition_type")) ? str(i, "acquisition_type") : "fcl_sale";
      const deed = deedRecordDueRolled(legal, inNameOf);
      const row = { loan_id: str(i, "loan_id"), property_id: optStr(i, "property_id"), liquidation_fact_id: optStr(i, "liquidation_fact_id"), acquisition_type: acq, legal_date: legal, title_vests_at: optDate(i, "title_vests_at") ?? legal, redemption_expires_at: optDate(i, "redemption_expires_at"),
        grantee_name: "Federal National Mortgage Association", foreclosed_in_name_of: inNameOf, deed_record_due: deed.task === "record_deed" ? deed.due : null, mi_policy_id: optStr(i, "mi_policy_id"), occupancy_status: optStr(i, "occupancy_status"), resale_restriction_flags: (i.resale_restriction_flags as Record<string, unknown> | undefined) ?? null, handoff_status: "pending", status: "sale_reported" };
      const rec = rt.store.put(kind, id, row, ctx.actor, ctx.now);
      // Rule 6: reo_cases creation is what closes the preservation gate and starts the deed / title / insurance clocks (Section 13 emits no sale event; the case carries the sale).
      ctx.events.append({ type: "reo.case.opened", loanId: str(i, "loan_id"), aggregate: { kind, id: rec.id }, actor: ctx.actor, payload: { action_code: actionCode, legal_date: legal, sale_date: legal, title_vests_at: row.title_vests_at, purchaser, acquirer: "fannie_mae", acquisition_type: acq, foreclosed_in_name_of: inNameOf, deed_record_due: row.deed_record_due, gates_closed: ["FNMA_E4301_PRESERVATION_STOP"] } });
      return { ...rec.data, id: rec.id, action_code: actionCode };
    }) },
  { name: "computeTpsSplit", kind: "write", moneyFields: ["amount_due_fnma_cents", "servicer_recovery_cents", "surplus_cents"],
    handler: compute((i, ctx, rt) => {
      need(i, "upb_cents", "ptr_pct", "lpi_due", "liquidation_date", "settlement_date", "gross_proceeds_cents");
      const advances = (i.advances as AdvanceItem[] | undefined) ?? [];
      const unrecovered = optCents(i, "unrecovered_advances_cents") ?? advances.reduce((s, a) => s + cents(a.unit_cents) * BigInt(a.quantity), 0n);
      const tps = thirdPartySale({ upb_cents: cents(i.upb_cents), ptr_pct: str(i, "ptr_pct"), lpi_due: date(i, "lpi_due"), liquidation_date: date(i, "liquidation_date"), settlement_date: date(i, "settlement_date"), gross_proceeds_cents: cents(i.gross_proceeds_cents), restricted_resale_price_cents: optCents(i, "restricted_resale_price_cents"), unrecovered_advances_cents: unrecovered });
      const from = date(i, "lpi_due"); const to = date(i, "liquidation_date") > date(i, "settlement_date") ? date(i, "liquidation_date") : date(i, "settlement_date");
      const spread = str(i, "note_rate_pct") ? spreadInterest(cents(i.upb_cents), str(i, "note_rate_pct"), str(i, "ptr_pct"), from, to) : 0n;
      const waterfall = advances.length ? recoveryWaterfall({ gross_proceeds_cents: cents(i.gross_proceeds_cents), amount_due_fnma_cents: tps.amount_due_fnma_cents, advances: advances.map((a) => ({ kind: a.kind, unit_cents: cents(a.unit_cents), quantity: Number(a.quantity) })), spread_interest_cents: spread }) : null;
      const rules = i.jurisdiction_rules as { state: string; surplus_order?: readonly SurplusDisposition[]; court_registry_required?: boolean } | undefined;
      const surplus = rules ? surplusDisposition({ surplus_cents: tps.surplus_cents, jurisdiction_rules: rules, junior_liens_present: flag(i, "junior_liens_present") }) : null;
      const result: Record<string, unknown> = { ...tps, spread_interest_cents: spread, waterfall, surplus_disposition: surplus };
      // With a TPS case the F-1-20 figures are persisted on `tps_cases` (the remittance cap) and the proceeds are booked once as balanced entry sets (spec Outputs / Ledger).
      if (str(i, "tps_case_id")) {
        const row = rt.store.require("tps_cases", str(i, "tps_case_id"));
        const loanId = String(row.data.loan_id ?? loanOf(i, ctx));
        let setIds = (row.data.ledger_set_ids as string[] | undefined) ?? [];
        if (setIds.length === 0) {
          const sets = tpsProceedsLedgerSets({ loan_id: loanId, custodial_account_id: str(i, "custodial_account_id") || String(row.data.custodial_account_id ?? "custodial-pi"), effective_date: to, amount_due_fnma_cents: tps.amount_due_fnma_cents, servicer_recovery_cents: tps.servicer_recovery_cents, surplus_cents: tps.surplus_cents, applied: waterfall?.applied ?? null });
          setIds = sets.map((s) => ctx.ledger.post(s, ctx.now).id);
        }
        const rec = rt.store.put("tps_cases", row.id, { gross_proceeds_cents: cents(i.gross_proceeds_cents), fnma_total_indebtedness_cents: tps.fnma_total_indebtedness_cents, restricted_resale_price_cents: optCents(i, "restricted_resale_price_cents"), amount_due_fnma_cents: tps.amount_due_fnma_cents, servicer_recovery_cents: tps.servicer_recovery_cents, surplus_cents: tps.surplus_cents, surplus_disposition: surplus?.disposition ?? row.data.surplus_disposition ?? "none", remit_due_at: row.data.remit_due_at ?? tps.settle_by, ledger_set_ids: setIds, split_computed_at: ctx.now }, ctx.actor, ctx.now);
        ctx.events.append({ type: "tps.split.computed", loanId, aggregate: { kind: "tps_cases", id: rec.id }, actor: ctx.actor, payload: { fnma_total_indebtedness_cents: tps.fnma_total_indebtedness_cents.toString(), amount_due_fnma_cents: tps.amount_due_fnma_cents.toString(), servicer_recovery_cents: tps.servicer_recovery_cents.toString(), surplus_cents: tps.surplus_cents.toString(), settle_by: tps.settle_by, ledger_set_ids: setIds } });
        result.tps_case_id = rec.id; result.ledger_set_ids = setIds;
      }
      return result;
    }) },
  { name: "buildReogramPackage", kind: "act",
    handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "fnma_loan_number", "legal_date");
      const property = (i.property as { address: string; unit?: string | null; city: string; county: string; state: string; zip: string; property_type: string } | undefined) ?? { address: str(i, "property_address"), city: str(i, "city"), county: str(i, "county"), state: str(i, "state"), zip: str(i, "zip"), property_type: str(i, "property_type") || "sfr" };
      const mi = (i.mi as { indicator: boolean; company?: string | null; certificate?: string | null; coverage_pct?: string | null } | undefined) ?? { indicator: flag(i, "mi_indicator"), company: optStr(i, "mi_company"), certificate: optStr(i, "mi_certificate"), coverage_pct: optStr(i, "mi_coverage_pct") };
      const legal = date(i, "legal_date");
      // Rule 4: the restriction status comes from the property record when it is on file; the caller's value only fills a gap.
      const stored = storedGateFacts(rt, str(i, "loan_id"), { ...i, facts: {} });
      const restriction = typeof stored.facts.resale_restriction === "string" ? stored.facts.resale_restriction : optStr(i, "resale_restriction");
      const pkg = reogramPackage({
        fnma_loan_number: str(i, "fnma_loan_number"), servicer_loan_number: str(i, "servicer_loan_number") || str(i, "loan_id"), borrower_names: (i.borrower_names as string[] | undefined) ?? [], property, mi,
        attorney: str(i, "attorney"), legal_date: legal, purchaser: (str(i, "purchaser") || "fnma") as "fnma" | "third_party", successful_bid_cents: optCents(i, "successful_bid_cents"),
        occupancy: str(i, "occupancy") || "unknown", keys_lockbox: optStr(i, "keys_lockbox"), preservation_vendor: optStr(i, "preservation_vendor"), hoa_utility_notes: optStr(i, "hoa_utility_notes"),
        resale_restriction: restriction, resale_notice_evidence: flag(i, "resale_notice_evidence"), restriction_agreement_complied: i.restriction_agreement_complied === undefined ? null : flag(i, "restriction_agreement_complied"), termination_actions_completed: i.termination_actions_completed === undefined ? null : flag(i, "termination_actions_completed"),
        known_exceptions: (i.known_exceptions as { code: string; text: string; proposed_override?: string | null }[] | undefined) ?? [],
      });
      // The 1-BD clock runs from the notification receipt (rule 2); before the notification the package is pre-built against the expected deadline (LAR accepted next BD, notification the BD after).
      const received = str(i, "notification_received_at") ? confirmDueAt(Date.parse(str(i, "notification_received_at"))) : null;
      const deadlineMs = received?.ms ?? zonedEpochMs(addBusinessDays(legal, 2, fannieEt), "17:00", ET);
      const rec = rt.store.put("reogram_confirmations", str(i, "reogram_confirmation_id") || `rc-${str(i, "loan_id")}`, { reo_case_id: optStr(i, "reo_case_id"), loan_id: str(i, "loan_id"), package: pkg.fields, gates_checked: pkg.gates_checked, blocked: pkg.blocked, missing: pkg.missing, fact_sources: stored.sources, ...(received ? { confirm_due_at: toIso(received.ms) } : {}), package_built_at: ctx.now }, ctx.actor, ctx.now);
      let escalation: Record<string, unknown> | null = null;
      if (pkg.escalation) {
        const requestAtMs = deadlineMs - 4 * 3_600_000;
        const e = rt.escalations.open({ kind: escKind(pkg.escalation.kind), ...(pkg.escalation.severity ? { severity: pkg.escalation.severity } : {}), loanId: str(i, "loan_id"), payload: { reason: pkg.escalation.reason, gate: pkg.attestation.blocked ? "SM_RESALE_RESTRICTION_NOTICES" : "MI_DATA_CHECK", missing: pkg.attestation.blocked ? pkg.attestation.missing : pkg.missing, request_at: toIso(requestAtMs), confirm_due_at: toIso(deadlineMs), package: pkg.fields } }, ctx.actor);
        escalation = { id: e.id, kind: e.kind, owner_role: e.ownerRole, request_at: toIso(requestAtMs), confirm_due_at: toIso(deadlineMs), before_deadline: requestAtMs < deadlineMs };
        ctx.events.append({ type: "reogram.confirmation.blocked", loanId: str(i, "loan_id"), aggregate: { kind: "escalation", id: e.id }, actor: ctx.actor, payload: { gate: escalation.gate ?? (pkg.attestation.blocked ? "SM_RESALE_RESTRICTION_NOTICES" : "MI_DATA_CHECK"), reason: pkg.escalation.reason, request_at: toIso(requestAtMs) } });
      }
      ctx.events.append({ type: "reogram.package.built", loanId: str(i, "loan_id"), aggregate: { kind: "reogram_confirmations", id: rec.id }, actor: ctx.actor, payload: { blocked: pkg.blocked, gates_checked: pkg.gates_checked, missing: pkg.missing, fact_sources: stored.sources } });
      return { ...pkg, reogram_confirmation_id: rec.id, confirm_due_at: received ? { date: received.date, at: toIso(received.ms) } : null, escalation, fact_sources: stored.sources };
    }) },
  { name: "openPortalTask", kind: "act",
    guardrails: [guard("REOGRAM_CONFIRM_GATES", GATE_CITATION, (i) => {
      if (str(i, "task_type") !== "p360.reogram.confirm" || str(i, "op") === "complete") return undefined;
      const g = reogramConfirmGate(suppliedFacts(i));
      return g.open ? undefined : `${g.reason} — resolve before the confirmation task (gates: ${g.gates_checked.join(", ")})`;
    })],
    handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "open";
      if (op === "complete") return completePortalTask(i, ctx, rt);
      need(i, "loan_id", "task_type");
      const taskType = str(i, "task_type"); const loanId = str(i, "loan_id");
      // Rule 4 / guardrail: the records decide — the guardrail's pass on the caller's facts is only the first line.
      const gate = taskType === "p360.reogram.confirm" ? assertConfirmGateOpen(rt, ctx, "openPortalTask", loanId, i) : null;
      const dueAt = optStr(i, "due_at") ?? (taskType === "p360.reogram.confirm" ? confirmDueFor(rt, { p360_case_id: optStr(i, "p360_case_id") }, loanId) : null);
      const held = holdIfLowConfidence(i, ctx, rt, dueAt ? Date.parse(dueAt) : Date.parse(ctx.now) + 24 * 3_600_000, ["purchaser", "successful_bid_cents", "title_vests_at"], `portal task ${taskType}`);
      if (held) return held;
      const pkg = (i.package as Record<string, unknown> | undefined) ?? null;
      const t = openPortalRow(rt, ctx, loanId, taskType, dueAt,
        { p360_case_id: optStr(i, "p360_case_id"), package: pkg, expected_values: (i.expected_values as Record<string, unknown> | undefined) ?? pkg, proposed_correction: (i.proposed_correction as Record<string, unknown> | undefined) ?? null, evidence_required: "P360 case export / screenshot hashed into documents", reason: optStr(i, "reason"), ...(gate ? { gates_checked: gate.gates_checked, fact_sources: gate.sources } : {}), ...(typeof i.case_id === "string" ? { case_id: i.case_id } : {}) },
        { p360_case_id: optStr(i, "p360_case_id"), fnma_loan_number: optStr(i, "fnma_loan_number") ?? (pkg?.fnma_loan_number as string | undefined) ?? null, tps_case_id: optStr(i, "tps_case_id"), request_id: optStr(i, "request_id"), exception_code: optStr(i, "exception_code"), package: pkg });
      return { portal_task_id: t.id, owner_role: t.ownerRole, task_type: taskType, due_at: dueAt, package: pkg, ...(gate ? { gates_checked: gate.gates_checked, fact_sources: gate.sources } : {}) };
    }) },
  { name: "parseP360Notification", kind: "act",
    handler: compute((i, ctx, rt) => {
      need(i, "subject", "body");
      const parsed = parseP360Notification({ subject: str(i, "subject"), body: str(i, "body"), received_at: str(i, "received_at") || ctx.now });
      const loanId = loanOf(i, ctx); const receivedMs = Date.parse(parsed.notification_received_at);
      const cases = parsed.cases.map((c) => {
        ctx.events.append({ type: "p360.case.observed", loanId, actor: ctx.actor, payload: { kind: c.kind, p360_case_id: c.p360_case_id, queue: c.queue, servicer_loan_number: c.servicer_loan_number, observation: parsed.notification_received_at } });
        if (c.kind === "third_party_sale") {
          if (str(i, "tps_case_id")) rt.store.put("tps_cases", str(i, "tps_case_id"), { p360_case_id: c.p360_case_id, p360_status: "intake" }, ctx.actor, ctx.now);
          return { ...c, portal_task_type: "p360.tps.update_upload", confirm_due_at: null };
        }
        const due = confirmDueAt(receivedMs);
        const rec = rt.store.put("reogram_confirmations", `rc-${c.p360_case_id}`, { reo_case_id: optStr(i, "reo_case_id"), loan_id: loanId, p360_case_id: c.p360_case_id, notification_received_at: parsed.notification_received_at, confirm_due_at: toIso(due.ms), p360_status: c.queue ?? "potential", exceptions: [], late_days: 0, notification_hash: optStr(i, "notification_hash") ?? sha256(`${str(i, "subject")}\n${str(i, "body")}`) }, ctx.actor, ctx.now);
        const reoCaseId = optStr(i, "reo_case_id") ?? rt.store.list("reo_cases", (d) => d.loan_id === loanId)[0]?.id;
        if (reoCaseId && rt.store.get("reo_cases", reoCaseId) && c.queue !== "confirmed") rt.store.put("reo_cases", reoCaseId, { status: c.queue === "exception" ? "exception" : "pending_confirmation" }, ctx.actor, ctx.now);
        if (c.queue !== "confirmed") ctx.events.append({ type: "reogram.created", loanId, aggregate: { kind: "reogram_confirmations", id: rec.id }, actor: ctx.actor, payload: { receipt: parsed.notification_received_at, p360_case_id: c.p360_case_id, queue: c.queue, confirm_due_at: toIso(due.ms) } });
        if (c.queue === "exception") ctx.events.append({ type: "reogram.exception.raised", loanId, aggregate: { kind: "reogram_confirmations", id: rec.id }, actor: ctx.actor, payload: { raised_at: parsed.notification_received_at, p360_case_id: c.p360_case_id, code: optStr(i, "exception_code"), text: optStr(i, "exception_text") } });
        return { ...c, reogram_confirmation_id: rec.id, portal_task_type: c.queue === "exception" ? "p360.reogram.exception" : "p360.reogram.confirm", confirm_due_at: { date: due.date, at: toIso(due.ms) } };
      });
      return { ...parsed, cases };
    }) },
  { name: "scheduleHandoffTasks", kind: "act",
    guardrails: [never("NO_POST_SALE_PRESERVATION", "15.1 guardrail: never order preservation after the sale for Fannie Mae-acquired property (E-4.3-01; rule 6 — emergency orders only on SF CPM direction, non-reimbursable by default)", (i) => (str(i, "op") === "order_preservation" || flag(i, "order_preservation") || str(i, "kind") === "preservation_order") && !postSalePreservationAllowed({ acquirer: (str(i, "acquirer") || "fannie_mae") as "fannie_mae" | "third_party", sale_completed: true, tps_completed: flag(i, "tps_completed"), sf_cpm_directed: flag(i, "sf_cpm_directed") }).allowed, "property preservation ceased at the sale; Fannie Mae's vendor manages the property (E-4.3-01)")],
    handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || (str(i, "requested_kind") ? "request" : "schedule");
      need(i, "reo_case_id");
      const caseId = str(i, "reo_case_id"); const loanId = loanOf(i, ctx);
      if (op === "complete") {
        need(i, "kind", "evidence_document_id");
        const kind = str(i, "kind") as HandoffKind; const evidence = str(i, "evidence_document_id");
        const rec = rt.store.put("reo_handoff_tasks", `${caseId}-${kind}`, { reo_case_id: caseId, kind, completed_at: ctx.now, evidence_document_id: evidence }, ctx.actor, ctx.now);
        const ev = handoffCompletionEvent(kind);
        const extra: Record<string, unknown> = { reo_case_id: caseId, evidence_document_id: evidence, confirmation_id: optStr(i, "confirmation_id"), submitted_on: optStr(i, "submitted_on"), recorded_on: optStr(i, "recorded_on") };
        ctx.events.append({ type: ev.type, loanId, aggregate: { kind: "reo_handoff_tasks", id: rec.id }, actor: ctx.actor, payload: { ...ev.payload, ...extra } });
        if (kind === "deed_record" && optStr(i, "recorded_on")) { rt.store.put("reo_cases", caseId, { deed_recorded_at: str(i, "recorded_on"), deed_document_id: evidence }, ctx.actor, ctx.now); ctx.events.append({ type: "deed.recorded", loanId, actor: ctx.actor, payload: { recorded_on: str(i, "recorded_on"), evidence_document_id: evidence } }); }
        if (kind === "deed_record") rt.store.put("reo_cases", caseId, { deed_submitted_at: optStr(i, "submitted_on") ?? ctx.now, deed_document_id: evidence }, ctx.actor, ctx.now);
        if (kind === "eviction_docs" && optStr(i, "ptfa_notice_served_on")) ctx.events.append({ type: "tenant.notice.served", loanId, actor: ctx.actor, payload: { kind: "ptfa_90_day", served_on: str(i, "ptfa_notice_served_on"), vacate_date: optStr(i, "vacate_date"), lease_honored: i.lease_honored === undefined ? true : flag(i, "lease_honored"), path: "servicer_counsel" } });
        return { ...rec.data, event: ev.type };
      }
      if (op === "request") {
        need(i, "requested_kind", "requested_on");
        const t = requestedDocumentsDue(date(i, "requested_on"), str(i, "requested_kind") as "recovery_firm_info" | "eviction_docs");
        const rec = rt.store.put("reo_handoff_tasks", `${caseId}-${t.kind}`, { reo_case_id: caseId, kind: t.kind, due_at: t.due_at, owner: t.owner, timer: t.timer, completed_at: null, evidence_document_id: null, requested_at: str(i, "requested_on"), requested_by: optStr(i, "requested_by") }, ctx.actor, ctx.now);
        ctx.events.append({ type: "fnma.request.received", loanId, aggregate: { kind: "reo_handoff_tasks", id: rec.id }, actor: ctx.actor, payload: { kind: t.kind === "eviction_docs" ? "eviction_documents" : "property_recovery", request: str(i, "requested_on"), due: t.due_at, requested_by: optStr(i, "requested_by") } });
        return [rec.data];
      }
      if (op === "tenant_identified") {
        // PTFA: a bona fide tenant found after acquisition — on the servicer-counsel path the 90-day notice clock runs to the vacate date; on Fannie Mae-managed property the tenant information goes to Fannie Mae's eviction counsel.
        need(i, "identified_on");
        const t = tenantIdentified({ bona_fide: flag(i, "bona_fide"), vacate_date: optDate(i, "vacate_date"), servicer_counsel_path: flag(i, "servicer_counsel_path"), lease_end: optDate(i, "lease_end") });
        if (t.timer && t.payload.vacate_date === null) throw new RangeError("vacate_date is required on the servicer-counsel path");
        rt.store.put("reo_cases", caseId, { occupancy_status: t.occupancy_status, tenant_identified_on: str(i, "identified_on") }, ctx.actor, ctx.now);
        ctx.events.append({ type: t.event, loanId, aggregate: { kind: "reo_cases", id: caseId }, actor: ctx.actor, payload: { ...t.payload, identified_on: str(i, "identified_on"), notice_serve_by: t.notice_serve_by, timer: t.timer, reo_case_id: caseId } });
        return { ...t, reo_case_id: caseId };
      }
      if (op === "order_preservation") {
        // Rule 6: reached only past NO_POST_SALE_PRESERVATION — an SF CPM-directed emergency order on Fannie Mae-acquired property (non-reimbursable by default) or Matrix preservation on a third-party sale still short of completion.
        need(i, "ordered_on", "scope");
        const r = postSalePreservationOrder({ acquirer: (str(i, "acquirer") || "fannie_mae") as "fannie_mae" | "third_party", tps_completed: flag(i, "tps_completed"), sf_cpm_directed: flag(i, "sf_cpm_directed"), ordered_on: date(i, "ordered_on") });
        if (!r.allowed) refuse(ctx, "scheduleHandoffTasks", "NO_POST_SALE_PRESERVATION", "15.1 guardrail: never order preservation after the sale for Fannie Mae-acquired property (E-4.3-01)", r.reason ?? "property preservation ceased at the sale");
        const task = r.task ? rt.store.put("reo_handoff_tasks", `${caseId}-${r.task.kind}`, { reo_case_id: caseId, kind: r.task.kind, due_at: r.task.due_at, owner: r.task.owner, timer: null, completed_at: null, evidence_document_id: null, nonreimbursable: r.nonreimbursable, scope: str(i, "scope"), sf_cpm_direction_ref: optStr(i, "sf_cpm_direction_ref") }, ctx.actor, ctx.now) : null;
        ctx.events.append({ type: "preservation.order.requested", loanId, aggregate: { kind: "reo_cases", id: caseId }, actor: ctx.actor, payload: { post_sale: true, acquirer: str(i, "acquirer") || "fannie_mae", sf_cpm_directed: flag(i, "sf_cpm_directed"), sf_cpm_direction_ref: optStr(i, "sf_cpm_direction_ref"), nonreimbursable: r.nonreimbursable, reason: r.reason, scope: str(i, "scope"), ordered_on: str(i, "ordered_on"), rule: "E-4.3-01" } });
        return { allowed: true, nonreimbursable: r.nonreimbursable, reason: r.reason, cpm_issue_report: task?.data ?? null };
      }
      need(i, "legal_date");
      const acquisition = (str(i, "acquisition") || "fnma") as "fnma" | "third_party";
      const inNameOf = (IN_NAME_OF as readonly string[]).includes(str(i, "foreclosed_in_name_of")) ? (str(i, "foreclosed_in_name_of") as ForeclosedInNameOf) : "fnma";
      const tasks = handoffTasks({ legal_date: date(i, "legal_date"), acquisition, foreclosed_in_name_of: inNameOf, flood_policy: flag(i, "flood_policy"), lpi_policy: flag(i, "lpi_policy"), tps_completion_date: optDate(i, "tps_completion_date") });
      const rows = tasks.map((t) => rt.store.put("reo_handoff_tasks", `${caseId}-${t.kind}`, { reo_case_id: caseId, kind: t.kind, due_at: t.due_at, owner: t.owner, timer: t.timer, completed_at: null, evidence_document_id: null }, ctx.actor, ctx.now).data);
      ctx.events.append({ type: "reo.handoff.scheduled", loanId, actor: ctx.actor, payload: { reo_case_id: caseId, kinds: tasks.map((t) => t.kind) } });
      if (acquisition === "fnma") { rt.store.put("reo_cases", caseId, { preservation_stopped_at: ctx.now, handoff_status: "in_progress" }, ctx.actor, ctx.now); ctx.events.append({ type: "preservation.stop_work", loanId, actor: ctx.actor, payload: { legal_date: str(i, "legal_date"), acquirer: "fannie_mae", gate: "FNMA_E4301_PRESERVATION_STOP", rule: "E-4.3-01" } }); }
      return rows;
    }) },
  { name: "requestInsuranceCancellation", kind: "act",
    handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "policy_kind");
      const kind = str(i, "policy_kind") as "hazard" | "flood" | "lpi"; const caseId = str(i, "reo_case_id") || str(i, "loan_id");
      if ((str(i, "op") || "request") === "carrier_refused") {
        need(i, "refused_on");
        const r = carrierRefusal(date(i, "refused_on"));
        const task = rt.store.put("reo_handoff_tasks", `${caseId}-${r.task.kind}`, { reo_case_id: caseId, kind: r.task.kind, due_at: r.task.due_at, owner: r.task.owner, timer: r.task.timer, completed_at: null, evidence_document_id: null, policy_kind: kind }, ctx.actor, ctx.now);
        const flagRow = rt.store.put("claim_flags", `${caseId}-${kind}-carrier_refused`, { reo_case_id: caseId, loan_id: str(i, "loan_id"), kind: r.claim_flag.kind, rule: r.claim_flag.rule, policy_kind: kind, comment: r.final_claim_comment, flagged_at: ctx.now, applies_to: "final_expense_claim" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "insurance.mortgagee_removal.requested", loanId: str(i, "loan_id"), aggregate: { kind: "reo_handoff_tasks", id: task.id }, actor: ctx.actor, payload: { policy_kind: kind, policy_id: optStr(i, "policy_id"), refused_on: str(i, "refused_on"), due: r.task.due_at } });
        ctx.events.append({ type: "claim.comment.flagged", loanId: str(i, "loan_id"), aggregate: { kind: "claim_flags", id: flagRow.id }, actor: ctx.actor, payload: { kind: r.claim_flag.kind, rule: r.claim_flag.rule, comment: r.final_claim_comment } });
        return { mortgagee_removal_task: task.data, claim_flag: flagRow.data };
      }
      need(i, "legal_date");
      const rec = rt.store.put("reo_handoff_tasks", `${caseId}-${kind}_cancel`, { reo_case_id: caseId, loan_id: str(i, "loan_id"), kind: `${kind}_cancel`, policy_id: optStr(i, "policy_id"), cancel_as_of: date(i, "legal_date"), refund_requested: kind !== "lpi", requested_at: ctx.now, owner: "agent", completed_at: ctx.now, evidence_document_id: optStr(i, "evidence_document_id") }, ctx.actor, ctx.now);
      ctx.events.append({ type: kind === "flood" ? "flood.cancellation.requested" : "insurance.cancellation.requested", loanId: str(i, "loan_id"), aggregate: { kind: "reo_handoff_tasks", id: rec.id }, actor: ctx.actor, payload: { policy_kind: kind, policy_id: optStr(i, "policy_id"), cancel_as_of: date(i, "legal_date"), refund_requested: kind !== "lpi", flow: "9.5" } });
      return rec.data;
    }) },
  { name: "buildCrsBatch", kind: "act", moneyFields: ["amount_due_fnma_cents", "remit_cents", "curtailment_cents"],
    guardrails: [never("REMIT_CAP_AMOUNT_DUE", CAP_CITATION, (i) => i.remit_cents !== undefined && i.remit_cents !== null && i.amount_due_fnma_cents !== undefined && i.amount_due_fnma_cents !== null && cents(i.remit_cents) > cents(i.amount_due_fnma_cents), "the 311/351 remittance is capped at amount_due_fnma; surplus is distributed per applicable law, never remitted to Fannie Mae")],
    handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "draft";
      if (op === "match_313") {
        need(i, "draft_id", "fnma_loan_number", "amount_cents", "draft_date");
        const exposures = rt.store.list("comp_fee_exposures").map((r) => ({ id: r.id, fnma_loan_number: (r.data.fnma_loan_number as string | null) ?? null, late_days: Number(r.data.late_days ?? 0), status: String(r.data.status ?? "open") }));
        const m = matchCode313Draft({ draft_id: str(i, "draft_id"), fnma_loan_number: str(i, "fnma_loan_number"), amount_cents: cents(i.amount_cents), draft_date: date(i, "draft_date") }, exposures);
        const draft = rt.store.put("crs_313_drafts", str(i, "draft_id"), { loan_id: loanOf(i, ctx), fnma_loan_number: str(i, "fnma_loan_number"), amount_cents: cents(i.amount_cents), draft_date: str(i, "draft_date"), matched_exposure_id: m.exposure_id, disposition: m.disposition, received_at: ctx.now }, ctx.actor, ctx.now);
        if (m.exposure_id) rt.store.put("comp_fee_exposures", m.exposure_id, { matched_draft_id: draft.id, status: "matched" }, ctx.actor, ctx.now);
        ctx.events.append({ type: m.matched ? "crs.draft_313.matched" : "crs.draft_313.unmatched", loanId: loanOf(i, ctx), aggregate: { kind: "crs_313_drafts", id: draft.id }, actor: ctx.actor, payload: { exposure_id: m.exposure_id, disposition: m.disposition, amount_cents: cents(i.amount_cents).toString(), rebuttal_route: m.rebuttal_route } });
        return { ...m, draft_id: draft.id };
      }
      if (op === "settled") {
        // The CRS settlement of a batch this process drafted (bank match / CRS confirmation): `remittance.special.settled{code, kind}` per line — the 5-BD and failed-deposit clocks close on it and the same-day closing-statement clock opens.
        need(i, "batch_id", "settled_on");
        const batch = rt.store.require("crs_batches", str(i, "batch_id"));
        if (batch.data.status === "settled") throw new RangeError(`batch ${batch.id} is already settled`);
        const loanId = String(batch.data.loan_id ?? loanOf(i, ctx)); const kind = String(batch.data.kind ?? "tps_proceeds"); const settledOn = date(i, "settled_on");
        const rec = rt.store.put("crs_batches", batch.id, { status: "settled", settled_on: settledOn, settled_at: ctx.now, bank_reference: optStr(i, "bank_reference") }, ctx.actor, ctx.now);
        const tpsId = typeof batch.data.tps_case_id === "string" ? batch.data.tps_case_id : null;
        if (tpsId && rt.store.get("tps_cases", tpsId)) rt.store.put("tps_cases", tpsId, kind === "tps_deposit" ? { deposit_remitted_at: ctx.now, crs_batch_id: batch.id } : { remitted_at: ctx.now, crs_batch_id: batch.id, status: "remitted" }, ctx.actor, ctx.now);
        const lines = (batch.data.lines as { code: string; cents: string }[] | undefined) ?? [];
        for (const l of lines) ctx.events.append({ type: "remittance.special.settled", loanId, aggregate: { kind: "crs_batches", id: batch.id }, actor: ctx.actor, payload: { code: l.code, kind, amount_cents: l.cents, settled_on: settledOn, batch_id: batch.id, tps_case_id: tpsId, bank_reference: optStr(i, "bank_reference") } });
        return { ...rec.data, id: rec.id, settled_codes: lines.map((l) => l.code) };
      }
      need(i, "tps_case_id");
      const kind = str(i, "kind") || "tps_proceeds";
      const row = rt.store.require("tps_cases", str(i, "tps_case_id"));
      // Guardrail: the cap is the figure on the record — the F-1-20 `amount_due_fnma` computeTpsSplit persisted (the deposit itself for a failed sale) — never a number the caller supplies.
      const stored = kind === "tps_deposit" ? rowCents(row.data.deposit_cents) : rowCents(row.data.amount_due_fnma_cents);
      if (stored === null) refuse(ctx, "buildCrsBatch", "REMIT_CAP_AMOUNT_DUE", CAP_CITATION, kind === "tps_deposit" ? `tps_cases ${row.id} carries no deposit_cents — record the deposit (openReoCase{op=proceeds_received, kind=deposit} / op=sale_failed) before drafting the 311` : `tps_cases ${row.id} carries no amount_due_fnma_cents — run computeTpsSplit (F-1-20) before drafting the 311/351`);
      const supplied = optCents(i, "amount_due_fnma_cents");
      if (supplied !== null && supplied !== stored) refuse(ctx, "buildCrsBatch", "REMIT_CAP_AMOUNT_DUE", CAP_CITATION, `supplied amount_due_fnma_cents ${supplied} ≠ tps_cases ${kind === "tps_deposit" ? "deposit_cents" : "amount_due_fnma_cents"} ${stored} — the cap is the persisted F-1-20 figure`);
      const lines = crsBatchLines({ amount_due_fnma_cents: stored, curtailment_cents: optCents(i, "curtailment_cents"), remit_cents: optCents(i, "remit_cents") });
      if (lines.refusal) refuse(ctx, "buildCrsBatch", "REMIT_CAP_AMOUNT_DUE", CAP_CITATION, lines.refusal);
      const loanId = String(row.data.loan_id ?? loanOf(i, ctx));
      const settleBy = optStr(i, "settle_by") ?? (typeof row.data.remit_due_at === "string" ? row.data.remit_due_at : null);
      const rec = rt.store.put("crs_batches", str(i, "id") || `crs-${row.id}-311-${kind}`, { tps_case_id: row.id, loan_id: loanId, kind, lines: lines.lines.map((l) => ({ code: l.code, cents: l.cents.toString() })), total_cents: lines.total_cents.toString(), cap_cents: stored.toString(), cap_source: kind === "tps_deposit" ? "tps_cases.deposit_cents" : "tps_cases.amount_due_fnma_cents", settle_by: settleBy, status: "drafted", drafted_at: ctx.now }, ctx.actor, ctx.now);
      rt.store.put("tps_cases", row.id, { crs_batch_id: rec.id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "remittance.special.drafted", loanId, aggregate: { kind: "crs_batches", id: rec.id }, actor: ctx.actor, payload: { batch_id: rec.id, codes: lines.lines.map((l) => l.code), kind, total_cents: lines.total_cents.toString(), settle_by: settleBy } });
      return { ...rec.data, id: rec.id, lines: lines.lines };
    }) },
  { name: "draftClosingStatement", kind: "act",
    handler: compute((i, ctx, rt) => {
      need(i, "upb_cents", "ptr_pct", "lpi_due", "liquidation_date", "settlement_date", "gross_proceeds_cents", "remitted_on");
      const tps = thirdPartySale({ upb_cents: cents(i.upb_cents), ptr_pct: str(i, "ptr_pct"), lpi_due: date(i, "lpi_due"), liquidation_date: date(i, "liquidation_date"), settlement_date: date(i, "settlement_date"), gross_proceeds_cents: cents(i.gross_proceeds_cents), restricted_resale_price_cents: optCents(i, "restricted_resale_price_cents"), unrecovered_advances_cents: optCents(i, "unrecovered_advances_cents") ?? 0n });
      const stmt = closingStatement({ tps, upb_cents: cents(i.upb_cents), servicing_fees_cents: optCents(i, "servicing_fees_cents") ?? 0n, advances_cents: optCents(i, "unrecovered_advances_cents") ?? 0n, other_cents: optCents(i, "other_cents") ?? 0n, remitted_on: date(i, "remitted_on") });
      const loanId = loanOf(i, ctx); const id = str(i, "id") || `cs-${str(i, "tps_case_id") || loanId}-${str(i, "remitted_on")}`;
      const send = str(i, "op") === "send";
      const breakdown = Object.fromEntries(Object.entries(stmt.breakdown).map(([k, v]) => [k, v.toString()]));
      const doc = documentRow(rt, ctx, `${id}.json`, "closing_statement", loanId, JSON.stringify({ recipient: stmt.recipient, remitted_on: str(i, "remitted_on"), through: str(i, "liquidation_date"), breakdown }), { tps_case_id: optStr(i, "tps_case_id"), mime_type: "application/json" });
      const rec = rt.store.put("closing_statements", id, { tps_case_id: optStr(i, "tps_case_id"), loan_id: loanId, recipient: stmt.recipient, send_by: stmt.send_by, on_time: stmt.on_time, breakdown, document_id: doc.id, sha256: doc.sha256, status: send ? "sent" : "drafted", drafted_at: ctx.now, ...(send ? { sent_at: ctx.now } : {}) }, ctx.actor, ctx.now);
      if (send) {
        if (str(i, "tps_case_id") && rt.store.get("tps_cases", str(i, "tps_case_id"))) rt.store.put("tps_cases", str(i, "tps_case_id"), { closing_statement_sent_at: ctx.now }, ctx.actor, ctx.now);
        ctx.events.append({ type: "closing_statement.sent", loanId, aggregate: { kind: "closing_statements", id: rec.id }, actor: ctx.actor, payload: { recipient: "sf_cpm", remitted_on: str(i, "remitted_on"), document_id: doc.id, sha256: doc.sha256, amount_due_fnma_cents: tps.amount_due_fnma_cents.toString() } });
      }
      return { ...stmt, document_id: doc.id, sha256: doc.sha256, sent: send, sent_at: send ? ctx.now : null };
    }) },
  { name: "draftEliminationTemplate", kind: "act",
    handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "draft";
      if (op === "approved" || op === "reactivated" || op === "instruct_counsel") {
        need(i, "request_id");
        const req = rt.store.require("elimination_rescission_requests", str(i, "request_id")); const loanId = String(req.data.loan_id ?? loanOf(i, ctx));
        if (op === "instruct_counsel") {
          // Rule 10: the title-restoration step is initiated when counsel is actually instructed — a separate act from the approval, so FNMA_E4102_TITLE_RESTORE_2 can breach.
          if (req.data.status !== "approved" && req.data.status !== "reactivated") throw new RangeError(`request ${req.id} is ${String(req.data.status)}, not approved`);
          need(i, "instruction_document_id");
          const rec = rt.store.put("elimination_rescission_requests", req.id, { title_steps_instructed_at: ctx.now, title_instruction_document_id: str(i, "instruction_document_id") }, ctx.actor, ctx.now);
          ctx.events.append({ type: "attorney.instruction.sent", loanId, aggregate: { kind: "elimination_rescission_requests", id: rec.id }, actor: ctx.actor, payload: { kind: "TITLE_RESTORATION", request_id: rec.id, due: req.data.title_steps_due_at ?? null, instruction_document_id: str(i, "instruction_document_id"), sent_at: ctx.now, attorney_escalation_id: req.data.attorney_escalation_id ?? null } });
          return { ...rec.data, id: rec.id };
        }
        if (op === "reactivated") {
          // Rule 10 / state machine: the loan returns to active servicing — sda_status, escrow and statements resume, delinquency and foreclosure cases reopen, the REO case parks in `rescinded`, and the 5.x re-add goes to readd_requests@fanniemae.com when the LAR removal was accepted.
          const r = rescissionReactivation({ lar_removal_accepted: i.lar_removal_accepted === undefined ? req.data.lar_removal_accepted === true : flag(i, "lar_removal_accepted"), action_code: optStr(i, "action_code") ?? (typeof req.data.action_code === "string" ? req.data.action_code : null) });
          const readd = r.readd_request.required ? openPortalRow(rt, ctx, loanId, r.readd_request.task_type, toIso(Date.parse(ctx.now) + 24 * 3_600_000), { mailbox: r.readd_request.mailbox, request_id: req.id, action_code: r.readd_request.action_code, reason: `E-4.1-02 rescission approved — re-add the loan through ${r.readd_request.mailbox} (LAR ${r.readd_request.action_code ?? "70/72"} removal was accepted)` }, { request_id: req.id }) : null;
          const rec = rt.store.put("elimination_rescission_requests", req.id, { reintegrated_at: ctx.now, status: "reactivated", readd_portal_task_id: readd?.id ?? null, resumed: r.resumes, cases_reopened: r.reopen }, ctx.actor, ctx.now);
          const reoCaseId = typeof req.data.reo_case_id === "string" ? req.data.reo_case_id : rt.store.list("reo_cases", (d) => d.loan_id === loanId)[0]?.id;
          if (reoCaseId && rt.store.get("reo_cases", reoCaseId)) rt.store.put("reo_cases", reoCaseId, { status: r.reo_case_status, rescinded_at: ctx.now }, ctx.actor, ctx.now);
          ctx.events.append({ type: "loan.reactivated", loanId, aggregate: { kind: "elimination_rescission_requests", id: rec.id }, actor: ctx.actor, payload: { reactivated_at: ctx.now, sda_status: "resumed", escrow: "resumed", statements: "resumed", cases_reopened: r.reopen, reo_case_status: r.reo_case_status, readd_request: r.readd_request.required ? r.readd_request.mailbox : null, readd_portal_task_id: readd?.id ?? null, reason: "e4102_rescission" } });
          ctx.events.append({ type: "sda_status.resumed", loanId, actor: ctx.actor, payload: { reason: "e4102_rescission", request_id: rec.id, resumed_at: ctx.now } });
          ctx.events.append({ type: "delinquency.case.reopened", loanId, actor: ctx.actor, payload: { reason: "e4102_rescission", request_id: rec.id } });
          ctx.events.append({ type: "foreclosure.case.reopened", loanId, actor: ctx.actor, payload: { reason: "e4102_rescission", request_id: rec.id, refo_fees_reimbursable: req.data.fees_nonreimbursable_reason === null } });
          return { ...rec.data, id: rec.id, readd_portal_task_id: readd?.id ?? null, readd_owner_role: readd?.ownerRole ?? null, reactivation: r };
        }
        need(i, "approved_at");
        const approvedMs = Date.parse(str(i, "approved_at"));
        const clocks = rescissionClocks(D(String(req.data.identified_at).slice(0, 10)), approvedMs);
        // The approval arms the 24-h re-add and 2-day title-restoration clocks and opens the attorney escalation; the instruction itself is `op=instruct_counsel`.
        const att = rt.escalations.open({ kind: "attorney", loanId, payload: { reason: "E-4.1-02 rescission approved — initiate title-restoration steps within two days", instruction: "TITLE_RESTORATION", due: clocks.counsel_by, request_id: req.id, refo_fees_reimbursable: req.data.fees_nonreimbursable_reason === null } }, ctx.actor);
        const rec = rt.store.put("elimination_rescission_requests", req.id, { approved_at: str(i, "approved_at"), reintegrate_due_at: toIso(clocks.reactivate_by_ms!), title_steps_due_at: clocks.counsel_by, status: "approved", attorney_escalation_id: att.id, ...(i.lar_removal_accepted !== undefined ? { lar_removal_accepted: flag(i, "lar_removal_accepted") } : {}), ...(optStr(i, "action_code") ? { action_code: str(i, "action_code") } : {}) }, ctx.actor, ctx.now);
        ctx.events.append({ type: "sale.rescission.approved", loanId, aggregate: { kind: "elimination_rescission_requests", id: rec.id }, actor: ctx.actor, payload: { notification: str(i, "approved_at"), request_id: rec.id, reintegrate_due_at: toIso(clocks.reactivate_by_ms!), title_steps_due_at: clocks.counsel_by, attorney_escalation_id: att.id } });
        ctx.events.append({ type: "loan.reactivation.requested", loanId, actor: ctx.actor, payload: { due_at: toIso(clocks.reactivate_by_ms!), request_id: rec.id } });
        return { ...rec.data, attorney_escalation_id: att.id, reintegrate_due_at: toIso(clocks.reactivate_by_ms!), title_steps_due_at: clocks.counsel_by };
      }
      need(i, "loan_id", "reason_code", "identified_on");
      const t = eliminationTemplate({ loan_id: str(i, "loan_id"), fnma_loan_number: str(i, "fnma_loan_number"), property_address: str(i, "property_address"), kind: (str(i, "kind") || "rescission") as "elimination" | "rescission" | "both", reason_code: str(i, "reason_code") as RescissionReason, reason_text: str(i, "reason_text"), identified_on: date(i, "identified_on"), supporting_document_ids: (i.supporting_document_ids as string[] | undefined) ?? [], servicer_caused: flag(i, "servicer_caused") });
      const rec = rt.store.put("elimination_rescission_requests", str(i, "id") || `err-${str(i, "loan_id")}-${str(i, "identified_on")}`, { reo_case_id: optStr(i, "reo_case_id"), loan_id: str(i, "loan_id"), kind: t.rows.requested_action, reason_code: t.rows.reason_code, identified_at: str(i, "identified_on"), submit_due_at: t.submit_due, template: t.rows, fees_nonreimbursable_reason: t.fees_nonreimbursable_reason, lar_removal_accepted: i.lar_removal_accepted === undefined ? null : flag(i, "lar_removal_accepted"), action_code: optStr(i, "action_code"), status: "drafted", drafted_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: "sale.rescission_issue.identified", loanId: str(i, "loan_id"), aggregate: { kind: "elimination_rescission_requests", id: rec.id }, actor: ctx.actor, payload: { identification: str(i, "identified_on"), reason_code: t.rows.reason_code, kind: t.rows.requested_action } });
      ctx.events.append({ type: "elimination_rescission.request.drafted", loanId: str(i, "loan_id"), aggregate: { kind: "elimination_rescission_requests", id: rec.id }, actor: ctx.actor, payload: { kind: t.rows.requested_action, reason_code: t.rows.reason_code, submit_due: t.submit_due, submitted_by: t.submitted_by } });
      const task = openPortalRow(rt, ctx, str(i, "loan_id"), t.portal_task_type, toIso(zonedEpochMs(t.submit_due, "17:00", ET)), { request_id: rec.id, channel: t.channel, template: t.rows, reason: `e-mail the Elimination/Rescission Request Template by ${t.submit_due} (E-4.1-02)` }, { request_id: rec.id });
      const reoCaseId = optStr(i, "reo_case_id") ?? rt.store.list("reo_cases", (d) => d.loan_id === str(i, "loan_id"))[0]?.id;
      if (reoCaseId && rt.store.get("reo_cases", reoCaseId)) rt.store.put("reo_cases", reoCaseId, { status: "elimination_requested" }, ctx.actor, ctx.now);
      return { ...rec.data, id: rec.id, portal_task_id: task.id, owner_role: task.ownerRole, template: t };
    }) },
  { name: "recordDecision", kind: "act", handler: decision() },
]);
