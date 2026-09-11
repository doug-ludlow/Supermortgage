/**
 * §4 tools — customer service and borrower communications.
 *
 * Two surfaces:
 *  - SECTION_04_TOOLS: the tool strings agents.json names verbatim for 4.1 and 4.3 (the read tools of the `case` agent
 *    and the continuity tools of `borrower-comms`), registered on the bus by src/app/tools/index.ts.
 *  - SECTION_04_CASE_COMMANDS: the `case` / `borrower-comms` commands the spec's Agents paragraphs describe but do not
 *    list as tool strings — the 4.1 correction commands from the Integrations table ("`payment.reapply`, `fee.reverse`,
 *    `late_charge.waive`, `escrow.correct`, `suspense.apply`, `payoff.quote.reissue` — each validates the case id"),
 *    the NoE / RFI / continuity / SII / complaint case commands, and the guardrails those paragraphs state. They are
 *    CommandSpecs on the same bus (`bindTools(rt, agents, SECTION_04_CASE_COMMANDS)`), so the AI path and the ops
 *    console share the validators; they are not in ALL_TOOLS because the audit's tool units are the spec's tool strings.
 *  - FC_NOE_OPEN_GATE: the guardrail `foreclosure.sale.conduct` / `foreclosure.judgment.motion` (13.x) call to assert
 *    REGX_1024_35E_FC_NOE_OPEN is open for the loan, read from the timer engine.
 *
 * Guardrails read the case record, never the caller's claims: the append-only event log is the record (`case.noe.opened`
 * carries every assertion's profile and due date, `case.noe.determined` / `case.noe.responded` / `case.noe.extended` the
 * state transitions), the ledger is the money actually posted, and an approval id names a `case.approval.recorded`
 * event written by an `officer` / `attorney` through the human-only `case.approval.record` command — an agent-supplied
 * id that no officer recorded is refused (ARCHITECTURE: "Money fields are never agent-corrected; waivers need an
 * `officer`").
 */
import { defineTools, read, escalate, timerOps, compute, guard, never, str, num, flag, data, cents, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { Recipient } from "../../notices/channel.ts";
import type { CommandContext, Guardrail } from "../commands.ts";
import { evaluateGate } from "../evaluators.ts";
import { hasRole } from "../roles.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { TimerDef, TimerRegistry } from "../../kernel/timers/registry.ts";
import type { TimerInstance } from "../../kernel/timers/engine.ts";
import { parseOffset } from "../../kernel/timers/offset.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { handleUtterance, callbackRequest, nyExtension, nyNoeDeadline, noeCommunicationCheck, documentRequest, earlyCorrection, earlyResponse, privilegeRouting, fraudSignals, texasCure, eiNoticeAssignment, AI_MONETARY_LIMIT_CENTS, type ContactTeamBlock } from "../../domain/servicing-requests/ops.ts";
import { federalDays } from "../../domain/servicing-requests/clocks.ts";
import { CORRECTION_MAX_CENTS, investigationValid, noeForeclosureDue, type AssertionType } from "../../domain/servicing-requests/noe.ts";
import { noeOpenedPayload, noeRespondedPayload, suppressionRow, repostSet, feeReversalSet, rfiOpenedPayload, rfiRespondedPayload, complaintOpenedPayload, complaintResponseCheck, siiPolicyDue, type NoeOpenInput, type NoeOpenedPayload, type RfiOpenInput, type RfiOpenedPayload, type ComplaintOpenInput, type ComplaintOpenedPayload } from "../../domain/servicing-requests/cases.ts";
import { ownerIdentity, FNMA_OWNER_BLOCK, redactionCheck, searchLogComplete, ownAccountRecord, type Ownership } from "../../domain/servicing-requests/rfi.ts";
import { DOCUMENT_MATRIX, evaluateDocuments, type TransferType } from "../../domain/servicing-requests/successor.ts";
import { onPermanentPayment, caSpocDue, type Episode } from "../../domain/servicing-requests/continuity.ts";
import { populationRemediation, type NyComplaintCategory } from "../../domain/servicing-requests/complaints.ts";
import { receiveInboundEmail, sendEmailReply, inboundEmailFor } from "../../domain/servicing-requests/ops-4-5.ts";
import { logContact } from "../../domain/servicing-requests/ops-4-3.ts";
import { CONTINUITY_COMMANDS_4_3 } from "./section4-3.ts";

// ---------------------------------------------------------------- spec tool strings (agents.json)
const p41: ToolDef[] = defineTools("4.1", "borrower-comms", [
  { name: "documents.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("documents", (d) => (!i.loan_id || d.loan_id === i.loan_id) && (!i.kind || d.kind === i.kind)).map((r) => ({ id: r.id, ...r.data, snapshot_version: r.version }))) },
  { name: "contacts.list", kind: "read", handler: read("contacts") },
  { name: "jurisdiction_rules.get", kind: "read", handler: compute((i, _c, rt) => rt.store.get("jurisdiction_rules", str(i, "state"))?.data ?? null) },
  { name: "timer.list", kind: "act", handler: timerOps(), guardrails: [never("LIST_ONLY", "4.1 tool set: timers are read on the NoE path; satisfaction is event-driven", (i) => i.op === "arm" || i.op === "cancel", "timer.list is read-only on the NoE path")] },
]);

const p43: ToolDef[] = defineTools("4.3", "borrower-comms", [
  { name: "lossmit_facts.get", kind: "read", handler: compute((i, _c, rt) => rt.store.get("lossmit_facts", str(i, "loan_id"))?.data ?? null) },
  { name: "payments.history", kind: "read", handler: compute((i, _c, rt) => rt.store.history("payments", str(i, "id")).map((r) => ({ version: r.version, ...r.data }))) },
  { name: "lossmit.documents.list", kind: "read", handler: compute((i, _c, rt) => rt.store.list("lossmit_documents", (d) => d.loan_id === i.loan_id).map((r) => ({ id: r.id, ...r.data }))) },
  { name: "lossmit.application.status", kind: "read", handler: compute((i, _c, rt) => { const f = rt.store.get("lossmit_facts", str(i, "loan_id"))?.data; return f ? { status: f.application_status ?? null, complete_at: f.complete_at ?? null, reasonable_date: f.reasonable_date ?? null } : null; }) },
  { name: "timer.list", kind: "act", handler: timerOps(), guardrails: [never("LIST_ONLY", "4.3 tool set: loss-mit deadlines are read, never armed or cancelled here", (i) => i.op === "arm" || i.op === "cancel", "timer.list is read-only in continuity mode")] },
  { name: "foreclosure.gates.get", kind: "read", handler: compute((i) => { const f = (i.facts as Record<string, unknown> | undefined) ?? {}; return { day_121: evaluateGate("13.1.preForeclosureReviewPeriodElapsed", f), trial_performing: evaluateGate("13.2.trialPerformingNoSale", f), rendered: "we may refer to foreclosure no earlier than day 121, and not while a complete application is pending" }; }) },
  // 4.3-T4 / REGX_1024_40A3_LIVE_RESPONSE_1BD: an after-hours call creates the callback request the timer arms on (anchor `requested_at`).
  { name: "callback.schedule", kind: "write", handler: compute((i, ctx, rt) => { const r = callbackRequest({ called_at_local: str(i, "called_at_local") || ctx.now.slice(0, 16), staffed_from: str(i, "staffed_from") || "08:00", staffed_to: str(i, "staffed_to") || "20:00" }); const rec = rt.store.put("callback_requests", str(i, "id") || `cb-${ctx.now}`, { ...data(i), requested_at: ctx.now, live_contact_due: r.live_contact_due, same_day_target: r.same_day_target }, ctx.actor, ctx.now); ctx.events.append({ type: "callback_requests.created", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id, requested_at: ctx.now, live_contact_due: r.live_contact_due, same_day_target: r.same_day_target } }); return { ...r, id: rec.id }; }) },
  { name: "human.transfer", kind: "act", handler: escalate("human_agent"), decision: (i) => ({ action: "human.transfer", rationale: str(i, "reason") || "borrower asked for a person (warm transfer)", ...(i.utterance ? { ruleCode: handleUtterance(str(i, "utterance")).human_transfer_requested ? "human_transfer_requested=true" : "policy_trigger" } : {}) }) },
  { name: "lossmit.intake.start", kind: "write", handler: compute((i, ctx, rt) => { const id = str(i, "id") || `lossmit-${rt.store.list("lossmit_applications").length + 1}`; const rec = rt.store.put("lossmit_applications", id, data(i), ctx.actor, ctx.now); ctx.events.append({ type: "lossmit.application.received", loanId: ctx.loanId, aggregate: { kind: "lossmit_applications", id }, actor: ctx.actor, payload: { id, version: rec.version, potential_successor: false } }); return rec.data; }), guardrails: [never("NO_REREQUEST", "4.3 rule 6 / §1024.41(b)(1): documents already held are never re-requested", (i) => flag(i, "rerequest_held_documents"), "documents already held are pushed to the evaluator, not re-requested")] },
  // REGX_1024_40A3_LIVE_RESPONSE_1BD is satisfied by `contact.logged{live_contact=true, by_assigned_personnel=true}` — ops-4-3.logContact derives `by_assigned_personnel` from the episode's assignment and the actor.
  { name: "contact.log", kind: "write", handler: compute((i, ctx, rt) => logContact(rt, ctx, i).data), guardrails: [never("FACTS_FROM_VIEW", "4.3 rule 5: the AI may not state a deadline or option not present in lossmit_facts", (i) => data(i).stated_deadline_not_in_view === true || data(i).stated_option_not_in_view === true, "a stated deadline/option is not in lossmit_facts")] },
]);

export const SECTION_04_TOOLS: readonly ToolDef[] = [...p41, ...p43];

// ---------------------------------------------------------------- REGX_1024_35E_FC_NOE_OPEN gate
export const FC_NOE_OPEN = "REGX_1024_35E_FC_NOE_OPEN";
/** The open (armed or breached) FC_NOE_OPEN instances for the loan the command runs on — the gate is closed while any exists. */
export function openFcNoeGates(ctx: CommandContext, loanId: string = ctx.loanId): { readonly id: string; readonly armed_at: string }[] {
  return ctx.timers.forSubject("loan", loanId).filter((t) => t.code === FC_NOE_OPEN && (t.status === "armed" || t.status === "breached")).map((t) => ({ id: t.id, armed_at: t.armedAt }));
}
/** 4.1 timer table: `foreclosure.sale.conduct` and `foreclosure.judgment.motion` call `assertGateOpen`; block + attorney escalation while a (b)(9)/(10) NoE is unanswered. */
export const FC_NOE_OPEN_GATE: Guardrail<ToolInput> = guard("FC_NOE_OPEN", "REGX_1024_35E_FC_NOE_OPEN (§1024.35(e)(3)(i)(B); §1024.35(i)(2))", (i, ctx) => {
  const open = openFcNoeGates(ctx, typeof i.loan_id === "string" ? i.loan_id : ctx.loanId);
  return open.length ? `a (b)(9)/(10) notice of error is open on the loan (${open.length} gate instance${open.length > 1 ? "s" : ""}); respond before the sale or postpone it (comment 35(e)(3)(i)-1)` : undefined;
});
/** The escalation package the attorney reviews when the gate blocks a sale: draft response, decision record, snapshots, timer status, one-page summary (4.1 human touchpoints); also the `noe_hold` instruction to the attorney network. */
export function foreclosureHoldPackage(rt: ToolRuntime, ctx: CommandContext, f: { case_id: string; draft_response?: string; decision_record?: Record<string, unknown>; snapshot_ids?: readonly string[]; summary: string; sale_date?: string }): { escalation_id: string; package: Record<string, unknown> } {
  const timers = ctx.timers.forSubject("loan", ctx.loanId).map((t) => ({ code: t.code, status: t.status, due_date: t.dueDate ?? null }));
  const pkg = { case_id: f.case_id, draft_response: f.draft_response ?? null, decision_record: f.decision_record ?? null, snapshot_ids: [...(f.snapshot_ids ?? [])], timer_status: timers, summary: f.summary, sale_date: f.sale_date ?? null, attorney_network_message: "noe_hold" };
  const e = rt.escalations.open({ kind: "attorney", loanId: ctx.loanId, caseId: f.case_id, severity: "sev-1", payload: pkg }, ctx.actor);
  ctx.events.append({ type: "foreclosure.noe_hold.requested", loanId: ctx.loanId, aggregate: { kind: "case", id: f.case_id }, actor: ctx.actor, payload: { case_id: f.case_id, escalation_id: e.id, sale_date: f.sale_date ?? null } });
  return { escalation_id: e.id, package: pkg };
}

// ---------------------------------------------------------------- the case record (event log) and approvals
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const caseEvent = (ctx: CommandContext, type: string, caseId: string, payload: Record<string, unknown>) => ctx.events.append({ type, loanId: ctx.loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, ...payload } });
const caseEvents = (ctx: CommandContext, type: string, caseId: string): readonly DomainEvent[] => ctx.events.ofType(type).filter((e) => e.payload.case_id === caseId);
const lastCaseEvent = (ctx: CommandContext, type: string, caseId: string): DomainEvent | undefined => caseEvents(ctx, type, caseId).at(-1);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
/** The NoE record: the `case.noe.opened` payload (assertions with profile / due dates / identifiability) — the state-machine guardrails read it, never the caller's copy. */
const noeRecord = (ctx: CommandContext, caseId: string): NoeOpenedPayload | undefined => lastCaseEvent(ctx, "case.noe.opened", caseId)?.payload as NoeOpenedPayload | undefined;
const noeAssertion = (ctx: CommandContext, caseId: string, assertionId: string) => noeRecord(ctx, caseId)?.assertions.find((a) => a.id === assertionId);
const determinedAssertions = (ctx: CommandContext, caseId: string): Set<string> => new Set(caseEvents(ctx, "case.noe.determined", caseId).map((e) => String(e.payload.assertion_id)));
const respondedAssertions = (ctx: CommandContext, caseId: string): string[] => caseEvents(ctx, "case.noe.responded", caseId).flatMap((e) => ids(e.payload.assertion_ids));
const noeResponded = (ctx: CommandContext, caseId: string): boolean => caseEvents(ctx, "case.noe.responded", caseId).some((e) => e.payload.complete === true);
const noeRespondIds = (i: ToolInput, rec: NoeOpenedPayload): string[] => (Array.isArray(i.assertion_ids) && i.assertion_ids.length ? ids(i.assertion_ids) : rec.assertions.map((a) => a.id));
const rfiRecord = (ctx: CommandContext, caseId: string): RfiOpenedPayload | undefined => lastCaseEvent(ctx, "case.rfi.opened", caseId)?.payload as RfiOpenedPayload | undefined;
const rfiItem = (ctx: CommandContext, caseId: string, itemId: string) => rfiRecord(ctx, caseId)?.items.find((it) => it.id === itemId);
const determinedItems = (ctx: CommandContext, caseId: string): Set<string> => new Set(caseEvents(ctx, "case.rfi.item.determined", caseId).map((e) => String(e.payload.item_id)));
const respondedItems = (ctx: CommandContext, caseId: string): string[] => caseEvents(ctx, "case.rfi.responded", caseId).flatMap((e) => ids(e.payload.item_ids));
const rfiRespondIds = (i: ToolInput, rec: RfiOpenedPayload): string[] => (Array.isArray(i.item_ids) && i.item_ids.length ? ids(i.item_ids) : rec.items.map((it) => it.id));
type ComplaintRecord = ComplaintOpenedPayload & { readonly linked_noe_case_id?: string | null; readonly officer_route?: boolean };
const complaintRecord = (ctx: CommandContext, caseId: string): ComplaintRecord | undefined => lastCaseEvent(ctx, "case.complaint.opened", caseId)?.payload as ComplaintRecord | undefined;
const caseKnown = (ctx: CommandContext, caseId: string): boolean => !!caseId && ["case.noe.opened", "case.complaint.opened", "case.rfi.opened", "case.sii.opened"].some((t) => caseEvents(ctx, t, caseId).length > 0);
/** Comment 38(b)(1)(vi)-5 flag: a loss-mit application from the potential successor is pending on the SII case (any of the events that carry it). */
const siiLossmitPending = (ctx: CommandContext, caseId: string): boolean => ["case.sii.opened", "case.sii.potential_successor.identified", "lossmit.application.received"].some((t) => caseEvents(ctx, t, caseId).some((e) => e.payload.lossmit_pending === true || e.payload.potential_successor === true));
const siiFraudFlagged = (ctx: CommandContext, caseId: string): boolean => caseEvents(ctx, "case.sii.fraud_flagged", caseId).length > 0;
/** Every event of the case (by `case_id`) — the instances they armed are the case's own clocks. */
const caseEventIds = (ctx: CommandContext, caseId: string): Set<string> => new Set(ctx.events.byLoan(ctx.loanId).filter((e) => e.payload.case_id === caseId).map((e) => e.id));
const openCaseInstances = (ctx: CommandContext, caseId: string, codes: readonly string[]): TimerInstance[] => { const own = caseEventIds(ctx, caseId); return ctx.timers.forSubject("loan", ctx.loanId).filter((t) => codes.includes(t.code) && (t.status === "armed" || t.status === "breached") && own.has(t.armedByEventId)); };

/** Guardrail: the command names a case the record knows. */
const caseExists = (type: string, what: string): Guardrail<ToolInput> => guard("CASE_NOT_FOUND", `4.1 state machine: every transition runs against a ${what} case the record holds`, (i, ctx) => (caseEvents(ctx, type, str(i, "case_id")).length ? undefined : `no ${what} case ${str(i, "case_id") || "(missing case_id)"} on the loan`));
const NOE_EXISTS = caseExists("case.noe.opened", "notice-of-error");
const RFI_EXISTS = caseExists("case.rfi.opened", "request-for-information");
const SII_EXISTS = caseExists("case.sii.opened", "successor-in-interest");
const COMPLAINT_EXISTS = caseExists("case.complaint.opened", "complaint");

/**
 * An approval id is a pointer into the record: `case.approval.recorded` is written only by the human-only
 * `case.approval.record` command, so the actor on the event is the officer/attorney the bus already role-checked.
 * The approval binds to the case, the command (scope) and, for money, an amount at least the amount actually posted.
 */
const approved = (ctx: CommandContext, i: ToolInput, field: string, roles: readonly string[], scope: string, amountCents?: bigint): boolean => {
  const id = str(i, field); if (!id) return false;
  const e = ctx.events.ofType("case.approval.recorded").find((x) => x.payload.approval_id === id);
  if (!e || !hasRole(e.actor, roles)) return false;
  if (e.payload.case_id !== str(i, "case_id")) return false;
  const s = String(e.payload.scope ?? "");
  if (s !== scope && s !== "*" && !(s === "correction" && CORRECTION_COMMANDS.includes(scope))) return false;
  return amountCents === undefined || cents(e.payload.amount_cents) >= amountCents;
};
/** Refuse unless the actor holds one of `roles` or the record holds a matching approval by one of them (`when` reads input + record). */
const needsApproval = (code: string, citation: string, when: (i: ToolInput, ctx: CommandContext) => boolean, roles: readonly string[], why: string): Guardrail<ToolInput> =>
  guard(code, citation, (i, ctx) => (when(i, ctx) && !hasRole(ctx.actor, roles) ? `${why}; requires ${roles.join("/")}` : undefined));
const CORRECTION_COMMANDS = ["payment.reapply", "fee.reverse", "late_charge.waive", "escrow.correct", "suspense.apply", "payoff.quote.reissue", "complaint.remediate"];

const approvalCommands: ToolDef[] = defineTools("4.1", "case", [
  // The officer's (or attorney's) recorded decision every approval-gated guardrail verifies; agents may prepare the package but never record the approval.
  { name: "case.approval.record", kind: "write", humanOnly: true, humanRoles: ["officer", "attorney"], handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const id = str(i, "approval_id") || `appr-${rt.store.list("case_approvals").length + 1}`;
      const rec = rt.store.put("case_approvals", id, { case_id: caseId, scope: str(i, "scope"), amount_cents: cents(i.amount_cents).toString(), rationale: str(i, "rationale"), approved_by: ctx.actor.id, role: ctx.actor.role ?? null, approved_at: ctx.now }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.approval.recorded", caseId, { approval_id: id, scope: str(i, "scope"), amount_cents: cents(i.amount_cents).toString(), role: ctx.actor.role ?? null, approved_by: ctx.actor.id, rationale: str(i, "rationale") });
      return { approval_id: id, version: rec.version, approved_by: ctx.actor.id, role: ctx.actor.role ?? null };
    }), decision: (i, _o, ctx) => ({ action: "case.approval.record", subject: { kind: "case", id: str(i, "case_id") }, rationale: `${ctx.actor.role ?? "human"} ${ctx.actor.id} approved ${str(i, "scope")}${i.amount_cents !== undefined ? ` up to ${cents(i.amount_cents)}¢` : ""}: ${str(i, "rationale") || "no rationale given"}` }),
    guardrails: [never("APPROVAL_SCOPE_REQUIRED", "4.1 human touchpoints: an approval names the case and the command it authorises", (i) => !str(i, "case_id") || !str(i, "scope"), "case_id and scope (command name, `correction` or `*`) are required")] },
]);

// ---------------------------------------------------------------- timer re-anchoring (registry offsets, command-computed anchors)
let registryCache: TimerRegistry | undefined;
const registryDef = (code: string): TimerDef => { registryCache ??= loadOverriddenRegistry(); const d = registryCache.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };
/**
 * "+15 on `case.noe.extended`" / "recomputed on `foreclosure.sale.rescheduled`": the open instance the case armed is closed
 * with the reason and a new instance of the same code is armed from the event, due on the event's `anchorField` date
 * (the timer history shows both dates; the code's satisfied pattern and breach severity stay the registry's).
 */
function reanchorDeadline(ctx: CommandContext, caseId: string, code: string, trigger: DomainEvent, anchorField: string, reason: string): TimerInstance | null {
  const open = openCaseInstances(ctx, caseId, [code]);
  if (!open.length) return null;
  for (const t of open) ctx.timers.cancel(t.id, reason, ctx.actor);
  return ctx.timers.arm({ ...registryDef(code), anchorField, offsetParsed: parseOffset("0") }, trigger);
}
/** Cancel the case's open instances of the codes with the reason (4.1-T11 `early_correction`, 4.2-T11 `early_response`). */
function cancelCaseTimers(ctx: CommandContext, caseId: string, codes: readonly string[], reason: string): string[] {
  const open = openCaseInstances(ctx, caseId, codes);
  for (const t of open) ctx.timers.cancel(t.id, reason, ctx.actor);
  return [...new Set(open.map((t) => t.code))];
}

// ---------------------------------------------------------------- 4.1 case commands
const amount = (i: ToolInput): bigint => { const a = cents(i.amount_cents); return a < 0n ? -a : a; };
const linesAmount = (lines: readonly { amountCents: unknown }[]): bigint => lines.reduce((s, l) => { const c = cents(l.amountCents); return c > 0n ? s + c : s; }, 0n);
/** The money a correction actually moves: the positive legs of the entry set it posts, the original set it reverses and re-posts, or the stated fee amount it reverses — never the caller's `amount_cents` alone. */
const postedAmount = (i: ToolInput, ctx: CommandContext): bigint => {
  const set = i.entry_set as { lines?: readonly { amountCents: unknown }[] } | undefined;
  if (set?.lines) return linesAmount(set.lines);
  if (typeof i.original_set_id === "string") { const orig = ctx.ledger.sets().find((s) => s.id === i.original_set_id); return orig ? linesAmount(orig.lines) : 0n; }
  return amount(i);
};
/** Every correction command validates the case id and the per-command monetary threshold (4.1 Integrations; guardrails: > `case.correction.max_cents` needs officer approval). */
const correctionGuardrails = (command: string): readonly Guardrail<ToolInput>[] => [
  never("CASE_ID_REQUIRED", "4.1 Integrations: each correction command validates the case id", (i) => !str(i, "case_id"), "a correction posts only against an NoE/complaint case id"),
  guard("CASE_NOT_FOUND", "4.1 Integrations: each correction command validates the case id against the record", (i, ctx) => (caseKnown(ctx, str(i, "case_id")) ? undefined : `no open case ${str(i, "case_id")} on the loan`)),
  needsApproval("CORRECTION_MAX_CENTS", "4.1 guardrails: cannot post corrections above `case.correction.max_cents` (default 500,000¢ = $5,000) without human approval (4.1-Q3: officer)", (i, ctx) => { const a = postedAmount(i, ctx); return a > CORRECTION_MAX_CENTS && !approved(ctx, i, "officer_approval_id", ["officer"], command, a); }, ["officer"], `correction above ${CORRECTION_MAX_CENTS}¢ (measured on the entries posted) without a recorded officer approval covering the case, the command and the amount`),
];
const ledgerCorrection = (eventType: string, ruleRef: string) => compute((i, ctx) => {
  const set = i.entry_set as Parameters<CommandContext["ledger"]["post"]>[0] | undefined;
  if (!set) throw new RangeError(`${eventType} needs entry_set {effectiveDate, description, lines[]}`);
  for (const l of set.lines) if (!l.ruleRef) throw new RangeError("every ledger line carries a ruleRef");
  const posted = ctx.ledger.post({ ...set, description: `NoE ${str(i, "case_id")}: ${set.description}` }, ctx.now);
  caseEvent(ctx, eventType, str(i, "case_id"), { entry_set_id: posted.id, effective_date: posted.effectiveDate, rule_ref: ruleRef, amount_cents: linesAmount(posted.lines).toString() });
  return { entry_set_id: posted.id, effective_date: posted.effectiveDate, amount_cents: linesAmount(posted.lines) };
});
const noeInput = (i: ToolInput, ctx: CommandContext): NoeOpenInput => ({
  case_id: str(i, "case_id") || `noe-${ctx.now}`, loan_id: (typeof i.loan_id === "string" ? i.loan_id : ctx.loanId), receipt_date: D(str(i, "receipt_date") || ctx.now.slice(0, 10)), ...(typeof i.receipt_at === "string" ? { receipt_at: i.receipt_at } : {}), state: typeof i.state === "string" ? i.state : null,
  assertions: (Array.isArray(i.assertions) ? (i.assertions as { id?: string; category: AssertionType; description?: string; period?: string; identifiable?: boolean }[]) : []).map((a, n) => ({ id: a.id ?? `a${n + 1}`, category: a.category, ...(a.description !== undefined ? { description: a.description } : {}), ...(a.period !== undefined ? { period: a.period } : {}), ...(a.identifiable !== undefined ? { identifiable: a.identifiable } : {}) })),
  foreclosure_sale_date: typeof i.foreclosure_sale_date === "string" ? D(i.foreclosure_sale_date) : null, is_qwr: flag(i, "is_qwr"), linked_case_ids: Array.isArray(i.linked_case_ids) ? (i.linked_case_ids as string[]) : [],
});
/** The response letters whose `notice.sent` is the delivery evidence `closed` requires (4.1 state machine). */
const NOE_RESPONSE_TEMPLATES = ["NTC_REGX_35E_CORRECTION", "NTC_REGX_35E_NO_ERROR", "NTC_REGX_35E_ADDITIONAL_ERRORS", "NTC_REGX_35G2_EXCEPTION", "NTC_REGX_35F1_EARLY_CORRECTION"];
const CORRECTION_EVENTS = ["payment.reapplied", "fee.reversed", "late_charge.waived", "escrow.corrected", "suspense.applied", "payoff.quote.reissued"];
/** The (d)/(e) clocks an (f)(1) early correction or a §1024.36(e) early response makes moot. */
const NOE_STD_CLOCKS = ["REGX_1024_35D_NOE_ACK_5", "REGX_1024_35E_NOE_RESPONSE_30", "REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30", "REGX_1024_35E_NOE_PAYOFF_RESPONSE_7", "SM_NOE_INTERNAL_TARGET_10"];
const earlyCorrectionWindow = (code: string): Guardrail<ToolInput> => guard(code, "§1024.35(f)(1): the correction and the written notice within 5 days of receipt — later, the (d)/(e) path applies (REGX_1024_35F1_NOE_EARLY_CORRECTION_5 breach: 'fall back to std path')", (i, ctx) => { const rec = noeRecord(ctx, str(i, "case_id")); return rec && today(ctx) > federalDays(rec.receipt_date, 5) ? `day ${federalDays(rec.receipt_date, 5)} has passed — the acknowledgment and response clocks govern` : undefined; });

const noeCommands: ToolDef[] = defineTools("4.1", "case", [
  // Intake: opens the case and emits `case.noe.opened` with the per-profile qualifiers and computed anchors the timers arm on; writes the §1024.35(i) suppression slice.
  { name: "case.noe.open", kind: "write", handler: compute((i, ctx, rt) => {
      const f = noeInput(i, ctx); const p = noeOpenedPayload(f); const sup = suppressionRow(f);
      rt.store.put("cases", f.case_id, { case_type: "noe", loan_id: f.loan_id, receipt_date: f.receipt_date, receipt_at: p.receipt_at, state: p.state, is_qwr: f.is_qwr ?? false, deadline_profiles: p.assertions.map((a) => a.profile), foreclosure_sale_date_at_receipt: p.foreclosure_sale_date, status: "triaged", linked_case_ids: p.linked_case_ids, jurisdiction_profile: p.state === "NY" ? "NY_419_6" : null, extension_used: false }, ctx.actor, ctx.now);
      p.assertions.forEach((a, n) => rt.store.put("case_assertions", `${f.case_id}:${a.id}`, { case_id: f.case_id, seq: n + 1, category: a.category, profile: a.profile, response_due: a.response_due, ack_due: a.ack_due, identifiable: a.identifiable, description: f.assertions[n]?.description ?? null, determination: null, responded_on: null }, ctx.actor, ctx.now));
      if (sup) rt.store.put("credit_reporting_suppressions", f.case_id, sup, ctx.actor, ctx.now);
      caseEvent(ctx, "case.noe.opened", f.case_id, p);
      return { ...p, suppression: sup };
    }),
    guardrails: [never("NOE_IS_WRITTEN", "§1024.35(a); 4.1 inputs: a voice complaint opens a complaint case (4.5), never an NoE", (i) => /^voice/.test(str(i, "channel")), "no oral NoE exists — route to complaint.open with the §1024.38(b)(5) script"),
      never("NOE_NEEDS_ASSERTION", "§1024.35(a): an NoE asserts an error the borrower believes has occurred", (i) => !Array.isArray(i.assertions) || i.assertions.length === 0, "no assertion of error identified"),
      guard("CASE_EXISTS", "4.1 edge cases: the same letter is one case (dedupe) — a case id is opened once", (i, ctx) => (str(i, "case_id") && caseKnown(ctx, str(i, "case_id")) ? `case ${str(i, "case_id")} already exists` : undefined))] },
  // Determination per assertion (state machine guards): no_error needs snapshot rows + a statement of reasons + the record types the assertion implicates (read from the record); overbroad only for the unidentifiable residue.
  { name: "case.noe.determine", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"), det = str(i, "determination"), basis = str(i, "exception_basis") || null;
      rt.store.put("case_assertions", `${caseId}:${str(i, "assertion_id")}`, { determination: det, exception_basis: basis, snapshot_ids: ids(i.snapshot_ids), statement_of_reasons: str(i, "statement_of_reasons") || null, records_consulted: ids(i.records_consulted), determined_on: today(ctx) }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.noe.determined", caseId, { assertion_id: str(i, "assertion_id"), determination: det, exception_basis: basis, snapshot_ids: ids(i.snapshot_ids), records_consulted: ids(i.records_consulted) });
      if (det === "exception") caseEvent(ctx, "case.noe.exception_determined", caseId, { assertion_id: str(i, "assertion_id"), exception_basis: basis, determination_date: today(ctx) });
      return { determination: det, exception_basis: basis, exception_notice_due: det === "exception" ? federalDays(today(ctx), 5) : null };
    }),
    guardrails: [NOE_EXISTS,
      guard("ASSERTION_NOT_FOUND", "4.1 data model: determinations attach to a `case_assertions` row of the case", (i, ctx) => (noeAssertion(ctx, str(i, "case_id"), str(i, "assertion_id")) ? undefined : `assertion ${str(i, "assertion_id")} is not on case ${str(i, "case_id")}`)),
      never("NO_ERROR_WITHOUT_SNAPSHOT", "4.1 guardrails: cannot select `no_error` without snapshot rows (`case_relied_documents` ≥ 1; comment 35(e)(4)-1)", (i) => str(i, "determination") === "no_error" && !ids(i.snapshot_ids).length, "no_error needs at least one relied-upon document/snapshot row"),
      never("NO_ERROR_WITHOUT_REASONS", "4.1 state machine: `no_error` requires a statement_of_reasons (§1024.35(e)(1)(i)(B))", (i) => str(i, "determination") === "no_error" && !str(i, "statement_of_reasons"), "no_error needs the plain-language statement of reasons"),
      guard("INVESTIGATION_RECORDS", "4.1 rule 5: 'no error' without consulting the record type the assertion implicates is a hard validation failure", (i, ctx) => { if (str(i, "determination") !== "no_error") return undefined; const a = noeAssertion(ctx, str(i, "case_id"), str(i, "assertion_id")); const v = investigationValid(a?.category ?? (str(i, "category") as AssertionType), ids(i.records_consulted)); return v.valid ? undefined : `the record types a ${a?.category ?? str(i, "category")} assertion implicates were not consulted: ${v.missing.join(", ")}`; }),
      guard("EXCEPTION_WITH_IDENTIFIABLE", "4.1 guardrails / rule 4: cannot select an exception on a case with an identifiable assertion — overbroad applies only to the unidentifiable residue; identifiable assertions are carved out and investigated", (i, ctx) => { if (str(i, "determination") !== "exception" || str(i, "exception_basis") !== "overbroad") return undefined; const a = noeAssertion(ctx, str(i, "case_id"), str(i, "assertion_id")); return a && a.identifiable ? `assertion ${a.id} (${a.category}) is identifiable — it is carved out and investigated; overbroad may attach only to the unidentifiable residue` : undefined; })] },
  // Extension: std_30 only (per the record), once, noticed on or before the original due date; NY adds 7 servicer BD instead of 15 federal; the 30-day clock is re-anchored on the federal new due date.
  { name: "case.noe.extend", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const rec = noeRecord(ctx, caseId)!; const a = noeAssertion(ctx, caseId, str(i, "assertion_id"))!;
      const due = a.response_due; const ny = rec.state === "NY"; const federalNew = federalDays(due, 15); const newDue = ny ? nyExtension({ response_due: due }) : federalNew;
      const ev = caseEvent(ctx, "case.noe.extended", caseId, { assertion_id: a.id, state: rec.state, original_due: due, new_due: newDue, federal_new_due: federalNew, reason: str(i, "reason"), noticed_on: today(ctx) });
      const inst = reanchorDeadline(ctx, caseId, "REGX_1024_35E_NOE_RESPONSE_30", ev, "federal_new_due", `extended +15 business_days_federal on ${today(ctx)} (§1024.35(e)(3)(ii)): ${str(i, "reason")}`);
      rt.store.put("case_assertions", `${caseId}:${a.id}`, { response_due: newDue, extended_on: today(ctx), extension_reason: str(i, "reason") }, ctx.actor, ctx.now); rt.store.put("cases", caseId, { extension_used: true }, ctx.actor, ctx.now);
      return { original_due: due, new_due: newDue, federal_new_due: federalNew, days: ny ? "+7 business_days_servicer" : "+15 business_days_federal", notice: "NTC_REGX_35E_EXTENSION", response_timer_id: inst?.id ?? null };
    }),
    guardrails: [NOE_EXISTS,
      guard("ASSERTION_NOT_FOUND", "4.1 data model: an extension attaches to a `case_assertions` row of the case", (i, ctx) => (noeAssertion(ctx, str(i, "case_id"), str(i, "assertion_id")) ? undefined : `assertion ${str(i, "assertion_id")} is not on case ${str(i, "case_id")}`)),
      guard("EXTENSION_NOT_PERMITTED", "4.1 guardrails: cannot extend (b)(6)/(9)/(10) profiles (§1024.35(e)(3)(ii) 'may not extend')", (i, ctx) => { const a = noeAssertion(ctx, str(i, "case_id"), str(i, "assertion_id")); return a && a.profile !== "std_30" ? `assertion ${a.id} is on the ${a.profile} profile — only a std_30 assertion is extendable` : undefined; }),
      guard("EXTENSION_LATE", "§1024.35(e)(3)(ii): the extension notice must go before the original 30 days end (REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30)", (i, ctx) => { const a = noeAssertion(ctx, str(i, "case_id"), str(i, "assertion_id")); return a && today(ctx) > a.response_due ? `the original response date ${a.response_due} has passed (today ${today(ctx)})` : undefined; }),
      never("EXTENSION_REASON", "§1024.35(e)(3)(ii): the notice states the reasons", (i) => !str(i, "reason"), "an extension needs its reasons"),
      guard("EXTENSION_ONCE", "4.1 state machine: `extended` only with no prior extension", (i, ctx) => (caseEvents(ctx, "case.noe.extended", str(i, "case_id")).some((e) => e.payload.assertion_id === str(i, "assertion_id")) ? `assertion ${str(i, "assertion_id")} was already extended` : undefined))] },
  // Response: emits `case.noe.responded` with the profiles the letter answers (rule 3: one letter by day 7 or two letters), satisfying the per-assertion clocks and clearing the FC gate; the (f)(2) good-faith contact emits `case.noe.goodfaith_responded`.
  { name: "case.noe.respond", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const rec = noeRecord(ctx, caseId)!; const answered = noeRespondIds(i, rec);
      const p = noeRespondedPayload(rec, answered, respondedAssertions(ctx, caseId));
      if (flag(i, "goodfaith")) { ctx.events.append({ type: "contact.logged", loanId: ctx.loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, mode: str(i, "mode") || "oral", purpose: "noe_goodfaith_response" } }); caseEvent(ctx, "case.noe.goodfaith_responded", caseId, { mode: str(i, "mode") || "oral", assertion_ids: answered }); }
      for (const id of answered) rt.store.put("case_assertions", `${caseId}:${id}`, { responded_on: today(ctx), response_notice: str(i, "template") || null }, ctx.actor, ctx.now);
      rt.store.put("cases", caseId, { status: p.complete ? "responded" : "investigating" }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.noe.responded", caseId, { ...p, notice: str(i, "template") || null, goodfaith: flag(i, "goodfaith") });
      return { case_id: caseId, responded_on: today(ctx), assertion_ids: answered, complete: p.complete, remaining_assertion_ids: p.remaining_assertion_ids, fc_gate_open_after: openFcNoeGates(ctx).length === 0 };
    }),
    guardrails: [NOE_EXISTS,
      never("FEE_CONDITION", "§1024.35(h); 4.1 guardrails: never tells a borrower a fee is due as a condition of the investigation", (i) => !!str(i, "text") && !noeCommunicationCheck(str(i, "text")).ok, "the response requests a fee or payment as a condition"),
      guard("UNDETERMINED_ASSERTIONS", "4.1 state machine: `investigating → responded` requires every assertion's determination set", (i, ctx) => { const rec = noeRecord(ctx, str(i, "case_id")); if (!rec) return undefined; const done = determinedAssertions(ctx, rec.case_id); const missing = noeRespondIds(i, rec).filter((id) => !done.has(id)); return missing.length ? `assertions without a determination on the record: ${missing.join(", ")}` : undefined; })] },
  { name: "case.noe.close", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); rt.store.put("cases", caseId, { status: "closed", closed_at: ctx.now, delivery_evidence_id: str(i, "delivery_evidence_id") }, ctx.actor, ctx.now); caseEvent(ctx, "case.noe.closed", caseId, { delivery_evidence_id: str(i, "delivery_evidence_id") }); return { closed: true }; }),
    guardrails: [NOE_EXISTS,
      guard("CLOSE_WITHOUT_EVIDENCE", "4.1 guardrails / state machine: cannot close a case without response evidence — `closed` requires every assertion responded (or excepted / early-corrected) and the response notice's delivery evidence on the record", (i, ctx) => {
        const caseId = str(i, "case_id"); const rec = noeRecord(ctx, caseId)!;
        const excepted = new Set(caseEvents(ctx, "case.noe.exception_determined", caseId).map((e) => String(e.payload.assertion_id)));
        const answered = noeResponded(ctx, caseId) || caseEvents(ctx, "case.noe.early_corrected", caseId).length > 0 || rec.assertions.every((a) => excepted.has(a.id));
        if (!answered) return "no complete response on the record — every assertion is responded to, excepted or early-corrected before the case closes";
        const evidenceId = str(i, "delivery_evidence_id");
        const sent = ctx.events.ofType("notice.sent").filter((e) => e.loanId === ctx.loanId && NOE_RESPONSE_TEMPLATES.includes(String(e.payload.template)) && (e.payload.case_id === caseId || (!!evidenceId && e.payload.notice_id === evidenceId)));
        return sent.length ? undefined : `no delivery evidence: no \`notice.sent\` of a response letter (${NOE_RESPONSE_TEMPLATES.join("/")}) for case ${caseId}${evidenceId ? ` or notice ${evidenceId}` : ""} on the record`;
      })] },
  // §1024.35(f)(1): the optional early-correction path — started within 5 federal BD of receipt (arms REGX_1024_35F1_NOE_EARLY_CORRECTION_5); completed by the correction plus the written notice, which makes the (d)/(e) clocks moot (4.1-T11).
  { name: "case.noe.early_correction.start", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const rec = noeRecord(ctx, caseId)!; rt.store.put("cases", caseId, { status: "early_correction" }, ctx.actor, ctx.now); caseEvent(ctx, "case.noe.early_correction.started", caseId, { receipt_date: rec.receipt_date, letter_due: federalDays(rec.receipt_date, 5) }); return { letter_due: federalDays(rec.receipt_date, 5), notice: "NTC_REGX_35F1_EARLY_CORRECTION" }; }),
    guardrails: [NOE_EXISTS, earlyCorrectionWindow("EARLY_CORRECTION_WINDOW")] },
  { name: "case.noe.early_correct", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const rec = noeRecord(ctx, caseId)!;
      const fixedOn = D(str(i, "fixed_on") || ctx.now.slice(0, 10)); const r = earlyCorrection(rec.receipt_date, fixedOn, today(ctx));
      caseEvent(ctx, "case.noe.early_corrected", caseId, { correction: str(i, "correction"), effective_on: str(i, "effective_on") || null, fixed_on: fixedOn, letter_mailed_on: today(ctx), notice: r.notice });
      const cancelled = cancelCaseTimers(ctx, caseId, NOE_STD_CLOCKS, "early_correction");
      for (const a of rec.assertions) rt.store.put("case_assertions", `${caseId}:${a.id}`, { determination: "early_corrected", responded_on: today(ctx) }, ctx.actor, ctx.now);
      rt.store.put("cases", caseId, { status: "early_corrected", determination: "early_corrected" }, ctx.actor, ctx.now);
      return { qualifies: r.qualifies, cancel_reason: r.cancel_reason, timers_cancelled: cancelled, notice: r.notice };
    }),
    guardrails: [NOE_EXISTS, earlyCorrectionWindow("EARLY_CORRECTION_WINDOW"),
      guard("EARLY_CORRECTION_NEEDS_CORRECTION", "§1024.35(f)(1): the servicer 'corrects the error or errors asserted' — a correction command posted against the case precedes the letter", (i, ctx) => (CORRECTION_EVENTS.some((t) => caseEvents(ctx, t, str(i, "case_id")).length > 0) ? undefined : `no correction (${CORRECTION_EVENTS.join("/")}) posted against case ${str(i, "case_id")}`))] },
  // §1024.35(e)(4): the borrower's (oral or written) request for the documents relied upon — arms REGX_1024_35E4_NOE_DOCS_15 on the request date; privileged items are withheld with the written notice in the same window (4.1-T10).
  { name: "case.noe.documents.request", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const requestedOn = D(str(i, "requested_on") || ctx.now.slice(0, 10));
      const docs = (Array.isArray(i.documents) ? (i.documents as { id: string; privileged?: boolean; relied_on: boolean }[]) : []);
      const r = documentRequest(requestedOn, docs);
      const rec = rt.store.put("document_copy_requests", `${caseId}:${requestedOn}`, { case_id: caseId, requested_at: ctx.now, requested_via: str(i, "requested_via") || "oral", due_at: r.copies_due, provided: r.provided, withheld: r.withheld }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.noe.document_copies.requested", caseId, { requested_on: requestedOn, requested_via: str(i, "requested_via") || "oral", copies_due: r.copies_due, provided: r.provided.map((d) => d.id), withheld: r.withheld.map((d) => d.id) });
      rt.store.put("cases", caseId, { status: "docs_requested" }, ctx.actor, ctx.now);
      return { ...r, request_id: rec.id };
    }), guardrails: [NOE_EXISTS] },
  // `foreclosure.sale.rescheduled` (13.x) recomputes the (b)(9)/(10) due date: the open sale-or-30 instance (and the NY 15-BD one) is re-anchored on the new min(30 federal BD, sale − 1).
  { name: "case.noe.sale_rescheduled", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const rec = noeRecord(ctx, caseId)!; const sale = D(str(i, "sale_date"));
      const due = noeForeclosureDue(rec.receipt_date, sale); const ny = rec.state === "NY" ? nyNoeDeadline(rec.receipt_date, { foreclosure_assertion: true, sale_on: sale }).response_due : null;
      const ev = caseEvent(ctx, "case.noe.fc_due.recomputed", caseId, { sale_date: sale, noe_fc_response_due: due, ny_noe_fc_response_due: ny, previous_sale_date: rec.foreclosure_sale_date });
      const inst = reanchorDeadline(ctx, caseId, "REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30", ev, "noe_fc_response_due", `foreclosure sale rescheduled to ${sale} (comment 35(e)(3)(i)-1)`);
      if (ny) reanchorDeadline(ctx, caseId, "NY_419_6_NOE_FC_RESPONSE_15BD", ev, "ny_noe_fc_response_due", `foreclosure sale rescheduled to ${sale} (3 NYCRR 419.6)`);
      rt.store.put("cases", caseId, { foreclosure_sale_date: sale }, ctx.actor, ctx.now); for (const a of rec.assertions) if (a.profile === "fc_before_sale") rt.store.put("case_assertions", `${caseId}:${a.id}`, { response_due: due }, ctx.actor, ctx.now);
      return { sale_date: sale, noe_fc_response_due: due, response_timer_id: inst?.id ?? null };
    }), guardrails: [NOE_EXISTS, never("SALE_DATE_REQUIRED", "4.1 inputs: `foreclosure.sale.rescheduled` carries the new sale date", (i) => !/^\d{4}-\d{2}-\d{2}$/.test(str(i, "sale_date")), "sale_date (YYYY-MM-DD) is required")] },
  // Correction commands (rule 6): ledger-neutral reversals + re-postings with the original effective date; the threshold is measured on the money posted.
  { name: "payment.reapply", kind: "act", handler: compute((i, ctx) => {
      const caseId = str(i, "case_id"); const eff = D(str(i, "effective_date")); const setId = str(i, "original_set_id");
      const orig = ctx.ledger.sets().find((s) => s.id === setId); if (!orig) throw new RangeError(`no entry set ${setId} to re-apply`);
      const reversal = ctx.ledger.reverse(setId, eff, `NoE ${caseId}: re-dated to ${eff}`, ctx.now);
      const repost = ctx.ledger.post(repostSet(orig, eff, caseId), ctx.now);
      caseEvent(ctx, "payment.reapplied", caseId, { original_set_id: setId, reversal_set_id: reversal.id, repost_set_id: repost.id, effective_date: eff, amount_cents: linesAmount(orig.lines).toString() });
      return { reversal_set_id: reversal.id, repost_set_id: repost.id, effective_date: eff, amount_cents: linesAmount(orig.lines) };
    }), guardrails: correctionGuardrails("payment.reapply") },
  { name: "fee.reverse", kind: "act", handler: compute((i, ctx) => {
      const caseId = str(i, "case_id"); const acct = (str(i, "fee_account") || "late_charges") as "late_charges" | "nsf_fees" | "other_fees";
      const set = ctx.ledger.post(feeReversalSet(typeof i.loan_id === "string" ? i.loan_id : ctx.loanId, acct, amount(i), D(str(i, "effective_date") || ctx.now.slice(0, 10)), caseId, str(i, "reason") || "fee lacking a reasonable basis (§1024.35(b)(5))"), ctx.now);
      caseEvent(ctx, "fee.reversed", caseId, { entry_set_id: set.id, fee_account: acct, amount_cents: amount(i).toString(), effective_date: set.effectiveDate });
      return { entry_set_id: set.id, fee_account: acct, amount_cents: amount(i), effective_date: set.effectiveDate };
    }), guardrails: correctionGuardrails("fee.reverse") },
  { name: "late_charge.waive", kind: "act", handler: compute((i, ctx) => {
      const caseId = str(i, "case_id");
      const set = ctx.ledger.post(feeReversalSet(typeof i.loan_id === "string" ? i.loan_id : ctx.loanId, "late_charges", amount(i), D(str(i, "effective_date") || ctx.now.slice(0, 10)), caseId, str(i, "reason") || "late charge waived on NoE resolution", "4.1:r6:late_charge_waiver"), ctx.now);
      caseEvent(ctx, "late_charge.waived", caseId, { entry_set_id: set.id, amount_cents: amount(i).toString() });
      return { entry_set_id: set.id, amount_cents: amount(i) };
    }), guardrails: correctionGuardrails("late_charge.waive") },
  { name: "escrow.correct", kind: "act", handler: ledgerCorrection("escrow.corrected", "4.1:r6:escrow_correction"), guardrails: correctionGuardrails("escrow.correct") },
  { name: "suspense.apply", kind: "act", handler: ledgerCorrection("suspense.applied", "4.1:r6:suspense_application"), guardrails: correctionGuardrails("suspense.apply") },
  { name: "payoff.quote.reissue", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const id = str(i, "quote_id") || `pq-${caseId}`; const corrected = cents(i.corrected_payoff_cents);
      const prev = rt.store.get("payoff_quotes", id); const delta = prev ? (corrected > cents(prev.data.payoff_cents) ? corrected - cents(prev.data.payoff_cents) : cents(prev.data.payoff_cents) - corrected) : amount(i);
      if (prev && delta !== amount(i)) throw new RangeError(`amount_cents ${amount(i)} is not the correction to quote ${id} (previous ${cents(prev.data.payoff_cents)}¢, corrected ${corrected}¢ → ${delta}¢)`);
      const rec = rt.store.put("payoff_quotes", id, { case_id: caseId, payoff_cents: corrected, good_through: str(i, "good_through") || null, reissued_at: ctx.now }, ctx.actor, ctx.now);
      caseEvent(ctx, "payoff.quote.reissued", caseId, { quote_id: id, version: rec.version, correction_cents: delta.toString() });
      return { quote_id: id, version: rec.version, correction_cents: delta };
    }), guardrails: [...correctionGuardrails("payoff.quote.reissue"), never("CORRECTION_AMOUNT_REQUIRED", "4.1 AI design: correction commands are gated by per-command monetary thresholds — a payoff reissue states the correction it makes", (i) => amount(i) === 0n, "amount_cents (the correction to the prior quote) is required")] },
  { name: "foreclosure.milestone.reverse", kind: "act", handler: compute((i, ctx) => { caseEvent(ctx, "foreclosure.milestone.reversed", str(i, "case_id"), { milestone: str(i, "milestone"), human_approval_id: str(i, "human_approval_id") }); return { reversed: str(i, "milestone") }; }),
    guardrails: [correctionGuardrails("foreclosure.milestone.reverse")[0]!, correctionGuardrails("foreclosure.milestone.reverse")[1]!,
      guard("FC_MILESTONE_REVERSAL_NEEDS_HUMAN", "4.1 guardrails: cannot reverse a foreclosure milestone without human approval (attorney review of (b)(9)/(10) determinations)", (i, ctx) => (ctx.actor.kind !== "human" && !approved(ctx, i, "human_approval_id", ["attorney", "officer"], "foreclosure.milestone.reverse") ? "reversing a foreclosure milestone is a human act — the attorney/officer records the approval (case.approval.record) the agent then cites" : undefined))] },
]);

// ---------------------------------------------------------------- 4.2 RFI case commands
const RFI_STD_CLOCKS = ["REGX_1024_36C_RFI_ACK_5", "SM_RFI_INTERNAL_TARGET_7"];
const earlyResponseWindow = (code: string): Guardrail<ToolInput> => guard(code, "§1024.36(e): the information provided in writing within 5 days of receipt — later, (c) and (d) apply (REGX_1024_36E_RFI_EARLY_RESPONSE_5 breach: 'revert to std path')", (i, ctx) => { const rec = rfiRecord(ctx, str(i, "case_id")); return rec && today(ctx) > federalDays(rec.receipt_date, 5) ? `day ${federalDays(rec.receipt_date, 5)} has passed — the acknowledgment and response clocks govern` : undefined; });
/** 4.4 inputs: `communication.classified` with kind `sii_inquiry` → `case.sii.opened` (+ `case.rfi.opened` when written); shared by rfi.open and sii.open. */
function openSiiCase(rt: ToolRuntime, ctx: CommandContext, f: { case_id: string; notice_source: string; transfer_type: string | null; notice_date: PlainDate; lossmit_pending: boolean; linked_case_ids: readonly string[]; transferor_borrower_id: string | null; state: string | null }): Record<string, unknown> {
  const due = siiPolicyDue(f.notice_date, f.lossmit_pending);
  rt.store.put("sii_cases", f.case_id, { case_type: "sii", notice_source: f.notice_source, transfer_type: f.transfer_type, state: f.state, notice_date: f.notice_date, lossmit_pending: f.lossmit_pending, determination: "pending", ack_status: "not_sent", assumption_status: "none", linked_case_ids: [...f.linked_case_ids], transferor_borrower_id: f.transferor_borrower_id, status: "opened" }, ctx.actor, ctx.now);
  const p = { case_id: f.case_id, notice_source: f.notice_source, transfer_type: f.transfer_type, state: f.state, notice_date: f.notice_date, lossmit_pending: f.lossmit_pending, facilitate_due: due.facilitate_due, linked_case_ids: [...f.linked_case_ids] };
  caseEvent(ctx, "case.sii.opened", f.case_id, p);
  return p;
}
const rfiCommands: ToolDef[] = defineTools("4.2", "case", [
  { name: "rfi.open", kind: "write", handler: compute((i, ctx, rt) => {
      const f: RfiOpenInput = { case_id: str(i, "case_id") || `rfi-${ctx.now}`, receipt_date: D(str(i, "receipt_date") || ctx.now.slice(0, 10)), state: typeof i.state === "string" ? i.state : null, requester_role: (str(i, "requester_role") || (flag(i, "is_potential_successor_request") ? "potential_successor" : "borrower")) as NonNullable<RfiOpenInput["requester_role"]>, items: (Array.isArray(i.items) ? (i.items as RfiOpenInput["items"]) : []), is_potential_successor_request: flag(i, "is_potential_successor_request"), linked_case_ids: Array.isArray(i.linked_case_ids) ? (i.linked_case_ids as string[]) : [] };
      const p = rfiOpenedPayload(f);
      const items = (f.items as readonly { id: string; description?: string }[]);
      rt.store.put("cases", f.case_id, { case_type: "rfi", receipt_date: f.receipt_date, state: p.state, requester_role: p.requester_role, is_potential_successor_request: p.is_potential_successor_request, deadline_profile: p.is_potential_successor_request ? "sii_docs_30" : p.owner_identity_item && !p.std_item ? "owner_10" : "std_30", status: "triaged", linked_case_ids: p.linked_case_ids }, ctx.actor, ctx.now);
      p.items.forEach((it, n) => rt.store.put("case_request_items", `${f.case_id}:${it.id}`, { case_id: f.case_id, seq: n + 1, item_kind: it.kind, description: items[n]?.description ?? null, response_due: it.response_due, ack_due: it.ack_due, extendable: it.extendable, determination: null, responded_on: null }, ctx.actor, ctx.now));
      caseEvent(ctx, "case.rfi.opened", f.case_id, { ...p, items: p.items.map((it, n) => ({ ...it, description: items[n]?.description ?? null })) });
      // §1024.36(i) / 4.2-T7: a potential successor's letter opens the 4.4 case too (the document description is the RFI answer; no account information before confirmation).
      const sii = p.is_potential_successor_request ? openSiiCase(rt, ctx, { case_id: str(i, "sii_case_id") || `sii-${f.case_id}`, notice_source: "letter", transfer_type: typeof i.transfer_type === "string" ? i.transfer_type : null, notice_date: f.receipt_date, lossmit_pending: flag(i, "lossmit_pending"), linked_case_ids: [f.case_id], transferor_borrower_id: typeof i.transferor_borrower_id === "string" ? i.transferor_borrower_id : null, state: p.state }) : null;
      if (sii) { caseEvent(ctx, "case.sii.potential_successor.identified", String(sii.case_id), { party_id: str(i, "party_id") || null, identified_on: f.receipt_date, lossmit_pending: flag(i, "lossmit_pending"), docs_description_due: siiPolicyDue(f.receipt_date, flag(i, "lossmit_pending")).docs_description_due, via: "rfi" }); rt.store.put("cases", f.case_id, { linked_case_ids: [...p.linked_case_ids, String(sii.case_id)] }, ctx.actor, ctx.now); }
      return { ...p, sii_case_id: sii ? String(sii.case_id) : null };
    }), guardrails: [never("RFI_NEEDS_ITEM", "§1024.36(a): a request states the information requested", (i) => !Array.isArray(i.items) || i.items.length === 0, "no information item identified"),
      guard("CASE_EXISTS", "4.1 edge cases: the same letter is one case (dedupe) — a case id is opened once", (i, ctx) => (str(i, "case_id") && caseKnown(ctx, str(i, "case_id")) ? `case ${str(i, "case_id")} already exists` : undefined))] },
  { name: "rfi.item.determine", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"), det = str(i, "determination");
      rt.store.put("case_request_items", `${caseId}:${str(i, "item_id")}`, { determination: det, search_log: (i.search_log as unknown[] | undefined) ?? [], not_available_basis: str(i, "not_available_basis") || null, determined_on: today(ctx) }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.rfi.item.determined", caseId, { item_id: str(i, "item_id"), determination: det });
      if (det.startsWith("exception_")) caseEvent(ctx, "case.rfi.exception_determined", caseId, { item_id: str(i, "item_id"), exception_basis: det.slice("exception_".length), determination_date: today(ctx) });
      return { determination: det, exception_notice_due: det.startsWith("exception_") ? federalDays(today(ctx), 5) : null };
    }),
    guardrails: [RFI_EXISTS,
      guard("ITEM_NOT_FOUND", "4.2 data model: determinations attach to a `case_request_items` row of the case", (i, ctx) => (rfiItem(ctx, str(i, "case_id"), str(i, "item_id")) ? undefined : `item ${str(i, "item_id")} is not on case ${str(i, "case_id")}`)),
      never("NOT_AVAILABLE_WITHOUT_SEARCH_LOG", "4.2 guardrails: cannot mark `not_available` without a search log covering the mandatory classes (online, offsite_reasonable)", (i) => str(i, "determination") === "not_available" && !searchLogComplete(i.search_log).complete, "the search log does not cover every mandatory records_inventory class (online, offsite_reasonable) with a searched_at timestamp"),
      guard("IRRELEVANT_OWN_RECORDS", "4.2 guardrails: cannot apply `irrelevant` to the borrower's own account records (comment 36(f)(1)(iii)-1; 4.2 rule 4)", (i, ctx) => { if (str(i, "determination") !== "exception_irrelevant") return undefined; const it = rfiItem(ctx, str(i, "case_id"), str(i, "item_id")) as { description?: string | null } | undefined; return flag(i, "own_account_record") || ownAccountRecord(it?.description ?? "") ? "the borrower's own evaluation inputs and results are relevant and provided" : undefined; }),
      // 4.2 human touchpoints / 4.2-T13: "privilege calls are made by counsel — `attorney` role, retained counsel — before anything is withheld as privileged"
      guard("PRIVILEGE_NEEDS_ATTORNEY", "4.2 human touchpoints: privilege calls are made by counsel (`attorney` role) before anything is withheld as privileged (§1024.36(f)(1)(ii))", (i, ctx) => (str(i, "determination") === "exception_confidential" && !(ctx.actor.kind === "human" && ctx.actor.role === "attorney") ? `a confidential/privileged withholding is determined by the attorney, not ${ctx.actor.kind}:${ctx.actor.id}` : undefined))] },
  // 4.2-T13: an item asking for legal analysis/advice routes to the `attorney` for the privilege determination (ops.privilegeRouting); the (f)(2) withholding notice then issues within the item's clock.
  { name: "rfi.item.route", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const it = rfiItem(ctx, caseId, str(i, "item_id")) as { id: string; description?: string | null; response_due: PlainDate }; const rec = rfiRecord(ctx, caseId)!;
      const r = privilegeRouting(it.description ?? str(i, "description"), rec.receipt_date);
      const esc = r.route === "attorney" ? rt.escalations.open({ kind: "attorney", loanId: ctx.loanId, caseId, severity: "sev-2", payload: { item_id: it.id, description: it.description ?? null, question: "privilege determination (§1024.36(f)(1)(ii))", basis_if_withheld: r.basis, withholding_notice: r.notice, due_on: r.due_on } }, ctx.actor) : null;
      rt.store.put("case_request_items", `${caseId}:${it.id}`, { routed_to: r.route, privilege_review_escalation_id: esc?.id ?? null }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.rfi.item.routed", caseId, { item_id: it.id, route: r.route, basis: r.basis, notice: r.notice, due_on: r.due_on, escalation_id: esc?.id ?? null });
      return { item_id: it.id, route: r.route, basis: r.basis, notice: r.notice, due_on: r.due_on, escalation_id: esc?.id ?? null };
    }),
    guardrails: [RFI_EXISTS, guard("ITEM_NOT_FOUND", "4.2 data model: routing attaches to a `case_request_items` row of the case", (i, ctx) => (rfiItem(ctx, str(i, "case_id"), str(i, "item_id")) ? undefined : `item ${str(i, "item_id")} is not on case ${str(i, "case_id")}`))] },
  { name: "rfi.item.extend", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const it = rfiItem(ctx, caseId, str(i, "item_id"))!; const due = it.response_due; const newDue = federalDays(due, 15);
      const ev = caseEvent(ctx, "case.rfi.extended", caseId, { item_id: it.id, original_due: due, new_due: newDue, federal_new_due: newDue, reason: str(i, "reason"), noticed_on: today(ctx) });
      const inst = reanchorDeadline(ctx, caseId, "REGX_1024_36D_RFI_RESPONSE_30", ev, "federal_new_due", `extended +15 business_days_federal on ${today(ctx)} (§1024.36(d)(2)(ii)): ${str(i, "reason")}`);
      rt.store.put("case_request_items", `${caseId}:${it.id}`, { response_due: newDue, extended_on: today(ctx), extension_reason: str(i, "reason") }, ctx.actor, ctx.now);
      return { original_due: due, new_due: newDue, notice: "NTC_REGX_36D_EXTENSION", reason: str(i, "reason"), response_timer_id: inst?.id ?? null };
    }),
    guardrails: [RFI_EXISTS,
      guard("ITEM_NOT_FOUND", "4.2 data model: an extension attaches to a `case_request_items` row of the case", (i, ctx) => (rfiItem(ctx, str(i, "case_id"), str(i, "item_id")) ? undefined : `item ${str(i, "item_id")} is not on case ${str(i, "case_id")}`)),
      guard("EXTENSION_NOT_PERMITTED", "§1024.36(d)(2)(ii): no extension for owner-identity requests", (i, ctx) => { const it = rfiItem(ctx, str(i, "case_id"), str(i, "item_id")); return it && !it.extendable ? `item ${it.id} (${it.kind}) is never extended` : undefined; }),
      guard("EXTENSION_LATE", "§1024.36(d)(2)(ii): the extension notice goes before the 30 days end (REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30)", (i, ctx) => { const it = rfiItem(ctx, str(i, "case_id"), str(i, "item_id")); return it && today(ctx) > it.response_due ? `the original response date ${it.response_due} has passed (today ${today(ctx)})` : undefined; }),
      never("EXTENSION_REASON", "§1024.36(d)(2)(ii): the notice states the reasons", (i) => !str(i, "reason"), "an extension needs its reasons"),
      guard("EXTENSION_ONCE", "4.2 state machine: `extended` only for `std_30`, once", (i, ctx) => (caseEvents(ctx, "case.rfi.extended", str(i, "case_id")).some((e) => e.payload.item_id === str(i, "item_id")) ? `item ${str(i, "item_id")} was already extended` : undefined))] },
  { name: "rfi.respond", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const rec = rfiRecord(ctx, caseId)!; const answered = rfiRespondIds(i, rec);
      const p = rfiRespondedPayload(rec, answered, respondedItems(ctx, caseId));
      const check = rec.requester_role !== "borrower" ? redactionCheck(rec.requester_role, i.response_data) : null;
      for (const id of answered) rt.store.put("case_request_items", `${caseId}:${id}`, { responded_on: today(ctx) }, ctx.actor, ctx.now);
      rt.store.put("cases", caseId, { status: p.complete ? "responded" : "searching", ...(check ? { omissions_applied: { requester_role: rec.requester_role, redaction_log: (i.redaction_log as unknown[] | undefined) ?? [], check_passed: check.passed } } : {}) }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.rfi.responded", caseId, { ...p, template: str(i, "template") || null, owner_block_version: i.owner_block !== undefined ? FNMA_OWNER_BLOCK.version : null, redaction_check_passed: check ? check.passed : null, redaction_log: (i.redaction_log as unknown[] | undefined) ?? [] });
      return { responded_on: today(ctx), item_ids: answered, complete: p.complete, redaction_check_passed: check ? check.passed : null };
    }),
    guardrails: [RFI_EXISTS,
      guard("ITEMS_UNDETERMINED", "4.2 state machine: `searching → responded` requires each `case_request_items.determination` set", (i, ctx) => { const rec = rfiRecord(ctx, str(i, "case_id")); if (!rec) return undefined; const done = determinedItems(ctx, rec.case_id); const missing = rfiRespondIds(i, rec).filter((id) => !done.has(id)); return missing.length ? `items without a determination on the record: ${missing.join(", ")}` : undefined; }),
      never("OWNER_BLOCK_VERSIONED", "4.2 guardrails: cannot send an owner-identity answer that deviates from the versioned Fannie Mae block (A4-1-03)", (i) => typeof i.owner_block === "string" && i.owner_block !== ownerIdentity((str(i, "ownership") || "fnma_portfolio") as Ownership, flag(i, "asked_for_trust_name"), str(i, "pool_number") || undefined), `the owner block must be the ${FNMA_OWNER_BLOCK.version} reference text for the loan's ownership type`),
      guard("SII_NO_ACCOUNT_INFO", "4.4 guardrails / §1024.36(i): cannot disclose account details to a potential successor before confirmation beyond the document description", (i, ctx) => { const rec = rfiRecord(ctx, str(i, "case_id")); if (!rec || (rec.requester_role !== "potential_successor" && !rec.is_potential_successor_request)) return undefined; if (flag(i, "account_information_included")) return "a potential successor gets the document description only until confirmed"; const r = i.response_data === undefined ? null : redactionCheck("potential_successor", i.response_data); return r && !r.passed ? `account information in the response to a potential successor: ${r.violations.map((v) => v.field).join(", ")}` : undefined; }),
      guard("REDACTION_BEFORE_SEND", "4.2 guardrails: must redact per §1024.36(d)(3) before send — automated PII detector + rule table; a failed redaction check blocks the send", (i, ctx) => { const rec = rfiRecord(ctx, str(i, "case_id")); if (!rec || rec.requester_role === "borrower") return undefined; if (i.response_data === undefined) return `requester is a ${rec.requester_role}: the response content (response_data) goes through the redaction check before send`; const r = redactionCheck(rec.requester_role, i.response_data); return r.passed ? undefined : `redaction check failed for a ${rec.requester_role}: ${r.violations.map((v) => `${v.field} (${v.rule})`).join(", ")}`; })] },
  // §1024.36(e): answered in writing within 5 federal BD → (c) and (d) do not apply; the ack clock cancels with reason `early_response` (4.2-T11).
  { name: "rfi.early_response.start", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const rec = rfiRecord(ctx, caseId)!; rt.store.put("cases", caseId, { status: "early_response", deadline_profile: "early_5" }, ctx.actor, ctx.now); caseEvent(ctx, "case.rfi.early_response.started", caseId, { receipt_date: rec.receipt_date, letter_due: federalDays(rec.receipt_date, 5) }); return { letter_due: federalDays(rec.receipt_date, 5), notice: "NTC_REGX_36E_EARLY" }; }),
    guardrails: [RFI_EXISTS, earlyResponseWindow("EARLY_RESPONSE_WINDOW")] },
  { name: "rfi.early_respond", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const rec = rfiRecord(ctx, caseId)!; const answered = rfiRespondIds(i, rec); const r = earlyResponse(rec.receipt_date, today(ctx));
      const p = rfiRespondedPayload(rec, answered, respondedItems(ctx, caseId));
      for (const id of answered) rt.store.put("case_request_items", `${caseId}:${id}`, { determination: "provided", responded_on: today(ctx) }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.rfi.early_responded", caseId, { item_ids: answered, responded_on: today(ctx), notice: r.notice });
      caseEvent(ctx, "case.rfi.responded", caseId, { ...p, template: r.notice, early: true });
      const cancelled = cancelCaseTimers(ctx, caseId, RFI_STD_CLOCKS, "early_response");
      rt.store.put("cases", caseId, { status: p.complete ? "responded" : "searching" }, ctx.actor, ctx.now);
      return { qualifies: r.qualifies, cancel_reason: r.cancel_reason, timers_cancelled: cancelled, notice: r.notice, complete: p.complete };
    }),
    guardrails: [RFI_EXISTS, earlyResponseWindow("EARLY_RESPONSE_WINDOW"),
      guard("REDACTION_BEFORE_SEND", "4.2 guardrails: must redact per §1024.36(d)(3) before send", (i, ctx) => { const rec = rfiRecord(ctx, str(i, "case_id")); if (!rec || rec.requester_role === "borrower") return undefined; const r = i.response_data === undefined ? null : redactionCheck(rec.requester_role, i.response_data); return !r ? "the response content (response_data) goes through the redaction check before send" : r.passed ? undefined : `redaction check failed: ${r.violations.map((v) => v.field).join(", ")}`; })] },
]);

// ---------------------------------------------------------------- 4.3 continuity-of-contact commands
const episodeId = (i: ToolInput, ctx: CommandContext): string => str(i, "episode_id") || `ep-${ctx.loanId}`;
const activeEpisode = (rt: ToolRuntime, ctx: CommandContext, id: string): Record<string, unknown> | undefined => { const e = rt.store.get("continuity_episodes", id)?.data; return e && e.status === "assigned" ? e : undefined; };
/**
 * 4.3-T1 / REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE: the 11.2 send command calls this before sending — with no active
 * assignment it auto-assigns the default team (mode `ai_first_named_human`) and returns the contact block the notice
 * carries (`continuity_block_present`). Emits `continuity.assigned` only when it assigns.
 */
export function ensureContinuityAssignment(rt: ToolRuntime, ctx: CommandContext, f: { team: ContactTeamBlock; due_unpaid: PlainDate; principal_residence: boolean; episode_id?: string }): { auto_assigned: boolean; episode_id: string; notice_block: ContactTeamBlock & { continuity_block_present: true }; assignment_due_at: PlainDate | "not_required" } {
  const id = f.episode_id ?? `ep-${ctx.loanId}`; const existing = activeEpisode(rt, ctx, id);
  const r = eiNoticeAssignment({ episode: existing ? { status: "assigned", consecutive_on_time: Number(existing.consecutive_on_time ?? 0), mode: existing.mode as Episode["mode"], team: existing.team as Episode["team"] } : null, requested_on: today(ctx), due_unpaid: f.due_unpaid, principal_residence: f.principal_residence, default_team: f.team });
  if (r.auto_assigned) {
    rt.store.put("continuity_episodes", id, { loan_id: ctx.loanId, status: "assigned", assigned_at: ctx.now, assignment_due_at: r.assignment_due_at, assignment_mode: r.episode.mode, mode: r.episode.mode, team: r.episode.team, team_name: f.team.team_name, named_human: f.team.named_human_first_name, direct_number: f.team.direct_number, hours: f.team.hours, consecutive_on_time: 0, auto_assigned_by: "ei_notice" }, ctx.actor, ctx.now);
    ctx.events.append({ type: "continuity.assigned", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, team: f.team.team_name, mode: r.episode.mode, named_human: f.team.named_human_first_name, direct_number: f.team.direct_number, assigned_on: today(ctx), auto_assigned: true, trigger: "ei_notice" } });
  }
  return { auto_assigned: r.auto_assigned, episode_id: id, notice_block: r.notice_block, assignment_due_at: r.assignment_due_at };
}
const continuityCommands: ToolDef[] = defineTools("4.3", "borrower-comms", [
  // §1024.40(a)(1): assignment of the team (AI first line + named human) — `continuity.assigned` satisfies REGX_1024_40A1_CONTACT_ASSIGN_45 / ASSIGN_BEFORE_EI_NOTICE and opens the daily availability check.
  { name: "continuity.assign", kind: "write", handler: compute((i, ctx, rt) => {
      const id = episodeId(i, ctx); const mode = str(i, "mode") || "ai_first_named_human";
      const rec = rt.store.put("continuity_episodes", id, { loan_id: ctx.loanId, status: "assigned", assigned_at: ctx.now, assignment_mode: mode, mode, team: str(i, "team") || "default", team_name: str(i, "team_name") || str(i, "team") || "default", named_human: str(i, "named_human") || null, direct_number: str(i, "direct_number"), hours: str(i, "hours") || null, consecutive_on_time: 0, ...(typeof i.assignment_due_at === "string" ? { assignment_due_at: i.assignment_due_at } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "continuity.assigned", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, team: rec.data.team_name, mode, named_human: rec.data.named_human, direct_number: rec.data.direct_number, assigned_on: today(ctx), auto_assigned: false } });
      return { episode_id: id, version: rec.version, mode };
    }),
    guardrails: [never("NAMED_HUMAN_REQUIRED", "4.3 state machine: `pending_assignment → assigned` requires `named_human_id` unless `ai_only` is enabled for the jurisdiction (default off — 4.3-Q1)", (i) => (str(i, "mode") || "ai_first_named_human") !== "ai_only" && !str(i, "named_human"), "an assignment names the human of record"),
      never("AI_ONLY_OFF", "4.3 AI design: `continuity.ai_only` is a feature flag, default off, enable-able per state only after the written legal opinion and partner sign-off", (i) => str(i, "mode") === "ai_only" && !flag(i, "ai_only_enabled_for_state"), "ai_only is not enabled for this jurisdiction"),
      never("DIRECT_NUMBER_REQUIRED", "4.3 state machine: an assignment needs a reachable `direct_number`", (i) => !str(i, "direct_number"), "the team's direct number is required")] },
  // 4.3 rule 3 / T6: a payment under a permanent agreement counts when on time; the second consecutive one releases the episode (`continuity.released`).
  { name: "continuity.permanent_payment.record", kind: "write", handler: compute((i, ctx, rt) => {
      const id = episodeId(i, ctx); const cur = rt.store.get("continuity_episodes", id)?.data; if (!cur) throw new RangeError(`no continuity episode ${id}`);
      const e: Episode = { status: cur.status as Episode["status"], consecutive_on_time: Number(cur.consecutive_on_time ?? 0), mode: cur.mode as Episode["mode"], team: cur.team as Episode["team"] };
      const r = onPermanentPayment(e, { due_date: D(str(i, "due_date")), received_on: D(str(i, "received_on")), ...(i.grace_days !== undefined ? { grace_days: num(i, "grace_days") } : {}), ...(i.late_charge_posted !== undefined ? { late_charge_posted: flag(i, "late_charge_posted") } : {}), permanent_agreement: flag(i, "permanent_agreement") });
      rt.store.put("continuity_episodes", id, { status: e.status, consecutive_on_time: e.consecutive_on_time, ...(r.release_on ? { released_at: r.release_on, release_reason: "two_consecutive_permanent_payments" } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "continuity.permanent_payment.counted", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, on_time: r.on_time, consecutive_on_time: e.consecutive_on_time, permanent_agreement: flag(i, "permanent_agreement"), release_on: r.release_on } });
      if (r.release_on) ctx.events.append({ type: "continuity.released", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, reason: "two_consecutive_permanent_payments", released_on: r.release_on } });
      return { on_time: r.on_time, consecutive_on_time: e.consecutive_on_time, release_on: r.release_on, status: e.status };
    }) },
  { name: "continuity.release", kind: "act", handler: compute((i, ctx, rt) => { const id = episodeId(i, ctx); rt.store.put("continuity_episodes", id, { status: "released", released_at: today(ctx), release_reason: str(i, "reason") }, ctx.actor, ctx.now); ctx.events.append({ type: "continuity.released", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, reason: str(i, "reason"), released_on: today(ctx) } }); return { episode_id: id, reason: str(i, "reason") }; }),
    guardrails: [never("RELEASE_REASON", "4.3 data model: `release_reason` ∈ {two_consecutive_permanent_payments, current, paid_off, refinanced, title_transferred, transfer_out}", (i) => !["two_consecutive_permanent_payments", "current", "paid_off", "refinanced", "title_transferred", "transfer_out"].includes(str(i, "reason")), "not a release trigger (comment 40(a)-1)"),
      guard("RELEASE_NOT_EARNED", "REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS: release command refused before two consecutive on-time payments under a permanent agreement (§1024.40(a)(2))", (i, ctx) => { if (str(i, "reason") !== "two_consecutive_permanent_payments") return undefined; const last = ctx.events.ofType("continuity.permanent_payment.counted").filter((e) => e.loanId === ctx.loanId && e.payload.episode_id === episodeId(i, ctx)).at(-1); return Number(last?.payload.consecutive_on_time ?? 0) >= 2 ? undefined : `the record shows ${Number(last?.payload.consecutive_on_time ?? 0)} consecutive on-time permanent-agreement payment(s)`; })] },
  // Cal. Civ. Code §2923.7: a human SPOC of record with a direct means of communication within 2 servicer BD of the request (4.3 rule 4 / T7).
  { name: "continuity.ca_spoc.assign", kind: "write", handler: compute((i, ctx, rt) => {
      const id = episodeId(i, ctx); const means = ids(i.direct_means);
      rt.store.put("continuity_episodes", id, { loan_id: ctx.loanId, ca_spoc_required: true, ca_spoc_assigned_at: ctx.now, ca_spoc_mode: str(i, "mode"), ca_spoc: str(i, "spoc_name"), ca_spoc_direct_means: means, status: rt.store.get("continuity_episodes", id)?.data.status ?? "assigned" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "continuity.ca_spoc_assigned", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, mode: str(i, "mode"), spoc_name: str(i, "spoc_name"), direct_means: means, direct_means_sent: means.length > 0, notice: "NTC_CA_2923_7_SPOC", assigned_on: today(ctx), assign_by: typeof i.requested_on === "string" ? caSpocDue(D(i.requested_on)) : null } });
      return { episode_id: id, mode: str(i, "mode"), direct_means: means, notice: "NTC_CA_2923_7_SPOC" };
    }),
    guardrails: [never("CA_SPOC_HUMAN", "4.3 rule 4: the SPOC of record is a human individual or human team (`assignment_mode ∈ {human_team, human_individual}`) until a CA-specific legal opinion permits otherwise (§2923.7(e))", (i) => !["human_team", "human_individual"].includes(str(i, "mode")), "the CA SPOC is a human team or individual with the AI as assistant"),
      never("CA_SPOC_DIRECT_MEANS", "§2923.7(a): 'one or more direct means of communication'", (i) => ids(i.direct_means).length === 0, "a direct number/email is sent with the assignment")] },
  { name: "continuity.ca_spoc.release", kind: "act", handler: compute((i, ctx, rt) => { const id = episodeId(i, ctx); rt.store.put("continuity_episodes", id, { ca_spoc_released_at: today(ctx), ca_spoc_release_reason: str(i, "reason") }, ctx.actor, ctx.now); ctx.events.append({ type: "continuity.ca_spoc.released", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, reason: str(i, "reason"), released_on: today(ctx), appeal_decided_on: str(i, "appeal_decided_on") || null } }); return { episode_id: id, reason: str(i, "reason") }; }),
    guardrails: [never("CA_SPOC_RELEASE_REASON", "CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT: release only when every option is exhausted or the account is current (§2923.7(c))", (i) => !["options_exhausted", "current"].includes(str(i, "reason")), "release refused"),
      guard("CA_SPOC_APPEAL_PENDING", "4.3-T7: the SPOC persists after a denial until the appeal is decided (§2923.7(c) 'all loss mitigation options … exhausted')", (i, ctx) => { if (str(i, "reason") !== "options_exhausted") return undefined; const det = ctx.events.ofType("lossmit.determination.sent").filter((e) => e.loanId === ctx.loanId).at(-1); const decided = ctx.events.ofType("lossmit.appeal.decided").some((e) => e.loanId === ctx.loanId && det !== undefined && e.sequence > det.sequence); return det && det.payload.outcome === "denied" && det.payload.appeal_available === true && !decided ? "the appeal of the denial has not been decided — options are not exhausted" : undefined; })] },
  { name: "continuity.availability.check", kind: "write", handler: compute((i, ctx) => { const staffed = flag(i, "team_active") && flag(i, "line_reachable"); ctx.events.append({ type: "continuity.availability.checked", loanId: ctx.loanId, actor: ctx.actor, payload: { episode_id: episodeId(i, ctx), staffed, checked_at: ctx.now, team_active: flag(i, "team_active"), line_reachable: flag(i, "line_reachable") } }); return { staffed }; }) },
  { name: "continuity.bankruptcy.reassign", kind: "write", handler: compute((i, ctx, rt) => { const id = episodeId(i, ctx); const cur = rt.store.get("continuity_episodes", id)?.data; if (!cur) throw new RangeError(`no continuity episode ${id}`); rt.store.put("continuity_episodes", id, { team: "bankruptcy_specialist" }, ctx.actor, ctx.now); ctx.events.append({ type: "continuity.reassigned", loanId: ctx.loanId, aggregate: { kind: "continuity_episode", id }, actor: ctx.actor, payload: { episode_id: id, team: "bankruptcy_specialist", reason: "bankruptcy_filed", new_episode: false } }); return { episode_id: id, team: "bankruptcy_specialist", new_episode: false }; }) },
]);

// ---------------------------------------------------------------- 4.4 successor-in-interest case commands
const siiCommands: ToolDef[] = defineTools("4.4", "case", [
  // `party.death_notice.received` / `property.transfer_notice.received` / `sii_inquiry` → `case.sii.opened` (the "facilitate communication" clock starts on the notice date).
  { name: "sii.open", kind: "write", handler: compute((i, ctx, rt) => openSiiCase(rt, ctx, { case_id: str(i, "case_id") || `sii-${ctx.now}`, notice_source: str(i, "notice_source") || "call", transfer_type: typeof i.transfer_type === "string" ? i.transfer_type : null, notice_date: D(str(i, "notice_date") || ctx.now.slice(0, 10)), lossmit_pending: flag(i, "lossmit_pending"), linked_case_ids: ids(i.linked_case_ids), transferor_borrower_id: typeof i.transferor_borrower_id === "string" ? i.transferor_borrower_id : null, state: typeof i.state === "string" ? i.state : null })),
    guardrails: [guard("CASE_EXISTS", "4.4 data model: one `sii_cases` row per notice — a case id is opened once", (i, ctx) => (str(i, "case_id") && caseKnown(ctx, str(i, "case_id")) ? `case ${str(i, "case_id")} already exists` : undefined))] },
  { name: "sii.facilitate", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const id = `contact-${rt.store.list("contacts").length + 1}`; rt.store.put("contacts", id, { case_id: caseId, purpose: "sii_facilitate", mode: str(i, "mode") || "letter", to: str(i, "to") || "estate" }, ctx.actor, ctx.now); ctx.events.append({ type: "contact.logged", loanId: ctx.loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { id, case_id: caseId, purpose: "sii_facilitate", mode: str(i, "mode") || "letter", to: str(i, "to") || "estate" } }); return { contact_id: id }; }), guardrails: [SII_EXISTS] },
  { name: "sii.potential_successor.identify", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const on = D(str(i, "identified_on") || ctx.now.slice(0, 10)); const pending = flag(i, "lossmit_pending") || siiLossmitPending(ctx, caseId);
      rt.store.put("sii_cases", caseId, { potential_successor_party_id: str(i, "party_id") || null, identified_on: on, lossmit_pending: pending, status: "identifying_successor" }, ctx.actor, ctx.now);
      if (str(i, "party_id")) rt.store.put("parties", str(i, "party_id"), { role: "potential_successor", case_id: caseId }, ctx.actor, ctx.now);
      // 02 §6 / 32.9 §4.2: the reporter is a `potential_successor` on the loan — the scoping row the borrower surface reads (correspondence only, no subject) — committed with the command when the runtime lends its transaction
      const defer = rt.services["deferWrite"] as ((fn: (q: { query(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<void>) => void) | undefined; const partyId = str(i, "party_id"); const loanId = ctx.loanId; const startedOn = on;
      if (defer && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partyId) && loanId) defer(async (q) => { await q.query(`INSERT INTO loan_parties (loan_id, party_id, role, started_at) VALUES ($1, $2, 'potential_successor', $3) ON CONFLICT DO NOTHING`, [loanId, partyId, startedOn]); });
      const due = siiPolicyDue(on, pending);
      caseEvent(ctx, "case.sii.potential_successor.identified", caseId, { party_id: str(i, "party_id") || null, identified_on: on, lossmit_pending: pending, docs_description_due: due.docs_description_due });
      return { docs_description_due: due.docs_description_due, lossmit_pending: pending };
    }), guardrails: [SII_EXISTS] },
  // Comment 36(i)-1 / 4.4-T8: a loss-mit application from the potential successor — `lossmit.application.received{potential_successor}` opens the interference gate, halves every policy clock and flags the reviewer.
  { name: "sii.lossmit.pending", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); rt.store.put("sii_cases", caseId, { lossmit_pending: true, lossmit_application_id: str(i, "application_id") || null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "lossmit.application.received", loanId: ctx.loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, application_id: str(i, "application_id") || null, potential_successor: true, lossmit_pending: true, held: "pending_confirmation", reviewer_flag: "sii_pending_confirmation" } });
      rt.escalations.open({ kind: "lossmit_reviewer", loanId: ctx.loanId, caseId, payload: { flag: "sii_pending_confirmation", application_id: str(i, "application_id") || null } }, ctx.actor);
      return { reviewer_flag: "sii_pending_confirmation", policy_timers: "halved" };
    }), guardrails: [SII_EXISTS] },
  { name: "sii.documents.request", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const pending = siiLossmitPending(ctx, caseId); const expedited = pending || flag(i, "expedited"); rt.store.put("sii_cases", caseId, { documents_required: ids(i.documents), transfer_type: str(i, "transfer_type") || null, status: "documents_described" }, ctx.actor, ctx.now); caseEvent(ctx, "case.sii.documents.described", caseId, { documents: ids(i.documents), transfer_type: str(i, "transfer_type"), lossmit_pending: pending, expedited }); return { notice: "NTC_REGX_38B1VI_SII_DOCS", documents: ids(i.documents), expedited }; }),
    guardrails: [SII_EXISTS,
      never("OUTSIDE_MATRIX_ROW", "4.4 guardrails: cannot demand documents outside the matrix row (comment 38(b)(1)(vi)-2/-3)", (i) => { const row = (i.matrix_row as string[] | undefined) ?? (i.transfer_type ? [...(DOCUMENT_MATRIX[str(i, "transfer_type") as TransferType] ?? [])] : undefined); return !!row && ids(i.documents).some((d) => !row.includes(d)); }, "a requested document is not in the counsel-reviewed matrix row for this transfer type"),
      guard("EXPEDITE_WHEN_LOSSMIT_PENDING", "4.4 guardrails: must expedite when a loss-mit application is pending (comment 38(b)(1)(vi)-5)", (i, ctx) => (siiLossmitPending(ctx, str(i, "case_id")) && i.expedited === false ? "a pending loss-mit application halves every SII policy timer — the request cannot be de-expedited" : undefined))] },
  { name: "sii.documents.receive", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const on = D(str(i, "received_on") || ctx.now.slice(0, 10)); const pending = siiLossmitPending(ctx, caseId);
      const t = (str(i, "transfer_type") || String(rt.store.get("sii_cases", caseId)?.data.transfer_type ?? "death_relative")) as TransferType;
      const ev = evaluateDocuments(t, ids(i.documents), flag(i, "vesting_established"), on, pending); const sufficient = ev.determination !== "additional_documents_required";
      const due = siiPolicyDue(on, pending);
      rt.store.put("sii_cases", caseId, { documents_received: ids(i.documents), documents_received_on: on, status: sufficient ? "evaluating" : "additional_documents_required", still_required: ev.still_required }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.sii.documents.received", caseId, { received_on: on, documents: ids(i.documents), sufficient, lossmit_pending: pending, determination_due: due.determination_due, addl_docs_due: due.addl_docs_due, still_required: ev.still_required, evaluated: ev.determination });
      return { sufficient, still_required: ev.still_required, determination_due: sufficient ? due.determination_due : null, addl_docs_due: sufficient ? null : due.addl_docs_due, notice: ev.notice, lossmit_pending: pending };
    }), guardrails: [SII_EXISTS] },
  // 4.4 rule 3 / T12: fraud and elder-abuse indicators → `officer` + `attorney` escalation; the file cannot be confirmed without the officer's approval.
  { name: "sii.fraud.screen", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const r = fraudSignals({ instrument: (str(i, "instrument") || "other") as "quitclaim" | "warranty_deed" | "other", ...(i.grantor_age !== undefined ? { grantor_age: num(i, "grantor_age") } : {}), grantee_related: flag(i, "grantee_related"), recorded_days_ago: num(i, "recorded_days_ago") || 0, ...(i.notary_anomaly !== undefined ? { notary_anomaly: flag(i, "notary_anomaly") } : {}) });
      const escalations = r.signals.length ? r.escalate.map((kind) => rt.escalations.open({ kind, loanId: ctx.loanId, caseId, severity: "sev-2", payload: { signals: r.signals, instrument: str(i, "instrument") } }, ctx.actor).id) : [];
      rt.store.put("sii_cases", caseId, { fraud_signals: r.signals, fraud_flagged: r.signals.length > 0 }, ctx.actor, ctx.now);
      if (r.signals.length) caseEvent(ctx, "case.sii.fraud_flagged", caseId, { signals: r.signals, escalation_ids: escalations, escalate: r.escalate });
      return { ...r, escalation_ids: escalations };
    }), guardrails: [SII_EXISTS] },
  { name: "sii.determine", kind: "write", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"), det = str(i, "determination"); const pending = siiLossmitPending(ctx, caseId);
      rt.store.put("sii_cases", caseId, { determination: det, determined_at: ctx.now, reason: str(i, "reason") || null, officer_approval_id: str(i, "officer_approval_id") || null, status: det }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.sii.determined", caseId, { determination: det, reason: str(i, "reason") || null, officer_approval_id: str(i, "officer_approval_id") || null });
      if (det === "confirmed") { rt.store.put("parties", str(i, "party_id") || `${caseId}:successor`, { role: "confirmed_successor", obligor: false, case_id: caseId }, ctx.actor, ctx.now); caseEvent(ctx, "case.sii.confirmed", caseId, { non_obligor: true, party_id: str(i, "party_id") || null, confirmed_on: today(ctx), lossmit_pending: pending, lossmit_application_received_on: pending ? today(ctx) : null });
        // 32.12 backend delta (additive): a confirmed successor who is a platform party (uuid) becomes a `loan_parties{role=confirmed_successor}` row committed with the determination — the scoped role the borrower surface reads (02 §6; borrower-parties.ts SCOPED_LOAN_PARTY_ROLES), so the successor's own sign-in sees the loan
        const partyId = str(i, "party_id"); const deferWrite = rt.services["deferWrite"] as ((fn: (q: { query(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<void>) => void) | undefined;
        if (deferWrite && ctx.loanId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partyId)) { const loanId = ctx.loanId; const at = ctx.now.slice(0, 10); deferWrite(async (q) => { await q.query(`INSERT INTO loan_parties (loan_id, party_id, role, started_at) SELECT $1, $2, 'confirmed_successor', $3::date WHERE NOT EXISTS (SELECT 1 FROM loan_parties WHERE loan_id = $1 AND party_id = $2 AND role = 'confirmed_successor' AND ended_at IS NULL)`, [loanId, partyId, at]); }); } }
      return { determination: det, notice: det === "confirmed" ? "NTC_REGX_38B1VI_SII_CONFIRMED" : det === "not_successor" ? "NTC_REGX_38B1VI_SII_NOT_SUCCESSOR" : "NTC_REGX_38B1VI_SII_ADDL_DOCS", obligor: false, ...(det === "confirmed" && pending ? { lossmit_application_received_on: today(ctx) } : {}) };
    }),
    guardrails: [never("DENY_FOR_NO_ASSUMPTION", "4.4 guardrails: cannot deny for \"no assumption\" or \"not on the note\" (§1024.31: ownership interest, not liability, defines a successor)", (i) => str(i, "determination") === "not_successor" && /no assumption|not on the note|not an obligor|did not assume/i.test(str(i, "reason")), "a successor need not be on the note or assume the loan"),
      needsApproval("NOT_SUCCESSOR_NEEDS_OFFICER", "4.4 human touchpoints: `officer` approves every `not_successor` determination", (i, ctx) => str(i, "determination") === "not_successor" && !approved(ctx, i, "officer_approval_id", ["officer"], "sii.determine"), ["officer"], "a not_successor determination without a recorded officer approval for the case"),
      needsApproval("FRAUD_FLAGGED_NEEDS_OFFICER", "4.4 human touchpoints: `officer` approves any fraud-flagged file; 4.4-T12: no confirmation on fraud signals", (i, ctx) => str(i, "determination") === "confirmed" && siiFraudFlagged(ctx, str(i, "case_id")) && !approved(ctx, i, "officer_approval_id", ["officer"], "sii.determine"), ["officer"], "the file carries fraud/elder-abuse signals — no confirmation without the officer's recorded approval"),
      never("CONFIRMED_NOT_OBLIGOR", "4.4 guardrails: cannot treat a confirmed successor as an obligor", (i) => flag(i, "obligor"), "a confirmed successor is never an obligor unless the loan is assumed under state law")] },
  { name: "sii.acknowledgment.return", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); rt.store.put("sii_cases", caseId, { ack_status: "returned", ack_returned_at: ctx.now, elected_notices: i.elected_notices !== false }, ctx.actor, ctx.now); caseEvent(ctx, "case.sii.acknowledgment.returned", caseId, { returned_on: today(ctx), elected_notices: i.elected_notices !== false, via: str(i, "via") || "form" }); return { elected_notices: i.elected_notices !== false, statements_from: "next_cycle" }; }), guardrails: [SII_EXISTS] },
  { name: "sii.interested_parties.notify", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const parties = ids(i.parties); rt.store.put("sii_cases", caseId, { interested_parties_notified: parties, interested_parties_notified_on: today(ctx) }, ctx.actor, ctx.now); caseEvent(ctx, "sii.interested_parties.notified", caseId, { parties, notified_on: today(ctx) }); return { parties }; }),
    guardrails: [SII_EXISTS, never("INTERESTED_PARTIES", "D1-4.1-02: the servicer notifies property insurers, tax authorities, the MI company and other interested parties", (i) => ids(i.parties).length === 0, "name the parties notified (insurer, tax, MI, HOA)")] },
  { name: "sii.due_on_transfer.notify", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const on = today(ctx); rt.store.put("sii_cases", caseId, { fnma_legal_notified_on: on }, ctx.actor, ctx.now); caseEvent(ctx, "due_on_transfer.unenforceable.notified", caseId, { notice_date: on, basis: str(i, "basis") }); return { notice_date: on, wait_until: addDays(on, 60) }; }), guardrails: [SII_EXISTS] },
  { name: "sii.due_on_transfer.resolve", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); rt.store.put("sii_cases", caseId, { fnma_legal_outcome: str(i, "outcome") }, ctx.actor, ctx.now); caseEvent(ctx, "fnma.due_on_transfer.resolved", caseId, { outcome: str(i, "outcome"), resolved_on: today(ctx) }); return { outcome: str(i, "outcome") }; }),
    guardrails: [SII_EXISTS, never("FNMA_LEGAL_OUTCOME", "FNMA_D1_4_1_02_FNMA_LEGAL_60: Fannie Mae non-objection or expiry (F-4-02)", (i) => !["non_objection", "expired", "objection"].includes(str(i, "outcome")), "outcome ∈ {non_objection, expired, objection}")] },
]);

// ---------------------------------------------------------------- 4.5 complaint case commands
const OFFICER_ROUTE = /discriminat|fair_lending|servicemember|ai_adverse/;
/** 4.5 guardrails: flags on the record (triage + intake flags) that always route to `officer`. */
const complaintOfficerRoute = (ctx: CommandContext, i: ToolInput): boolean => { const rec = complaintRecord(ctx, str(i, "case_id")); return [...(rec?.flags ?? []), ...ids(i.flags)].some((f) => OFFICER_ROUTE.test(f)) || rec?.officer_route === true; };
/** 4.5 state machine: a complaint that is also an NoE cannot respond/close before the NoE responds — the linked NoE's record decides. */
const NOE_GOVERNS: Guardrail<ToolInput> = guard("NOE_GOVERNS", "4.5 state machine: a complaint that is also an NoE cannot close before the NoE responds — its clocks govern the written response", (i, ctx) => { const rec = complaintRecord(ctx, str(i, "case_id")); const linked = rec?.linked_noe_case_id; if (!linked) return undefined; return noeResponded(ctx, linked) ? undefined : `the linked NoE ${linked} has not responded${noeRecord(ctx, linked) ? "" : " (not yet opened)"} — its clocks govern the written response`; });
/** Texas §50(a)(6): `attorney`/`officer` escalation with the Form 20 package and the 60-day cure clock from the notice date (4.5-T5). */
function escalateTx50a6(rt: ToolRuntime, ctx: CommandContext, caseId: string, noticeOn: PlainDate, allegation: string): Record<string, unknown> {
  const r = texasCure(noticeOn);
  const pkg = { form: "form_20", kind: "non_routine_litigation", case_id: caseId, notice_date: noticeOn, allegation, cure_by: r.cure_by, constitutional_basis: "Tex. Const. art. XVI §50(a)(6)(Q)(x)" };
  const esc = r.escalate.map((kind) => rt.escalations.open({ kind, loanId: ctx.loanId, caseId, severity: "sev-1", payload: pkg }, ctx.actor).id);
  rt.store.put("form_20_packages", `f20-${caseId}`, { ...pkg, escalation_ids: esc, prepared_at: ctx.now, status: "prepared" }, ctx.actor, ctx.now);
  caseEvent(ctx, "complaint.tx_50a6_defect.alleged", caseId, { notice_date: noticeOn, cure_by: r.cure_by, escalation_ids: esc, escalate: r.escalate, package: r.package, timer: r.timer });
  return { escalate: r.escalate, package: r.package, cure_by: r.cure_by, timer: r.timer, escalation_ids: esc };
}
const complaintCommands: ToolDef[] = defineTools("4.5", "case", [
  { name: "complaint.open", kind: "write", handler: compute((i, ctx, rt) => {
      const f: ComplaintOpenInput = { case_id: str(i, "case_id") || `cmp-${ctx.now}`, received_on: D(str(i, "received_on") || ctx.now.slice(0, 10)), ...(typeof i.received_at === "string" ? { received_at: i.received_at } : {}), state: typeof i.state === "string" ? i.state : null, channel: (str(i, "channel") || "web_form") as ComplaintOpenInput["channel"], source: (str(i, "source") || "borrower_direct") as ComplaintOpenInput["source"], text: str(i, "text"), complaints_90d: num(i, "complaints_90d") || 0, ...(typeof i.ny_category === "string" ? { ny_category: i.ny_category as NyComplaintCategory } : {}), sale_on: typeof i.sale_on === "string" ? D(i.sale_on) : null, ...(typeof i.external_ref === "string" ? { external_ref: i.external_ref } : {}), flags: ids(i.flags), ...(i.tx_50a6_loan !== undefined ? { tx_50a6_loan: flag(i, "tx_50a6_loan") } : {}) };
      const p = complaintOpenedPayload(f);
      const linked = p.opens_noe ? `noe-${f.case_id}` : null;
      const officerRoute = p.flags.some((x) => OFFICER_ROUTE.test(x)) || /discriminat|national origin|servicemember|active duty|military status/i.test(f.text);
      rt.store.put("cases", f.case_id, { case_type: "complaint", source: p.source, channel: p.channel, is_oral: p.is_oral, received_at: p.received_at, state: p.state, severity: p.severity, flags: p.flags, officer_route: officerRoute, linked_case_ids: linked ? [linked] : [], response_governed_by: linked ? "noe" : "policy", status: "triaged", regulator_due_at: p.cfpb_response_by, regulator_final_due_at: p.cfpb_final_by, tx_50a6_defect_alleged: p.tx_50a6_defect_alleged }, ctx.actor, ctx.now);
      caseEvent(ctx, "case.complaint.opened", f.case_id, { ...p, linked_noe_case_id: linked, officer_route: officerRoute });
      if (p.script_1024_38b5) ctx.events.append({ type: "contact.logged", loanId: ctx.loanId, aggregate: { kind: "case", id: f.case_id }, actor: ctx.actor, payload: { case_id: f.case_id, script: "SCRIPT_38B5_ORAL_COMPLAINT", written_procedure_reminder: true } });
      if (p.regulator_portal === "cfpb") ctx.events.append({ type: "regulator.complaint.received", loanId: ctx.loanId, aggregate: { kind: "case", id: f.case_id }, actor: ctx.actor, payload: { case_id: f.case_id, portal: "cfpb", received_at: p.received_at, external_ref: p.external_ref, regulator_due_at: p.cfpb_response_by, regulator_final_due_at: p.cfpb_final_by } });
      if (p.source === "fannie_mae_referral") caseEvent(ctx, "investor.referral.received", f.case_id, { received: f.received_on, received_at: p.received_at, external_ref: p.external_ref });
      // FNMA_A4_2_1_04_EMAIL_48H (4.5 rule 1 / T10): an e-mail complaint is an inbound e-mail — ingested at its received_at so the 48-hour reply clock anchors on receipt.
      const inbound = p.channel === "email" ? receiveInboundEmail(ctx.events, { loan_id: ctx.loanId, case_id: f.case_id, from: str(i, "from") || "borrower@unknown.invalid", received_at: p.received_at, ...(typeof i.subject === "string" ? { subject: i.subject } : {}), text: f.text, ...(typeof i.message_id === "string" ? { message_id: i.message_id } : {}) }, ctx.actor) : null;
      const tx = p.tx_50a6_defect_alleged ? escalateTx50a6(rt, ctx, f.case_id, f.received_on, f.text) : null;
      return { ...p, linked_noe_case_id: linked, response_governed_by: linked ? "noe" : "policy", officer_route: officerRoute, tx_50a6: tx, ...(inbound ? { email_reply_due_at: inbound.payload.reply_due_at } : {}) };
    }), guardrails: [never("COMPLAINT_NEEDS_TEXT", "4.5 inputs: a complaint is an expression of dissatisfaction", (i) => !str(i, "text"), "no complaint text"),
      guard("CASE_EXISTS", "4.5 data model: a complaint case id is opened once", (i, ctx) => (str(i, "case_id") && caseKnown(ctx, str(i, "case_id")) ? `case ${str(i, "case_id")} already exists` : undefined))] },
  // SM_COMPLAINT_ACK_1BD: acknowledgment by any channel — written for written complaints.
  { name: "complaint.acknowledge", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const channel = str(i, "channel") || "written"; const written = !/^(oral|call|voice|phone)/i.test(channel); rt.store.put("cases", caseId, { acknowledged_at: ctx.now, acknowledged_via: channel }, ctx.actor, ctx.now); caseEvent(ctx, "case.complaint.acknowledged", caseId, { channel, written, acknowledged_on: today(ctx), notice: written ? "NTC_COMPLAINT_ACK" : null });
      // an e-mailed acknowledgment is an outbound e-mail but not the substantive reply (reply=false): FNMA_A4_2_1_04_EMAIL_48H keeps running
      if (/^email/i.test(channel)) sendEmailReply(ctx.events, { loan_id: ctx.loanId, case_id: caseId, in_reply_to: inboundEmailFor(ctx.events, caseId)?.id ?? null, substantive: false, template: "NTC_COMPLAINT_ACK", text: str(i, "text") || "We received your complaint and are reviewing it.", sent_at: ctx.now }, ctx.actor);
      return { acknowledged_on: today(ctx), channel, written }; }),
    guardrails: [COMPLAINT_EXISTS, guard("WRITTEN_ACK_FOR_WRITTEN", "4.5 timer table SM_COMPLAINT_ACK_1BD: acknowledgment 'written for written complaints'", (i, ctx) => { const rec = complaintRecord(ctx, str(i, "case_id")); return rec && !rec.is_oral && /^(oral|call|voice|phone)/i.test(str(i, "channel")) ? "a written complaint is acknowledged in writing (NTC_COMPLAINT_ACK)" : undefined; })] },
  { name: "complaint.respond", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const template = str(i, "template") || "NTC_COMPLAINT_RESPONSE"; rt.store.put("cases", caseId, { status: "responded", responded_at: ctx.now }, ctx.actor, ctx.now); caseEvent(ctx, "case.complaint.responded", caseId, { template });
      // 4.5 rule 1 / T10: the response to an e-mail complaint is the substantive e-mail reply (reply=true) that satisfies FNMA_A4_2_1_04_EMAIL_48H
      const inbound = inboundEmailFor(ctx.events, caseId); const byEmail = /^email/i.test(str(i, "channel")) || (!str(i, "channel") && (complaintRecord(ctx, caseId)?.channel === "email" || !!inbound));
      if (byEmail) sendEmailReply(ctx.events, { loan_id: ctx.loanId, case_id: caseId, in_reply_to: inbound?.id ?? null, substantive: true, template, text: str(i, "text") || template, sent_at: ctx.now }, ctx.actor);
      return { responded_on: today(ctx), ...(byEmail ? { email_reply: true } : {}) }; }),
    guardrails: [COMPLAINT_EXISTS,
      never("NO_PAYMENT_CONDITION", "4.5 guardrails: never condition resolution on payment", (i) => !!str(i, "text") && complaintResponseCheck(str(i, "text")).violations.includes("resolution conditioned on payment"), "the response conditions resolution on a payment"),
      never("NO_LOSSMIT_PROMISE", "4.5 guardrails: never promise outcomes on loss mitigation", (i) => !!str(i, "text") && complaintResponseCheck(str(i, "text")).violations.includes("promised a loss-mitigation outcome"), "the response promises a loss-mitigation outcome"),
      NOE_GOVERNS] },
  { name: "complaint.close", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); rt.store.put("cases", caseId, { status: "closed", closed_at: ctx.now, closed_with: str(i, "closed_with"), root_cause_code: str(i, "root_cause_code") || null, officer_review_id: str(i, "officer_review_id") || null }, ctx.actor, ctx.now); caseEvent(ctx, "case.complaint.closed", caseId, { closed_with: str(i, "closed_with"), root_cause_code: str(i, "root_cause_code") || null, officer_review_id: str(i, "officer_review_id") || null }); return { closed: true }; }),
    guardrails: [COMPLAINT_EXISTS,
      never("NO_DISMISS_TONE_REPETITION", "4.5 guardrails: never dismiss a complaint for tone or repetition", (i) => /^(tone|repetition|repeat)/i.test(str(i, "dismiss_reason")), "a complaint is investigated on its substance regardless of tone or repetition"),
      never("ROOT_CAUSE_REQUIRED", "4.5 state machine: `resolved` requires a root-cause code and a remediation decision", (i) => str(i, "closed_with") !== "withdrawn" && !str(i, "root_cause_code"), "closing needs the root-cause code"),
      needsApproval("OFFICER_ROUTE_FLAGS", "4.5 guardrails: discrimination/servicemember/AI-adverse-decision complaints always route to `officer` (no AI-only closure)", (i, ctx) => complaintOfficerRoute(ctx, i) && !approved(ctx, i, "officer_review_id", ["officer"], "complaint.close"), ["officer"], "flagged complaint without a recorded officer review of the closure"),
      NOE_GOVERNS] },
  { name: "complaint.remediate", kind: "act", handler: compute((i, ctx, rt) => {
      const caseId = str(i, "case_id"); const acct = (str(i, "fee_account") || "other_fees") as "late_charges" | "nsf_fees" | "other_fees";
      const set = ctx.ledger.post(feeReversalSet(typeof i.loan_id === "string" ? i.loan_id : ctx.loanId, acct, amount(i), D(str(i, "assessed_on") || ctx.now.slice(0, 10)), caseId, str(i, "reason") || "complaint remediation", "4.5:r3:fee_reversal"), ctx.now);
      rt.store.put("cases", caseId, { remediation: { kind: "monetary", amount_cents: amount(i).toString(), ledger_entry_ids: [set.id] }, closed_with: "monetary_relief" }, ctx.actor, ctx.now);
      caseEvent(ctx, "complaint.remediated", caseId, { entry_set_id: set.id, fee_account: acct, amount_cents: amount(i).toString(), effective_date: set.effectiveDate, closed_with: "monetary_relief" });
      return { entry_set_id: set.id, amount_cents: amount(i), effective_date: set.effectiveDate, closed_with: "monetary_relief" };
    }),
    guardrails: [correctionGuardrails("complaint.remediate")[0]!, correctionGuardrails("complaint.remediate")[1]!,
      needsApproval("MONETARY_AUTHORITY_50000", "4.5 guardrails: monetary authority limits — AI ≤ 50,000¢ per loan without approval; `officer` above (4.5-T12: blocked pending officer approval; the borrower is told the review timeline)", (i, ctx) => amount(i) > AI_MONETARY_LIMIT_CENTS && !approved(ctx, i, "officer_approval_id", ["officer"], "complaint.remediate", amount(i)), ["officer"], `remediation above ${AI_MONETARY_LIMIT_CENTS}¢ without a recorded officer approval covering the amount — the borrower is told the review timeline`)] },
  { name: "regulator.response.prepare", kind: "write", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); const readyOn = today(ctx); const rec = rt.store.put("regulator_response_packages", `pkg-${caseId}`, { case_id: caseId, portal: str(i, "portal") || "cfpb", response_text: str(i, "response_text"), attachments: ids(i.attachments), pii_minimized: flag(i, "pii_minimized"), ready_on: readyOn, package_due_by: addDays(D(str(i, "received_on") || ctx.now.slice(0, 10)), 5) }, ctx.actor, ctx.now); return { package_id: rec.id, ready_on: readyOn, package_due_by: rec.data.package_due_by, awaiting: "officer approval" }; }),
    guardrails: [never("PII_MINIMIZED", "4.5 rule 5: regulator responses attach evidence with PII minimization", (i) => !flag(i, "pii_minimized"), "the package has not passed PII minimization")] },
  { name: "regulator.response.submit", kind: "act", humanOnly: true, humanRoles: ["officer"], handler: compute((i, ctx) => {
      const caseId = str(i, "case_id"); const status = (str(i, "status") || "closed") as "closed" | "in_progress";
      ctx.events.append({ type: "regulator.complaint.responded", loanId: ctx.loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, portal: str(i, "portal") || "cfpb", status, received_at: str(i, "received_at"), response_date: today(ctx), package_id: str(i, "package_id") } });
      return { submitted_on: today(ctx), status, final_due_by: status === "in_progress" ? addDays(D(str(i, "received_at").slice(0, 10) || ctx.now.slice(0, 10)), 60) : null };
    }), decision: (i, _o, ctx) => ({ action: "regulator.response.submit", subject: { kind: "case", id: str(i, "case_id") }, rationale: `regulator response sent under the officer's name (${ctx.actor.id}); package ${str(i, "package_id")}` }) },
  // Fannie Mae escalation referral (1-800-2FANNIE case): the AI-prepared package is sent back within the 5-Fannie-BD SLA (FNMA_REFERRAL_RESPONSE_5BD).
  { name: "investor.referral.respond", kind: "act", handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); rt.store.put("cases", caseId, { investor_referral_responded_at: ctx.now }, ctx.actor, ctx.now); caseEvent(ctx, "investor.referral.responded", caseId, { responded_on: today(ctx), response_text: str(i, "response_text"), sent_by: ctx.actor.id }); return { responded_on: today(ctx) }; }),
    guardrails: [COMPLAINT_EXISTS, guard("REFERRAL_ON_RECORD", "4.5 inputs: `investor.referral.received` (Fannie Mae escalation) precedes the response", (i, ctx) => (caseEvents(ctx, "investor.referral.received", str(i, "case_id")).length ? undefined : `no Fannie Mae referral on record for case ${str(i, "case_id")}`))] },
  { name: "udaap_review.open", kind: "write", handler: compute((i, ctx, rt) => { const id = str(i, "id") || `udaap-${rt.store.list("udaap_reviews").length + 1}`; rt.store.put("udaap_reviews", id, { monitor: str(i, "monitor"), criteria: str(i, "criteria"), opened_on: today(ctx), outcome: null }, ctx.actor, ctx.now); ctx.events.append({ type: "udaap_review.opened", loanId: ctx.loanId, aggregate: { kind: "udaap_review", id }, actor: ctx.actor, payload: { id, monitor: str(i, "monitor"), opened: today(ctx) } }); return { id }; }) },
  // 4.5 rule 4: the finding/no-finding record with the element-by-element analysis; a systemic finding starts the 60-day population-remediation clock.
  { name: "udaap_review.close", kind: "write", handler: compute((i, ctx, rt) => {
      const id = str(i, "id"); const outcome = str(i, "outcome"); const systemic = flag(i, "systemic"); const analysis = (i.analysis as Record<string, unknown> | undefined) ?? null;
      rt.store.put("udaap_reviews", id, { outcome, systemic, analysis, closed_on: today(ctx) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "udaap_review.closed", loanId: ctx.loanId, aggregate: { kind: "udaap_review", id }, actor: ctx.actor, payload: { id, outcome, systemic, closed_on: today(ctx) } });
      if (outcome === "finding") ctx.events.append({ type: "udaap_review.finding", loanId: ctx.loanId, aggregate: { kind: "udaap_review", id }, actor: ctx.actor, payload: { id, systemic, finding_date: today(ctx), analysis } });
      return { id, outcome, systemic, remediation_due: outcome === "finding" && systemic ? addDays(today(ctx), 60) : null };
    }),
    guardrails: [never("UDAAP_OUTCOME", "SM_UDAAP_REVIEW_10BD: finding/no-finding record", (i) => !["finding", "no_finding"].includes(str(i, "outcome")), "outcome ∈ {finding, no_finding}"),
      never("UDAAP_ELEMENT_ANALYSIS", "4.5 rule 4: a finding carries the statutory element analysis (unfair / deceptive / abusive, element by element)", (i) => { const a = i.analysis as Record<string, unknown> | undefined; return str(i, "outcome") === "finding" && !(a && ["unfair", "deceptive", "abusive"].every((k) => typeof a[k] === "boolean")); }, "the finding needs {unfair, deceptive, abusive} booleans from the UDAAP screen"),
      guard("REVIEW_NOT_FOUND", "4.5 state machine: `udaap_review` is opened by a flag or monitor breach before it closes", (i, ctx) => (ctx.events.ofType("udaap_review.opened").some((e) => e.payload.id === str(i, "id")) ? undefined : `no udaap_review ${str(i, "id")} on record`))] },
  { name: "population_remediation.execute", kind: "act", handler: compute((i, ctx, rt) => {
      const loans = (i.loans as { loan_id: string; assessed_on: string; fee_account?: string }[] | undefined) ?? []; const per = cents(i.per_loan_cents);
      const plan = populationRemediation(loans.length, per);
      const sets = loans.map((l) => ctx.ledger.post(feeReversalSet(l.loan_id, (l.fee_account ?? "other_fees") as "late_charges" | "nsf_fees" | "other_fees", per, D(l.assessed_on), str(i, "id"), str(i, "issue") || "population remediation", "4.5:r3:population_remediation"), ctx.now).id);
      rt.store.put("population_remediations", str(i, "id") || `pr-${ctx.now}`, { issue: str(i, "issue"), loans_affected: loans.length, total_cents: plan.total_cents, approved_by: str(i, "officer_approval_id") || ctx.actor.id, executed_at: ctx.now, entry_set_ids: sets }, ctx.actor, ctx.now);
      ctx.events.append({ type: "population_remediation.executed", loanId: ctx.loanId, actor: ctx.actor, aggregate: { kind: "population_remediation", id: str(i, "id") }, payload: { id: str(i, "id"), loans_affected: loans.length, total_cents: plan.total_cents.toString(), letters: { template: "NTC_REMEDIATION_REFUND", count: loans.length }, metro2_corrections: flag(i, "delinquency_resulted"), claim_corrections_15_2: flag(i, "claimed_from_fnma") } });
      ctx.events.append({ type: "partner.notified", actor: ctx.actor, aggregate: { kind: "population_remediation", id: str(i, "id") }, payload: { id: str(i, "id"), total_cents: plan.total_cents.toString() } });
      return { loans_affected: loans.length, total_cents: plan.total_cents, entry_set_ids: sets, letters: loans.length, steps: plan.steps };
    }),
    guardrails: [needsApproval("POPULATION_REMEDIATION_OFFICER", "4.5 rule 3 / T6: a population remediation needs `officer` approval before refunds post", (i, ctx) => !approved(ctx, { ...i, case_id: str(i, "case_id") || str(i, "id") }, "officer_approval_id", ["officer"], "population_remediation.execute", BigInt(((i.loans as unknown[] | undefined) ?? []).length) * cents(i.per_loan_cents)), ["officer"], "population remediation without a recorded officer approval covering the total")] },
  // Texas §50(a)(6) allegation detected after intake (or on a loan flagged later): the same Form 20 escalation and cure clock complaint.open runs at intake.
  { name: "complaint.tx_50a6.escalate", kind: "act", handler: compute((i, ctx, rt) => escalateTx50a6(rt, ctx, str(i, "case_id"), D(str(i, "notice_on") || ctx.now.slice(0, 10)), str(i, "allegation"))),
    guardrails: [COMPLAINT_EXISTS, guard("TX_ALREADY_ESCALATED", "TX_50A6_CURE_60 arms once per allegation", (i, ctx) => (caseEvents(ctx, "complaint.tx_50a6_defect.alleged", str(i, "case_id")).length ? `case ${str(i, "case_id")} already carries the Form 20 escalation` : undefined))] },
  // The cure is a human act (attorney for the cure instrument, officer signs the Form 20 escalation): `complaint.tx_50a6.cured` satisfies TX_50A6_CURE_60.
  { name: "complaint.tx_50a6.cure", kind: "act", humanOnly: true, humanRoles: ["attorney", "officer"], handler: compute((i, ctx, rt) => { const caseId = str(i, "case_id"); rt.store.put("form_20_packages", `f20-${caseId}`, { status: "cured", cure: str(i, "cure"), cured_on: today(ctx), cured_by: ctx.actor.id }, ctx.actor, ctx.now); caseEvent(ctx, "complaint.tx_50a6.cured", caseId, { cure: str(i, "cure"), cured_on: today(ctx), form_20_logged: true, notice: "NTC_TX_50A6_CURE", cured_by: ctx.actor.id, role: ctx.actor.role ?? null }); return { cured_on: today(ctx), notice: "NTC_TX_50A6_CURE" }; }),
    decision: (i, _o, ctx) => ({ action: "complaint.tx_50a6.cure", subject: { kind: "case", id: str(i, "case_id") }, rationale: `§50(a)(6)(Q)(x) cure executed by ${ctx.actor.role ?? "human"} ${ctx.actor.id}: ${str(i, "cure")}` }),
    guardrails: [COMPLAINT_EXISTS, guard("FORM_20_REQUIRED", "4.5 human touchpoints: Form 20 escalation logged before the cure", (i, ctx) => (caseEvents(ctx, "complaint.tx_50a6_defect.alleged", str(i, "case_id")).length ? undefined : `no §50(a)(6) allegation / Form 20 escalation on record for case ${str(i, "case_id")}`)), never("CURE_REQUIRED", "§50(a)(6)(Q)(x): the cure taken is stated", (i) => !str(i, "cure"), "state the cure")] },
]);

// ---------------------------------------------------------------- the 4.x notices through the Notice Registry (32.9 backend delta)
/** The 4.x-owned templates (src/notices/authored/section04.ts) the `case` agent renders and sends: acknowledgments, responses, the successor document description, complaint letters. */
export const CASE_NOTICE_TEMPLATES = /^NTC_(REGX_35[CDEFG]|REGX_36[ACDEFI]|REGX_38B|REGX_32C|REGX_40|CA_2923_7|COMPLAINT|REMEDIATION|TX_50A6|FNMA_D1_4_1_02)/;
const noticeCommands: ToolDef[] = defineTools("4.1", "case", [
  // The acknowledgment / response / document-description letters the 4.1, 4.2, 4.4 and 4.5 clocks wait on (`notice.sent{template}`): rendered and sent
  // through the Notice Registry (checklist, channel decision, delivery evidence) for a case the record holds — never free text, never a figure.
  { name: "case.notice.send", kind: "act", handler: compute(async (i, ctx, rt) => {
      const template = str(i, "template"); const caseId = str(i, "case_id"); const recipients = (Array.isArray(i.recipients) ? i.recipients : []) as Recipient[];
      const svc = rt.notices; if (!svc) throw new PortUnavailable("notices");
      if (!recipients.length) throw new RangeError("recipients are required (the party the case is for)");
      const payload = (i.payload && typeof i.payload === "object" && !Array.isArray(i.payload) ? (i.payload as Record<string, unknown>) : {});
      const n = svc.render({ templateCode: template, loanId: ctx.loanId, caseId, recipients, payload, asOf: today(ctx) });
      if (n.status === "held") throw new RangeError(`${template} for case ${caseId} is held: ${n.heldReason ?? "checklist"}`);
      const sent = await svc.send(n.id, (i.channel_context as Parameters<typeof svc.send>[1] | undefined) ?? {});
      caseEvent(ctx, "case.notice.sent", caseId, { template, notice_id: n.id, template_version: n.templateVersion, sent_on: today(ctx), channels: (sent.channelDecision ?? []).map((d) => ({ party_id: d.partyId, channel: d.channel })) });
      return { case_id: caseId, template, notice_id: n.id, template_version: n.templateVersion, status: sent.status, sent_at: sent.sentAt ?? ctx.now, channels: (sent.channelDecision ?? []).map((d) => ({ party_id: d.partyId, channel: d.channel, satisfies_timer: d.satisfiesTimer })) };
    }),
    decision: (i, out) => ({ action: "case.notice.send", subject: { kind: "case", id: str(i, "case_id") }, rationale: `${str(i, "template")} rendered through the Notice Registry for case ${str(i, "case_id")} (notice ${String((out as { notice_id?: unknown })?.notice_id ?? "?")})` }),
    guardrails: [never("CASE_NOTICE_TEMPLATE", "4.x outputs: the case agent sends only the section's own templates (acknowledgments, responses, SII document descriptions, complaint letters)", (i) => !CASE_NOTICE_TEMPLATES.test(str(i, "template")), "template must be a 4.1/4.2/4.4/4.5 Notice Registry template"),
      guard("CASE_NOT_FOUND", "4.x state machine: a letter attaches to a case the record holds", (i, ctx) => (caseKnown(ctx, str(i, "case_id")) ? undefined : `no case ${str(i, "case_id") || "(missing case_id)"} on the loan`))] },
]);

export const SECTION_04_CASE_COMMANDS: readonly ToolDef[] = [...approvalCommands, ...noeCommands, ...rfiCommands, ...continuityCommands, ...CONTINUITY_COMMANDS_4_3, ...siiCommands, ...complaintCommands, ...noticeCommands];
/** Helper for §13 (and tests): the sale/judgment command's guardrail list — the FC gate first, then the process's own. */
export const withFcNoeGate = (guardrails: readonly Guardrail<ToolInput>[] = []): Guardrail<ToolInput>[] => [FC_NOE_OPEN_GATE, ...guardrails];
/** 4.4 worked timeline / 4.4-T6: the successor's payoff request is answered within the Reg Z §1026.36(c)(3) window — 7 business days (Reg Z §1026.2(a)(6): days the servicer is open), never held for the acknowledgment. */
export const successorPayoffDue = (requestedOn: string): string => addBusinessDays(D(requestedOn), 7, servicer);
