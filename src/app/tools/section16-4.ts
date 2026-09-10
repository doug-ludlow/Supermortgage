/**
 * §16.4 tools — the spec's tool strings for process 16.4, verbatim, via
 * `defineTools("16.4", "payoff-release", defs)` from ../tools.ts (see section13.ts). Spread by ./section16.ts.
 *
 * spec/registry/agents.json names two 16.4 tools (`checkDeactivationEligibility`, `validateMinIntegrity`) and
 * src/app/tools.test.ts refuses any other name for the process, so the rest of the spec's toolset for the
 * deactivation family runs as `op`s of checkDeactivationEligibility, named after the spec's tool strings:
 *   check (default)      rule 1 eligibility; logs a blocked attempt (`mers.deactivation.refused`, T2); appends
 *                        `mers.deactivation.eligible{last_recorded_at}` once per (min, txn_type, effective_date) —
 *                        the last county's recording, which arms MERS_PROC_PAID_IN_FULL_DEACTIVATE_60 / _5BD (T1, T3);
 *                        `mers.deactivation.multi_county_warning` while other counties are pending (T3)
 *   prepare              (`prepare_transaction=true`) the deactivation submit: `mers.deactivation.submit_requested`
 *                        is appended *before* the registered evaluator `16.4.allCountiesRecorded` is asserted, so a
 *                        blocked submit arms the gate row and is refused (NO_DEACTIVATE_BEFORE_RECORDING; T2);
 *                        rule-2 integrity → `mers_transactions` row (prepared) + `mers.deactivation.requested`
 *   schedule             rule 3 batch ride (T+0 / T+1 / same-day)
 *   ingestMersAck        rule 3 ack for the prepared row: `mers.txn.accepted{txn_type, accepted_at, enote,
 *                        paper_note_return_required}` (T1) or `mers.txn.rejected` + exception (T4)
 *   resubmit             rule 3 resubmission within 1 BD; a data mismatch needs the 1.5 MIN update first (T4)
 *   snapshotMins         rule 4 post-acceptance snapshot → `mers.snapshot.verified{status=inactive}` (T1) or the
 *                        post-reversal `mers.deactivation.reversed{status=active}` (T6); `mers_min_snapshots` rows
 *   requestENoteStatus   rule 5 `mers_eregistry_transactions` rows → `enote.status.paid_off{status}` /
 *                        `enote.registration.deactivated`; `human_portal_task` for the `fnma_portal_operator` when a
 *                        Fannie Mae UI step is required; `officer` when the Controller is not Fannie Mae (T5)
 *   printENoteCopy       rule 5 F-1-09 letter `NTC_ENOTE_PAPER_COPY` through the Notice Registry (mail_only) →
 *                        `notice.sent{template}` satisfies SM_ENOTE_PAPER_COPY_10BD; `enote.paper_copy.sent` (T5)
 *   reverse              (`txn_type=deactivation_reversal`) rule 6: `mers.deactivation.reversal_needed` arms
 *                        SM_MERS_DEACT_REVERSAL_5BD; `officer` outside the window ($24.95 re-registration to the
 *                        partner's invoice + QA finding), `attorney` when contested; a payoff reversed before any
 *                        deactivation cancels eligibility (open 60-day / 5-BD instances) — nothing to reverse (T6)
 *   reconcileMre         rule 4 monthly MRE: `mers.mre.received` → findings (`mers_qa_findings`, sev-1 `officer`),
 *                        the stale MIN becomes eligible on its recording date, `mers.recon.completed` (T7)
 *   batchOutage          Integrations: escalate at deadline − 5 days; the `officer`-authorized MERS OnLine task (T8)
 * Guardrails encode the Agents paragraph over fields the handlers read: never deactivate a MIN whose loan is not
 * `paid_in_full`/charged-off (`loan_status`); no reversal without a documented cause (`cause` + `cause_document_id`);
 * the LLM only classifies rejects and drafts QA notes (`llm_reject_class` / `llm_qa_note` are its only authored
 * fields — a hand-keyed `transaction` on a resubmission is the ops-console AI-off path, a human act); no borrower
 * contact except the eNote paper-copy letter (`template_code`). The recording gate is asserted in the handler after
 * the submit-attempt event, the 16.3 `lien_release.execution_requested` → `16.3.lpoaRecordedForState` pattern.
 */
import { defineTools, compute, noticeOps, never, humanWhen, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { Escalation as EscalationRow } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { EVALUATORS_16_4 } from "../../domain/payoff/evaluators-16-4.ts";
import { deactivationClocks } from "../../domain/payoff/release.ts";
import { deactivationEligibility, minIntegrity, prepareDeactivation, batchSchedule, mersAck, mersResubmission, verificationSnapshot, reactivationSnapshot, mreReconcile, enoteOverlay, eregistryTransaction, enotePaperCopy, deactivationReversal, batchOutage, submitRequestedEvent, mersTxnKey, RELEASE_GATE, REVERSAL_CAUSES, type ReleaseTask, type MinRecordFields, type ReversalCause, type MreRow, type RejectAction, type ERegistryTxnType, type Escalation, type MersAck, type MinSnapshotRow, type Eligibility } from "../../domain/payoff/ops-16-4.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : String(i[k]));
const today = (i: ToolInput, ctx: { now: string }): PlainDate => optDate(i, "today") ?? D(ctx.now.slice(0, 10));
const S = (d: Record<string, unknown>, k: string): string => String(d[k] ?? "");
const PAID = ["paid_in_full", "charged_off"];
const AGENT = "payoff-release";
export const OPS = ["check", "prepare", "schedule", "ingestMersAck", "resubmit", "snapshotMins", "requestENoteStatus", "printENoteCopy", "reverse", "reconcileMre", "batchOutage"] as const;
type Op = (typeof OPS)[number];
type DeactTxn = "deactivation_paid_in_full" | "deactivation_reversal";
const tasksOf = (i: ToolInput): ReleaseTask[] => (Array.isArray(i.release_tasks) ? i.release_tasks : []) as ReleaseTask[];
const isReversal = (i: ToolInput): boolean => str(i, "txn_type") === "deactivation_reversal" || str(i, "op") === "reverse";
/** The op: the spec's tool string, else the legacy flags (`txn_type=deactivation_reversal` → reverse; `prepare_transaction` → prepare). */
export const opOf = (i: ToolInput): Op => { const o = str(i, "op"); if ((OPS as readonly string[]).includes(o)) return o as Op; if (isReversal(i)) return "reverse"; return flag(i, "prepare_transaction") ? "prepare" : "check"; };
const preparing = (i: ToolInput): boolean => opOf(i) === "prepare";
const causeUndocumented = (i: ToolInput): boolean => !(REVERSAL_CAUSES as readonly string[]).includes(str(i, "cause")) || str(i, "cause_document_id") === "";
const fields = (v: unknown, k: string): MinRecordFields => {
  const o = (v ?? null) as Record<string, unknown> | null; if (!o) throw new RangeError(`${k} is required`);
  const amt = o.original_amount_cents; if (amt === undefined || amt === null || amt === "") throw new RangeError(`${k}.original_amount_cents is required`);
  return { borrower_names: Array.isArray(o.borrower_names) ? (o.borrower_names as unknown[]).map(String) : [], property_address: String(o.property_address ?? ""), note_date: D(String(o.note_date ?? "")), original_amount_cents: typeof amt === "bigint" ? amt : BigInt(String(amt)) };
};
const integrityOf = (i: ToolInput): ReturnType<typeof minIntegrity> => { need(i, "min", "our_org_id"); return minIntegrity({ min: str(i, "min"), platform: fields(i.platform, "platform"), mers: fields(i.mers, "mers"), our_org_id: str(i, "our_org_id"), min_subservicer_org_id: optStr(i, "min_subservicer_org_id") }); };

/** A handler-level refusal (the recording gate over the registered evaluator, the rule-3 resubmission rules): logged as `command.refused` like a bus guardrail and thrown as CommandRefused. */
function refuse(ctx: CommandContext, loanId: string, code: string, citation: string, reason: string, extra: Record<string, unknown> = {}): never {
  ctx.events.append({ type: "command.refused", loanId, actor: ctx.actor, payload: { command: "checkDeactivationEligibility", code, citation, reason, ...extra } });
  throw new CommandRefused("checkDeactivationEligibility", code, citation, reason);
}
const GATE_CITATION = "16.4 guardrail: never deactivate before recording evidence (SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE; rule 1) — the gate cannot be overridden";
const append = (ctx: CommandContext, loanId: string, ev: Record<string, unknown> & { type: string }): string => { const { type, ...payload } = ev; return ctx.events.append({ type, loanId, actor: ctx.actor, payload }).id; };
const seen = (ctx: CommandContext, loanId: string, type: string, where: (p: Record<string, unknown>) => boolean): boolean => ctx.events.byLoan(loanId).some((ev) => ev.type === type && where(ev.payload as Record<string, unknown>));
/** Opens the role's work item once; `sev3` breaches go to the ops queue, everything else to the named role (agents.json escalations). */
function openEscalation(rt: ToolRuntime, ctx: CommandContext, loanId: string, e: Escalation, payload: Record<string, unknown>): EscalationRow {
  const kind = e.kind === "fnma_portal_operator" ? { kind: "human_portal_task" as const, ownerRole: "fnma_portal_operator" } : { kind: e.severity === "sev3" ? ("sev3" as const) : e.kind };
  return rt.escalations.open({ ...kind, loanId, severity: e.severity, payload: { reason: e.reason, ...payload } }, ctx.actor);
}
/** The latest `mers_transactions` row for a MIN and transaction type (by effective date). */
const latestRow = (rt: ToolRuntime, min: string, txn_type: string) => [...rt.store.list("mers_transactions", (d) => d.min === min && d.txn_type === txn_type && d.status !== "cancelled")].sort((a, b) => S(b.data, "effective_date").localeCompare(S(a.data, "effective_date")))[0] ?? null;
const eligibilityOf = (i: ToolInput, ctx: CommandContext): Eligibility => deactivationEligibility({ min: str(i, "min"), loan_id: str(i, "loan_id"), loan_status: str(i, "loan_status"), min_status: str(i, "min_status") === "inactive" ? "inactive" : "active", release_tasks: tasksOf(i), chargeoff_release_recorded_on: optDate(i, "chargeoff_release_recorded_on"), attempted_on: today(i, ctx), actor: ctx.actor.id });
/** `mers.deactivation.eligible` once per (min, txn_type, effective_date) — the spec's idempotency key; re-running the check never re-arms the 60-day row. */
function armEligible(ctx: CommandContext, loanId: string, e: Eligibility): string | null {
  const ev = e.eligible_event; if (!ev) return null;
  if (seen(ctx, loanId, ev.type, (p) => p.min === ev.min && p.last_recorded_at === ev.last_recorded_at)) return null;
  return append(ctx, loanId, { ...ev });
}

// ---------------------------------------------------------------- ops
function check(i: ToolInput, ctx: CommandContext, op: "check" | "prepare", rt: ToolRuntime): unknown {
  need(i, "loan_id", "min", "loan_status", "min_status");
  const loanId = str(i, "loan_id"), min = str(i, "min"), on = today(i, ctx);
  const eligibility = eligibilityOf(i, ctx);
  const w = eligibility.warning_event;
  const warning_event_id = w && !seen(ctx, loanId, w.type, (p) => p.min === min && p.first_recorded_on === w.first_recorded_on) ? append(ctx, loanId, { ...w }) : null;
  if (op === "check") {
    if (eligibility.attempt_log) append(ctx, loanId, { ...eligibility.attempt_log });   // T2: the gate logs the attempt
    const eligible_event_id = armEligible(ctx, loanId, eligibility);
    return { ...eligibility, eligible_event_id, warning_event_id };
  }
  // the deactivation submit: the attempt is on the log before the gate is asserted (arms SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE)
  append(ctx, loanId, { ...submitRequestedEvent(eligibility, min, loanId, on) });
  const gate = EVALUATORS_16_4["16.4.allCountiesRecorded"]!({ release_tasks: tasksOf(i), chargeoff_release_recorded_on: optStr(i, "chargeoff_release_recorded_on") ?? "" });
  if (eligibility.state === "not_payoff") refuse(ctx, loanId, "LOAN_NOT_PAID_IN_FULL", "16.4 guardrail: never deactivate a MIN whose loan is not `paid_in_full`/charged-off", eligibility.refusal ?? "loan not paid in full", { min });
  if (!gate.open || eligibility.state === "awaiting_release") {
    if (eligibility.attempt_log) append(ctx, loanId, { ...eligibility.attempt_log });
    refuse(ctx, loanId, "NO_DEACTIVATE_BEFORE_RECORDING", GATE_CITATION, gate.reason ?? eligibility.refusal ?? "release not recorded", { min, gate: RELEASE_GATE, blocked_counties: eligibility.blocked_counties });
  }
  if (eligibility.state === "already_inactive") return { eligibility, integrity: null, prepared: false, refusal: eligibility.refusal, next_state: "already_inactive", transaction: null, transaction_id: null, requested_event: null };
  const eligible_event_id = armEligible(ctx, loanId, eligibility);
  const integrity = integrityOf(i);
  const prepared = prepareDeactivation({ loan_id: loanId, eligibility, integrity });
  if (!prepared.prepared || !prepared.transaction) return { eligibility, integrity, ...prepared, transaction_id: null, eligible_event_id };
  const key = mersTxnKey(min, prepared.transaction.txn_type, prepared.transaction.effective_date);
  const existing = rt.store.get("mers_transactions", key);
  if (!existing) {
    rt.store.put("mers_transactions", key, { id: key, ...prepared.transaction, submitted_by_org_id: prepared.transaction.submitting_org_id, release_task_id: prepared.transaction.release_task_ids[prepared.transaction.release_task_ids.length - 1] ?? null, due_on: eligibility.clocks!.due_on, policy_target: eligibility.clocks!.policy_target, escalate_on: eligibility.clocks!.escalate_on, prepared_on: on, min_subservicer_org_id: optStr(i, "min_subservicer_org_id"), resubmit_attempt: 0, enote: flag(i, "enote"), paper_note_return_required: flag(i, "paper_note_return_required") }, ctx.actor, ctx.now);
    append(ctx, loanId, { ...prepared.requested_event! });
  }
  return { eligibility, integrity, ...prepared, transaction_id: key, row: rt.store.get("mers_transactions", key)!.data, eligible_event_id };
}

function schedule(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min");
  const min = str(i, "min"); const row = latestRow(rt, min, "deactivation_paid_in_full");
  const effective = optDate(i, "effective_date") ?? (row ? D(S(row.data, "effective_date")) : null); if (!effective) throw new RangeError("effective_date is required (no prepared deactivation for this MIN)");
  const due_on = optDate(i, "due_on") ?? (row && row.data.due_on ? D(S(row.data, "due_on")) : deactivationClocks(effective).due_on);
  const b = batchSchedule({ eligible_on: optDate(i, "eligible_on") ?? today(i, ctx), due_on, evidence_time_local: optStr(i, "evidence_time_local") });
  if (row) rt.store.put("mers_transactions", row.id, { batch_on: b.batch_on, batch_window: b.window, same_day_required: b.same_day_required, ack_expected_on: b.ack_ingested_on }, ctx.actor, ctx.now);
  return { ...b, due_on, transaction_id: row?.id ?? null };
}

function ingestAck(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min", "ack", "our_org_id");
  const loanId = str(i, "loan_id"), min = str(i, "min"); const txn_type = (str(i, "txn_type") || "deactivation_paid_in_full") as DeactTxn;
  if (txn_type !== "deactivation_paid_in_full" && txn_type !== "deactivation_reversal") throw new RangeError(`txn_type ${txn_type} is not a 16.4 transaction`);
  const a = i.ack as Record<string, unknown>; const status = String(a.status ?? "");
  const ack: MersAck = status === "accepted" ? { status: "accepted" } : status === "rejected" ? { status: "rejected", reject_code: String(a.reject_code ?? ""), reject_reason: String(a.reject_reason ?? "") } : (() => { throw new RangeError("ack.status must be accepted or rejected"); })();
  const row = latestRow(rt, min, txn_type); const d = row?.data ?? {};
  const ingested = optDate(i, "ack_ingested_on") ?? today(i, ctx);
  const opt = (k: string): PlainDate | null => optDate(i, k) ?? (d[k] ? D(S(d, k)) : null);
  // the 1.5 Subservicer-designation check (T4): the caller's answer wins when given (null = MERS names nobody), else the platform's record on the row
  const designation = i.min_subservicer_org_id !== undefined ? optStr(i, "min_subservicer_org_id") : d.min_subservicer_org_id ? S(d, "min_subservicer_org_id") : null;
  const r = mersAck({ min, txn_type, submitted_on: optDate(i, "submitted_on") ?? opt("batch_on") ?? ingested, ack_ingested_on: ingested, ack, our_org_id: str(i, "our_org_id"), min_subservicer_org_id: designation, due_on: opt("due_on") ?? opt("submit_by"), policy_target: opt("policy_target"), effective_date: opt("effective_date"), batch_id: optStr(i, "batch_id"),
    enote: flag(i, "enote") || d.enote === true, paper_note_return_required: flag(i, "paper_note_return_required") || d.paper_note_return_required === true, llm: { reject_class: optStr(i, "llm_reject_class"), qa_note: optStr(i, "llm_qa_note") } });
  if (r.state === "accepted" && r.event) {
    if (row) rt.store.put("mers_transactions", row.id, { status: "accepted", accepted_on: r.accepted_on, acked_at: ctx.now, batch_id: optStr(i, "batch_id"), on_time_deadline: r.on_time.deadline, on_time_policy: r.on_time.policy_target, verify_by: r.verify_by }, ctx.actor, ctx.now);
    const event_id = append(ctx, loanId, { ...r.event });
    return { ...r, transaction_id: row?.id ?? null, event_id };
  }
  const rj = r.reject!;
  const exceptionId = `${row?.id ?? mersTxnKey(min, txn_type, ingested)}:reject:${ingested}`;
  rt.store.put("mers_exceptions", exceptionId, { ...rj.exception, loan_id: loanId, reject_class: rj.reject_class, action: rj.subservicer_check.action, subservicer_check: rj.subservicer_check, resubmit_by: rj.resubmit_by, llm_drafts: rj.llm_drafts, llm_scope: rj.llm_scope }, ctx.actor, ctx.now);
  if (row) rt.store.put("mers_transactions", row.id, { status: "rejected", mers_reject_code: rj.exception.reject_code, reject_reason: rj.exception.reject_reason, reject_class: rj.reject_class, reject_action: rj.subservicer_check.action, min_subservicer_org_id: designation, rejected_on: ingested, resubmit_by: rj.resubmit_by, exception_id: exceptionId, next_state: rj.next_state }, ctx.actor, ctx.now);
  const event_id = append(ctx, loanId, { ...rj.event, exception_id: exceptionId });
  return { ...r, transaction_id: row?.id ?? null, exception_id: exceptionId, event_id };
}

function resubmit(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min");
  const loanId = str(i, "loan_id"), min = str(i, "min"); const txn_type = (str(i, "txn_type") || "deactivation_paid_in_full") as DeactTxn;
  const row = latestRow(rt, min, txn_type); if (!row || S(row.data, "status") !== "rejected") throw new RangeError(`no rejected ${txn_type} for MIN ${min} to resubmit`);
  const d = row.data;
  const r = mersResubmission({ min, txn_type, reject_action: S(d, "reject_action") as RejectAction, resubmit_by: D(S(d, "resubmit_by")), resubmitted_on: today(i, ctx), attempt: Number(d.resubmit_attempt ?? 0), min_update_accepted_on: optDate(i, "min_update_accepted_on"), min_subservicer_org_id: optStr(i, "min_subservicer_org_id") ?? (d.min_subservicer_org_id ? S(d, "min_subservicer_org_id") : null), our_org_id: str(i, "our_org_id") || S(d, "submitting_org_id") });
  if (!r.allowed || !r.event) refuse(ctx, loanId, r.refusal!.code, "16.4 rule 3: rejects are mapped and resubmitted within 1 BD; a mismatch is corrected first (Rule 2 §4)", r.refusal!.reason, { min, transaction_id: row.id });
  rt.store.put("mers_transactions", row.id, { status: "prepared", resubmit_attempt: r.attempt, resubmitted_on: r.event.resubmitted_at, resubmitted_on_time: r.on_time, min_subservicer_org_id: optStr(i, "min_subservicer_org_id") ?? d.min_subservicer_org_id ?? null, ...(optDate(i, "min_update_accepted_on") ? { min_update_accepted_on: optDate(i, "min_update_accepted_on") } : {}), ...(i.transaction !== undefined ? { manual_transaction: i.transaction, manual_keyed_by: `${ctx.actor.kind}:${ctx.actor.id}` } : {}) }, ctx.actor, ctx.now);
  if (d.exception_id) rt.store.put("mers_exceptions", S(d, "exception_id"), { status: "resubmitted", resubmitted_on: r.event.resubmitted_at }, ctx.actor, ctx.now);
  const event_id = append(ctx, loanId, { ...r.event });
  return { ...r, transaction_id: row.id, event_id };
}

function snapshot(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min", "snapshot");
  const loanId = str(i, "loan_id"), min = str(i, "min"); const s = i.snapshot as Record<string, unknown>;
  const snap: MinSnapshotRow = { taken_on: D(String(s.taken_on ?? "")), status: String(s.status ?? "").toLowerCase() === "active" ? "active" : "inactive", reason: s.reason === undefined || s.reason === null ? null : String(s.reason) };
  const txn_type = (str(i, "txn_type") || "deactivation_paid_in_full") as DeactTxn;
  const row = latestRow(rt, min, txn_type);
  const accepted = optDate(i, "accepted_on") ?? (row?.data.accepted_on ? D(S(row.data, "accepted_on")) : null); if (!accepted) throw new RangeError("accepted_on is required (no accepted transaction for this MIN)");
  const putSnap = (r: { min: string; taken_on: PlainDate; status: string; reason: string | null; verified: boolean } | null) => r ? rt.store.put("mers_min_snapshots", `${min}:${r.taken_on}`, { ...r, loan_id: loanId, verified_transaction_id: row?.id ?? null }, ctx.actor, ctx.now).id : null;
  if (txn_type === "deactivation_reversal") {
    const r = reactivationSnapshot({ min, reversal_accepted_on: accepted, snapshot: snap }); const snapshot_id = putSnap(r.snapshot_row);
    if (row && r.reactivated) rt.store.put("mers_transactions", row.id, { status: "confirmed", verified_snapshot_id: snapshot_id, reactivated_on: r.satisfied_on }, ctx.actor, ctx.now);
    const event_id = r.event ? append(ctx, loanId, { ...r.event }) : null;
    const escalation_id = r.escalation ? openEscalation(rt, ctx, loanId, r.escalation, { min, snapshot_id, transaction_id: row?.id ?? null }).id : null;
    return { ...r, snapshot_id, event_id, escalation_id, transaction_id: row?.id ?? null };
  }
  const r = verificationSnapshot({ min, accepted_on: accepted, snapshot: snap }); const snapshot_id = putSnap(r.snapshot_row);
  if (row && r.verified) rt.store.put("mers_transactions", row.id, { status: "confirmed", verified_snapshot_id: snapshot_id, verified_on: r.satisfied_on }, ctx.actor, ctx.now);
  const event_id = r.event ? append(ctx, loanId, { ...r.event }) : null;
  const escalation_id = r.escalation ? openEscalation(rt, ctx, loanId, r.escalation, { min, snapshot_id, transaction_id: row?.id ?? null, timer: "SM_MERS_DEACTIVATION_VERIFY_3BD" }).id : null;
  return { ...r, snapshot_id, event_id, escalation_id, transaction_id: row?.id ?? null };
}

function enoteStatus(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min");
  const loanId = str(i, "loan_id"), min = str(i, "min"); const txn_type = (str(i, "txn_type") || "change_status_paid_off") as ERegistryTxnType;
  if (!["change_status_paid_off", "registration_deactivation", "change_status_reversal"].includes(txn_type)) throw new RangeError(`txn_type ${txn_type} is not an eRegistry transaction`);
  const payoff_on = optDate(i, "payoff_on"); if (txn_type === "change_status_paid_off" && !payoff_on) throw new RangeError("payoff_on is required");
  const controller = str(i, "controller") === "other" ? "other" : "fnma"; const ui = flag(i, "requires_fnma_ui");
  const overlay = enoteOverlay({ payoff_on: payoff_on ?? today(i, ctx), release_recorded_on: optDate(i, "release_recorded_on"), deactivation_accepted_on: optDate(i, "deactivation_accepted_on"), paper_note_return_required: flag(i, "paper_note_return_required"), controller, requires_fnma_ui: ui });
  const a = (i.ack ?? null) as Record<string, unknown> | null; const ackStatus = a ? String(a.status ?? "") : "";
  const t = eregistryTransaction({ loan_id: loanId, min, enote_id: optStr(i, "enote_id"), txn_type, requested_on: optDate(i, "requested_on") ?? today(i, ctx), requested_via: ui ? "ui" : (str(i, "requested_via") === "fnma_request" ? "fnma_request" : "evault_api"), controller_org_id: optStr(i, "controller_org_id"), ack: a && ["accepted", "rejected", "confirmed"].includes(ackStatus) ? { status: ackStatus as "accepted" | "rejected" | "confirmed", reference: a.reference === undefined ? null : String(a.reference), evidence_document_id: a.evidence_document_id === undefined ? null : String(a.evidence_document_id) } : null, payoff_on, release_recorded_on: optDate(i, "release_recorded_on") });
  if (t.refusal || !t.row || !t.event) refuse(ctx, loanId, "NO_DEACTIVATE_BEFORE_RECORDING", "16.4 rule 5: after the release records, deactivate the eRegistry registration and the MERS System MIN", t.refusal ?? "refused", { min, txn_type });
  const existing = rt.store.get("mers_eregistry_transactions", t.row.id);
  const rec = rt.store.put("mers_eregistry_transactions", t.row.id, existing ? { status: t.row.status, ack_reference: t.row.ack_reference ?? existing.data.ack_reference ?? null, evidence_document_id: t.row.evidence_document_id ?? existing.data.evidence_document_id ?? null, ...(t.row.status !== "requested" ? { acked_at: ctx.now } : {}) } : { ...t.row, due_by: t.event.due_by }, ctx.actor, ctx.now);
  const event_id = seen(ctx, loanId, t.event.type, (p) => p.min === min && p.txn_type === txn_type && p.status === t.event!.status && p.requested_at === t.event!.requested_at) ? null : append(ctx, loanId, { ...t.event, eregistry_transaction_id: rec.id });
  const pkg = { min, enote_id: optStr(i, "enote_id"), payoff_evidence_document_id: optStr(i, "payoff_evidence_document_id"), requested_status: txn_type === "change_status_paid_off" ? "Paid Off" : txn_type, requested_on: t.row.requested_at, due_by: t.event.due_by };
  const portal = overlay.portal_task && !existing ? rt.escalations.open({ kind: "human_portal_task", loanId, ownerRole: overlay.portal_task.owner, payload: { task: "enote_status_change_fnma_ui", eregistry_transaction_id: rec.id, package: pkg, reason: "eNote status change requires a Fannie Mae UI step (16.4 Integrations: no Fannie Mae UI automation)" } }, ctx.actor) : null;
  const esc = overlay.escalation && !existing ? openEscalation(rt, ctx, loanId, overlay.escalation, { eregistry_transaction_id: rec.id, package: pkg }) : null;
  return { ...t, row: rec.data, eregistry_transaction_id: rec.id, event_id, status_request: overlay.status_request, registration_deactivation: overlay.registration_deactivation, portal_task: overlay.portal_task, portal_task_id: portal?.id ?? null, escalation: overlay.escalation, escalation_id: esc?.id ?? null };
}

async function paperCopy(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  need(i, "loan_id", "min", "payoff_on", "release_recorded_on");
  const loanId = str(i, "loan_id"), min = str(i, "min"); const mailed_on = optDate(i, "mailed_on") ?? today(i, ctx);
  const required = i.paper_note_return_required === undefined ? true : flag(i, "paper_note_return_required");   // open question 4 default: the F-1-09 paper-copy step in every state until counsel confirms the list
  const accepted = optDate(i, "deactivation_accepted_on") ?? (latestRow(rt, min, "deactivation_paid_in_full")?.data.accepted_on ? D(S(latestRow(rt, min, "deactivation_paid_in_full")!.data, "accepted_on")) : null);
  const plan = enoteOverlay({ payoff_on: date(i, "payoff_on"), release_recorded_on: date(i, "release_recorded_on"), deactivation_accepted_on: accepted, paper_note_return_required: required, controller: "fnma" });
  if (!required || !plan.paper_copy) return { required: false, paper_copy: null, notice_id: null, event: null };
  need(i, "recipients");
  const template = str(i, "template_code") || "NTC_ENOTE_PAPER_COPY";
  const payload = { ...((i.payload as Record<string, unknown> | undefined) ?? {}), min, payoff_date: str(i, "payoff_on"), recorded_date: str(i, "release_recorded_on"), enclosure_marked_copy_paid_in_full: true, ...(optStr(i, "evault_document_id") ? { evault_document_id: optStr(i, "evault_document_id") } : {}) };
  const notice = (await noticeOps("render_send")({ ...i, template_code: template, loan_id: loanId, payload, as_of: mailed_on }, ctx, rt)) as { id: string; status: string };
  const pc = enotePaperCopy({ loan_id: loanId, min, payoff_on: date(i, "payoff_on"), release_recorded_on: date(i, "release_recorded_on"), deactivation_accepted_on: accepted, paper_note_return_required: required, mailed_on, notice_id: notice.id, evault_document_id: optStr(i, "evault_document_id") });
  const event_id = pc.event ? append(ctx, loanId, { ...pc.event }) : null;
  if (pc.housekeeping) rt.store.put("payoff_housekeeping_tasks", `${loanId}:enote_paper_copy`, { loan_id: loanId, ...pc.housekeeping, notice_id: notice.id }, ctx.actor, ctx.now);
  return { ...pc, paper_copy: plan.paper_copy, notice_id: notice.id, notice_status: notice.status, event_id, template };
}

function reverse(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min", "reversal_needed_on");
  const loanId = str(i, "loan_id"), min = str(i, "min");
  const deact = latestRow(rt, min, "deactivation_paid_in_full");
  const deactivated_on = optDate(i, "deactivated_on") ?? (deact?.data.accepted_on ? D(S(deact.data, "accepted_on")) : null);
  const rv = deactivationReversal({ min, cause: (REVERSAL_CAUSES as readonly string[]).includes(str(i, "cause")) ? (str(i, "cause") as ReversalCause) : null, cause_document_id: optStr(i, "cause_document_id"), reversal_needed_on: date(i, "reversal_needed_on"), deactivated_on, mers_window_open: i.mers_window_open !== false, ...(i.contested === true ? { contested: true } : {}) });
  if (rv.path === "refused") refuse(ctx, loanId, "NO_REVERSAL_WITHOUT_CAUSE", "16.4 guardrail: no reversal without a documented cause (rule 6)", rv.refusal ?? "no documented cause", { min });
  if (rv.cancel_eligibility) {   // reversed before any deactivation: cancel eligibility (open 60-day / 5-BD instances, the prepared row) — nothing to reverse
    const cancelled: string[] = [];
    for (const t of ctx.timers.forSubject("loan", loanId)) if ((rv.cancel_eligibility.timers as readonly string[]).includes(t.code) && (t.status === "armed" || t.status === "breached")) { ctx.timers.cancel(t.id, rv.cancel_eligibility.reason, ctx.actor); cancelled.push(t.id); }
    if (deact) rt.store.put("mers_transactions", deact.id, { status: "cancelled", cancelled_reason: rv.cancel_eligibility.reason }, ctx.actor, ctx.now);
    const event_id = append(ctx, loanId, { ...rv.cancel_eligibility.event, timers_cancelled: cancelled, transaction_id: deact?.id ?? null });
    return { ...rv, timers_cancelled: cancelled, event_id, transaction_id: null, escalation_id: null, qa_finding_id: null };
  }
  const tx = rv.transaction!; const key = mersTxnKey(min, tx.txn_type, tx.effective_date);
  const existing = rt.store.get("mers_transactions", key);
  if (!existing) rt.store.put("mers_transactions", key, { id: key, loan_id: loanId, ...tx, cause: rv.reversal_needed_event!.cause, cause_document_id: rv.reversal_needed_event!.cause_document_id, deactivated_on, submit_by: rv.submit_by, bill_to: rv.bill_to, borrower_charge_cents: 0n, reverses_transaction_id: deact?.id ?? null, contested: i.contested === true, resubmit_attempt: 0 }, ctx.actor, ctx.now);
  const event_id = existing ? null : append(ctx, loanId, { ...rv.reversal_needed_event!, transaction_id: key });
  const qa_finding_id = rv.qa_finding && !existing ? rt.store.put("mers_qa_findings", `${min}:reregister:${tx.effective_date}`, { kind: "reversal_window_passed", min, loan_id: loanId, raised_at: tx.effective_date, fee_cents: rv.fee_cents, bill_to: rv.bill_to, resolved_at: null }, ctx.actor, ctx.now).id : null;
  const esc = rv.escalation && !existing ? openEscalation(rt, ctx, loanId, rv.escalation, { min, transaction_id: key, path: rv.path, submit_by: rv.submit_by, fee_cents: rv.fee_cents, bill_to: rv.bill_to, qa_finding_id }) : null;
  return { ...rv, transaction_id: key, event_id, escalation_id: esc?.id ?? null, qa_finding_id, timers_cancelled: [] };
}

function reconcile(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "mre_received_on", "our_org_id", "rows");
  const rows = (Array.isArray(i.rows) ? i.rows : []) as MreRow[]; const org = str(i, "our_org_id"); const agg = { kind: "mers_org", id: org };
  const r = mreReconcile({ mre_received_on: date(i, "mre_received_on"), our_org_id: org, rows });
  const { type: rt0, ...received } = r.received_event; ctx.events.append({ type: rt0, aggregate: agg, actor: ctx.actor, payload: received });
  const findings = r.findings.map((f) => {
    const id = rt.store.put("mers_qa_findings", `${f.min}:${f.exception}:${f.qa_finding.opened_on}`, { kind: f.exception, min: f.min, loan_id: f.loan_id, severity: f.qa_finding.severity, raised_at: f.qa_finding.opened_on, action: f.action, submit_on: f.submit_on, days_since_recording: f.days_since_recording, resolved_at: null }, ctx.actor, ctx.now).id;
    const esc = f.escalation ? openEscalation(rt, ctx, f.loan_id, f.escalation, { min: f.min, qa_finding_id: id, exception: f.exception, action: f.action, submit_on: f.submit_on }) : null;
    return { ...f, qa_finding_id: id, escalation_id: esc?.id ?? null };
  });
  const eligible_event_ids = r.eligible_events.map((ev) => seen(ctx, ev.loan_id, ev.type, (p) => p.min === ev.min && p.last_recorded_at === ev.last_recorded_at) ? null : append(ctx, ev.loan_id, { ...ev, source_of_eligibility: "mre_reconciliation" }));
  const { type: ct, ...completed } = r.completed_event; const done = ctx.events.append({ type: ct, aggregate: agg, actor: ctx.actor, payload: completed });
  return { findings, clean: r.clean, completed_event: r.completed_event, completed_event_id: done.id, eligible_event_ids };
}

function outage(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "loan_id", "min", "outage_on");
  const loanId = str(i, "loan_id"), min = str(i, "min"); const row = latestRow(rt, min, "deactivation_paid_in_full");
  const due_on = optDate(i, "due_on") ?? (row?.data.due_on ? D(S(row.data, "due_on")) : null); if (!due_on) throw new RangeError("due_on is required (no prepared deactivation for this MIN)");
  const r = batchOutage({ min, outage_on: date(i, "outage_on"), due_on, batch_document_id: optStr(i, "batch_document_id") ?? (row?.data.file_document_id ? S(row.data, "file_document_id") : null) });
  const event_id = append(ctx, loanId, { ...r.event, transaction_id: row?.id ?? null });
  const esc = r.escalation && r.manual_task ? openEscalation(rt, ctx, loanId, r.escalation, { task: r.manual_task.kind, authorized_role: r.manual_task.authorized_role, min, due_on, batch_document_id: r.manual_task.batch_document_id, transaction_id: row?.id ?? null, timers_unaffected: true }) : null;
  if (row && r.escalation_fired) rt.store.put("mers_transactions", row.id, { manual_upload_task_id: esc?.id ?? null, channel: "ui" }, ctx.actor, ctx.now);
  return { ...r, event_id, escalation_id: esc?.id ?? null, transaction_id: row?.id ?? null };
}

const RULE_BY_OP: Record<Op, string> = { check: "16.4 rule 1", prepare: "16.4 rules 1–2", schedule: "16.4 rule 3", ingestMersAck: "16.4 rule 3", resubmit: "16.4 rule 3 / Rule 2 §4", snapshotMins: "16.4 rule 4", requestENoteStatus: "16.4 rule 5", printENoteCopy: "16.4 rule 5 / F-1-09", reverse: "16.4 rule 6", reconcileMre: "16.4 rule 4", batchOutage: "16.4 Integrations (mers outage)" };

export const TOOLS_16_4: readonly ToolDef[] = defineTools("16.4", AGENT, [
  { name: "checkDeactivationEligibility", kind: "act", handler: compute(async (i, ctx, rt) => {
      const op = opOf(i);
      switch (op) {
        case "check": case "prepare": return check(i, ctx, op, rt);
        case "schedule": return schedule(i, ctx, rt);
        case "ingestMersAck": return ingestAck(i, ctx, rt);
        case "resubmit": return resubmit(i, ctx, rt);
        case "snapshotMins": return snapshot(i, ctx, rt);
        case "requestENoteStatus": return enoteStatus(i, ctx, rt);
        case "printENoteCopy": return paperCopy(i, ctx, rt);
        case "reverse": return reverse(i, ctx, rt);
        case "reconcileMre": return reconcile(i, ctx, rt);
        case "batchOutage": return outage(i, ctx, rt);
      }
    }),
    decision: (i, out) => { const op = opOf(i); if (op === "check") return null; const min = str(i, "min"); const o = (out ?? {}) as Record<string, unknown>;
      const summary = [o.path, o.state, o.next_state, o.window, o.transaction_id, o.event_id ? `event ${String(o.event_id)}` : null, o.escalation_id ? `escalation ${String(o.escalation_id)}` : null].filter((x) => x !== undefined && x !== null && x !== "").map(String).join("; ");
      return { action: `checkDeactivationEligibility:${op}`, rationale: str(i, "rationale") || `${RULE_BY_OP[op]}: ${summary || op}`, ...(min ? { subject: { kind: "min", id: min } } : {}), ruleCode: RULE_BY_OP[op] }; },
    guardrails: [
      never("LOAN_NOT_PAID_IN_FULL", "16.4 guardrail: never deactivate a MIN whose loan is not `paid_in_full`/charged-off", (i) => preparing(i) && !PAID.includes(str(i, "loan_status")), "only a paid-in-full or charged-off loan's MIN is deactivated"),
      never("NO_REVERSAL_WITHOUT_CAUSE", "16.4 guardrail: no reversal without a documented cause (rule 6)", (i) => opOf(i) === "reverse" && causeUndocumented(i), "record the cause (payoff_reversed / wrong_min) with its evidence document first"),
      humanWhen("LLM_CLASSIFIES_ONLY", "16.4 guardrail: the LLM only classifies rejects and drafts QA notes", (i) => opOf(i) === "resubmit" && i.transaction !== undefined, "the resubmitted transaction is the platform's prepared row (llm_reject_class / llm_qa_note are the agent's only authored fields; a mismatch is corrected through the 1.5 MIN update with evidence, Rule 2 §4) — a hand-keyed transaction is the ops-console MERS workbench path, a human act"),
      never("NO_BORROWER_CONTACT_EXCEPT_PAPER_COPY", "16.4 guardrail: no borrower contact except the eNote paper-copy letter", (i) => opOf(i) === "printENoteCopy" && str(i, "template_code") !== "" && str(i, "template_code") !== "NTC_ENOTE_PAPER_COPY", "the only borrower letter in 16.4 is NTC_ENOTE_PAPER_COPY (F-1-09), rendered from the Notice Registry"),
    ] },
  // rule 2: the 1.5 data-integrity check (borrower names, property, note date, original amount) against the MERS snapshot and the Subservicer designation — a read; a mismatch is corrected through the 1.5 MIN update (Rule 2 §4) before the deactivation is prepared, never by the agent editing either record
  { name: "validateMinIntegrity", kind: "read", handler: compute((i) => { need(i, "loan_id"); return integrityOf(i); }) },
]);
