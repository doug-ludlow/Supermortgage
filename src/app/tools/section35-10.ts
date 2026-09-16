/**
 * §35.10 process-owned tools — the `payoff-release` agent's closeout.* tools (spec/sections/35-operations-runtime/
 * 35-10-the-refinance-close-of-the-loop.md "AI agent design"), defined with `defineTools("35.10", "payoff-release", defs)`
 * and spread by ./index.ts. Every one runs on the command's own transaction (`ctx.q`), claims its closeout FOR UPDATE SKIP
 * LOCKED (rule 10), runs the OWNING sections' tools through the command view (`runtimeOf(rt).execute` — 24.4 as
 * `title-closing`, 16.x as `payoff-release`, 3.5 / 30.3 as `escrow`, 2.1 as `cashiering`, 26.3 as `funder`, 33.1 as
 * `portfolio`; OWNER_AGENT_ACTS), journals every command with its trigger event and the owner's decision id
 * (refinance_closeout_steps), and persists its own events through a nested unit of work on the same transaction so the
 * owners' later commands see them and the registry's clocks arm and satisfy in order (SM_REFI_PRIOR_SETTLE_1BD on
 * `refinance.closeout.funded`, SM_REFI_ESCROW_CREDIT_0 on `refinance.prior_loan.retired{escrow_treatment}` satisfied by
 * 30.3's `escrow.credit_to_new_loan.posted` that follows it). Nothing here computes a payoff figure (rule 2): every figure
 * is copied from 16.1's, 16.2's or 24.4's row; every input to an owner's tool is derived from the record (rule 3,
 * closeout-35-10/derive.ts) — a hosted call that supplies one is refused NO_CLIENT_STATE. A refusal from an owner's tool
 * is caught and journaled `command_refused` (the nested savepoint rolled it back; the closeout waits or holds); a
 * failure is journaled `command_failed` and counted (three on a step → held{attempts}).
 *
 *   closeout.open            the row for a refinance application with a prior loan on the platform (mode = loans.status, rule 1)
 *   closeout.pass            the sweep's pass, on demand (35.8 screens): src/runtime/refinance-closeout.ts closeoutPass
 *   closeout.quote           24.4 requestPayoff (+ 16.1 computePayoffQuote / assertAccuracyGate / mintVerificationToken / renderStatement,
 *                            the statement document, 24.4 parsePayoffStatement from 16.1's own row) or the partner's statement through the
 *                            payoff_demand port; 24.4 decideEscrowTreatment; `op: unwind` supersedes the quote and cancels the demand
 *   closeout.settle          serviced: 26.3 postLedger{payoff_transfer}, 2.1 ledger.post (receipt), 16.2 matchPayoffFunds / postPayoff /
 *                            computeFnmaPayoffShare / buildCrsBatch / projectRemovalPayoff / createHousekeepingTasks; monitored: 24.4
 *                            parsePayoffStatement{op: paid}; a variance beyond 16.2's tolerance → 16.1 openShortagePath, held{money_mismatch},
 *                            waiting_human{officer} (disposeVariance is the officer's — NO_MONEY_FIELD); `op: reversal` folds 16.2's payoff.reversed
 *   closeout.escrow          the disposition recorded (credit_to_new_loan | refund | none | partner_obligation); the credit posts through 30.3
 *                            after the retirement event; the refund through 3.5 issueRefund once the 5-BD hold elapsed; never netting (NO_NETTING)
 *   closeout.retire          NO_SETTLEMENT guardrail; prior_loan_retirements; `refinance.prior_loan.retired` (the projector flips loans.status);
 *                            monitored: `partner_book.loan.paid_off` with 33.3's payload; then the credit posting; `linked` → completed
 *   closeout.lien_release    16.3 selectReleaseInstrument / draftReleaseInstrument / runReleaseChecklist / routeForExecution → waiting_human{signing_officer}
 *                            (clocked = false); on `lien_release.recorded` 16.3 notifyBorrower and the closeout moves on
 *   closeout.notify_partner  the outbox row (partner-book.notify, retirement:<prior_loan_id>, PARTNER_PAYLOAD_MINIMAL) + `partner_book.retirement.notified`
 *   closeout.confirm_partner the partner's tape (33.1 partner_book.loan.loaded{status}) / book.resolve → confirmed | disputed | resolved
 *   closeout.hold / resume   an ops_analyst's acts (humanOnly)
 *   closeout.board           the daily receipt and `refinance.closeout.daily.run_completed` (SM_REFI_CLOSEOUT_BOARD_DAILY, global subject)
 *   writeDecision            the decision row (closeout.v1)
 */
import { randomUUID, createHash } from "node:crypto";
import { defineTools, compute, decision, guard, never, str, flag, PortUnavailable, EntityStore, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { PgOutbox } from "../../infra/integrations/pg-outbox.ts";
import type { Runtime } from "../../runtime/app.ts";
import { closeoutPass, closeoutBoardRun, PAYOFF_RELEASE, ET } from "../../runtime/refinance-closeout.ts";
import { loanCashState, SERVICER_CONTACT } from "../../runtime/servicing.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { RoleDenied } from "../roles.ts";
import { SHORT_TOLERANCE_CENTS, OVER_TOLERANCE_CENTS } from "../../domain/payoff/remit.ts";
import { finalDisbursementHold } from "../../domain/escrow/ops-3-5.ts";
import { type NewNotification, closeoutByApplication, openCloseoutOnPriorLoan, insertCloseout, updateCloseout, insertRetirement, retirementsOf, insertNotification, notificationsOf, insertReceipt, boardCounts, stepsOf } from "../../domain/operations-runtime/closeout-35-10/repo.ts";
import { enterStep, completeStep, journal, civilDay, type JournalIo } from "../../domain/operations-runtime/closeout-35-10/journal.ts";
import { modeFor, fold, before, type Folded } from "../../domain/operations-runtime/closeout-35-10/machine.ts";
import { priorLoanFacts, partnerTerms, projectedDisbursement, fundingIdFor, settlementPayoffLine, authorizationDocument, liabilityIdFor, creditConsent, cdInitialDeposit, securityInstrumentFor, remittedTo, inFlightOf, pl, type PriorLoanFacts, type RecordIo } from "../../domain/operations-runtime/closeout-35-10/derive.ts";
import { renderRefinanceBoard } from "../../domain/operations-runtime/closeout-35-10/board.ts";
import { PROCESS, AGENT, RULE_SET_VERSION, PROMPT_VERSION, PARTNER_NOTIFY_ADAPTER, retirementIdempotencyKey, type CloseoutRow, type CloseoutStep, type CloseoutDecision, type PriorStatus, type EscrowTreatment, type CloseoutMode } from "../../domain/operations-runtime/closeout-35-10/types.ts";
import type { StepOutcome } from "../../runtime/refinance-closeout.ts";

type Row = Record<string, unknown>;
const TITLE_CLOSING: Actor = { kind: "agent", id: "title-closing" };
const ESCROW: Actor = { kind: "agent", id: "escrow" };
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const FUNDER: Actor = { kind: "agent", id: "funder" };
const S = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const txOf = (ctx: CommandContext): Queryable => { if (!ctx.q) throw new RangeError("35.10 tools run inside a database command (PgUnitOfWork): no transaction on this context"); return ctx.q; };

// ---------------------------------------------------------------- guardrails
/** Rule 2 / 3, 35.1-T10: a hosted call carrying a figure or a record fact is refused — the closeout derives them (NO_CLIENT_STATE). */
const CLIENT_STATE_KEYS = ["upb_cents", "total_cents", "buckets", "rate_pct", "lpi_due", "per_diem_cents", "interest_cents", "amount_cents", "exact_total_cents", "escrow_balance_cents", "quoted_total_cents", "payoff_line_cents", "principal_cents", "changes", "figures", "state_snapshot", "custodial_ids", "ledger_snapshot"];
const NO_CLIENT_STATE = never("NO_CLIENT_STATE", "35.10 rule 3 / 35.1-T10: 'Inputs come from the record … A hosted call that supplies any of these is refused' — the UPB, the rate, the paid-through installment, the figures and the custodial ids are derived by the pass, never taken from a caller",
  (i) => CLIENT_STATE_KEYS.some((k) => has(i, k)), `a closeout tool derives every figure and record fact itself (rule 3); remove ${CLIENT_STATE_KEYS.slice(0, 6).join(", ")}, … from the input`);
/** Rule 7: no retirement without the owner's settlement — `loan.paid_in_full` on the prior loan (16.2) or 24.4's demand paid from the settlement statement's line with its evidence. */
const NO_SETTLEMENT = guard("NO_SETTLEMENT", "35.10 rule 7: 'closeout.retire refuses (NO_SETTLEMENT) unless the serviced prior loan has loan.paid_in_full on its log with a payoff_settlements.status = paid_in_full row, or the monitored prior loan's demand reads paid with the settlement statement's payoff line … and evidence_document_id'", (i, ctx) => {
  const loanId = str(i, "prior_loan_id") || ctx.loanId;
  const paid = ctx.events.all().some((e) => (e.type === "loan.paid_in_full" && e.loanId === loanId) || (e.type === "payoff.demand.paid" && (e.applicationId === (str(i, "application_id") || ctx.applicationId)) && !!(e.payload as Row)["evidence_document_id"]));
  return paid ? undefined : "no settlement on the record: neither 16.2's loan.paid_in_full on the prior loan nor 24.4's demand paid from the settlement statement's payoff line with its evidence document";
});
const HUMAN_ONLY_HOLD = guard("HOLD_IS_HUMAN", "35.10 Inputs and triggers: 'closeout.hold{reason} / closeout.resume (ops_analyst)'", (_i, ctx) => (ctx.actor.kind === "human" ? undefined : "a hold or a resume is an ops_analyst's act; the pass holds on its own reasons (money_mismatch, unavailable, attempts) and never through this tool"));

// ---------------------------------------------------------------- the command's view of a closeout
interface Cx { readonly q: Queryable; readonly rt: ToolRuntime; readonly runtime: Runtime; readonly ctx: CommandContext; readonly io: JournalIo; c: CloseoutRow; readonly scope: { loanId: string; applicationId: string }; readonly store: EntityStore; readonly events: readonly DomainEvent[]; readonly f: Folded; readonly asOf: PlainDate; readonly trigger: string | null; }
async function load(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Cx> {
  const q = txOf(ctx); const runtime = runtimeOf(rt);
  const applicationId = str(i, "application_id") || ctx.applicationId || "";
  if (!applicationId) throw new RangeError("a closeout tool runs on the refinance application (application_id)");
  const c = await closeoutByApplication(q, applicationId, { forUpdate: true });
  if (!c) throw new RangeError(`no refinance_closeouts row for application ${applicationId} (closeout.open first, or another sweep holds it)`);
  if (ctx.loanId && ctx.loanId !== c.prior_loan_id) throw new RangeError(`closeout ${c.id} is the prior loan ${c.prior_loan_id}'s, not ${ctx.loanId}'s`);
  const events = ctx.events.all();
  const io: JournalIo = { q, events: ctx.events, actor: ctx.actor, now: ctx.now, sweepRunId: runtime.root.sweepRunId };
  return { q, rt, runtime, ctx, io, c, scope: { loanId: c.prior_loan_id, applicationId }, store: rt.store, events, f: fold(events, c), asOf: wallClock(Date.parse(ctx.now), ET).date, trigger: str(i, "trigger_event_id") || null };
}
const recordIo = (cx: Cx): RecordIo => ({ q: cx.q, store: cx.store, events: cx.events, cash: async (loanId, asOf) => { const f = await loanCashState(cx.runtime, loanId, asOf); return { lpi_date: f.state.lpi_date, note_rate_pct: f.state.note_rate_pct, custodial: f.custodial, upb_cents: f.state.upb_cents }; } });
/** The closeout's own event, persisted through a nested unit of work on the command's transaction (the owners' later commands and the registry's clocks see it in order). */
// the id grammar (src/runtime/lifecycle.test.ts g): the closeout's own events are the second bridge between the two records — keyed by the prior loan and the application it is retired by (30.2's hand-off events are the first)
async function emit(cx: Cx, type: string, payload: Row, o: { loanOnly?: boolean; causationId?: string | null; aggregate?: { kind: string; id: string } } = {}): Promise<DomainEvent> {
  const scope = o.loanOnly ? { loanId: cx.c.prior_loan_id } : cx.scope;
  const r = await cx.runtime.uow.run(scope, (u) => u.events.append({ type, loanId: cx.c.prior_loan_id, ...(o.loanOnly ? {} : { applicationId: cx.c.application_id }), aggregate: o.aggregate ?? { kind: "refinance_closeout", id: cx.c.id }, actor: cx.ctx.actor, payload: { closeout_id: cx.c.id, application_id: cx.c.application_id, prior_loan_id: cx.c.prior_loan_id, mode: cx.c.mode, origination: true, ...payload }, ...(o.causationId ? { causationId: o.causationId } : {}) }), { clock: cx.runtime.clock });
  return r.events[0]!;
}
interface OwnerCall { readonly process: string; readonly name: string; readonly actor: Actor; readonly scope: "loan" | "app" | "both"; readonly input: ToolInput; readonly trigger?: string | null; readonly note?: string; }
type OwnerResult = { ok: true; output: Row; events: readonly DomainEvent[]; decision_id: string | null } | { ok: false; code: string; message: string; refused: boolean };
/** Run an owning section's tool as its owning agent on the command's transaction; journal the run, the refusal or the failure. */
async function owner(cx: Cx, o: OwnerCall): Promise<OwnerResult> {
  // the id grammar (lifecycle g): an application command before the hand-off is keyed by the application alone; after 30.2 staged the new loan it carries that loan too
  const req = { process: o.process, name: o.name, loanId: o.scope === "app" ? cx.c.new_loan_id ?? "" : cx.c.prior_loan_id, ...(o.scope === "loan" ? {} : { applicationId: cx.c.application_id }), actor: o.actor, input: o.input, run: { runId: `35.10:${cx.c.id}:${cx.c.step}`, modelVersion: "deterministic", promptVersion: PROMPT_VERSION, confidence: 1 } };
  const command = { process: o.process, name: o.name, op: typeof o.input["op"] === "string" ? String(o.input["op"]) : null };
  try {
    const r = await cx.runtime.execute(req);
    const decision_id = r.decisions[0]?.id ?? null;
    // rule 3 / T1: the figures and record facts the pass derived for the owner (never taken from a caller) are journaled apart from the rest of the owner's input
    const keys = Object.keys(o.input).sort(); const derived = keys.filter((k) => CLIENT_STATE_KEYS.includes(k));
    await journal(cx.io, cx.c, "command_run", { command, trigger_event_id: o.trigger ?? cx.trigger, decision_id, actor: o.actor, detail: { ...(o.note ? { note: o.note } : {}), events: r.events.map((e) => e.type), input_keys: keys.filter((k) => !derived.includes(k)), ...(derived.length ? { derived_from_record: derived } : {}) } });
    return { ok: true, output: (r.output ?? {}) as Row, events: r.events, decision_id };
  } catch (e) {
    if (e instanceof CommandRefused) { await journal(cx.io, cx.c, "command_refused", { command, trigger_event_id: o.trigger ?? cx.trigger, refusal_code: e.code, actor: o.actor, detail: { reason: e.message.slice(0, 500), citation: e.citation } }); return { ok: false, code: e.code, message: e.message, refused: true }; }
    const msg = e instanceof Error ? e.message : String(e);
    await journal(cx.io, cx.c, "command_failed", { command, trigger_event_id: o.trigger ?? cx.trigger, error_class: e instanceof Error ? e.name : "Error", actor: o.actor, detail: { error: msg.slice(0, 500) } });
    return { ok: false, code: e instanceof Error ? e.name : "Error", message: msg, refused: false };
  }
}
const outcome = (c: CloseoutRow, o: StepOutcome["outcome"], detail?: string, x: { record_wait?: boolean } = {}): StepOutcome & { closeout_id: string; decision: CloseoutDecision } => ({ outcome: o, step: c.step, status: c.status, ...(detail ? { detail } : {}), ...(x.record_wait ? { record_wait: true } : {}), closeout_id: c.id, decision: decisionOf(c, o, detail ?? null) });
/** A wait on a record row (a fundings row, an installment, a wire instruction, the statement's payoff line, a consent) appends no event: the pass keeps no fold marker for it and looks again next sweep. */
const recordWait = (c: CloseoutRow, detail: string) => outcome(c, "waiting", detail, { record_wait: true });
function decisionOf(c: CloseoutRow, o: string, detail: string | null, command: CloseoutDecision["command"] = null, ownerDecisionId: string | null = null, figures: Partial<CloseoutDecision["figures"]> = {}): CloseoutDecision {
  return { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, mode: c.mode, step: c.step, command, trigger_event_id: null, owner_decision_id: ownerDecisionId, figures: { quoted_total_cents: S(c.quoted_total_cents), per_diem_cents: S(c.per_diem_cents), exact_total_cents: null, variance_cents: null, ...figures }, rule_set_version: RULE_SET_VERSION, model_version: "deterministic", prompt_version: PROMPT_VERSION, confidence: 1, rationale: `${o}${detail ? `: ${detail}` : ""}` };
}
const decisionFn = (name: string) => (_i: ToolInput, output: unknown) => { const o = (output ?? {}) as Row; const d = o["decision"] as CloseoutDecision | undefined; if (o["outcome"] === "noop" || o["outcome"] === "waiting") return null; return d ? { action: name, rationale: JSON.stringify(d), subject: { kind: "refinance_closeout", id: d.closeout_id }, ruleCode: PROCESS } : null; };
async function hold(cx: Cx, reason: string, o: { status?: CloseoutRow["status"]; waiting_on?: string | null; detail?: Row } = {}): Promise<StepOutcome & { closeout_id: string; decision: CloseoutDecision }> {
  cx.c = await updateCloseout(cx.q, cx.c.id, { status: o.status ?? "held", hold_reason: reason, waiting_on: o.waiting_on ?? cx.c.waiting_on }, cx.ctx.now);
  await journal(cx.io, cx.c, "held", { waiting_on: cx.c.waiting_on, detail: { reason, ...(o.detail ?? {}) } });
  await emit(cx, "refinance.closeout.held", { reason, step: cx.c.step, waiting_on: cx.c.waiting_on });
  return outcome(cx.c, "held", reason);
}
/** `loan.staged` names the new loan: link it (rule 7, whichever sweep it lands in) — `refinance.new_loan.linked` is what the projector writes `loans.refinanced_by_loan_id` from. */
async function linkIfStaged(cx: Cx): Promise<void> {
  if (cx.c.new_loan_id || !cx.f.staged?.loanId) return;
  if (cx.f.reversed && cx.f.reversed.sequence > cx.f.staged.sequence && !cx.c.settlement_id) return;   // 16.2 rule 6: the reversal cleared the link; it is re-made once the settlement is redone
  const newLoanId = cx.f.staged.loanId;
  const number = String(pl(cx.f.staged)["servicing_loan_number"] ?? "");
  await emit(cx, "refinance.new_loan.linked", { new_loan_id: newLoanId, servicing_loan_number: number || null, staged_event_id: cx.f.staged.id }, { causationId: cx.f.staged.id });
  cx.c = await updateCloseout(cx.q, cx.c.id, { new_loan_id: newLoanId }, cx.ctx.now);
  await journal(cx.io, cx.c, "command_run", { step: "linked", command: { process: PROCESS, name: "closeout.link" }, trigger_event_id: cx.f.staged.id, detail: { new_loan_id: newLoanId, servicing_loan_number: number || null } });
}
async function advance(cx: Cx, to: CloseoutStep, o: { status?: CloseoutRow["status"]; waiting_on?: string | null; trigger?: string | null; detail?: Row } = {}): Promise<void> {
  await completeStep(cx.io, cx.c, { trigger_event_id: o.trigger ?? cx.trigger, ...(o.detail ? { detail: o.detail } : {}) });
  const r = await enterStep(cx.io, cx.c, to, { status: o.status ?? "open", waiting_on: o.waiting_on ?? null, trigger_event_id: o.trigger ?? cx.trigger });
  cx.c = r.row;
}
/** Every step done → `refinance.closeout.completed` (terminal). */
async function completeIfDone(cx: Cx): Promise<boolean> {
  const escrowDone = cx.c.escrow_treatment === "credit_to_new_loan" ? !!cx.c.escrow_credit_event_id : cx.c.escrow_treatment === "refund" ? !!cx.c.refund_disbursement_id : true;
  if (cx.c.step !== "linked" || !cx.c.retirement_id || !escrowDone) return false;
  await completeStep(cx.io, cx.c, {});
  cx.c = await updateCloseout(cx.q, cx.c.id, { step: "completed", status: "completed", waiting_on: null, completed_at: cx.ctx.now }, cx.ctx.now);
  await journal(cx.io, cx.c, "completed", { detail: { completed_at: cx.ctx.now } });
  await emit(cx, "refinance.closeout.completed", { completed_at: cx.ctx.now, new_loan_id: cx.c.new_loan_id, retirement_id: cx.c.retirement_id });
  return true;
}
/** After the release / the partner's confirmation: `linked` when the new loan is known, else wait for 35.6 (`open{waiting_on: 35.6}`). */
async function toLinked(cx: Cx): Promise<void> {
  await linkIfStaged(cx);
  if (cx.c.new_loan_id) { await advance(cx, "linked", { status: "open", waiting_on: null }); await completeIfDone(cx); }
  else await advance(cx, "linked", { status: "open", waiting_on: "35.6" });
}

// ---------------------------------------------------------------- closeout.open
async function open(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const q = txOf(ctx); const runtime = runtimeOf(rt);
  const applicationId = str(i, "application_id") || ctx.applicationId || ""; if (!applicationId) throw new RangeError("closeout.open needs application_id");
  const existing = await closeoutByApplication(q, applicationId);
  if (existing) return { ...outcome(existing, "noop", "ONE_CLOSEOUT_PER_APPLICATION: the closeout exists"), closeout_id: existing.id };
  const app = (await q.query<{ prior_loan_id: string | null; partner_party_id: string | null; status: string | null }>(`SELECT a.prior_loan_id::text AS prior_loan_id, a.partner_party_id::text AS partner_party_id, l.status::text AS status FROM applications a LEFT JOIN loans l ON l.id = a.prior_loan_id WHERE a.id = $1`, [applicationId]))[0];
  if (!app?.prior_loan_id) throw new RangeError(`application ${applicationId} has no prior_loan_id: no closeout (24.4's external path runs alone, rule 1)`);
  const io: JournalIo = { q, events: ctx.events, actor: ctx.actor, now: ctx.now, sweepRunId: runtime.root.sweepRunId };
  const m = modeFor(String(app.status ?? ""));
  const priorPartner = (await q.query<{ p: string | null }>(`SELECT partner_party_id::text AS p FROM loans WHERE id = $1`, [app.prior_loan_id]))[0]?.p ?? app.partner_party_id;
  // rule 1 / edge cases: a prior loan that cannot be retired (paid_off, transferred_out, staged) or one already in an open closeout → cancelled + an ops_analyst escalation
  const other = await openCloseoutOnPriorLoan(q, app.prior_loan_id);
  const priorStatus = String(app.status ?? "") as PriorStatus;
  if (!other && "cancel" in m && priorStatus === "paid_off") {
    // edge case: the prior loan is already paid off (a plain payoff, or an earlier refinance) → completed{already_retired} with the existing settlement id; nothing to quote, settle or release
    const settlement = (await q.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'payoff_settlements' AND (data->>'loan_id') = $1 ORDER BY updated_at DESC LIMIT 1`, [app.prior_loan_id]))[0]?.id ?? null;
    const partnerBook = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_facts WHERE loan_id = $1`, [app.prior_loan_id]))[0]!.n !== "0";
    const row = await insertCloseout(q, { application_id: applicationId, prior_loan_id: app.prior_loan_id, partner_party_id: priorPartner, mode: partnerBook ? "monitored_partner" : "serviced_same_servicer", prior_status_at_open: priorStatus, step: "completed", status: "completed", hold_reason: "already_retired", now: ctx.now });
    if (settlement) await updateCloseout(q, row.id, { settlement_id: settlement, completed_at: ctx.now }, ctx.now); else await updateCloseout(q, row.id, { completed_at: ctx.now }, ctx.now);
    await journal(io, row, "completed", { step: "completed", detail: { reason: "already_retired", prior_status: priorStatus, settlement_id: settlement } });
    return { ...outcome({ ...row, settlement_id: settlement }, "completed", "already_retired"), closeout_id: row.id };
  }
  if ("cancel" in m || other) {
    const reason = other ? "prior_loan_in_closeout" : "cancel" in m ? m.cancel : "prior_not_retirable";
    const row = await insertCloseout(q, { application_id: applicationId, prior_loan_id: app.prior_loan_id, partner_party_id: priorPartner, mode: other ? other.mode : "serviced_same_servicer", prior_status_at_open: other ? other.prior_status_at_open : priorStatus || "active", step: "opened", status: "cancelled", hold_reason: reason, now: ctx.now });
    await journal(io, row, "cancelled", { detail: { reason, prior_status: app.status, other_closeout_id: other?.id ?? null } });
    rt.escalations.open({ kind: "sev3", severity: "3", ownerRole: "ops_analyst", loanId: app.prior_loan_id, applicationId, payload: { reason, application_id: applicationId, prior_loan_id: app.prior_loan_id, prior_status: app.status, other_closeout_id: other?.id ?? null, closeout_id: row.id } }, ctx.actor);
    await runtime.uow.run({ loanId: app.prior_loan_id, applicationId }, (u) => u.events.append({ type: "refinance.closeout.unwound", loanId: app.prior_loan_id!, applicationId, aggregate: { kind: "refinance_closeout", id: row.id }, actor: ctx.actor, payload: { closeout_id: row.id, application_id: applicationId, prior_loan_id: app.prior_loan_id, reason, terminal: "cancelled", origination: true } }), { clock: runtime.clock });
    return { ...outcome(row, "cancelled", reason), closeout_id: row.id };
  }
  const row = await insertCloseout(q, { application_id: applicationId, prior_loan_id: app.prior_loan_id, partner_party_id: priorPartner, mode: m.mode, prior_status_at_open: m.prior_status, step: "opened", status: "open", now: ctx.now });
  await journal(io, row, "entered", { step: "opened", detail: { mode: m.mode, prior_status: m.prior_status } });
  const opened = await runtime.uow.run({ loanId: app.prior_loan_id, applicationId }, (u) => u.events.append({ type: "refinance.closeout.opened", loanId: app.prior_loan_id!, applicationId, aggregate: { kind: "refinance_closeout", id: row.id }, actor: ctx.actor, payload: { closeout_id: row.id, application_id: applicationId, prior_loan_id: app.prior_loan_id, mode: m.mode, prior_status: m.prior_status, origination: true } }), { clock: runtime.clock });
  const entered = await enterStep(io, row, "awaiting_schedule", { status: "open", waiting_on: "26.2", trigger_event_id: opened.events[0]?.id ?? null });
  return { ...outcome(entered.row, "advanced", `opened as ${m.mode}`), closeout_id: row.id };
}

// ---------------------------------------------------------------- closeout.quote
async function quote(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  if (i["op"] === "unwind") return unwind(cx);
  await linkIfStaged(cx);
  if (!["opened", "awaiting_schedule", "quoted"].includes(cx.c.step)) return outcome(cx.c, "noop", `step ${cx.c.step} is past the quote`);
  const disb = projectedDisbursement(cx.store, cx.events, cx.c.application_id);
  if (!disb) { await journal(cx.io, cx.c, "waiting", { waiting_on: "26.3", detail: { reason: "no projected disbursement date on the record (26.3 funding calendar / closing.scheduled)" } }); cx.c = await updateCloseout(cx.q, cx.c.id, { waiting_on: "26.3" }, cx.ctx.now); return recordWait(cx.c, "no projected disbursement date"); }
  const refresh = cx.c.step === "quoted";
  if (refresh && cx.c.good_through && cx.c.good_through >= disb.date) return outcome(cx.c, "noop", "the quote covers the disbursement date");
  const goodThrough = disb.date;   // worked example A / T1: good-through = the projected disbursement date (funds deemed received that day)
  const liability = liabilityIdFor(cx.store, cx.c.application_id, cx.c.prior_loan_id);
  const authorization = authorizationDocument(cx.store, cx.c.application_id);
  const prior = (await cx.q.query<{ state: string; partner: string; n: string }>(`SELECT p.state, l.partner_party_id::text AS partner, l.servicer_loan_number AS n FROM loans l JOIN properties p ON p.id = l.property_id WHERE l.id = $1`, [cx.c.prior_loan_id]))[0]!;
  const trigger = cx.trigger;
  if (cx.c.mode === "serviced_same_servicer") {
    const facts = await priorLoanFacts(recordIo(cx), cx.c.prior_loan_id, cx.asOf);
    if (!facts.lpi_due) { await journal(cx.io, cx.c, "waiting", { waiting_on: "35.5", detail: { reason: "no paid-through installment on the record (2.x cash state)" } }); return recordWait(cx.c, "no paid-through installment on the record"); }
    if (!facts.wire_instruction_version_id) { await journal(cx.io, cx.c, "waiting", { waiting_on: "16.1", detail: { reason: "no active payoff_wire_instructions version (16.1's vault, an officer-rotated row)" } }); return recordWait(cx.c, "no active wire instruction version"); }
    // 24.4: the demand to the servicer of record = this platform (same_servicer) — 16.1's request row is created by 24.4's intake
    const demand = await owner(cx, { process: "24.4", name: "requestPayoff", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, existing_servicer_party_id: prior.partner, same_servicer: true, servicing_loan_id: cx.c.prior_loan_id, requested_good_through: goodThrough, state: prior.state, written_authorization_document_id: authorization, request_channel: "servicing_16_1", requested_on: cx.asOf, requester_type: "refinancing_lender", ...(refresh ? { refresh: true } : {}) } });
    if (!demand.ok) return outcome(cx.c, demand.refused ? "refused" : "failed", demand.message);
    const requestId = `PR-${cx.c.application_id}-${liability}${refresh ? "-refresh" : ""}`;
    const quoteId = `pq-${cx.c.application_id.slice(0, 8)}-${refresh ? `r${cx.c.step_attempts + 1}-` : ""}${goodThrough}`;
    // 16.1: the quote on the record's figures (UPB = the principal ledger balance; the rate from loan_terms; lpi_due from 2.x's installments; the escrow advance when negative)
    const q16 = await owner(cx, { process: "16.1", name: "computePayoffQuote", actor: PAYOFF_RELEASE, scope: "loan", trigger, input: { loan_id: cx.c.prior_loan_id, quote_id: quoteId, request_id: requestId, channel: "api", received_on: cx.asOf, requester_type: "refinancing_lender", authorization_evidence: true, upb_cents: facts.upb_cents, rate_pct: facts.note_rate_pct, lpi_due: facts.lpi_due, good_through: goodThrough, state: facts.state, ledger_snapshot_id: `ledger:${cx.c.prior_loan_id}:${cx.events.at(-1)?.sequence ?? 0}`, late_charges_cents: facts.late_charges_cents, fees_cents: facts.other_fees_cents, ...(facts.escrow_balance_cents < 0n ? { escrow_advance_cents: -facts.escrow_balance_cents } : {}) }, note: "inputs derived from the record (rule 3): principal ledger balance, loan_terms rate, the paid-through installment, properties.state" });
    if (!q16.ok) return outcome(cx.c, q16.refused ? "refused" : "failed", q16.message);
    const qr = q16.output;
    const gate = await owner(cx, { process: "16.1", name: "assertAccuracyGate", actor: PAYOFF_RELEASE, scope: "loan", trigger, input: { loan_id: cx.c.prior_loan_id, quote_id: quoteId, ledger_clean: facts.suspense_cents === 0n, pending_reversal: false, rate_segments_final: true, in_foreclosure: false, firm_figures_present: true, in_bankruptcy: false, bk_figures_present: false } });
    if (!gate.ok) return outcome(cx.c, gate.refused ? "refused" : "failed", gate.message);
    const minted = await owner(cx, { process: "16.1", name: "mintVerificationToken", actor: PAYOFF_RELEASE, scope: "loan", trigger, input: { loan_id: cx.c.prior_loan_id, statement_hash: String(qr["hash"]), wire_instruction_version_id: facts.wire_instruction_version_id } });
    if (!minted.ok) return outcome(cx.c, minted.refused ? "refused" : "failed", minted.message);
    const token = String(minted.output["token"]);
    const rendered = await owner(cx, { process: "16.1", name: "renderStatement", actor: PAYOFF_RELEASE, scope: "loan", trigger, input: { loan_id: cx.c.prior_loan_id, quote_id: quoteId, active_wire_instruction_version_id: facts.wire_instruction_version_id, wire_instruction_version_id: facts.wire_instruction_version_id, verification_token: token, state: facts.state, escrow_balance_cents: facts.escrow_balance_cents } });
    if (!rendered.ok) return outcome(cx.c, rendered.refused ? "refused" : "failed", rendered.message);
    // 35.2 (documents port default): the statement PDF as a documents row with its printed token
    const statementId = String(rendered.output["statement_id"] ?? `ps-${quoteId}`);
    const text = `PAYOFF STATEMENT ${statementId}\nLoan ${facts.servicer_loan_number}\nGood through ${goodThrough}\nTotal $${dollars(c(qr["total_cents"]))}\nPer diem $${dollars(c(qr["per_diem_cents"]))} after ${goodThrough}\nVerify: ${String(minted.output["verify_path"])} token ${token}\nWire instructions: vault version ${facts.wire_instruction_version_id}`;
    const sha = createHash("sha256").update(text).digest("hex");
    const documentId = `doc-payoff-statement-${quoteId}`;
    cx.rt.store.put("documents", documentId, { kind: "payoff_statement", loan_id: cx.c.prior_loan_id, application_id: cx.c.application_id, sha256: sha, byte_size: Buffer.byteLength(text), storage_uri: `fake://documents/${sha}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y", metadata: { statement_id: statementId, quote_id: quoteId, verification_token: token, verify_path: String(minted.output["verify_path"]), good_through: goodThrough, printed: true } }, cx.ctx.actor, cx.ctx.now);
    // 24.4 reads 16.1's own row: the statement parsed (the printed interest line taken as printed) and the demand received
    const parsed = await owner(cx, { process: "24.4", name: "parsePayoffStatement", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, statement_document_id: documentId, statement_date: cx.asOf, principal_cents: c(qr["upb_cents"]), rate_pct: facts.note_rate_pct, interest_paid_through: addDays(facts.lpi_due, -1), per_diem_cents: c(qr["per_diem_cents"]), good_through_date: goodThrough, stated_interest_cents: c(qr["interest_cents"]), stated_total_cents: c(qr["total_cents"]), late_charges_cents: undefined, fees_cents: c(qr["late_charges_cents"]) + c(qr["fees_cents"]), disbursement_date: disb.date, ...(refresh ? { refresh: true } : {}) }, note: "figures copied from 16.1's payoff_quotes row (rule 2)" });
    if (!parsed.ok) return outcome(cx.c, parsed.refused ? "refused" : "failed", parsed.message);
    const consent = creditConsent(cx.store, cx.events, cx.c.prior_loan_id, cx.c.application_id);
    const deposit = cdInitialDeposit(cx.store, cx.events, cx.c.application_id);
    const treat = await owner(cx, { process: "24.4", name: "decideEscrowTreatment", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, servicing_loan_id: cx.c.prior_loan_id, same_servicer: true, payoff_posted_on: goodThrough, escrow_balance_cents: facts.escrow_balance_cents < 0n ? 0n : facts.escrow_balance_cents, settlement_date: goodThrough, ...(consent ? { consent: { kind: "escrow_credit_to_new_loan", captured_at: consent.captured_at }, consent_id: consent.consent_id } : {}), ...(deposit !== null ? { initial_escrow_deposit_cents: deposit } : {}), net_against_shortfall_flag: false } });
    if (!treat.ok) return outcome(cx.c, treat.refused ? "refused" : "failed", treat.message);
    const treatment = treatmentOf(String(treat.output["escrow_treatment"]), facts.escrow_balance_cents);
    const quoted = await emit(cx, "refinance.closeout.quoted", { quote_id: quoteId, payoff_demand_id: `${cx.c.application_id}:${liability}`, payoff_request_id: requestId, statement_document_id: documentId, good_through: goodThrough, total_cents: S(c(qr["total_cents"])), per_diem_cents: S(c(qr["per_diem_cents"])), escrow_treatment: treatment, refresh }, { causationId: trigger });
    cx.c = await updateCloseout(cx.q, cx.c.id, { payoff_demand_id: `${cx.c.application_id}:${liability}`, payoff_request_id: requestId, quote_id: quoteId, statement_document_id: documentId, good_through: goodThrough, quoted_total_cents: c(qr["total_cents"]), per_diem_cents: c(qr["per_diem_cents"]), projected_disbursement_date: disb.date, escrow_treatment: treatment, escrow_balance_cents: facts.escrow_balance_cents, escrow_consent_id: consent?.consent_id ?? null, partner_party_id: prior.partner }, cx.ctx.now);
    if (!refresh) await advance(cx, "quoted", { status: "waiting_window", waiting_on: "rescission_window", trigger: quoted.id });
    else await journal(cx.io, cx.c, "command_run", { command: { process: PROCESS, name: "closeout.quote", op: "refresh" }, trigger_event_id: trigger, detail: { good_through: goodThrough, quote_id: quoteId, event_id: quoted.id } });
    return { ...outcome(cx.c, "advanced", `quoted ${goodThrough}`), decision: decisionOf(cx.c, "advanced", `quoted through ${goodThrough}`, { process: "16.1", name: "computePayoffQuote", op: null }, q16.decision_id, { quoted_total_cents: S(c(qr["total_cents"])), per_diem_cents: S(c(qr["per_diem_cents"])) }) };
  }
  // ---- monitored: 24.4's demand to the partner as the external servicer; the partner's statement through the payoff_demand port (FAKE)
  const terms = await partnerTerms(cx.q, cx.c.prior_loan_id);
  if (!terms) { await journal(cx.io, cx.c, "waiting", { waiting_on: "33.1", detail: { reason: "no partner_book_facts row for the monitored loan" } }); return recordWait(cx.c, "no partner tape facts"); }
  // 24.4 rule 6 (T7): on a refresh the received statement is marked stale and the planning figure at the new disbursement date written on 24.4's row (statement total + per diem × days past good-through, never a funding figure) — the refresh request below is this closeout's, citing the resync
  let planning: OwnerResult | null = null;
  if (refresh && cx.c.quoted_total_cents !== null) { planning = await owner(cx, { process: "24.4", name: "computePayoffAtDate", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, on: disb.date, state: prior.state, planned_disbursement: true, request_refresh: false }, note: "24.4 rule 6: the statement stale past good-through; the planning figure (never a funding figure)" }); if (!planning.ok) return outcome(cx.c, planning.refused ? "refused" : "failed", planning.message); }
  // a port retry (the statement channel was out) re-uses the demand already requested for this good-through: no second request to the partner's queue
  const demandRow = cx.store.get("payoff_demands", `${cx.c.application_id}:${liability}`)?.data ?? null;
  const alreadyRequested = !!demandRow && demandRow["status"] === "requested" && String(demandRow["requested_good_through"] ?? "") === String(goodThrough);
  const demand = alreadyRequested ? { ok: true as const, output: demandRow!, events: [] as DomainEvent[], decision_id: null } : await owner(cx, { process: "24.4", name: "requestPayoff", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, existing_servicer_party_id: prior.partner, same_servicer: false, servicing_loan_id: cx.c.prior_loan_id, requested_good_through: goodThrough, state: prior.state, written_authorization_document_id: authorization, request_channel: "partner_api", requested_on: cx.asOf, ...(refresh ? { refresh: true } : {}) } });
  if (!demand.ok) return outcome(cx.c, demand.refused ? "refused" : "failed", demand.message);
  let statement: Awaited<ReturnType<Runtime["closeoutPorts"]["payoffDemand"]["statement"]>>;
  try { statement = await cx.runtime.closeoutPorts.payoffDemand.statement({ servicer_party_id: prior.partner, servicer_loan_number: terms.servicer_loan_number, requested_on: cx.asOf, statement_date: cx.asOf, good_through: goodThrough, refresh, terms }); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await journal(cx.io, cx.c, "command_failed", { command: { process: "24.4", name: "payoff_demand" }, trigger_event_id: trigger, waiting_on: "payoff_demand", error_class: e instanceof Error ? e.name : "Error", detail: { error: msg.slice(0, 300), attempt: cx.c.step_attempts + 1, port: "payoff_demand" } });
    // the wait on the partner's statement channel is a clocked wait (a vendor owns it): entered once — SM_REFI_CLOSEOUT_STALLED_2BD arms on it; the pass counts the attempts (three → held{attempts})
    if (cx.c.waiting_on !== "payoff_demand") { const entered = await enterStep(cx.io, cx.c, cx.c.step, { status: "waiting_vendor", waiting_on: "payoff_demand", trigger_event_id: trigger, detail: { transition: `${cx.c.step} → quote`, port: "payoff_demand", reason: msg.slice(0, 200) } }); cx.c = entered.row; }
    return outcome(cx.c, "failed", `payoff_demand port: ${msg}`);
  }
  cx.rt.store.put("documents", statement.statement_document_id, { kind: "partner_payoff_statement", loan_id: cx.c.prior_loan_id, application_id: cx.c.application_id, sha256: createHash("sha256").update(statement.text).digest("hex"), byte_size: Buffer.byteLength(statement.text), storage_uri: `fake://documents/partner/${statement.statement_document_id}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y", metadata: { servicer_loan_number: terms.servicer_loan_number, statement_date: statement.statement_date, good_through: statement.good_through_date, lines: { principal_cents: S(statement.principal_cents), interest_cents: S(statement.interest_cents), per_diem_cents: S(statement.per_diem_cents), total_cents: S(statement.total_cents) } } }, cx.ctx.actor, cx.ctx.now);
  const parsed = await owner(cx, { process: "24.4", name: "parsePayoffStatement", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, statement_document_id: statement.statement_document_id, statement_date: statement.statement_date, principal_cents: statement.principal_cents, rate_pct: statement.rate_pct, interest_paid_through: statement.interest_paid_through, per_diem_cents: statement.per_diem_cents, good_through_date: statement.good_through_date, stated_interest_cents: statement.interest_cents, stated_total_cents: statement.total_cents, fees_cents: statement.fees_cents, disbursement_date: disb.date, wire_instructions_document_id: statement.wire_instructions_document_id, ...(refresh ? { refresh: true } : {}) }, note: "the partner's statement as printed (24.4 rule 6: the servicer's figure is never corrected)" });
  if (!parsed.ok) return outcome(cx.c, parsed.refused ? "refused" : "failed", parsed.message);
  if (parsed.output["short_payoff"] === true) return hold(cx, "short_payoff", { status: "held", waiting_on: "underwriting_reviewer", detail: { statement_document_id: statement.statement_document_id } });
  const treat = await owner(cx, { process: "24.4", name: "decideEscrowTreatment", actor: TITLE_CLOSING, scope: "app", trigger, input: { liability_id: liability, servicing_loan_id: cx.c.prior_loan_id, same_servicer: false, payoff_posted_on: goodThrough, escrow_balance_cents: statement.escrow_balance_cents ?? 0n, settlement_date: goodThrough, net_against_shortfall_flag: false } });
  if (!treat.ok) return outcome(cx.c, treat.refused ? "refused" : "failed", treat.message);
  const quoted = await emit(cx, "refinance.closeout.quoted", { payoff_demand_id: `${cx.c.application_id}:${liability}`, statement_document_id: statement.statement_document_id, good_through: goodThrough, total_cents: S(statement.total_cents), per_diem_cents: S(statement.per_diem_cents), escrow_treatment: "partner_obligation", refresh, ...(planning?.ok ? { planning_total_cents: S(c(planning.output["total_at_cents"])) } : {}) }, { causationId: trigger });
  cx.c = await updateCloseout(cx.q, cx.c.id, { payoff_demand_id: `${cx.c.application_id}:${liability}`, statement_document_id: statement.statement_document_id, good_through: goodThrough, quoted_total_cents: statement.total_cents, per_diem_cents: statement.per_diem_cents, projected_disbursement_date: disb.date, escrow_treatment: "partner_obligation", escrow_balance_cents: statement.escrow_balance_cents, partner_party_id: prior.partner, waiting_on: null, step_attempts: 0 }, cx.ctx.now);
  if (!refresh) await advance(cx, "quoted", { status: "waiting_window", waiting_on: "rescission_window", trigger: quoted.id });
  else await journal(cx.io, cx.c, "command_run", { command: { process: PROCESS, name: "closeout.quote", op: "refresh" }, trigger_event_id: trigger, detail: { good_through: goodThrough, statement_document_id: statement.statement_document_id, event_id: quoted.id } });
  return { ...outcome(cx.c, "advanced", `quoted ${goodThrough} (partner statement)`), decision: decisionOf(cx.c, "advanced", `the partner's statement good through ${goodThrough}`, { process: "24.4", name: "parsePayoffStatement", op: null }, parsed.decision_id, { quoted_total_cents: S(statement.total_cents), per_diem_cents: S(statement.per_diem_cents) }) };
}
const treatmentOf = (t: string, balance: Cents): EscrowTreatment => (balance <= 0n ? "none" : t === "credit_to_new_loan" ? "credit_to_new_loan" : t === "partner_obligation" ? "partner_obligation" : "refund");
const dollars = (v: Cents): string => { const s = (v < 0n ? -v : v).toString().padStart(3, "0"); return `${v < 0n ? "-" : ""}${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${s.slice(-2)}`; };

/** Off-path before `settling` (rescission exercised, funding cancelled, withdrawal, adverse action, 35.6's unwind): the quote superseded, the demand cancelled, every closeout clock cancelled, nothing posted (T10). */
async function unwind(cx: Cx): Promise<unknown> {
  if (!before(cx.c.step, "settling")) return outcome(cx.c, "refused", "an unwind at or after settling is 16.2 rule 6's reversal — an officer's act");
  const trigger = cx.f.unwind; const reason = trigger?.type ?? str({} as ToolInput, "reason") ?? "unwind";
  if (cx.c.mode === "serviced_same_servicer" && cx.c.quote_id && cx.c.statement_document_id) {
    const statementId = `ps-${cx.c.quote_id}`;
    await owner(cx, { process: "16.1", name: "scheduleRecompute", actor: PAYOFF_RELEASE, scope: "loan", trigger: trigger?.id ?? null, input: { loan_id: cx.c.prior_loan_id, statement_id: statementId, op: "supersede", trigger_event: "refinance.unwound", occurred_on: cx.asOf, ledger_snapshot_id: `ledger:${cx.c.prior_loan_id}:${cx.events.at(-1)?.sequence ?? 0}`, reason: `refinance unwound (${reason}): the quote is superseded and no funds are expected` }, note: "16.1 supersedes the statement; the figures stay 16.1's" });
  }
  if (cx.c.payoff_demand_id) await owner(cx, { process: "24.4", name: "requestPayoff", actor: TITLE_CLOSING, scope: "app", trigger: trigger?.id ?? null, input: { op: "cancel", liability_id: cx.c.payoff_demand_id.slice(cx.c.application_id.length + 1), reason } });
  // every closeout clock of this closeout is cancelled (the owners' own clocks stay the owners')
  const mine = cx.ctx.timers.open().filter((t) => t.code.startsWith("SM_REFI_") && t.code !== "SM_REFI_CLOSEOUT_BOARD_DAILY" && (t.loanId === cx.c.prior_loan_id || t.applicationId === cx.c.application_id));
  for (const t of mine) cx.ctx.timers.cancel(t.id, `refinance closeout unwound (${reason})`, cx.ctx.actor);
  cx.c = await updateCloseout(cx.q, cx.c.id, { status: "unwound", waiting_on: null, hold_reason: reason, completed_at: cx.ctx.now }, cx.ctx.now);
  await journal(cx.io, cx.c, "unwound", { trigger_event_id: trigger?.id ?? null, detail: { reason, timers_cancelled: mine.map((t) => t.code) } });
  await emit(cx, "refinance.closeout.unwound", { reason, step: cx.c.step, timers_cancelled: mine.length }, { causationId: trigger?.id ?? null });
  return outcome(cx.c, "unwound", reason);
}

// ---------------------------------------------------------------- closeout.settle
async function settle(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  if (i["op"] === "reversal") return reversal(cx);
  await linkIfStaged(cx);
  if (cx.c.step !== "quoted" && cx.c.step !== "settling") return outcome(cx.c, "noop", `step ${cx.c.step} is not the settlement`);
  if (cx.f.reversed && !cx.c.funds_id && !cx.c.settlement_id && cx.c.waiting_on === "officer") return outcome(cx.c, "waiting", "payoff.reversed (16.2 rule 6): the returned funds are gone; the officer decides how the settlement resumes (closeout.resume) — never a second transfer on its own");
  const funded = cx.f.funded; const confirmed = cx.f.confirmed;
  if (!funded || !confirmed) return outcome(cx.c, "waiting", "loan.funded and funding.disbursement.confirmed are not both on the log");
  const disbursement = D(String(pl(funded)["disbursement_date"]).slice(0, 10));
  if (cx.c.step === "quoted" && cx.c.good_through && disbursement > cx.c.good_through) { await journal(cx.io, cx.c, "waiting", { waiting_on: "16.1", detail: { reason: "the disbursement date is past the quote's good-through: the quote re-runs before the settlement (rule 2)", good_through: cx.c.good_through, disbursement_date: disbursement } }); return outcome(cx.c, "waiting", "quote stale: re-quote first"); }
  const evidenceId = String(pl(confirmed)["evidence_document_id"] ?? "");
  // rule 4 / IDEMPOTENT_ON_FUNDED_EVENT: the closeout's loan-scoped restatement of 26.3's application-scoped loan.funded — once (SM_REFI_PRIOR_SETTLE_1BD arms on it)
  if (cx.c.step === "quoted") {
    const fundedEv = await emit(cx, "refinance.closeout.funded", { disbursement_date: disbursement, funded_event_id: funded.id, confirmed_event_id: confirmed.id, evidence_document_id: evidenceId || null }, { causationId: funded.id });
    cx.c = await updateCloseout(cx.q, cx.c.id, { disbursement_date: disbursement }, cx.ctx.now);
    await advance(cx, "settling", { status: "open", waiting_on: null, trigger: fundedEv.id });
  }
  const line = evidenceId ? settlementPayoffLine(cx.store, evidenceId, cx.c.payoff_demand_id, cx.c.partner_party_id) : null;
  if (!line) { if (cx.c.hold_reason === "payoff_line_missing") return recordWait(cx.c, "the settlement statement still carries no payoff line"); return hold(cx, "payoff_line_missing", { status: "waiting_vendor", waiting_on: "settlement_agent", detail: { evidence_document_id: evidenceId || null, payoff_demand_id: cx.c.payoff_demand_id } }); }
  const liability = cx.c.payoff_demand_id ? cx.c.payoff_demand_id.slice(cx.c.application_id.length + 1) : null;
  if (cx.c.mode === "monitored_partner") {
    // the demand marked paid from the statement's payoff line (24.4's row, 24.4's tool); NO_SETTLEMENT is satisfied by the evidence it names
    if (!liability) return hold(cx, "payoff_line_missing", { status: "waiting_vendor", waiting_on: "24.4", detail: { reason: "no demand" } });
    // rule 5 (monitored): the settlement statement's line against the partner's statement on 24.4's row — beyond 16.2's tolerance nothing is paid on the agent's say-so: held{money_mismatch}, the officer decides (closeout.resume{accept_variance})
    const demandRow = cx.c.payoff_demand_id ? cx.store.get("payoff_demands", cx.c.payoff_demand_id)?.data ?? null : null;
    const stated = demandRow ? c(demandRow["total_cents"]) : null; const varM = stated !== null ? line.amount_cents - stated : 0n;
    if (stated !== null && (varM < -SHORT_TOLERANCE_CENTS || varM > OVER_TOLERANCE_CENTS)) {
      const accepted = (await stepsOf(cx.q, cx.c.id)).some((x) => x.kind === "resumed" && (x.detail as Row)["accept_variance"] === true);
      if (!accepted) {
        if (cx.c.hold_reason === "money_mismatch") return outcome(cx.c, "waiting", "waiting on the officer: the payoff line differs from the partner's statement");
        cx.rt.escalations.open({ kind: "sev1", severity: "1", ownerRole: "officer", loanId: cx.c.prior_loan_id, applicationId: cx.c.application_id, payload: { reason: "the settlement statement's payoff line differs from the partner's statement beyond 16.2's tolerance", closeout_id: cx.c.id, application_id: cx.c.application_id, prior_loan_id: cx.c.prior_loan_id, variance_cents: S(varM), stated_total_cents: S(stated), amount_cents: S(line.amount_cents) } }, cx.ctx.actor);
        return hold(cx, "money_mismatch", { status: "held", waiting_on: "officer", detail: { variance_cents: S(varM), stated_total_cents: S(stated), amount_cents: S(line.amount_cents), guardrail: "NO_MONEY_FIELD" } });
      }
    }
    const paid = await owner(cx, { process: "24.4", name: "parsePayoffStatement", actor: TITLE_CLOSING, scope: "app", trigger: funded.id, input: { op: "paid", liability_id: liability, payoff_posted_on: disbursement, amount_cents: line.amount_cents, wire_reference: line.wire_reference, evidence_document_id: evidenceId } });
    if (!paid.ok) return outcome(cx.c, paid.refused ? "refused" : "failed", paid.message);
    cx.c = await updateCloseout(cx.q, cx.c.id, { payoff_date: disbursement, waiting_on: null, hold_reason: null, status: "open" }, cx.ctx.now);
    await advance(cx, "settled", { status: "open", waiting_on: null, trigger: funded.id, detail: { payoff_posted_on: disbursement, amount_cents: S(line.amount_cents), wire_reference: line.wire_reference } });
    return { ...outcome(cx.c, "advanced", "the partner's demand paid from the settlement statement"), decision: decisionOf(cx.c, "advanced", "demand paid", { process: "24.4", name: "parsePayoffStatement", op: "paid" }, paid.decision_id, { exact_total_cents: S(cx.c.quoted_total_cents), variance_cents: S(line.amount_cents - (cx.c.quoted_total_cents ?? 0n)) }) };
  }
  // ---- serviced: the internal transfer, 2.1's receipt, 16.2 to zero
  const facts = await priorLoanFacts(recordIo(cx), cx.c.prior_loan_id, disbursement);
  // rule 6: the escrow balance the closeout carries from here is the ledger's at the payoff date (the quote-time copy served the quote)
  if (facts.escrow_balance_cents !== cx.c.escrow_balance_cents) cx.c = await updateCloseout(cx.q, cx.c.id, { escrow_balance_cents: facts.escrow_balance_cents }, cx.ctx.now);
  if (!facts.custodial) { if (cx.c.hold_reason === "unavailable") return recordWait(cx.c, "still no custodial accounts for the prior loan's partner"); return hold(cx, "unavailable", { status: "waiting_vendor", waiting_on: "custodial_accounts", detail: { reason: "no custodial accounts for the prior loan's partner" } }); }
  if (!cx.c.funds_id) {
    const fundingId = fundingIdFor(cx.store, cx.c.application_id);
    const newLoan = cx.c.new_loan_id ?? (await cx.q.query<{ l: string | null }>(`SELECT loan_id::text AS l FROM applications WHERE id = $1`, [cx.c.application_id]))[0]?.l ?? null;
    const fundingClearing = newLoan ? (await cx.q.query<{ id: string }>(`SELECT id::text AS id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = 'origination_funding_clearing' ORDER BY created_at DESC LIMIT 1`, [facts.partner_party_id]))[0]?.id ?? null : null;
    if (!fundingId || !fundingClearing) { if (cx.c.hold_reason === "unavailable") return recordWait(cx.c, "still waiting on 26.3's funding row / the staged loan"); return hold(cx, "unavailable", { status: "open", waiting_on: "35.6", detail: { reason: fundingId ? "the new loan is not staged (35.6 / the hand-off): no funding clearing account" : "no 26.3 funding row" } }); }
    // rule 4, once: the transfer set is keyed on 26.3's confirmation event (ledger_entry_sets.source_event_id) — an unreversed one on the record is reused, never re-posted (a reversal, a retried settlement)
    const existingTransfer = (await cx.q.query<{ id: string }>(`SELECT DISTINCT s.id::text AS id FROM ledger_entry_sets s JOIN ledger_lines l ON l.set_id = s.id WHERE s.source_event_id = $1 AND l.rule_ref = '35.10:r4:transfer' AND s.reverses_set_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entry_sets r WHERE r.reverses_set_id = s.id)`, [confirmed.id]))[0]?.id ?? null;
    // the transfer, 2.1's receipt and 16.2's match are one settlement: a failure in the chain throws so the command rolls back whole (the pass counts the attempt) — never a committed transfer with funds_id null
    function chain(r: OwnerResult, what: string): asserts r is Extract<OwnerResult, { ok: true }> { if (!r.ok) throw new Error(`${what} failed inside the settlement chain (rolled back): ${r.message}`); }
    if (!existingTransfer) {
    const transfer = await owner(cx, { process: "26.3", name: "postLedger", actor: FUNDER, scope: "app", trigger: funded.id, input: { op: "payoff_transfer", funding_id: fundingId, effective_date: disbursement, amount_cents: line.amount_cents, payoff_demand_id: cx.c.payoff_demand_id, prior_loan_id: cx.c.prior_loan_id, from_custodial_account_id: fundingClearing, to_custodial_account_id: facts.custodial.clearing, source_event_id: confirmed.id } });
    chain(transfer, "26.3 postLedger{payoff_transfer}");
    const receipt = await owner(cx, { process: "2.1", name: "ledger.post", actor: CASHIERING, scope: "loan", trigger: funded.id, input: { loan_id: cx.c.prior_loan_id, via: "payment.post", entry_set: { effectiveDate: disbursement, description: `receipt payoff transfer ${cx.c.payoff_demand_id ?? cx.c.id}`, lines: [{ account: { scope: "custodial", custodialAccountId: facts.custodial.clearing, account: "clearing_cash" }, amountCents: line.amount_cents, ruleRef: "2.1:r8:receipt" }, { account: { scope: "loan", loanId: cx.c.prior_loan_id, account: "suspense_unapplied" }, amountCents: -line.amount_cents, ruleRef: "2.1:r8:receipt" }] } } });
    chain(receipt, "2.1 ledger.post{receipt}");
    } else await journal(cx.io, cx.c, "skipped", { command: { process: "26.3", name: "postLedger", op: "payoff_transfer" }, detail: { reason: "the transfer set for this confirmation is on the record already (rule 4: once)", set_id: existingTransfer } });
    const matched = await owner(cx, { process: "16.2", name: "matchPayoffFunds", actor: PAYOFF_RELEASE, scope: "loan", trigger: funded.id, input: { loan_id: cx.c.prior_loan_id, amount_cents: line.amount_cents, method: "internal_transfer", received_at: `${disbursement}T${cx.ctx.now.slice(11)}`, bank_reference: String(pl(funded)["wire_id"] ?? line.wire_reference ?? cx.c.quote_id ?? ""), remittance_type: facts.remittance_type, settlement_date: disbursement } });
    chain(matched, "16.2 matchPayoffFunds");
    const fundsId = String(matched.output["funds_id"]);
    cx.c = await updateCloseout(cx.q, cx.c.id, { funds_id: fundsId, payoff_date: disbursement }, cx.ctx.now);
  }
  const quoteRow = cx.c.quote_id ? cx.store.get("payoff_quotes", cx.c.quote_id)?.data ?? null : null;
  if (!quoteRow) return hold(cx, "unavailable", { status: "open", waiting_on: "16.1", detail: { reason: "no payoff_quotes row on the record" } });
  const exact = c(quoteRow["total_cents"]); const variance = line.amount_cents - exact;
  const shortBeyond = variance < -SHORT_TOLERANCE_CENTS; const overBeyond = variance > OVER_TOLERANCE_CENTS;
  const disposed = cx.f.disposeVariance;
  if ((shortBeyond || overBeyond) && !disposed) {
    // rule 5: beyond 16.2's tolerance — 16.1 opens the short/over path; disposeVariance is a money field the agent may only propose (NO_MONEY_FIELD → ROLE_DENIED in the journal); the officer disposes
    if (cx.c.hold_reason !== "money_mismatch") {
      await owner(cx, { process: "16.1", name: "openShortagePath", actor: PAYOFF_RELEASE, scope: "loan", trigger: funded.id, input: { loan_id: cx.c.prior_loan_id, quote_id: cx.c.quote_id, received_on: disbursement, amount_received_cents: line.amount_cents, state: facts.state } });
      const denied = new RoleDenied(cx.ctx.actor, ["officer"], "16.2 disposeVariance");
      await journal(cx.io, cx.c, "command_refused", { command: { process: "16.2", name: "disposeVariance", op: null }, trigger_event_id: funded.id, refusal_code: "ROLE_DENIED", detail: { reason: denied.message, guardrail: "NO_MONEY_FIELD", variance_cents: S(variance), exact_total_cents: S(exact), amount_cents: S(line.amount_cents) } });
      cx.rt.escalations.open({ kind: "sev1", severity: "1", ownerRole: "officer", loanId: cx.c.prior_loan_id, applicationId: cx.c.application_id, payload: { reason: "payoff line beyond 16.2's tolerance: disposeVariance is the officer's", closeout_id: cx.c.id, application_id: cx.c.application_id, prior_loan_id: cx.c.prior_loan_id, variance_cents: S(variance), exact_total_cents: S(exact), amount_cents: S(line.amount_cents) } }, cx.ctx.actor);
      return hold(cx, "money_mismatch", { status: "held", waiting_on: "officer", detail: { variance_cents: S(variance), exact_total_cents: S(exact), amount_cents: S(line.amount_cents) } });
    }
    return outcome(cx.c, "waiting", "waiting on the officer's disposeVariance");
  }
  const dispositionOutcome = disposed ? String(pl(disposed)["outcome"] ?? "absorbed") : null;
  if (dispositionOutcome === "applied_per_note") { if (cx.c.hold_reason === "applied_per_note") return recordWait(cx.c, "16.2 applied the uncured funds per the note: no payoff to post"); return hold(cx, "applied_per_note", { status: "held", waiting_on: "officer", detail: { reason: "16.2 rule 5: the uncured shortage was applied per the note — the loan stays active; the officer decides the closeout" } }); }
  const disposition = disposed ? String(pl(disposed)["disposition"] ?? pl(disposed)["shortage_disposition"] ?? "servicer_absorbed") : null;
  // absorbed: the servicer eats the shortfall; cured: the remitter paid it (16.2's cure receipt) — the payoff posts for the exact total with nothing absorbed
  const cured = dispositionOutcome === "cured";
  const absorbed = disposed && !cured && variance < 0n ? -variance : 0n;
  const amountPosted = cured ? exact : line.amount_cents;
  const posted = await owner(cx, { process: "16.2", name: "postPayoff", actor: PAYOFF_RELEASE, scope: "loan", trigger: funded.id, input: { loan_id: cx.c.prior_loan_id, funds_id: cx.c.funds_id, amount_cents: amountPosted, payoff_date: disbursement, remittance_type: facts.remittance_type, escrowed: facts.escrowed, buckets: { accrued_interest: c(quoteRow["interest_cents"]), principal: c(quoteRow["upb_cents"]), escrow_balance: facts.escrow_balance_cents > 0n ? facts.escrow_balance_cents : 0n, ...(c(quoteRow["late_charges_cents"]) > 0n ? { late_charges: c(quoteRow["late_charges_cents"]) } : {}), ...(c(quoteRow["fees_cents"]) > 0n ? { nsf_other_fees: c(quoteRow["fees_cents"]) } : {}) }, custodial_pi_id: facts.custodial.pi, custodial_ti_id: facts.custodial.ti, custodial_clearing_id: facts.custodial.clearing, ...(facts.purchased ? { note_rate_pct: facts.note_rate_pct, ptr_pct: facts.purchased.pass_through_rate, lpi_due: facts.lpi_due ?? undefined } : {}), ...(absorbed > 0n ? { absorbed_shortage_cents: absorbed, shortage_disposition: disposition === "reliance_absorbed" ? "reliance_absorbed" : "servicer_absorbed" } : {}) }, note: "buckets copied from 16.1's payoff_quotes row (rule 2); custodial ids from custodial_accounts" });
  if (!posted.ok) return outcome(cx.c, posted.refused ? "refused" : "failed", posted.message);
  const settlementId = String(posted.output["settlement_id"]);
  const pif = posted.events.find((e) => e.type === "loan.paid_in_full") ?? null;
  cx.c = await updateCloseout(cx.q, cx.c.id, { settlement_id: settlementId, payoff_date: disbursement, hold_reason: null, waiting_on: null, status: "open" }, cx.ctx.now);
  const purchased = !!facts.purchased && !!facts.fnma_loan_number;
  if (purchased) {
    const share = await owner(cx, { process: "16.2", name: "computeFnmaPayoffShare", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif?.id ?? null, input: { loan_id: cx.c.prior_loan_id, settlement_id: settlementId, type: facts.remittance_type, upb_cents: c(quoteRow["upb_cents"]), nib_cents: 0n, note_rate_pct: facts.note_rate_pct, ptr_pct: facts.purchased!.pass_through_rate, lpi_due: facts.lpi_due, payoff_on: disbursement, fnma_advance_repay_cents: 0n } });
    if (share.ok && facts.remittance_type === "AA") {
      const fnmaShare = c(share.output["total_cents"]);
      await owner(cx, { process: "16.2", name: "buildCrsBatch", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif?.id ?? null, input: { loan_id: cx.c.prior_loan_id, batch_id: randomUUID(), lender_id: facts.partner_servicer_number ?? facts.partner_party_id, instructed_at: cx.ctx.now, settlements: [{ loan_id: cx.c.prior_loan_id, settlement_id: settlementId, fnma_loan_number: facts.fnma_loan_number, remittance_type: "AA", fnma_share_cents: fnmaShare, fnma_advance_repay_cents: 0n, payoff_on: disbursement }] } });
      await owner(cx, { process: "16.2", name: "projectRemovalPayoff", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif?.id ?? null, input: { loan_id: cx.c.prior_loan_id, funds_id: cx.c.funds_id, settlement_id: settlementId, fnma_loan_number: facts.fnma_loan_number, principal_cents: c(quoteRow["upb_cents"]), nib_cents: 0n, interest_cents: c(share.output["interest_cents"]), payoff_date: disbursement, processed_at: cx.ctx.now } });
    }
  } else {
    await journal(cx.io, cx.c, "skipped", { command: { process: "16.2", name: "buildCrsBatch" }, detail: { reason: "the prior loan is not purchased: the payoff repays 27.1's advance through 27.2's waterfall (remitted_to = warehouse_paydown)" } });
    await journal(cx.io, cx.c, "skipped", { command: { process: "16.2", name: "projectRemovalPayoff" }, detail: { reason: "not purchased: no LAR action code 60" } });
  }
  await owner(cx, { process: "16.2", name: "createHousekeepingTasks", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif?.id ?? null, input: { loan_id: cx.c.prior_loan_id, settlement_id: settlementId, payoff_date: disbursement, escrowed: facts.escrowed && facts.escrow_balance_cents > 0n, mi_active: false, autodraft: false, enote: false, lpi_active: false, tax_service: false } });
  await advance(cx, "settled", { status: "open", waiting_on: null, trigger: pif?.id ?? funded.id, detail: { settlement_id: settlementId, funds_id: cx.c.funds_id, variance_cents: S(variance) } });
  return { ...outcome(cx.c, "advanced", "settled: 16.2 applied the payoff to zero"), decision: decisionOf(cx.c, "advanced", "settled", { process: "16.2", name: "postPayoff", op: null }, posted.decision_id, { exact_total_cents: S(exact), variance_cents: S(variance) }) };
}
/** 16.2 rule 6: an officer reversed the settlement inside the finality window (`payoff.reversed` on the log): the retirement is superseded, the link cleared, the closeout back to `settling`. */
async function reversal(cx: Cx): Promise<unknown> {
  const rev = cx.f.reversed; if (!rev) return outcome(cx.c, "noop", "no payoff.reversed on the log");
  const already = (await retirementsOf(cx.q, cx.c.prior_loan_id)).some((r) => r.retirement_event_id === rev.id);
  if (already) return outcome(cx.c, "noop", "the reversal is folded");
  const live = (await retirementsOf(cx.q, cx.c.prior_loan_id)).filter((r) => r.retired_on !== null).at(-1) ?? null;
  await insertRetirement(cx.q, { prior_loan_id: cx.c.prior_loan_id, new_loan_id: null, application_id: cx.c.application_id, closeout_id: cx.c.id, mode: cx.c.mode, prior_status: cx.c.prior_status_at_open, retired_on: null, retirement_event_id: rev.id, settlement_event_id: null, settlement_id: cx.c.settlement_id, payoff_demand_id: cx.c.payoff_demand_id, payoff_total_cents: live?.payoff_total_cents ?? null, upb_cents: null, interest_cents: null, fees_cents: null, remitted_to: live?.remitted_to ?? null, wire_reference: null, escrow_treatment: cx.c.escrow_treatment, escrow_balance_cents: cx.c.escrow_balance_cents, evidence_document_id: null, decision_id: null }, cx.ctx.now);
  cx.c = await updateCloseout(cx.q, cx.c.id, { step: "settling", status: "held", hold_reason: "reversed", waiting_on: "officer", retirement_id: null, retired_at: null, funds_id: null, settlement_id: null, new_loan_id: null, release_task_id: null }, cx.ctx.now);
  await journal(cx.io, cx.c, "held", { step: "settling", trigger_event_id: rev.id, waiting_on: "officer", detail: { reason: "reversed", note: "payoff.reversed inside the finality window (16.2 rule 6): superseding retirement row appended, refinanced_by_loan_id cleared by the projector; the officer decides how the settlement resumes (closeout.resume, then the transfer on the record is reused and 16.2 matches the returned funds again)" } });
  await emit(cx, "refinance.closeout.step.entered", { step: "settling", clocked: false, entered_at: civilDay(cx.ctx.now), waiting_on: "officer", status: "open", reversal_event_id: rev.id }, { causationId: rev.id });
  return outcome(cx.c, "advanced", "back to settling after the officer's reversal");
}

// ---------------------------------------------------------------- closeout.escrow
async function escrow(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  await linkIfStaged(cx);
  let treatment = cx.c.escrow_treatment;
  // the disposition recorded once (step escrow_disposed), on the settled closeout; the credit posts after the retirement event (SM_REFI_ESCROW_CREDIT_0 arms on it); the refund after the 5-BD hold
  if (cx.c.step === "settled") {
    // rule 6: the treatment is 24.4's decision as of the settlement — a consent captured after the quote (30.3, by the settlement date) turns the quote-time refund into the credit
    const consentNow = creditConsent(cx.store, cx.events, cx.c.prior_loan_id, cx.c.application_id);
    if (consentNow && consentNow.consent_id !== cx.c.escrow_consent_id && cx.c.payoff_demand_id && (cx.c.escrow_balance_cents ?? 0n) > 0n) {
      const liability = cx.c.payoff_demand_id.slice(cx.c.application_id.length + 1);
      const deposit = cdInitialDeposit(cx.store, cx.events, cx.c.application_id);
      const re = await owner(cx, { process: "24.4", name: "decideEscrowTreatment", actor: TITLE_CLOSING, scope: "app", trigger: cx.f.paidInFull?.id ?? cx.trigger, input: { liability_id: liability, servicing_loan_id: cx.c.prior_loan_id, same_servicer: true, payoff_posted_on: cx.c.payoff_date ?? cx.asOf, escrow_balance_cents: cx.c.escrow_balance_cents, settlement_date: cx.c.payoff_date ?? cx.asOf, consent: { kind: "escrow_credit_to_new_loan", captured_at: consentNow.captured_at }, consent_id: consentNow.consent_id, ...(deposit !== null ? { initial_escrow_deposit_cents: deposit } : {}), net_against_shortfall_flag: false }, note: "the consent captured after the quote: 24.4 re-decides the treatment as of the settlement" });
      if (re.ok) { treatment = treatmentOf(String(re.output["escrow_treatment"]), cx.c.escrow_balance_cents ?? 0n); cx.c = await updateCloseout(cx.q, cx.c.id, { escrow_treatment: treatment, escrow_consent_id: consentNow.consent_id }, cx.ctx.now); }
    }
    const detail = { treatment, escrow_balance_cents: S(cx.c.escrow_balance_cents), consent_id: cx.c.escrow_consent_id, netting: "never (NO_NETTING: escrow.payoff.net_against_shortfall is 3.5's flag and off)" };
    await journal(cx.io, cx.c, "command_run", { step: "escrow_disposed", command: { process: PROCESS, name: "closeout.escrow", op: "record" }, detail: { ...detail, guardrail: "NO_NETTING" } });
    const recorded = await emit(cx, "refinance.escrow.disposition.recorded", { treatment, escrow_balance_cents: S(cx.c.escrow_balance_cents), consent_id: cx.c.escrow_consent_id, netting: "NO_NETTING" });
    await advance(cx, "escrow_disposed", { status: "open", waiting_on: null, trigger: recorded.id });
    return outcome(cx.c, "advanced", `escrow disposition ${treatment} recorded`);
  }
  if (treatment === "refund" && !cx.c.refund_disbursement_id && cx.c.retirement_id && cx.c.payoff_date) {
    const holdState = finalDisbursementHold({ payoff_date: cx.c.payoff_date, today: cx.asOf, in_flight: inFlightOf(cx.events, cx.c.prior_loan_id) });
    if (!(holdState.hold_elapsed || holdState.reason === "deadline")) return outcome(cx.c, "waiting", `3.5's 5-BD in-flight hold: the refund issues from ${holdState.gate_opens_on}`);
    // rule 6: the refund is the ledger's escrow balance now (a tax or insurance disbursement between the quote and today changes it), never the quote-time copy
    const facts = await priorLoanFacts(recordIo(cx), cx.c.prior_loan_id, cx.asOf);
    const amount = facts.escrow_balance_cents > 0n ? facts.escrow_balance_cents : 0n;
    if (amount === 0n) { cx.c = await updateCloseout(cx.q, cx.c.id, { refund_disbursement_id: `${cx.c.prior_loan_id}:none` }, cx.ctx.now); await journal(cx.io, cx.c, "skipped", { step: "escrow_disposed", command: { process: "3.5", name: "issueRefund" }, detail: { reason: "no escrow balance left to refund" } }); await completeIfDone(cx); return outcome(cx.c, "advanced", "no escrow balance: nothing to refund"); }
    const r = await owner(cx, { process: "3.5", name: "issueRefund", actor: ESCROW, scope: "loan", input: { loan_id: cx.c.prior_loan_id, kind: "payoff_refund", amount_cents: amount, escrow_balance_after_payoff_cents: amount, in_flight: inFlightOf(cx.events, cx.c.prior_loan_id), payoff_date: cx.c.payoff_date, due_on: cx.asOf, method: "check", payee_kind: "borrower" }, note: "3.5's refund of the prior escrow balance after the in-flight hold (§1024.34(b)(1)); the amount is the ledger's escrow balance 16.2 left pending" });
    if (!r.ok) return outcome(cx.c, r.refused ? "refused" : "failed", r.message);
    const issued = r.events.find((e) => e.type === "disbursement.issued") ?? null;
    cx.c = await updateCloseout(cx.q, cx.c.id, { refund_disbursement_id: `${cx.c.prior_loan_id}:${cx.asOf}` }, cx.ctx.now);
    await journal(cx.io, cx.c, "completed", { step: "escrow_disposed", command: { process: "3.5", name: "issueRefund" }, decision_id: r.decision_id, detail: { amount_cents: S(amount), disbursement_event_id: issued?.id ?? null, guardrail: "NO_NETTING" } });
    await completeIfDone(cx);
    return outcome(cx.c, "advanced", "3.5's payoff refund issued");
  }
  return outcome(cx.c, "noop", `nothing to dispose at step ${cx.c.step} (${treatment ?? "no treatment"})`);
}

// ---------------------------------------------------------------- closeout.retire
async function retire(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  await linkIfStaged(cx);
  if (cx.c.step === "linked") { const done = await completeIfDone(cx); return outcome(cx.c, done ? "completed" : "waiting", done ? "every step done" : "waiting on the escrow disposition"); }
  if (cx.c.retirement_id) return outcome(cx.c, "noop", "retired already");
  if (cx.c.step !== "escrow_disposed" && cx.c.step !== "settled") return outcome(cx.c, "noop", `step ${cx.c.step} is not the retirement`);
  const pif = cx.f.paidInFull; const confirmed = cx.f.confirmed;
  const paidDemand = [...cx.events].reverse().find((e) => e.type === "payoff.demand.paid" && e.applicationId === cx.c.application_id) ?? null;
  const serviced = cx.c.mode === "serviced_same_servicer";
  const payoffDate = cx.c.payoff_date ?? (serviced && pif ? D(String(pl(pif)["payoff_date"]).slice(0, 10)) : cx.c.disbursement_date);
  if (!payoffDate) return outcome(cx.c, "waiting", "no payoff date");
  const settlement = serviced ? (cx.c.settlement_id ? cx.store.get("payoff_settlements", cx.c.settlement_id)?.data ?? null : null) : null;
  if (serviced && (!pif || !settlement || settlement["status"] !== "paid_in_full")) return outcome(cx.c, "refused", "NO_SETTLEMENT: no loan.paid_in_full with a paid_in_full settlement");
  if (!serviced && (!paidDemand || !pl(paidDemand)["evidence_document_id"])) return outcome(cx.c, "refused", "NO_SETTLEMENT: the demand is not paid with evidence");
  const facts = serviced ? await priorLoanFacts(recordIo(cx), cx.c.prior_loan_id, payoffDate) : null;
  const demandRow = cx.c.payoff_demand_id ? cx.store.get("payoff_demands", cx.c.payoff_demand_id)?.data ?? null : null;
  const remitted = serviced ? remittedTo(facts!) : "partner_wire";
  const total = serviced ? c(settlement!["amount_received_cents"] ?? cx.c.quoted_total_cents) : c(paidDemand ? pl(paidDemand)["amount_cents"] : cx.c.quoted_total_cents);
  const wire = serviced ? null : (paidDemand ? String(pl(paidDemand)["wire_reference"] ?? "") || null : null);
  const evidence = serviced ? (confirmed ? String(pl(confirmed)["evidence_document_id"] ?? "") || null : null) : String(pl(paidDemand!)["evidence_document_id"]);
  const escrowTreatment = cx.c.escrow_treatment ?? (serviced ? "refund" : "partner_obligation");
  // the retirement event first (persisted: the projector flips loans.status; SM_REFI_PRIOR_SETTLE_1BD satisfied; SM_REFI_ESCROW_CREDIT_0 armed when the credit is elected), then the row that names it
  const retired = await emit(cx, "refinance.prior_loan.retired", { prior_status: cx.c.prior_status_at_open, status: "paid_off", retired_on: payoffDate, payoff_date: payoffDate, settlement_id: cx.c.settlement_id, payoff_demand_id: cx.c.payoff_demand_id, payoff_total_cents: S(total), wire_reference: wire, evidence_document_id: evidence, new_loan_id: cx.c.new_loan_id, escrow_treatment: escrowTreatment, remitted_to: remitted, escrow_balance_cents: S(cx.c.escrow_balance_cents), settlement_event_id: serviced ? pif!.id : confirmed?.id ?? null }, { causationId: serviced ? pif!.id : paidDemand!.id });
  const row = await insertRetirement(cx.q, { prior_loan_id: cx.c.prior_loan_id, new_loan_id: cx.c.new_loan_id, application_id: cx.c.application_id, closeout_id: cx.c.id, mode: cx.c.mode, prior_status: cx.c.prior_status_at_open, retired_on: payoffDate, retirement_event_id: retired.id, settlement_event_id: serviced ? pif!.id : confirmed?.id ?? null, settlement_id: cx.c.settlement_id, payoff_demand_id: cx.c.payoff_demand_id, payoff_total_cents: total, upb_cents: serviced ? c(settlement!["upb_cents"]) : demandRow ? c(demandRow["principal_cents"]) : null, interest_cents: serviced ? c(settlement!["interest_note_rate_cents"]) : demandRow ? c(demandRow["interest_cents"]) : null, fees_cents: serviced ? 0n : demandRow ? c(demandRow["fees_cents"]) : null, remitted_to: remitted, wire_reference: wire, escrow_treatment: escrowTreatment, escrow_balance_cents: cx.c.escrow_balance_cents, evidence_document_id: evidence, decision_id: null }, cx.ctx.now);
  cx.c = await updateCloseout(cx.q, cx.c.id, { retirement_id: row.id, retired_at: cx.ctx.now, payoff_date: payoffDate }, cx.ctx.now);
  if (!serviced) {
    // 33.3's receipt with exactly its payload (Discrepancy 1): the monitored loan paid off by the refinance that funded
    const funded = cx.f.funded!;
    await emit(cx, "partner_book.loan.paid_off", { loan_id: cx.c.prior_loan_id, new_loan_id: cx.c.new_loan_id, funding_date: String(pl(funded)["funding_date"] ?? payoffDate), disbursement_date: String(pl(funded)["disbursement_date"] ?? payoffDate), servicing_loan_number: cx.c.new_loan_id ? (await cx.q.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [cx.c.new_loan_id]))[0]?.n ?? null : null, funded_event: funded.type, funded_event_id: funded.id, prior_status: "monitored", status: "paid_off" }, { causationId: retired.id, aggregate: { kind: "loan", id: cx.c.prior_loan_id } });
  }
  if (cx.c.step === "settled") { await journal(cx.io, cx.c, "skipped", { step: "escrow_disposed", detail: { reason: "already disposed" } }); }
  await advance(cx, "retired", { status: "open", waiting_on: null, trigger: retired.id, detail: { retirement_id: row.id, retired_on: payoffDate, remitted_to: remitted } });
  // the same-servicer credit posts after the retirement event, on the settlement date, through 30.3 (3.5's rule; SM_REFI_ESCROW_CREDIT_0 and REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD satisfied by its event)
  if (serviced && escrowTreatment === "credit_to_new_loan" && !cx.c.escrow_credit_event_id) {
    const newLoan = cx.c.new_loan_id;
    if (!newLoan) { await journal(cx.io, cx.c, "waiting", { step: "escrow_disposed", waiting_on: "35.6", detail: { reason: "the credit needs the new loan (loan.staged)" } }); }
    else {
      const deposit = cdInitialDeposit(cx.store, cx.events, cx.c.application_id) ?? cx.c.escrow_balance_cents ?? 0n;
      const tiPre = facts!.ti_prepurchase_id ?? (await cx.q.query<{ id: string }>(`SELECT id::text AS id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = 'ti_prepurchase' ORDER BY created_at LIMIT 1`, [facts!.partner_party_id]))[0]?.id ?? null;
      const credit = await owner(cx, { process: "30.3", name: "buildEscrowLines", actor: ESCROW, scope: "both", trigger: retired.id, input: { op: "post_credit_transfer", application_id: cx.c.application_id, old_loan_id: cx.c.prior_loan_id, new_loan_id: newLoan, consent_id: cx.c.escrow_consent_id, payoff_date: payoffDate, settlement_date: payoffDate, old_balance_after_final_disbursements_cents: facts!.escrow_balance_cents ?? 0n, target_at_start_cents: deposit, fnma_ti_account_id: facts!.custodial!.ti, ...(tiPre ? { custodial_ti_prepurchase_id: tiPre } : {}) }, note: "30.3 rule 8: the prior escrow balance credited to the new loan as of settlement (§1024.34(b)(2)(iii)); the balance is the ledger's, the target the CD's" });
      if (credit.ok) {
        const ev = credit.events.find((e) => e.type === "escrow.credit_to_new_loan.posted") ?? null;
        cx.c = await updateCloseout(cx.q, cx.c.id, { escrow_credit_event_id: ev?.id ?? null }, cx.ctx.now);
        await journal(cx.io, cx.c, "completed", { step: "escrow_disposed", command: { process: "30.3", name: "buildEscrowLines", op: "post_credit_transfer" }, decision_id: credit.decision_id, detail: { credit_event_id: ev?.id ?? null, amount_cents: S(cx.c.escrow_balance_cents), guardrail: "NO_NETTING" } });
      } else { cx.rt.escalations.open({ kind: "sev2", severity: "2", ownerRole: "officer", loanId: cx.c.prior_loan_id, applicationId: cx.c.application_id, payload: { reason: "the elected escrow credit did not post (30.3)", closeout_id: cx.c.id, error: credit.message.slice(0, 300) } }, cx.ctx.actor); }
    }
  }
  return { ...outcome(cx.c, "advanced", `retired ${payoffDate} (${remitted})`), decision: decisionOf(cx.c, "advanced", `retired on ${payoffDate}`, { process: PROCESS, name: "closeout.retire", op: null }, null, { exact_total_cents: S(total) }) };
}

// ---------------------------------------------------------------- closeout.lien_release
async function lienRelease(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  await linkIfStaged(cx);
  if (cx.c.mode !== "serviced_same_servicer") return outcome(cx.c, "noop", "the partner releases (rule 9)");
  const pif = cx.f.paidInFull; if (!pif) return outcome(cx.c, "waiting", "no loan.paid_in_full");
  const payoffOn = D(String(pl(pif)["payoff_date"]).slice(0, 10));
  if (cx.c.step === "retired") {
    const facts = await priorLoanFacts(recordIo(cx), cx.c.prior_loan_id, payoffOn);
    const evidence = cx.f.confirmed ? String(pl(cx.f.confirmed)["evidence_document_id"] ?? "") || null : null;
    const sel = await owner(cx, { process: "16.3", name: "selectReleaseInstrument", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif.id, input: { loan_id: cx.c.prior_loan_id, state: facts.state, county: facts.county, security_instrument: securityInstrumentFor(cx.store, cx.c.prior_loan_id, facts.state), mortgagee_of_record: facts.min && facts.mers_eligible ? "mers" : facts.fnma_loan_number ? "fannie_mae" : "partner", mortgagee_kind: "nonbank", min: facts.min, min_active: !!facts.min, mers_registered: !!facts.min, fnma_loan_number: facts.fnma_loan_number, payoff_on: payoffOn, funds_received_on: payoffOn, funds_kind: "internal_transfer", funds_cleared_on: payoffOn, settlement_id: cx.c.settlement_id, payoff_evidence_document_id: evidence ?? cx.c.settlement_id, confidence: 1 }, note: "16.3's matrix selects the instrument and the signatory path; the facts are the loans / properties rows" });
    if (!sel.ok) return outcome(cx.c, sel.refused ? "refused" : "failed", sel.message);
    const taskId = String(sel.output["release_task_id"]);
    cx.c = await updateCloseout(cx.q, cx.c.id, { release_task_id: taskId }, cx.ctx.now);
    const draft = await owner(cx, { process: "16.3", name: "draftReleaseInstrument", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif.id, input: { release_task_id: taskId, borrower_names: facts.borrower_names.length ? facts.borrower_names : ["Borrower of record"], property_address: facts.property_address, original_recording_reference: `Instrument recorded ${facts.instrument_date} (${facts.county ?? facts.state} recorder)`, original_recording_date: facts.instrument_date, county: facts.county, partner_name: facts.partner_legal_name, original_lender: facts.partner_legal_name } });
    if (!draft.ok) return outcome(cx.c, draft.refused ? "refused" : "failed", draft.message);
    const present = Object.fromEntries(["instrument_title", "min", "fnma_loan_number", "original_recording_reference", "legal_description", "borrower_names_as_recorded", "property_address_apn", "full_satisfaction_statement", "signatory_block", "notary_acknowledgment_form", "pria_cover_sheet", "return_to_address", "fees_from_recorder_schedule"].map((k) => [k, true]));
    const checklist = await owner(cx, { process: "16.3", name: "runReleaseChecklist", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif.id, input: { release_task_id: taskId, present, county_requires_legal_description: false } });
    if (!checklist.ok) return outcome(cx.c, checklist.refused ? "refused" : "failed", checklist.message);
    const routed = await owner(cx, { process: "16.3", name: "routeForExecution", actor: PAYOFF_RELEASE, scope: "loan", trigger: pif.id, input: { release_task_id: taskId } });
    if (!routed.ok) return outcome(cx.c, routed.refused ? "refused" : "failed", routed.message);
    // 16.3's clocks own the release from here: the signing officer executes, the recorder records — unclocked wait (`clocked = false`)
    await advance(cx, "released_or_confirmed", { status: "waiting_human", waiting_on: "signing_officer", trigger: pif.id, detail: { release_task_id: taskId, signatory_path: String(sel.output["signatory_path"] ?? "") } });
    return { ...outcome(cx.c, "advanced", "16.3's release opened; waiting on the signing officer"), decision: decisionOf(cx.c, "advanced", "release routed for execution", { process: "16.3", name: "routeForExecution", op: null }, routed.decision_id) };
  }
  if (cx.c.step === "released_or_confirmed") {
    const recorded = cx.f.recorded; if (!recorded) return outcome(cx.c, "waiting", "16.3: not recorded yet");
    // 16.3's notice, by 16.3's tool (never this process's): the borrower's recorded-release notice
    if (cx.c.release_task_id && !cx.events.some((e) => e.type === "lien_release.borrower_notified" && e.loanId === cx.c.prior_loan_id)) {
      const facts = await priorLoanFacts(recordIo(cx), cx.c.prior_loan_id, payoffOn);
      const task = cx.store.get("release_tasks", cx.c.release_task_id)?.data ?? {};
      const instrumentTitle = String(task["instrument_type"] ?? "release").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      const security = securityInstrumentFor(cx.store, cx.c.prior_loan_id, facts.state);
      // the notice's payload from the record: 16.3's task row (instrument, recording office and reference), the loans / properties rows, the FAKE servicer contact block every servicing notice carries
      const payload = { ...SERVICER_CONTACT, team_name: "Payoff & Lien Release Team", team_phone: SERVICER_CONTACT.servicer_phone, toll_free: SERVICER_CONTACT.servicer_phone, website: SERVICER_CONTACT.portal_url, account_last4: facts.servicer_loan_number.slice(-4), borrower_name: facts.borrower_names[0] ?? "Borrower of record", property_address: facts.property_address,
        payoff_date: payoffOn, instrument_title: instrumentTitle, security_instrument_title: security === "deed_of_trust" ? "Deed of Trust" : security === "security_deed" ? "Security Deed" : "Mortgage", original_recording_date: facts.instrument_date, original_recording_reference: String(task["original_recording_reference"] ?? `Instrument recorded ${facts.instrument_date} (${facts.county ?? facts.state})`),
        recording_office: `${facts.county ?? facts.state} County Recorder`, recorded_date: String(pl(recorded)["recorded_at"] ?? pl(recorded)["recorded_on"] ?? civilDay(cx.ctx.now)), recording_reference: String(pl(recorded)["recording_reference"] ?? task["recording_reference"] ?? ""), escrow_refund_cents: c(([...cx.events].reverse().find((e) => e.type === "disbursement.issued" && e.loanId === cx.c.prior_loan_id && pl(e)["kind"] === "payoff_refund")?.payload as Row | undefined)?.["amount_cents"] ?? 0n), min: facts.min ? (/^\d{18}$/.test(facts.min) ? `${facts.min.slice(0, 7)}-${facts.min.slice(7, 17)}-${facts.min.slice(17)}` : facts.min) : "", note_return_note: "" };   // the MIN as MERS prints it (7-10-1)
      await owner(cx, { process: "16.3", name: "notifyBorrower", actor: PAYOFF_RELEASE, scope: "loan", trigger: recorded.id, input: { loan_id: cx.c.prior_loan_id, op: "release_recorded", release_task_id: cx.c.release_task_id, recorded_document_id: String(pl(recorded)["recorded_document_id"] ?? ""), consent_on_file: false, recipients: (facts.borrower_names.length ? facts.borrower_names : ["Borrower of record"]).map((n, k) => ({ partyId: `borrower-${k + 1}`, name: n, mailingAddress: facts.property_address })), payload } });
    }
    await toLinked(cx);
    return outcome(cx.c, cx.c.status === "completed" ? "completed" : "advanced", "lien_release.recorded: the closeout moves on");
  }
  return outcome(cx.c, "noop", `step ${cx.c.step}`);
}

// ---------------------------------------------------------------- closeout.notify_partner / confirm_partner (monitored)
async function notifyPartner(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  await linkIfStaged(cx);
  if (cx.c.mode !== "monitored_partner" || cx.c.step !== "retired" || !cx.c.retirement_id) return outcome(cx.c, "noop", `nothing to notify at step ${cx.c.step}`);
  const ret = (await retirementsOf(cx.q, cx.c.prior_loan_id)).find((r) => r.id === cx.c.retirement_id)!;
  const loan = (await cx.q.query<{ n: string; partner: string }>(`SELECT servicer_loan_number AS n, partner_party_id::text AS partner FROM loans WHERE id = $1`, [cx.c.prior_loan_id]))[0]!;
  const notice = { servicer_loan_number: loan.n, payoff_date: ret.retired_on, amount_cents: S(ret.payoff_total_cents), wire_reference: ret.wire_reference, refinance_program: true as const, channel: "partner_api" as const };
  const hash = createHash("sha256").update(JSON.stringify(notice)).digest("hex");
  const outbox = new PgOutbox(cx.q);
  const { message } = await outbox.enqueue({ adapter: PARTNER_NOTIFY_ADAPTER, direction: "out", idempotencyKey: retirementIdempotencyKey(cx.c.prior_loan_id), payload: notice, payloadSummary: { servicer_loan_number: loan.n, payoff_date: ret.retired_on, refinance_program: true }, loanId: cx.c.prior_loan_id }, cx.ctx.now);
  const notifiedOn = cx.asOf;
  const row = await insertNotification(cx.q, { retirement_id: ret.id, prior_loan_id: cx.c.prior_loan_id, partner_party_id: loan.partner, kind: "notified", integration_message_id: message.id, channel: "partner_api", payload_hash: hash, servicer_loan_number: loan.n, notified_on: notifiedOn, ack_reference: null, confirmation_source: null, confirmation_import_id: null, tape_status: null, escalation_id: null, actor_kind: cx.ctx.actor.kind, actor_id: cx.ctx.actor.id }, cx.ctx.now);
  const notified = await emit(cx, "partner_book.retirement.notified", { servicer_loan_number: loan.n, notified_on: notifiedOn, integration_message_id: message.id, payload_hash: hash, retirement_id: ret.id }, { aggregate: { kind: "loan", id: cx.c.prior_loan_id } });
  cx.c = await updateCloseout(cx.q, cx.c.id, { partner_notification_id: row.id }, cx.ctx.now);
  await journal(cx.io, cx.c, "command_run", { command: { process: PROCESS, name: "closeout.notify_partner" }, trigger_event_id: notified.id, detail: { integration_message_id: message.id, payload_hash: hash, servicer_loan_number: loan.n, guardrail: "PARTNER_PAYLOAD_MINIMAL" } });
  await advance(cx, "released_or_confirmed", { status: "waiting_partner", waiting_on: "partner", trigger: notified.id });
  // rule 8: a loan the partner reported paid before we notified confirms on notification
  const already = [...cx.events].reverse().find((e) => e.type === "partner_book.loan.loaded" && e.loanId === cx.c.prior_loan_id && (e.payload as Row)["status"] === "paid_off");
  if (already) await confirmFrom(cx, ret.id, loan.partner, loan.n, "tape", already, String((already.payload as Row)["import_id"] ?? "") || null, String((already.payload as Row)["tape_status"] ?? "paid"));
  return { ...outcome(cx.c, "advanced", "the partner notified"), decision: decisionOf(cx.c, "advanced", "partner notified the same day", { process: PROCESS, name: "closeout.notify_partner", op: null }) };
}
async function confirmFrom(cx: Cx, retirementId: string, partner: string, number: string, source: "tape" | "ack" | "ops_resolve", ev: DomainEvent, importId: string | null, tapeStatus: string | null): Promise<void> {
  const row = await insertNotification(cx.q, { retirement_id: retirementId, prior_loan_id: cx.c.prior_loan_id, partner_party_id: partner, kind: source === "ops_resolve" ? "resolved" : "confirmed", integration_message_id: null, channel: null, payload_hash: null, servicer_loan_number: number, notified_on: null, ack_reference: null, confirmation_source: source, confirmation_import_id: importId, tape_status: tapeStatus, escalation_id: null, actor_kind: ev.actor.kind, actor_id: ev.actor.id }, cx.ctx.now);
  const confirmed = await emit(cx, "partner_book.retirement.confirmed", { source, import_id: importId, tape_status: tapeStatus, retirement_id: retirementId, confirming_event_id: ev.id, notification_id: row.id }, { causationId: ev.id, aggregate: { kind: "loan", id: cx.c.prior_loan_id } });
  cx.c = await updateCloseout(cx.q, cx.c.id, { partner_notification_id: row.id, status: "open", waiting_on: null }, cx.ctx.now);
  await journal(cx.io, cx.c, "command_run", { command: { process: PROCESS, name: "closeout.confirm_partner", op: source }, trigger_event_id: ev.id, detail: { source, import_id: importId, tape_status: tapeStatus, event_id: confirmed.id } });
  await toLinked(cx);
}
async function confirmPartner(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  await linkIfStaged(cx);
  if (cx.c.mode !== "monitored_partner" || cx.c.step !== "released_or_confirmed" || !cx.c.retirement_id) return outcome(cx.c, "noop", `nothing to confirm at step ${cx.c.step}`);
  const notes = await notificationsOf(cx.q, cx.c.retirement_id);
  const notified = notes.find((n) => n.kind === "notified"); if (!notified) return outcome(cx.c, "waiting", "not notified yet");
  const loan = (await cx.q.query<{ n: string; partner: string }>(`SELECT servicer_loan_number AS n, partner_party_id::text AS partner FROM loans WHERE id = $1`, [cx.c.prior_loan_id]))[0]!;
  // "after the notification" is the record's order: the partner's tape (or the analyst's resolution) logged after `partner_book.retirement.notified`
  const notifiedEvent = [...cx.events].reverse().find((e) => e.type === "partner_book.retirement.notified" && e.loanId === cx.c.prior_loan_id && (e.payload as Row)["retirement_id"] === cx.c.retirement_id) ?? null;
  const afterNotice = (e: DomainEvent) => e.loanId === cx.c.prior_loan_id && (notifiedEvent ? e.sequence > notifiedEvent.sequence : e.occurredAt >= `${notified.notified_on}T00:00:00.000Z`);
  const resolved = [...cx.events].reverse().find((e) => e.type === "partner_book.loan.resolved" && afterNotice(e) && (e.payload as Row)["resolution"] === "paid_off") ?? null;
  const loaded = [...cx.events].filter((e) => e.type === "partner_book.loan.loaded" && e.loanId === cx.c.prior_loan_id && e.sequence > 0).filter(afterNotice);
  const paidTape = [...loaded].reverse().find((e) => (e.payload as Row)["status"] === "paid_off") ?? null;
  if (resolved) { await confirmFrom(cx, cx.c.retirement_id, loan.partner, loan.n, "ops_resolve", resolved, null, "resolved by the analyst"); return outcome(cx.c, cx.c.status === "completed" ? "completed" : "advanced", "resolved by book.resolve{paid_off}"); }
  if (paidTape) { await confirmFrom(cx, cx.c.retirement_id, loan.partner, loan.n, "tape", paidTape, String((paidTape.payload as Row)["import_id"] ?? "") || null, String((paidTape.payload as Row)["tape_status"] ?? "paid")); return outcome(cx.c, cx.c.status === "completed" ? "completed" : "advanced", "confirmed by the partner's tape"); }
  // a tape after the notification that still carries the loan (no paid status) → disputed, once per import
  const activeTape = [...loaded].reverse().find((e) => (e.payload as Row)["status"] === undefined && (e.payload as Row)["change"] !== undefined) ?? null;
  const openDispute = notes.some((n) => n.kind === "disputed") && !notes.some((n) => n.kind === "confirmed" || n.kind === "resolved");
  if (activeTape && openDispute) { await journal(cx.io, cx.c, "waiting", { waiting_on: "ops_analyst", trigger_event_id: activeTape.id, detail: { disputed: true, later_import_id: String((activeTape.payload as Row)["import_id"] ?? "") || null, note: "the dispute stays open (one escalation per retirement); the analyst resolves through 33.1 book.resolve" } }); return outcome(cx.c, "waiting", "disputed: a later tape still carries the loan"); }
  if (activeTape && !notes.some((n) => n.kind === "disputed" && n.confirmation_import_id === String((activeTape.payload as Row)["import_id"] ?? ""))) {
    const importId = String((activeTape.payload as Row)["import_id"] ?? "") || null;
    // the tape's status as printed: the loaded event carries it only on a transition; an unchanged row's status is 33.1's facts row (the latest tape)
    const tapeStatus = String((activeTape.payload as Row)["tape_status"] ?? (await cx.q.query<{ s: string | null }>(`SELECT facts->>'servicing_status' AS s FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC LIMIT 1`, [cx.c.prior_loan_id]))[0]?.s ?? "active");
    const esc = cx.rt.escalations.open({ kind: "sev2", severity: "2", ownerRole: "ops_analyst", loanId: cx.c.prior_loan_id, applicationId: cx.c.application_id, payload: { reason: "the partner's tape still carries the retired loan as active after the notification (rule 8)", closeout_id: cx.c.id, application_id: cx.c.application_id, prior_loan_id: cx.c.prior_loan_id, servicer_loan_number: loan.n, tape_status: tapeStatus, import_id: importId, resolve_through: "33.1 book.resolve{paid_off}" } }, cx.ctx.actor);
    const disputedId = randomUUID(); const defer = cx.rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!defer) throw new PortUnavailable("service:deferWrite");
    const disputedRow = { id: disputedId, retirement_id: cx.c.retirement_id, prior_loan_id: cx.c.prior_loan_id, partner_party_id: loan.partner, kind: "disputed", integration_message_id: null, channel: null, payload_hash: null, servicer_loan_number: loan.n, notified_on: null, ack_reference: null, confirmation_source: null, confirmation_import_id: importId, tape_status: tapeStatus, escalation_id: esc.id, actor_kind: cx.ctx.actor.kind, actor_id: cx.ctx.actor.id };
    // the escalation row is saved at the command's commit: the disputed row (escalation_id → escalations) follows it in the same transaction
    defer(async (q) => { await insertNotification(q, disputedRow as unknown as NewNotification, cx.ctx.now); await updateCloseout(q, cx.c.id, { partner_notification_id: disputedId }, cx.ctx.now); });
    const row = { id: disputedId };
    await emit(cx, "partner_book.retirement.disputed", { tape_status: tapeStatus, import_id: importId, escalation_id: esc.id, notification_id: row.id, servicer_loan_number: loan.n }, { causationId: activeTape.id, aggregate: { kind: "loan", id: cx.c.prior_loan_id } });
    await journal(cx.io, cx.c, "waiting", { waiting_on: "ops_analyst", trigger_event_id: activeTape.id, detail: { disputed: true, tape_status: tapeStatus, import_id: importId, escalation_id: esc.id } });
    return outcome(cx.c, "waiting", "disputed: the partner's tape still carries the loan");
  }
  return outcome(cx.c, "waiting", "waiting on the partner's tape");
}

// ---------------------------------------------------------------- closeout.hold / resume / board / pass
async function holdTool(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt); const reason = str(i, "reason") || "manual";
  if (["completed", "unwound", "cancelled"].includes(cx.c.status)) return outcome(cx.c, "refused", `${cx.c.status} is terminal`);
  return hold(cx, reason, { status: "held", waiting_on: "ops_analyst", detail: { by: `${ctx.actor.kind}:${ctx.actor.id}` } });
}
async function resumeTool(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const cx = await load(i, ctx, rt);
  if (cx.c.status !== "held") return outcome(cx.c, "noop", `not held (${cx.c.status})`);
  if (i["op"] === "cancel") {
    // the analyst closes a closeout that cannot complete (16.2 applied the uncured shortage per the note: the prior loan stays active; a refinance abandoned after funding): terminal cancelled{reason}
    const reason = str(i, "reason") || cx.c.hold_reason || "cancelled";
    cx.c = await updateCloseout(cx.q, cx.c.id, { status: "cancelled", hold_reason: reason, waiting_on: null, completed_at: cx.ctx.now }, cx.ctx.now);
    await journal(cx.io, cx.c, "cancelled", { detail: { by: `${ctx.actor.kind}:${ctx.actor.id}`, reason } });
    await emit(cx, "refinance.closeout.unwound", { reason, step: cx.c.step, terminal: "cancelled", by: `${ctx.actor.kind}:${ctx.actor.id}` });
    return outcome(cx.c, "cancelled", reason);
  }
  const status: CloseoutRow["status"] = cx.c.hold_reason === "money_mismatch" ? "waiting_human" : "open";
  cx.c = await updateCloseout(cx.q, cx.c.id, { status, hold_reason: null, step_attempts: 0, waiting_on: status === "waiting_human" ? "officer" : null }, cx.ctx.now);
  await journal(cx.io, cx.c, "resumed", { detail: { by: `${ctx.actor.kind}:${ctx.actor.id}`, reason: str(i, "reason") || null, ...(flag(i, "accept_variance") ? { accept_variance: true } : {}) } });
  await emit(cx, "refinance.closeout.resumed", { step: cx.c.step, by: `${ctx.actor.kind}:${ctx.actor.id}` });
  return outcome(cx.c, "advanced", "resumed");
}
async function board(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const q = txOf(ctx);
  const asOf = has(i, "as_of_date") ? D(str(i, "as_of_date")) : wallClock(Date.parse(ctx.now), ET).date;
  const counts = await boardCounts(q, asOf);
  const rows = await q.query<{ application_id: string; prior_loan_id: string; mode: string; step: string; status: string; waiting_on: string | null; opened_at: string; good_through: string | null; disbursement_date: string | null }>(`SELECT application_id::text AS application_id, prior_loan_id::text AS prior_loan_id, mode, step, status, waiting_on, opened_at::text AS opened_at, good_through::text AS good_through, disbursement_date::text AS disbursement_date FROM refinance_closeouts WHERE status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at`);
  const text = renderRefinanceBoard(asOf, counts, rows);
  const sha = createHash("sha256").update(text).digest("hex");
  const documentId = `doc-refinance-board-${asOf}`;
  rt.store.put("documents", documentId, { kind: "refinance_closeout_daily_receipt", sha256: sha, byte_size: Buffer.byteLength(text), storage_uri: `fake://documents/${sha}`, mime_type: "text/plain", retention_class: "life_of_loan_plus_4y", metadata: { as_of_date: asOf, counts: { ...counts } }, text }, ctx.actor, ctx.now);
  const receipt = await insertReceipt(q, asOf, counts, documentId, ctx.now);
  ctx.events.append({ type: "refinance.closeout.daily.run_completed", aggregate: { kind: "global", id: "*" }, actor: ctx.actor, payload: { as_of_date: asOf, receipt_id: receipt.id, report_document_id: documentId, counts: { open: counts.open, by_mode: counts.by_mode, by_step: counts.by_step, waiting_human: counts.waiting_human, waiting_vendor: counts.waiting_vendor, waiting_partner: counts.waiting_partner, held: counts.held, retired_today: counts.retired_today, completed_today: counts.completed_today, unwound_today: counts.unwound_today, releases_open: counts.releases_open, partner_unconfirmed: counts.partner_unconfirmed }, origination: true } });
  return { receipt_id: receipt.id, as_of_date: asOf, report_document_id: documentId, counts, board: text, decision: { closeout_id: receipt.id, application_id: "", prior_loan_id: "", mode: "serviced_same_servicer" as CloseoutMode, step: "board", command: { process: PROCESS, name: "closeout.board", op: null }, trigger_event_id: null, owner_decision_id: null, figures: { quoted_total_cents: null, per_diem_cents: null, exact_total_cents: null, variance_cents: null }, rule_set_version: RULE_SET_VERSION, model_version: "deterministic", prompt_version: PROMPT_VERSION, confidence: 1, rationale: `daily receipt ${asOf}: ${counts.open} open` } satisfies CloseoutDecision };
}
async function pass(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const runtime = runtimeOf(rt);
  const r = await closeoutPass(runtime, ctx.now, { application_id: str(i, "application_id") || null, logger: runtime.logger });
  const b = flag(i, "board") ? await closeoutBoardRun(runtime, ctx.now, { force: true }) : null;
  return { ...r, board: b };
}

const step = (name: string, handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => Promise<unknown>, extra: Partial<Omit<ToolDef, "process" | "agent">> = {}): Omit<ToolDef, "process" | "agent"> => { const { guardrails: more, ...rest } = extra; return { name, kind: "act", ruleSetVersion: RULE_SET_VERSION, handler: compute(handler), decision: decisionFn(name), ...rest, guardrails: [NO_CLIENT_STATE, ...(more ?? [])] }; };

export const TOOLS_35_10: readonly ToolDef[] = defineTools(PROCESS, AGENT, [
  step("closeout.open", open),
  step("closeout.pass", pass),
  step("closeout.quote", quote),
  step("closeout.settle", settle),
  step("closeout.escrow", escrow),
  step("closeout.lien_release", lienRelease),
  step("closeout.retire", retire, { guardrails: [NO_SETTLEMENT] }),
  step("closeout.notify_partner", notifyPartner),
  step("closeout.confirm_partner", confirmPartner),
  step("closeout.hold", holdTool, { humanOnly: true, humanRoles: ["ops_analyst"], guardrails: [HUMAN_ONLY_HOLD] }),
  step("closeout.resume", resumeTool, { humanOnly: true, humanRoles: ["ops_analyst"], guardrails: [HUMAN_ONLY_HOLD] }),
  step("closeout.board", board),
  { name: "writeDecision", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [NO_CLIENT_STATE], handler: decision() },
]);
export { stepsOf };
