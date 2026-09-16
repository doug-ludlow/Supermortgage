/**
 * §35.10 — the refinance closeout as the runtime pass the sweep takes after 35.6's orchestration and before the breach pass
 * (src/runtime/app.ts Runtime.sweep → `refinance.closeout`), the daily board at 06:45 ET, the breach annotations, and the
 * narrow ports on the neighbours (35.7's roles-35-7/ports.ts pattern — each with an in-repo default so this process runs
 * whether or not the neighbour has merged):
 *
 *   closeoutPass(rt, now)      rule 10: opens a closeout for every refinance application with a prior loan on the platform
 *                              (35.10 `closeout.open`), then for every open closeout reads the row and the two aggregates' logs,
 *                              asks the state machine (closeout-35-10/machine.ts) what runs next and executes THAT closeout tool
 *                              on the bus — never a command for a closeout with nothing new (T2: a second sweep folding the same
 *                              events writes no set, row or event). Failures are journaled `command_failed` in a short unit of
 *                              work of the pass's own and counted; three on one step → held{attempts}.
 *   handoff port (35.6)        the new loan is staged and boarded before the closeout settles: the default is the fund bridge
 *                              `POST /v1/applications/{id}/fund` takes (src/runtime/origination.ts fundApplication from the record —
 *                              26.3's loan.funded, 26.1's note terms through its own calculator, 25.2's CD figures where recorded),
 *                              carrying the same-servicer escrow credit 30.2's opening set reads (rule 6); a no-op once 35.6's
 *                              orchestration.pass has staged the loan.
 *   payoff_demand port (24.4)  the partner's statement channel — FakePartnerPayoffDemand (src/infra/integrations/partner-payoff.ts).
 *   partner-book.notify        the outbox adapter of rule 8 — FakePartnerBookNotify, registered beside 35.1's port adapters.
 *   closeoutBoardRun(rt, now)  rule 11: `closeout.board{as_of_date}` once a day at/after 06:45 America/New_York.
 *   closeoutBreachActions      after the breach pass: the closeout's journal records each breached SM_REFI_* clock once (`waiting`,
 *                              detail.timer_id) so the board and the examiner see it beside the sweep's escalation.
 */
import { EntityStore } from "../app/tools.ts";
import type { OutboundAdapter } from "../infra/integrations/outbox.ts";
import { FakePartnerBookNotify, FakePartnerPayoffDemand, type PartnerPayoffDemandPort } from "../infra/integrations/partner-payoff.ts";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { plainDate as D, type PlainDate } from "../kernel/calendar/date.ts";
import type { Actor, DomainEvent } from "../kernel/events/index.ts";
import type { Cents } from "../kernel/money/cents.ts";
import { CommandRefused } from "../app/commands.ts";
import { closeoutByApplication, openCloseouts, applicationsWithoutCloseout, updateCloseout, appendStep } from "../domain/operations-runtime/closeout-35-10/repo.ts";
import { fold, next, before, MAX_ATTEMPTS, type Next } from "../domain/operations-runtime/closeout-35-10/machine.ts";
import { creditConsent, cdInitialDeposit, fundingIdFor, projectedDisbursement, inFlightOf } from "../domain/operations-runtime/closeout-35-10/derive.ts";
import { AGENT, PROCESS, type CloseoutRow } from "../domain/operations-runtime/closeout-35-10/types.ts";
import { finalDisbursementHold } from "../domain/escrow/ops-3-5.ts";
import { prepaidInterest, type LoanFundedPayload } from "../domain/orig-boarding/ops-30-2.ts";
import { demoSnapshot, fundApplication, fundedFromLog, snapshotOverridesFromRecord, type DemoOverrides } from "./origination.ts";
import type { Runtime } from "./app.ts";
import { orchestrationByApplication } from "../domain/operations-runtime/orchestration-35-6.ts";
import type { Logger } from "./log.ts";

export const ET = "America/New_York";
/** The spec's schedule for the board: 06:45 America/New_York ("Inputs and triggers"). */
export const BOARD_AT_ET = "06:45";
export const PAYOFF_RELEASE: Actor = { kind: "agent", id: AGENT };
const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const FUNDING: Actor = { kind: "agent", id: "funding" };
type Row = Record<string, unknown>;

// ---------------------------------------------------------------- ports
export interface HandoffResult { readonly ran: boolean; readonly loan_id: string | null; readonly reason: string; }
export interface HandoffPort { stageAndBoard(rt: Runtime, c: { application_id: string; prior_loan_id: string; escrow_credit_cents: Cents | null }, nowIso: string): Promise<HandoffResult>; }
export interface CloseoutPorts { readonly payoffDemand: PartnerPayoffDemandPort; readonly handoff: HandoffPort; readonly partnerNotify: OutboundAdapter; }

/** 35.6's hand-off, from the record: what `POST /v1/applications/{id}/fund` does, with 26.1's note terms computed by 26.1's own calculator from 26.3's funding row and the CD figures where 25.2 recorded them; the same-servicer credit rides on the funded payload (30.2 rule 3 / 35.10 rule 6). */
export const defaultHandoff: HandoffPort = {
  async stageAndBoard(rt, c, nowIso) {
    const app = await rt.applications.get(c.application_id);
    if (!app) return { ran: false, loan_id: null, reason: "no application" };
    if (app.loan_id) return { ran: false, loan_id: app.loan_id, reason: "already staged (35.6 or an earlier hand-off)" };
    // 35.6 rule 6: an orchestrated application is handed off by `orchestration.pass` (the snapshot from the record, one `loans` row) earlier in the same sweep — rule 10: closeout.pass runs after it — and the closeout links on `loan.staged` (edge case: `open{waiting_on: 35.6}` until then); in production no fixture ever fills a gap, so a row the pass does not own waits for 35.6's discovery instead of `demoSnapshot`
    const orch = await orchestrationByApplication(rt.db, c.application_id);
    if (orch !== null) return { ran: false, loan_id: null, reason: `35.6 owns the hand-off (orchestration ${orch.id} at ${orch.step}/${orch.status}); the closeout links on loan.staged` };
    if (rt.environment === "production") return { ran: false, loan_id: null, reason: "FIXTURE_REFUSED: production hands off from the record through 35.6's orchestration.pass, never from demoSnapshot (35.6 rule 6)" };
    const funded = await fundedFromLog(rt, c.application_id);
    if (!funded) return { ran: false, loan_id: null, reason: "no loan.funded on the application" };
    const store = new EntityStore(); store.seed(await rt.entities.load({ applicationId: c.application_id }));
    const events = await rt.uow.events.byApplication(c.application_id);
    const recorded = await snapshotOverridesFromRecord(rt, c.application_id);
    const base = demoSnapshot(app, recorded);
    const funding = [...store.list("fundings", (d) => d["application_id"] === c.application_id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.data ?? null;
    const cd = [...store.list("disclosures", (d) => d["application_id"] === c.application_id && String(d["kind"] ?? "").startsWith("cd"))].sort((a, b) => Number(b.data["cd_version"] ?? 0) - Number(a.data["cd_version"] ?? 0))[0]?.data ?? null;
    // 25.2's cdFigureSnapshot is flat (rate_pct, loan_amount_cents, monthly_escrow_cents, …); a loan / escrow sub-object is accepted too
    const figures = cd?.["figures"] as Row | undefined;
    const cdLoan = (figures?.["loan"] as Row | undefined) ?? (figures && figures["loan_amount_cents"] != null ? figures : undefined); const cdEscrow = (figures?.["escrow"] as Row | undefined) ?? (figures && figures["monthly_escrow_cents"] != null ? figures : undefined);
    const gross: Cents = funding && funding["gross_loan_cents"] != null ? BigInt(String(funding["gross_loan_cents"])) : cdLoan ? BigInt(String(cdLoan["loan_amount_cents"])) : base.note.amount_cents;
    const rate = funding && funding["note_rate_pct"] != null ? String(funding["note_rate_pct"]) : cdLoan ? String(cdLoan["rate_pct"]) : base.note.note_rate_pct;
    const term = cdLoan && cdLoan["term_months"] != null ? Number(cdLoan["term_months"]) : base.note.term_months;
    const state = app.properties[0]?.state ?? base.property.state;
    // 26.1 computes the note terms (P&I, first payment, maturity, the data hash) — its calculator, its tool
    const terms = (await rt.execute({ process: "26.1", name: "computeNoteTerms", loanId: "", applicationId: c.application_id, actor: CLOSER, input: { principal_cents: gross, note_rate_pct: rate, term_months: term, scheduled_disbursement_date: funded.disbursement_date, state } })).output as { pi_cents: Cents; first_payment_date: PlainDate; maturity_date: PlainDate; data_hash: string; late_charge_pct: string; late_charge_days: number };
    const prior = c.prior_loan_id ? (await rt.db.query<{ e: string | null }>(`SELECT escrow_payment_cents::text AS e FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [c.prior_loan_id]))[0] : null;
    const monthly: Cents = cdEscrow ? BigInt(String(cdEscrow["monthly_escrow_cents"])) : prior?.e ? BigInt(prior.e) : base.final_cd.monthly_escrow_cents;
    const deposit: Cents = cdInitialDeposit(store, events, c.application_id) ?? base.final_cd.initial_escrow_deposit_cents;
    const prepaid = prepaidInterest(gross, rate, funded.disbursement_date);
    const cushion = monthly * 2n;
    const overrides: DemoOverrides = {
      ...recorded,
      note: { ...base.note, amount_cents: gross, note_rate_pct: rate, term_months: term, first_payment_date: terms.first_payment_date, maturity_date: terms.maturity_date, late_charge_pct: terms.late_charge_pct, late_charge_grace_days: terms.late_charge_days, ...(recorded.note ?? {}), ...(recorded.note?.data_hash ? {} : { data_hash: terms.data_hash }) },
      // OB-002: the signed note's data hash is the record's (26.1's rendered eNote) when it has one, else 26.1's computed terms hash for these figures
      closing: { ...base.closing, ...(recorded.closing ?? {}), ...(recorded.closing?.note_terms_hash ? {} : { note_terms_hash: terms.data_hash }) },
      final_cd: { ...base.final_cd, pi_cents: terms.pi_cents, monthly_escrow_cents: monthly, initial_escrow_deposit_cents: deposit, prepaid_interest_cents: funded.interest_credit ? 0n : prepaid.prepaid_interest_cents, prepaid_interest_days: prepaid.days },
      escrow_analysis: base.escrow_analysis ? { ...base.escrow_analysis, monthly_escrow_cents: monthly, required_start_balance_cents: deposit - cushion, cushion_cents: cushion, lines: [{ line_type: "county_tax", annual_amount_cents: monthly * 12n - (monthly * 12n) / 4n, monthly_cents: monthly - monthly / 4n }, { line_type: "hazard", annual_amount_cents: (monthly * 12n) / 4n, monthly_cents: monthly / 4n }] } : null,
    } as DemoOverrides;
    const snapshot = demoSnapshot(app, overrides);
    const credit = c.escrow_credit_cents !== null && c.escrow_credit_cents > 0n ? (c.escrow_credit_cents < deposit ? c.escrow_credit_cents : deposit) : null;
    const payload: LoanFundedPayload = { ...funded, ...(credit !== null ? { escrow_credit_from_prior_loan_cents: credit } : {}) };
    const r = await fundApplication(rt, c.application_id, snapshot, payload, FUNDING);
    rt.logger?.info("refinance closeout: hand-off from the record (35.6 port default)", { application_id: c.application_id, loan_id: r.loan_id, status: r.status, at: nowIso, credit: credit?.toString() ?? null });
    return { ran: true, loan_id: r.loan_id, reason: `fundApplication from the record: ${r.status}` };
  },
};
export function closeoutPortsOf(p?: Partial<CloseoutPorts>): CloseoutPorts {
  return { payoffDemand: p?.payoffDemand ?? new FakePartnerPayoffDemand(), handoff: p?.handoff ?? defaultHandoff, partnerNotify: p?.partnerNotify ?? new FakePartnerBookNotify() };
}
/** 35.1's outbox adapter registry gains the closeout's partner adapter (the FAKE unless the deployment wires one). */
export function withCloseoutAdapters(existing: ReadonlyMap<string, OutboundAdapter> | undefined, ports: CloseoutPorts): ReadonlyMap<string, OutboundAdapter> | undefined {
  if (existing?.has(ports.partnerNotify.name)) return existing;
  const m = new Map(existing ?? []); m.set(ports.partnerNotify.name, ports.partnerNotify); return m;
}

// ---------------------------------------------------------------- the pass
export interface CloseoutPassReport { readonly at: string; readonly opened: number; readonly examined: number; readonly commands: number; readonly failed: number; readonly held: number; readonly handoffs: number; readonly line: string; readonly skipped: readonly { application_id: string; reason: string }[]; }
export interface CloseoutPassOptions { readonly logger?: Logger | undefined; /** one application only (35.8's screens: closeout.pass{application_id}) */ readonly application_id?: string | null; readonly max_transitions?: number; }

/** What a closeout tool answers the pass (the row's outcome after the command). */
export interface StepOutcome { readonly outcome: "advanced" | "waiting" | "held" | "refused" | "failed" | "completed" | "unwound" | "cancelled" | "noop"; readonly step: string; readonly status: string; readonly detail?: string; /** a wait on a record row (no event): the pass keeps no fold marker and looks again next sweep */ readonly record_wait?: boolean; }

async function journalFailure(rt: Runtime, c: CloseoutRow, tool: string, err: unknown, nowIso: string): Promise<CloseoutRow> {
  const msg = err instanceof Error ? err.message : String(err); const cls = err instanceof Error ? err.name : "Error";
  return countFailure(rt, c, tool, nowIso, { error_class: cls, error: msg });
}
/** Rule 10: a failure on a step counts toward `held{attempts}` (MAX_ATTEMPTS) — a thrown error journals `command_failed` here; an owner tool's failure was journaled by the tool itself (`owner()`), so only the attempt is counted. */
async function countFailure(rt: Runtime, c: CloseoutRow, tool: string, nowIso: string, thrown: { error_class: string; error: string } | null): Promise<CloseoutRow> {
  const attempts = c.step_attempts + 1;
  const held = attempts >= MAX_ATTEMPTS;
  // the pass's own short unit of work (rt.root.db: the failure must outlive the failed command)
  const row = await rt.db.tx(async (q) => {
    if (thrown) await appendStep(q, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step: c.step, kind: "command_failed", waiting_on: c.waiting_on, command_process: PROCESS, command_name: tool, actor_kind: PAYOFF_RELEASE.kind, actor_id: PAYOFF_RELEASE.id, error_class: thrown.error_class, detail: { error: thrown.error.slice(0, 500), attempt: attempts, waiting_on: c.waiting_on }, sweep_run_id: rt.root.sweepRunId }, nowIso);
    if (held) await appendStep(q, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step: c.step, kind: "held", waiting_on: c.waiting_on, actor_kind: PAYOFF_RELEASE.kind, actor_id: PAYOFF_RELEASE.id, detail: { reason: "attempts", attempts, tool }, sweep_run_id: rt.root.sweepRunId }, nowIso);
    return updateCloseout(q, c.id, held ? { step_attempts: attempts, status: "held", hold_reason: "attempts" } : { step_attempts: attempts }, nowIso);
  });
  rt.logger?.warn("refinance closeout: command failed", { closeout_id: c.id, application_id: c.application_id, tool, attempt: attempts, held, error: thrown?.error ?? "owner tool failed (journaled by the tool)" });
  return row;
}
/** Rule 10's fold marker: the newest event on the closeout's subject that is not the bus's own audit (`command.*`) — a run with nothing newer than `last_event_sequence` is not a run. */
const newestSequence = (events: readonly DomainEvent[]): number => events.reduce((m, e) => (e.type.startsWith("command.") ? m : Math.max(m, e.sequence)), 0);

export async function closeoutPass(rt: Runtime, nowIso: string, opts: CloseoutPassOptions = {}): Promise<CloseoutPassReport> {
  const log = opts.logger ?? rt.logger; const asOf = wallClock(Date.parse(nowIso), ET).date;
  let opened = 0, examined = 0, commands = 0, failed = 0, held = 0, handoffs = 0; const skipped: { application_id: string; reason: string }[] = [];
  // 1. closeout.open for every refinance application with a prior loan on the platform and no closeout (ONE_CLOSEOUT_PER_APPLICATION)
  const fresh = (await applicationsWithoutCloseout(rt.db)).filter((a) => !opts.application_id || a.application_id === opts.application_id);
  for (const a of fresh) {
    try { await rt.execute({ process: PROCESS, name: "closeout.open", loanId: a.prior_loan_id, applicationId: a.application_id, actor: PAYOFF_RELEASE, input: { application_id: a.application_id, prior_loan_id: a.prior_loan_id } }); opened += 1; commands += 1; }
    catch (e) { failed += 1; skipped.push({ application_id: a.application_id, reason: e instanceof Error ? e.message : String(e) }); log?.warn("refinance closeout: open failed", { application_id: a.application_id, error: e instanceof Error ? e.message : String(e) }); }
  }
  // 2. every open closeout: read, decide, run — at most a few transitions per sweep, no command when nothing is new
  const rows = (await openCloseouts(rt.db)).filter((c) => !opts.application_id || c.application_id === opts.application_id);
  for (let c of rows) {
    examined += 1;
    for (let k = 0; k < (opts.max_transitions ?? 8); k += 1) {
      const current = await closeoutByApplication(rt.db, c.application_id); if (!current) break; c = current;
      if (["completed", "unwound", "cancelled"].includes(c.status)) break;
      const events = [...await rt.uow.events.byLoan(c.prior_loan_id), ...await rt.uow.events.byApplication(c.application_id)].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i).sort((a, b) => a.sequence - b.sequence);
      const f = fold(events, c);
      // rule 5 / T12: a closeout held{money_mismatch} resumes on its own once the officer's disposeVariance (`payoff.shortage.resolved`) is on the prior loan's log; every other hold waits for closeout.resume
      if (c.status === "held" && c.hold_reason === "money_mismatch" && f.disposeVariance && (c.last_event_sequence === null || BigInt(f.disposeVariance.sequence) > c.last_event_sequence)) {
        c = await rt.db.tx(async (q) => { await appendStep(q, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step: c.step, kind: "resumed", waiting_on: null, actor_kind: PAYOFF_RELEASE.kind, actor_id: PAYOFF_RELEASE.id, trigger_event_id: f.disposeVariance!.id, detail: { reason: "the officer disposed the variance (16.2 disposeVariance): the settlement resumes", disposition: (f.disposeVariance!.payload as Row)["disposition"] ?? null }, sweep_run_id: rt.root.sweepRunId }, nowIso); return updateCloseout(q, c.id, { status: "open", hold_reason: null, waiting_on: null, step_attempts: 0 }, nowIso); });
      }
      if (c.status === "held") { held += 1; break; }
      // 35.6's hand-off (the port): the new loan is staged and boarded before the closeout settles (rule 10: closeout.pass runs after orchestration.pass)
      if (f.funded && f.confirmed && !f.unwind && !c.new_loan_id) {
        const app = await rt.applications.get(c.application_id);
        if (app && !app.loan_id) {
          try {
            const store = new EntityStore(); store.seed(await rt.entities.load({ loanId: c.prior_loan_id, applicationId: c.application_id }));
            // rule 6: the credit follows 30.3's consent on the record now (captured after the quote, it still counts: the treatment is re-decided at settlement)
            // rule 6: the credit is the ledger's escrow balance now (never the quote-time copy)
            const ledgerEscrow = -BigInt((await rt.db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'escrow'`, [c.prior_loan_id]))[0]!.s);
            const credit = creditConsent(store, events, c.prior_loan_id, c.application_id) !== null && ledgerEscrow > 0n ? ledgerEscrow : null;
            const h = await rt.closeoutPorts.handoff.stageAndBoard(rt, { application_id: c.application_id, prior_loan_id: c.prior_loan_id, escrow_credit_cents: credit }, nowIso);
            if (h.ran) { handoffs += 1; continue; }   // loan.staged / loan.boarded are on the log now: re-read and fold them
          } catch (e) { c = await journalFailure(rt, c, "handoff", e, nowIso); failed += 1; break; }
        }
      }
      const store = new EntityStore(); store.seed(await rt.entities.load({ loanId: c.prior_loan_id, applicationId: c.application_id }));
      const disb = projectedDisbursement(store, events, c.application_id);
      const goodThroughCovers = c.good_through && disb ? c.good_through >= disb.date : null;
      const disposed = f.disposeVariance !== null;
      // the escrow refund after the 5-BD in-flight hold (3.5's clock; the pass issues it once the gate opens — never a write while it waits)
      const refundElected = c.mode === "serviced_same_servicer" && c.escrow_treatment === "refund" && !c.refund_disbursement_id && !!c.payoff_date && !!c.retirement_id;
      // rule 6: the refund issues once 3.5's 5-BD in-flight hold has elapsed (worked example A: Fri 2027-02-05), or at 3.5's 20-BD deadline — never on the payoff date itself
  const refundDue = refundElected ? ((h) => h.hold_elapsed || h.reason === "deadline")(finalDisbursementHold({ payoff_date: c.payoff_date!, today: asOf, in_flight: inFlightOf(events, c.prior_loan_id) })) : null;
      let n: Next = next(c, f, { newLoanLinked: !!c.new_loan_id, goodThroughCovers, disposed, refundDue });
      if (refundDue === true && (n.kind === "wait" || (n.kind === "run" && n.tool !== "closeout.escrow"))) n = { kind: "run", tool: "closeout.escrow", trigger: null, reason: "the 5-BD in-flight hold elapsed: 3.5's refund issues" };
      // the new loan staged but not linked yet (35.6 stages later than the settlement, or before it): the current step's own tool folds the link (linkIfStaged), never a step it has not reached
      const stagedUnlinked = f.staged && f.staged.loanId && !c.new_loan_id && !(f.reversed && f.reversed.sequence > f.staged.sequence);   // a reversal cleared the link on purpose: the officer decides
      if (n.kind === "wait" && stagedUnlinked) {
        const linkTool = before(c.step, "settling") ? "closeout.quote" : before(c.step, "retired") ? "closeout.settle" : c.mode === "monitored_partner" ? (c.step === "retired" ? "closeout.notify_partner" : "closeout.confirm_partner") : c.step === "retired" ? "closeout.lien_release" : "closeout.retire";
        n = { kind: "run", tool: linkTool, trigger: f.staged!.id, reason: "loan.staged names the new loan: link it" };
      }
      if (n.kind === "wait") break;
      // rule 10: no command when nothing is new — the fold marker (`last_event_sequence`) set by the last run that waited; a time-driven run (the refund gate) is the exception
      const newest = newestSequence(events);
      const timeDriven = n.kind === "run" && n.tool === "closeout.escrow" && refundDue === true;
      if (!timeDriven && c.last_event_sequence !== null && BigInt(newest) <= c.last_event_sequence) break;
      const tool = n.kind === "unwind" ? "closeout.quote" : n.kind === "reverse" ? "closeout.settle" : n.tool;
      const input = { application_id: c.application_id, prior_loan_id: c.prior_loan_id, trigger_event_id: n.trigger, reason: "reason" in n ? n.reason : "payoff.reversed", ...(n.kind === "unwind" ? { op: "unwind" } : n.kind === "reverse" ? { op: "reversal" } : {}) };
      try {
        const r = await rt.execute({ process: PROCESS, name: tool, loanId: c.prior_loan_id, applicationId: c.application_id, actor: PAYOFF_RELEASE, input });
        commands += 1;
        const out = r.output as StepOutcome;
        if (out.outcome === "failed") { failed += 1; c = await countFailure(rt, c, tool, nowIso, null); if (c.status === "held") held += 1; break; }
        if (out.outcome === "held") { held += 1; break; }
        if (out.outcome === "waiting" && out.record_wait) break;
        if (out.outcome === "waiting" || out.outcome === "refused" || out.outcome === "noop") { await updateCloseout(rt.db, c.id, { last_event_sequence: BigInt(newest) }, nowIso); break; }
      } catch (e) {
        if (e instanceof CommandRefused) { log?.warn("refinance closeout: refused", { closeout_id: c.id, tool, code: e.code, reason: e.message }); failed += 1; await updateCloseout(rt.db, c.id, { last_event_sequence: BigInt(newest) }, nowIso); break; }
        c = await journalFailure(rt, c, tool, e, nowIso); failed += 1; break;
      }
    }
  }
  const line = `refinance closeout ${asOf}: opened=${opened} examined=${examined} commands=${commands} handoffs=${handoffs} failed=${failed} held=${held}`;
  log?.info("refinance closeout pass", { at: nowIso, opened, examined, commands, handoffs, failed, held, skipped, line });
  return { at: nowIso, opened, examined, commands, failed, held, handoffs, line, skipped };
}

// ---------------------------------------------------------------- the daily board (rule 11)
export interface BoardRunReport { readonly ran: boolean; readonly as_of_date: PlainDate; readonly reason: string | null; readonly receipt_id: string | null; }
export async function boardRanToday(rt: Runtime, asOf: PlainDate): Promise<boolean> {
  return (await rt.db.query<{ n: string }>(`SELECT 1 AS n FROM refinance_closeout_daily_receipts WHERE as_of_date = $1::date LIMIT 1`, [asOf])).length > 0;
}
export async function closeoutBoardRun(rt: Runtime, nowIso: string, opts: { force?: boolean } = {}): Promise<BoardRunReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date;
  const [hh, mm] = BOARD_AT_ET.split(":").map(Number) as [number, number];
  if (!opts.force && wc.hour * 60 + wc.minute < hh * 60 + mm) return { ran: false, as_of_date: asOf, reason: `before ${BOARD_AT_ET} ET`, receipt_id: null };
  if (await boardRanToday(rt, asOf)) return { ran: false, as_of_date: asOf, reason: "already ran today", receipt_id: null };
  const r = await rt.execute({ process: PROCESS, name: "closeout.board", loanId: "", actor: PAYOFF_RELEASE, input: { as_of_date: asOf } });
  return { ran: true, as_of_date: asOf, reason: null, receipt_id: String((r.output as Row)["receipt_id"] ?? "") || null };
}

// ---------------------------------------------------------------- breach annotations (after the breach pass)
const CLOSEOUT_TIMERS = ["SM_REFI_CLOSEOUT_STALLED_2BD", "SM_REFI_PRIOR_SETTLE_1BD", "SM_REFI_ESCROW_CREDIT_0", "SM_REFI_PARTNER_CONFIRM_21"];
/** Each breached closeout clock is journaled once (`waiting`, detail.timer_id / code) on its closeout so the board and the examiner see it beside the sweep's escalation. */
export async function closeoutBreachActions(rt: Runtime, nowIso: string): Promise<{ journaled: number }> {
  const due = await rt.db.query<{ timer_id: string; code: string; loan_id: string | null; closeout_id: string | null; application_id: string | null; breached_at: string }>(
    `SELECT t.id::text AS timer_id, t.code, t.loan_id::text AS loan_id, e.payload->>'closeout_id' AS closeout_id, e.payload->>'application_id' AS application_id, t.breached_at::text AS breached_at
       FROM timers t JOIN loan_events e ON e.id = t.armed_by_event_id
      WHERE t.code = ANY($1::text[]) AND t.status = 'breached' AND t.breached_at <= $2
        AND NOT EXISTS (SELECT 1 FROM refinance_closeout_steps s WHERE s.kind = 'waiting' AND s.detail->>'timer_id' = t.id::text)
      ORDER BY t.breached_at, t.id`, [CLOSEOUT_TIMERS, nowIso]);
  let journaled = 0;
  for (const row of due) {
    const c = row.application_id ? await closeoutByApplication(rt.db, row.application_id) : row.loan_id ? (await rt.db.query<Row>(`SELECT application_id::text AS application_id FROM refinance_closeouts WHERE prior_loan_id = $1 ORDER BY opened_at DESC LIMIT 1`, [row.loan_id]))[0] ? await closeoutByApplication(rt.db, String((await rt.db.query<Row>(`SELECT application_id::text AS application_id FROM refinance_closeouts WHERE prior_loan_id = $1 ORDER BY opened_at DESC LIMIT 1`, [row.loan_id]))[0]!["application_id"])) : null : null;
    if (!c) continue;
    await appendStep(rt.db, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step: c.step, kind: "waiting", waiting_on: c.waiting_on, actor_kind: "system", actor_id: "sweep", detail: { timer_id: row.timer_id, timer_code: row.code, breached_at: row.breached_at, status: c.status, hold_reason: c.hold_reason }, sweep_run_id: rt.root.sweepRunId }, nowIso);
    journaled += 1;
  }
  return { journaled };
}

/** The escalation payload the sweep's breach pass adds for a closeout clock: the arming event's ids (T13: `application_id`, `prior_loan_id`, `step`, `waiting_on`). */
export { BREACH_PAYLOAD_KEYS, breachPayloadOf } from "../domain/operations-runtime/closeout-35-10/breach.ts";
export const civilDate = (iso: string): PlainDate => D(iso.slice(0, 10));
export type { DomainEvent };
export { fundingIdFor };
