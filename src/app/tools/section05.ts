/**
 * §5 tools — investor reporting and remittance (5.1–5.7). Tool strings are
 * verbatim from each process's Agents paragraph; guardrails encode the
 * "cannot"/"never" sentences and the confidence thresholds. Agents: 5.1/5.3/
 * 5.6/5.7 `investor-reporting` (5.3 also `payoff-release`/`claims-reo`/
 * `foreclosure-ops`), 5.2/5.4/5.5 `custodial-recon`.
 *
 * Guardrails read the thing being done, not a caller's description of it: the
 * ledger guardrails inspect `entry_set.lines` (scope, account, signed
 * amountCents), the clocks come from `ctx.now`, and Stop Advance / prior-period
 * AW facts are read back from the loan's event history.
 */
import { defineTools, escalate, decision, ledgerPost, compute, never, needsRole, humanWhen, guard, cents, abs, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { createInvestorEvent } from "../../domain/investor/ops-5-1.ts";
import { sdaStatusFromEvents } from "../../domain/investor/ops-5-4.ts";
import { SequenceAllocator } from "../../domain/investor/batch.ts";
import type { CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { projectLar96, prevalidate, validateLar80, type ExpectedPosition } from "../../domain/investor/lar.ts";
import { crsAaRequest, classifyVariance, gfeeCheckFigure, fundingDecision } from "../../domain/investor/remittance.ts";
import { actionCode, removalAmounts, type LiquidationKind, type InsuredFlag, type SaAdvanceState } from "../../domain/investor/liquidation.ts";
import { predictSda, applyRecovery, type SdaState } from "../../domain/investor/sda.ts";
import { deriveStatusCode, candidates, statusLine, consistencyErrors, inPopulation, validateF121Layout, validateF121Record, type LoanStatusFacts, type StatusLine } from "../../domain/investor/delinquency-status.ts";
import { larDeadlineMs, removalCorrectionCloseMs, period as periodOf } from "../../domain/investor/period.ts";
import { EVENT_FAMILY, type LarPayload, type RemittanceType, type ChannelMode, type InvestorEventType } from "../../domain/investor/types.ts";
import { ET, escrowDepositRouting, softRejectInterest, advanceTransfer, reconcileDra, reogramConfirmation, projectLiquidationEvent, removalConfidenceHold, tpsProceeds, matchReimbursements, sdaStatusVariance, form496Line12, gfeeBillLine, gfeeReliefPrediction, gfeeRecovery, gfeeBillVariance, projectLar65, dqExceptionCycle, dqEventForAction, amnTransmission, reconcileDraftDebit, consistencyBlock, lineReviewFlag, type AdvanceRow, type DraMilestone } from "../../domain/investor/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const nowMs = (ctx: CommandContext): number => Date.parse(ctx.now);
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const isoDate = (s: string): s is PlainDate => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---- shared: post-close removal finality (5.1 rule 11 / 5.3 rule 6 / 5.6 rule 5) -----------------------------------------
const afterBd2Close = (i: ToolInput, ctx: CommandContext): boolean => { const p = str(i, "activity_period"); return /^\d{4}-\d{2}$/.test(p) && nowMs(ctx) > removalCorrectionCloseMs(p); };
const noPostCloseRemovalCorrection = guard("NO_REMOVAL_CORRECTION_AFTER_BD2", "5.1/5.3/5.6 guardrail: cannot submit/change a removal correction after BD2 17:00 ET (IRM 4-08)",
  (i, ctx) => (str(i, "family") === "removal" && flag(i, "correction") && afterBd2Close(i, ctx) ? "removal corrections close at BD2 17:00 ET of the month after the activity period; open a qc_finding instead" : undefined));
const recordDecision: Omit<ToolDef, "process" | "agent"> = { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) };

// ---- shared: ledger entry-set inspection ----------------------------------------------------------------------------------
interface AnyLine { readonly account?: { readonly scope?: string; readonly account?: string; readonly custodialAccountId?: string }; readonly amountCents?: unknown }
const linesOf = (i: ToolInput): AnyLine[] => { const s = i.entry_set as { lines?: unknown } | undefined; return Array.isArray(s?.lines) ? (s.lines as AnyLine[]) : []; };
const acct = (l: AnyLine): string => String(l.account?.account ?? "");
const amt = (l: AnyLine): bigint => { try { return cents(l.amountCents); } catch { return 0n; } };
const TI = /custodial_ti|ti_custodial|escrow/i, PI_DRAFT = /fnma_remittance_payable|remittance|pi_custodial|custodial_pi/i, CORPORATE = /corporate|servicer_advance|servicing_fee_income|gfee_payable|transfer_clearing/i;
const scopeOf = (l: AnyLine): "custodial" | "corporate" | "loan" => (l.account?.scope === "custodial" || l.account?.scope === "corporate" ? l.account.scope : /custodial/i.test(acct(l)) ? "custodial" : CORPORATE.test(acct(l)) ? "corporate" : "loan");
/** A movement between custodial and corporate money: lines on both scopes; size = Σ|corporate side|. */
const custodialCorporateTransfer = (i: ToolInput): { cents: bigint; direction: "corporate_to_custodial" | "custodial_to_corporate" } | null => {
  const ls = linesOf(i); const cust = ls.filter((l) => scopeOf(l) === "custodial"), corp = ls.filter((l) => scopeOf(l) === "corporate");
  if (!cust.length || !corp.length) return null;
  return { cents: corp.reduce((s, l) => s + abs(amt(l)), 0n), direction: corp.some((l) => amt(l) < 0n) ? "corporate_to_custodial" : "custodial_to_corporate" };
};
/** Custodial↔corporate transfers already posted today (the $1,000,000 daily dual-control threshold), read from the ledger itself. */
const dailyTransferCents = (ctx: CommandContext): bigint => {
  const today = wallClock(nowMs(ctx), ET).date; let total = 0n;
  for (const set of ctx.ledger.sets()) { if (set.effectiveDate !== today) continue; const cust = set.lines.some((l) => l.account.scope === "custodial"), corp = set.lines.filter((l) => l.account.scope === "corporate"); if (cust && corp.length) total += corp.reduce((s, l) => s + abs(l.amountCents), 0n); }
  return total;
};
/** Stop Advance as Fannie Mae reported it, from the loan's `sda_status.*` history (5.4 state machine: `active` is set only from Fannie Mae data). */
const sdaActive = (ctx: CommandContext, loanId: string): boolean => sdaStatusFromEvents(ctx.events.byLoan(loanId)).status === "active";   // the four status moves only (predicted / prediction_cleared / active / exited) — a later `sda.reconciled` or other non-move fact must not clear the gate
const recoveryDraftSettled = (ctx: CommandContext, loanId: string): boolean => ctx.events.byLoan(loanId).some((e) => e.type === "remittances.drafted" && (e.payload as { sda_recovery?: unknown }).sda_recovery === true);
const noAdvanceOnStopAdvance = guard("NO_ADVANCE_ON_STOP_ADVANCE", "5.4 guardrail: never fund an advance for a loan Fannie Mae has flagged Stop Advance", (i, ctx) => {
  const t = custodialCorporateTransfer(i); const advance = (t !== null && t.direction === "corporate_to_custodial") || linesOf(i).some((l) => /servicer_advance_receivable/i.test(acct(l)) && amt(l) > 0n);
  return advance && sdaActive(ctx, loanOf(i, ctx)) ? "Fannie Mae has set Stop Advance for the loan: no delinquency advance is funded (F-1-20)" : undefined;
});
const holdPiUntilRecoveryDraft = guard("HOLD_PI_UNTIL_RECOVERY_DRAFT", "5.4 guardrail: never release custodial P&I collected on an SDA loan before Fannie Mae's recovery draft settles", (i, ctx) => {
  const ls = linesOf(i); const release = ls.some((l) => /custodial_pi/i.test(acct(l)) && amt(l) < 0n) && ls.some((l) => scopeOf(l) === "corporate" && amt(l) > 0n);
  const loan = loanOf(i, ctx);
  return release && sdaActive(ctx, loan) && !recoveryDraftSettled(ctx, loan) ? "collected P&I stays in custodial_pi_cash until Fannie Mae's Stop Advance recovery draft settles" : undefined;
});

// ---- 5.1 LAR submission -----------------------------------------------------
/** 5.1 reads the family off the event type (the data model's `event_family`), never off a caller's label. */
const family51 = (i: ToolInput): string => EVENT_FAMILY[str(i, "event_type") as InvestorEventType] ?? (str(i, "family") || "payment");
/** The loan's last accepted removal (`investor_events.accepted{family=removal}`) — a further removal projection for that loan is a correction of it. */
const acceptedRemoval51 = (ctx: CommandContext, loanId: string): { activity_period: string } | null => { const evs = ctx.events.byLoan(loanId).filter((e) => e.type === "investor_events.accepted" && (e.payload as { family?: unknown }).family === "removal"); const last = evs[evs.length - 1]; return last ? { activity_period: String((last.payload as { activity_period?: unknown }).activity_period ?? "") } : null; };
const isCorrection51 = (i: ToolInput, ctx: CommandContext): boolean => flag(i, "correction") || (typeof i.supersedes_event_id === "string" && i.supersedes_event_id !== "") || (family51(i) === "removal" && acceptedRemoval51(ctx, loanOf(i, ctx)) !== null);
const activityPeriod51 = (i: ToolInput, ctx: CommandContext): string => { const p = str(i, "activity_period"); if (/^\d{4}-\d{2}$/.test(p)) return p; const d = (i.payload as { action_date?: unknown } | undefined)?.action_date; if (typeof d === "string" && isoDate(d)) return periodOf(D(d)); return acceptedRemoval51(ctx, loanOf(i, ctx))?.activity_period ?? ""; };
/** 5.1 rule 11 / guardrail: no removal correction is projected after BD2 17:00 ET of the month after the activity period (IRM 4-08); the family, the correction and the period are read off the event, not the call. */
const noPostCloseRemovalCorrection51 = guard("NO_REMOVAL_CORRECTION_AFTER_BD2", "5.1 guardrail: cannot submit a removal correction after BD2 17:00 ET (IRM 4-08) — family from the event type, correction from `supersedes_event_id` / the loan's accepted removal",
  (i, ctx) => { const p = activityPeriod51(i, ctx); return family51(i) === "removal" && isCorrection51(i, ctx) && /^\d{4}-\d{2}$/.test(p) && nowMs(ctx) > removalCorrectionCloseMs(p) ? `removal corrections close at BD2 17:00 ET of the month after the ${p} activity period; the payoff is final — open a qc_finding and compute the remit/advance amount instead` : undefined; });
/** `investor_loan_sequences`: the row-locked per-loan allocator, persisted in the runtime store (rule 1: in processing order, never reused). */
const sequenceAllocator51 = (rt: ToolRuntime, loanId: string): SequenceAllocator => new SequenceAllocator({ [loanId]: Number(rt.store.get("investor_loan_sequences", loanId)?.data.next_sequence ?? 1) });
const p51 = defineTools("5.1", "investor-reporting", [
  { name: "projectEvent", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "event_type");
      const eventType = str(i, "event_type") as InvestorEventType; const family = family51(i);
      const processedMs = Date.parse(str(i, "processed_at") || ctx.now); const mode = (str(i, "mode") || "legacy") as ChannelMode;
      if (family === "escrow") return escrowDepositRouting(mode, processedMs);
      const p = i.payload as LarPayload | undefined; if (!p) throw new RangeError("payload (LarPayload) is required");
      const loanId = loanOf(i, ctx); const servicer = str(i, "servicer_number") || "000000000", fnmaLoan = str(i, "fnma_loan_number") || "0000000000";
      // rule 1: the canonical `investor_events` row is created here when the source command did not (cashiering creates its own and passes `investor_event_id`); a replay of the same source event returns the existing row
      let created: ReturnType<typeof createInvestorEvent> | null = null;
      if (!str(i, "investor_event_id")) {
        const seq = sequenceAllocator51(rt, loanId);
        const open = Array.isArray(i.open_periods) && i.open_periods.length ? (i.open_periods as string[]) : [activityPeriod51(i, ctx) || periodOf(D(p.action_date))];
        created = createInvestorEvent(ctx.events, seq, { loan_id: loanId, servicer_number: servicer, fnma_loan_number: fnmaLoan, event_type: eventType, effective_date: (typeof i.effective_date === "string" && isoDate(i.effective_date) ? D(i.effective_date) : p.action_date), processed_at_ms: processedMs, payload: p, mode, open_periods: open,
          ...(typeof i.source_loan_event_id === "string" && i.source_loan_event_id ? { source_loan_event_id: i.source_loan_event_id } : {}), ...(typeof i.supersedes_event_id === "string" && i.supersedes_event_id ? { supersedes_event_id: i.supersedes_event_id } : {}), ...(flag(i, "deferral_pending") ? { deferral_pending: true } : {}), actor: ctx.actor });
        rt.store.put("investor_loan_sequences", loanId, { next_sequence: seq.peek(loanId) }, ctx.actor, ctx.now);
      }
      const lar = projectLar96(servicer, fnmaLoan, p);
      const due = larDeadlineMs(processedMs, family === "removal");
      const eventId = created?.event_id ?? str(i, "investor_event_id");
      ctx.events.append({ type: "investor_events.projected", loanId, aggregate: { kind: "investor_event", id: eventId }, actor: ctx.actor, payload: { event_id: eventId, event_type: eventType, family, mode, activity_period: created?.activity_period ?? (activityPeriod51(i, ctx) || null), per_loan_sequence: created?.per_loan_sequence ?? null, record: lar.record, processed_at: new Date(processedMs).toISOString(), due_at: new Date(due).toISOString(), status: "projected" } });
      return { ...lar, family, due_at_ms: due, validation: validateLar80(lar.record), event_id: eventId, ...(created ? { activity_period: created.activity_period, per_loan_sequence: created.per_loan_sequence, idempotency_key: created.idempotency_key, replayed: created.replayed } : {}) };
    }),
    guardrails: [never("NO_DIRECT_LEDGER", "5.1 guardrail: cannot alter ledger balances directly — Section 2 correction commands post the reversing entries", (i) => flag(i, "adjust_ledger"), "issue a cashiering correction command instead"),
      never("NO_ACCEPT_WITHOUT_RESPONSE", "5.1 guardrail: cannot mark an event `accepted` without a parsed Fannie Mae response", (i) => str(i, "set_status") === "accepted" && !flag(i, "fnma_response_parsed"), "acceptance is written from the parsed feedback only"),
      noPostCloseRemovalCorrection51, humanWhen("ROOT_CAUSE_CONFIDENCE", "5.1 guardrail: confidence < 0.8 on root cause → hold and escalate", (i) => typeof i.root_cause === "string" && num(i, "confidence") < 0.8, "root-cause confidence below 0.8: hold and escalate")] },
  { name: "validateLar80", kind: "read", handler: compute((i) => { need(i, "record"); const errors = validateLar80(str(i, "record")); return { ok: errors.length === 0, errors }; }) },
  { name: "validateSeJson", kind: "read", handler: compute((i) => { const p = i.payload as LarPayload | undefined; if (!p) throw new RangeError("payload is required");
      const expected: ExpectedPosition = { upb_cents: cents(i.expected_upb_cents), lpi_date: (i.expected_lpi_date as PlainDate | null | undefined) ?? null, ...(i.expected_nib_cents !== undefined && i.expected_nib_cents !== null ? { nib_cents: cents(i.expected_nib_cents) } : {}), ...(typeof i.participation_pct === "string" ? { participation_pct: i.participation_pct } : {}) };
      const errs = prevalidate(p, expected, date(i, "today"), (i.last_accepted_effective as PlainDate | null | undefined) ?? null);
      const names = ["Loan Servicer Transaction Effective Date", "Loan Servicer Transaction Processed Date", "Loan Last Paid Installment Due Date", "Loan Actual UPB Amount", "Loan Non-Interest Bearing Balance Amount", "Loan Suspense Balance Amount", "Loan Interest Rate", "Loan Lender Pass Through Rate", "Loan Principal and Interest Payment Amount", "Loan Event Sequence Number"];
      return { ok: errs.length === 0, errors: errs, schema_fields: names }; }) },
]);

// ---- 5.2 remittance of P&I -------------------------------------------------
// Process-owned: every 5.2 tool (buildCrsBatch, openPortalTask, pullDraftNotifications, matchBankDebits, explainVariance,
// postLedger, recordDecision) lives in ./section5-2.ts (TOOLS_5_2, spread by ./index.ts) over src/domain/investor/ops-5-2.ts.
const p52: readonly ToolDef[] = [];

// ---- 5.3 liquidations -------------------------------------------------------
// Process-owned: every 5.3 tool (selectLiquidationCode, computeRemovalAmounts, projectEvent, buildCrsBatch, draftCpmNotice,
// recordDecision, prepareReogramPackage, reconcileDra) lives in ./section5-3.ts (TOOLS_5_3, spread by ./index.ts) over
// src/domain/investor/ops-5-3.ts — the guardrails there read the loan's history (cleared funds, the accepted removal).
const p53: readonly ToolDef[] = [];

// ---- 5.4 Stop Delinquency Advance: moved to ./section5-4.ts (TOOLS_5_4, over src/domain/investor/ops-5-4.ts) ----

// ---- 5.5 guaranty fee relief: moved to ./section5-5.ts (TOOLS_5_5, over src/domain/investor/ops-5-5.ts) ----

// ---- 5.6 repurchases --------------------------------------------------------
const p56 = defineTools("5.6", "investor-reporting", [
  // projectEvent, buildCrsBatch and recordDecision for 5.6 live in ./section5-6.ts (over src/domain/investor/ops-5-6.ts).
  { name: "draftLetter", kind: "write", handler: compute((i) => { need(i, "kind"); return { kind: str(i, "kind"), status: "draft", requires: "officer", package: ["pricing worksheet", "loan history", "eligibility", "alternative analysis"], body: str(i, "body") }; }),
    guardrails: [never("NEVER_COMMITS_PARTNER", "5.6 guardrail: the agent never commits the partner — every offer, acceptance, appeal and payment authorization is an officer escalation", (i) => flag(i, "commit") || flag(i, "send"), "offers/acceptances/appeals/payment authorizations are officer decisions")] },
  { name: "openPortalTask", kind: "act", handler: escalate("officer"), decision: (i) => ({ action: "openPortalTask", rationale: str(i, "reason") || "officer: repurchase package" }) },
]);

// ---- 5.7 delinquent loan status -------------------------------------------
// The 5.7 tools live in ./section5-7.ts (TOOLS_5_7, spread by ./index.ts): buildDqSnapshot, deriveStatusCode,
// validateF121Layout, submitAmnFile, parseExceptionReport, submitDqEvent, checkConsistency, recordDecision.
const p57: readonly ToolDef[] = [];

export const SECTION_05_TOOLS: readonly ToolDef[] = [...p51, ...p52, ...p53, ...p56, ...p57];
