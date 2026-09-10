/**
 * §13.8 process-owned tool paths. The three spec tools (`dmdc.batch.prepare`, `dmdc.results.import`,
 * `scra.case.get/open/close`) are registered by the 13.8 block of ./section13.ts, which delegates to the handlers here;
 * each validates through src/domain/foreclosure/ops-13-8.ts and appends the events the process's registry rows arm on
 * and are satisfied by (a bare literal never stands in for an emitter):
 *   dmdc.batch.prepare{records}   inbound attorney-network / eviction records that need a certificate ≤30 days old →
 *                                 foreclosure.first_notice.authorize.requested · firm.dispositive_motion.proposed{judicial} ·
 *                                 eviction.referral.requested{eviction_referral_on}; the loans join the day's batch with the milestone's purpose
 *   dmdc.results.import           scra.status.verified{purpose, result, post_judgment_on_duty, service_end_date} next to the
 *                                 platform's dmdc.verification.completed{purpose} (an attorney escalation on the §3931(g) flag)
 *   scra.case.get/open/close      op=open   scra.relief.started (the §3919 umbrella 8.3 consumes)
 *                                 op=get    the relief-cycle sweep: scra.relief.ended{plus_one_cycle=true} one furnishing cycle after the tail
 *                                 op=contact         scra.contact.completed{kind=status_check} + contact.scra.status_check (D2-3.4-01 quarterly contact)
 *                                 op=affidavit_filed scra.affidavit.filed (the firm's filing evidence releases the motion instruction)
 *                                 op=judgment_reopen judgment.reopen.decided (the attorney records the court's §3931(g) decision)
 * `TOOLS_13_8` stays empty: every 13.8 tool string is already on the bus from ./section13.ts, and src/app/tools.test.ts
 * refuses any other name for the process.
 */
import { str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { statusCheckContact, reliefStarted, reliefCycleSweep, verificationOutcome, intakeFirmRecord, affidavitFiled, judgmentReopenDecided, type VerificationResultRow, type EmittedEvent } from "../../domain/foreclosure/ops-13-8.ts";

export const TOOLS_13_8: readonly ToolDef[] = [];

type Row = Record<string, unknown>;
const todayOf = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && v.length >= 10 ? D(v.slice(0, 10)) : null);
const optStr = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const append = (ctx: CommandContext, loanId: string, e: EmittedEvent): void => { ctx.events.append({ type: e.type, loanId, actor: ctx.actor, payload: e.payload }); };

/**
 * `dmdc.batch.prepare{loan_ids?, purpose?, records?}`: the day's DMDC batch — the listed loans (periodic re-checks and
 * milestone loans) plus every inbound record's loan. Each record is validated by `intakeFirmRecord` and its milestone
 * event appended before the loan joins the batch with the milestone's verification purpose; an empty call is refused.
 */
export function dmdcBatchPrepare_13_8(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const ids = Array.isArray(i.loan_ids) ? (i.loan_ids as unknown[]).map(String).filter(Boolean) : [];
  const records = Array.isArray(i.records) ? (i.records as Row[]) : [];
  if (ids.length === 0 && records.length === 0) throw new RangeError("loan_ids or records is required — nothing to verify");
  const milestones = records.map((r) => {
    const loanId = str(r, "loan_id"); const received = dateOf(r.received_on) ?? todayOf(ctx);
    const out = intakeFirmRecord({ kind: str(r, "kind"), loan_id: loanId, firm_id: str(r, "firm_id"), received_on: received, foreclosure_case_id: optStr(r.foreclosure_case_id), judicial: r.judicial === undefined ? undefined : r.judicial === true, motion_kind: optStr(r.motion_kind), court: optStr(r.court), first_notice_kind: optStr(r.first_notice_kind), eviction_referral_on: dateOf(r.eviction_referral_on), occupant_type: optStr(r.occupant_type), record_id: optStr(r.record_id) } as Parameters<typeof intakeFirmRecord>[0]);
    const rec = rt.store.put("firm_records", optStr(r.record_id) ?? `fr-${loanId}-${out.event.type}-${ctx.now}`, { loan_id: loanId, firm_id: str(r, "firm_id"), kind: str(r, "kind"), received_on: received, event_type: out.event.type, verification_purpose: out.purpose, verify_by: out.verify_by, affidavit_required: out.affidavit_required }, ctx.actor, ctx.now);
    append(ctx, loanId, out.event);
    return { record_id: rec.id, loan_id: loanId, kind: str(r, "kind"), event: out.event.type, purpose: out.purpose, verify_by: out.verify_by, affidavit_required: out.affidavit_required };
  });
  const loanIds = [...new Set([...ids, ...milestones.map((m) => m.loan_id)])];
  const purposes = Object.fromEntries([...ids.map((id) => [id, str(i, "purpose") || "periodic"] as const), ...milestones.map((m) => [m.loan_id, m.purpose] as const)]);
  const rec = rt.store.put("dmdc_batches", str(i, "id") || `dmdc-${ctx.now}`, { loan_ids: loanIds, purpose: str(i, "purpose") || (milestones[0]?.purpose ?? "periodic"), purposes, status: "prepared", rows: loanIds.length, milestones }, ctx.actor, ctx.now);
  ctx.events.append({ type: "dmdc.batch.prepared", loanId: loanIds[0]!, actor: ctx.actor, payload: { batch_id: rec.id, rows: loanIds.length, loan_ids: loanIds, purposes } });
  return { ...rec.data, id: rec.id };
}

/**
 * Facts for `13.8.affidavitOnFreshCertificates` — the evaluator SCRA_3931_AFFIDAVIT_GATE runs ("motion instruction
 * refused"; asserted by `attorney.instruction.send` at step judgment_motion and listed by `foreclosure.gates.evaluate`,
 * both in ./section13.ts) — all from the event log and the store, never the caller: the loan's latest
 * `firm.dispositive_motion.proposed{judicial=true}` arms the gate (a non-judicial proposal never does — the §3931
 * affidavit is a judicial requirement); the affidavit is the newest `scra_affidavits` row executed on/after that
 * proposal, with its checklist `certificate_on` aged at execution (rule 5: "never executed on a certificate older than
 * 30 days"), the executing role (only a `signing_officer`) and its `filed_at` — the firm's filing evidence
 * (`scra.affidavit.filed`, op=affidavit_filed) that alone releases the motion instruction (13.8-T5).
 */
export function affidavitGateFacts_13_8(rt: ToolRuntime, ctx: CommandContext, loanId: string): Row & { judicial_motion_proposed: boolean; certificate_age_days: number; executed_by_role: string | null; filed: boolean } {
  const proposal = ctx.events.all().filter((e) => e.type === "firm.dispositive_motion.proposed" && e.loanId === loanId && e.payload.judicial === true).at(-1) ?? null;
  const proposedOn = dateOf(proposal?.payload.proposed_on) ?? (proposal ? dateOf(proposal.occurredAt) : null);
  const aff = rt.store.list("scra_affidavits").filter((r) => r.data.loan_id === loanId && r.data.executed_at && (!proposedOn || String(r.data.executed_at).slice(0, 10) >= proposedOn)).sort((a, b) => (String(a.data.executed_at) < String(b.data.executed_at) ? -1 : 1)).at(-1) ?? null;
  const certOn = dateOf(aff?.data.certificate_on); const executedOn = dateOf(aff?.data.executed_at);
  return {
    judicial_motion_proposed: proposal !== null, motion_kind: optStr(proposal?.payload.motion_kind), court: optStr(proposal?.payload.court), proposed_on: proposedOn, firm_record_id: optStr(proposal?.payload.record_id),
    affidavit_id: aff?.id ?? null, affidavit_kind: optStr(aff?.data.kind), certificate_on: certOn, certificate_age_days: certOn && executedOn ? daysBetween(certOn, executedOn) : 9_999,
    executed_by_role: optStr(aff?.data.executed_by_role), executed_at: optStr(aff?.data.executed_at), filed: !!aff?.data.filed_at, filed_at: optStr(aff?.data.filed_at), filing_document_id: optStr(aff?.data.document_id),
  };
}

/**
 * After `dmdc.results.import` wrote the `scra_verifications` rows and `dmdc.verification.completed{purpose}`: the spec's
 * own `scra.status.verified{purpose, result}` with the §3931(g) flag read from the loan's foreclosure case
 * (`foreclosure_cases.judgment_entered_at`), an attorney escalation when a judgment was entered against a defendant now
 * found on duty, and a `human_agent` re-verification queue entry on a Future Call-Up flag (13.8 edge cases).
 */
export function scraStatusVerified_13_8(ctx: CommandContext, rt: ToolRuntime, loanId: string, purpose: string, results: readonly VerificationResultRow[], statusDate: PlainDate, verificationIds: readonly string[]): ReturnType<typeof verificationOutcome> & { escalation_id: string | null } {
  const fc = rt.store.list("foreclosure_cases").map((r) => r.data).filter((c) => c.loan_id === loanId && c.status !== "closed").sort((a, b) => (String(a.judgment_entered_at ?? "") < String(b.judgment_entered_at ?? "") ? 1 : -1))[0];
  const judgmentOn = dateOf(fc?.judgment_entered_at);
  const out = verificationOutcome({ purpose, results, status_date: statusDate, judgment_entered_on: judgmentOn, verification_ids: verificationIds });
  append(ctx, loanId, { type: out.event.type, payload: { ...out.event.payload, foreclosure_case_id: fc?.case_id ?? null } });
  const esc = out.escalation ? rt.escalations.open({ kind: "attorney", loanId, ...(out.escalation.severity ? { severity: out.escalation.severity } : {}), payload: { reason: out.escalation.reason, purpose, service_end_date: out.service_end_date, reopen_application_deadline: out.reopen_application_deadline, judgment_entered_on: judgmentOn, foreclosure_case_id: fc?.case_id ?? null } }, ctx.actor) : null;
  if (out.future_call_up) rt.escalations.open({ kind: "human_agent", loanId, payload: { reason: "DMDC Future Call-Up flag: no protection yet — re-verify weekly until the sale and postpone if the call-up date precedes it (13.8 edge cases)", purpose } }, ctx.actor);
  return { ...out, escalation_id: esc?.id ?? null };
}

/** op=open: the §3919 umbrella event next to `scra.stay.granted` (13.8 Outputs "`scra.relief.started` (umbrella, consumed by 8.x)"). */
export function scraReliefStarted_13_8(ctx: CommandContext, loanId: string, caseId: string, statusCode: string): void {
  append(ctx, loanId, reliefStarted({ case_id: caseId, started_on: todayOf(ctx), status_code: statusCode }));
}

/** op=get (the sweep): closed cases one furnishing cycle past their protection window release the 8.3 gate — once per case. */
export function scraReliefSweep_13_8(ctx: CommandContext, rt: ToolRuntime, loanId: string): string[] {
  const rows = rt.store.list("scra_cases").filter((r) => r.data.loan_id === loanId);
  const closedOn = (id: string): PlainDate | null => { const e = ctx.events.all().find((x) => x.type === "scra.case.closed" && x.loanId === loanId && x.payload.case_id === id); return dateOf(e?.payload.closed_on) ?? (e ? dateOf(e.occurredAt) : null); };
  const due = reliefCycleSweep(rows.map((r) => ({ case_id: r.id, status: String(r.data.status ?? ""), fc_stay_granted_at: optStr(r.data.fc_stay_granted_at), protection_ends_on: dateOf(r.data.protection_ends_on), closed_on: closedOn(r.id), relief_ended_at: optStr(r.data.relief_ended_at) })), todayOf(ctx));
  for (const d of due) { rt.store.put("scra_cases", d.case_id, { relief_ended_at: ctx.now }, ctx.actor, ctx.now); append(ctx, loanId, d.event); }
  return due.map((d) => d.case_id);
}

/**
 * The 13.8 ops beyond get/open/close/gate_exception/affidavit; `undefined` means "not one of mine" so the section's
 * handler can raise its own RangeError for an unknown op.
 */
export function scraCaseOps_13_8(op: string, i: ToolInput, ctx: CommandContext, rt: ToolRuntime, loanId: string, caseId: string): unknown {
  if (op === "contact") {
    const cur = rt.store.get("scra_cases", caseId)?.data ?? rt.store.list("scra_cases").find((r) => r.data.loan_id === loanId && r.data.status !== "closed")?.data;
    const r = statusCheckContact({ case_id: String(cur?.case_id ?? caseId), case_status: String(cur?.status ?? ""), contacted_on: dateOf(i.contacted_on) ?? todayOf(ctx), channel: str(i, "channel") || "call", outcome: str(i, "outcome"), tcpa_consent: flag(i, "tcpa_consent"), automation_disclosed: flag(i, "automation_disclosed"), expected_service_end_on: dateOf(i.expected_service_end_on), contact_id: optStr(i.contact_id), notice_template: optStr(i.notice_template) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const contact = rt.store.put("scra_contacts", optStr(i.contact_id) ?? `scc-${loanId}-${ctx.now}`, { loan_id: loanId, case_id: String(cur?.case_id ?? caseId), kind: "status_check", channel: str(i, "channel") || "call", outcome: str(i, "outcome"), contacted_on: r.events[0]!.payload.contacted_on, contact_made: r.contact_made, expected_service_end_on: dateOf(i.expected_service_end_on), recorded_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
    if (r.contact_made) rt.store.put("scra_cases", String(cur?.case_id ?? caseId), { contact_cadence_next_on: r.next_contact_on }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, contact_id: contact.id } });
    return { contact_id: contact.id, contact_made: r.contact_made, next_contact_on: r.contact_made ? r.next_contact_on : String(cur?.contact_cadence_next_on ?? ""), events: r.events.map((e) => e.type), timer: "FNMA_D23401_SM_CONTACT_90" };
  }
  if (op === "affidavit_filed") {
    const affId = str(i, "affidavit_id"); if (!affId) throw new RangeError("affidavit_id is required");
    const aff = rt.store.get("scra_affidavits", affId); if (!aff || aff.data.loan_id !== loanId) throw new RangeError(`no affidavit ${affId} on loan ${loanId}`);
    const review = aff.data.records_review as { passed?: boolean } | undefined;
    const r = affidavitFiled({ affidavit_id: affId, executed_at: optStr(aff.data.executed_at), executed_by: optStr(aff.data.executed_by), records_review_passed: review?.passed ?? null, already_filed_at: optStr(aff.data.filed_at), filed_at: str(i, "filed_at") || ctx.now, filed_by_firm_id: str(i, "filed_by_firm_id"), document_id: str(i, "document_id") });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const rec = rt.store.put("scra_affidavits", affId, { filed_at: str(i, "filed_at") || ctx.now, filed_by_firm_id: str(i, "filed_by_firm_id"), document_id: str(i, "document_id"), court: optStr(i.court) ?? aff.data.court ?? null }, ctx.actor, ctx.now);
    append(ctx, loanId, { type: r.event!.type, payload: { ...r.event!.payload, case_id: caseId, kind: aff.data.kind } });
    return { ...rec.data, affidavit_id: affId, motion_instruction_released: r.motion_instruction_released, gate: "SCRA_3931_AFFIDAVIT_GATE" };
  }
  if (op === "judgment_reopen") {
    const cur = rt.store.get("scra_cases", caseId)?.data ?? rt.store.list("scra_cases").filter((r) => r.data.loan_id === loanId).map((r) => r.data).at(-1);
    const fc = rt.store.list("foreclosure_cases").map((r) => r.data).find((c) => c.loan_id === loanId && c.judgment_entered_at);
    const r = judgmentReopenDecided({ decision: str(i, "decision"), decided_on: dateOf(i.decided_on) ?? todayOf(ctx), applied_on: dateOf(i.applied_on), service_end_on: dateOf(i.service_end_on) ?? dateOf(cur?.service_end_on), court: optStr(i.court), order_document_id: optStr(i.order_document_id), judgment_entered_on: dateOf(fc?.judgment_entered_at) });
    const rec = rt.store.put("judgment_reopen_decisions", optStr(i.decision_id) ?? `jrd-${loanId}-${ctx.now}`, { loan_id: loanId, scra_case_id: cur?.case_id ?? null, foreclosure_case_id: fc?.case_id ?? null, ...r.event.payload, recorded_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
    append(ctx, loanId, { type: r.event.type, payload: { ...r.event.payload, decision_id: rec.id, scra_case_id: cur?.case_id ?? null } });
    return { ...rec.data, decision_id: rec.id, timer: "SCRA_3931G_DEFAULT_JUDGMENT_REOPEN_90" };
  }
  return undefined;
}
