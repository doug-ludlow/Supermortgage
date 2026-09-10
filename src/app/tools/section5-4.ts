/**
 * §5.4 tools — Stop Delinquency Advance handling (`custodial-recon`). Every tool string is one spec/registry/agents.json
 * names for 5.4, via `defineTools("5.4", "custodial-recon", defs)` from ../tools.ts; src/app/tools.test.ts refuses the
 * rest. The section's original 5.4 block moved here from ./section05.ts. Spread by ./index.ts (TOOLS_5_4).
 *
 * The handlers are thin shells over src/domain/investor/ops-5-4.ts, which owns the event vocabulary the 5.4 timer rows
 * arm on and are satisfied by:
 *   predictSdaEntry{op}: default — one loan's prediction (rule 2) with the T1 entry model; `period_end` — the period-end
 *     run over every special-servicing S/S loan (→ `sda_status.predicted` set / `sda_status.prediction_cleared`,
 *     `reclass.selection.expected` for regular servicing option loans at six months, the period-level
 *     `sda_status.predicted{scope=period}` that satisfies FNMA_C301_SDA_PREDICT_EOM);
 *   parseRemittanceDetail{op}: default — Remittance Detail – P&I lines parsed (T2: Stop Advance credits → `fm_pi_receivable`
 *     delta); `ingest` — an inbound Fannie Mae Connect report validated and posted (`fnma.connect.report.available{report}`;
 *     the deselection report also posts the CD11 task per loan); `purchase_advice` — a reclass/repurchase purchase advice
 *     (`fnma.purchase_advice.received{kind}`);
 *   rollForwardReceivables{op}: default — one loan's receivable roll-forward with the T6 status variance; `reconcile` — the
 *     BD3 reconciliation of every predicted/active loan against the report (`sda_status.active` only from Fannie Mae data,
 *     sev-2 variances opened, `sda_status.reconciled{all_reconciled=true}`); `contractual_payment` — full contractual
 *     payments applied on an SDA loan (`sda.contractual_payment.applied`, the next-BD 20:00 ET LAR clock); `exit` — an
 *     F-1-20 exit recorded (`sda_status.exited{reason}`); `resume_draft` — the resumed scheduled draft funded through
 *     5.2's funding check;
 *   matchAdjustments{op}: `expect_recovery` — the accepted contractual LAR sets the recovery expectation
 *     (`sda.recovery.expected`); `recovery_draft` (or `recovery_cents`) — Fannie Mae's recovery draft / servicer retention
 *     matched (`sda.adjustment.matched{kind}`, the held P&I released once the debit settled); default — reimbursement
 *     credits matched FIFO to `advances` rows (`advances.reimbursed_by_fnma{all_outstanding=true}` or the IRR package to
 *     `officer` after two cycles);
 *   buildForm496Line12: Section II line 12 from Fannie Mae-reported receivables (rule 6);
 *   openPortalTask{op}: default — the `fnma_portal_operator` work item; `deselection` — the F-1-25 deselection decision
 *     recorded (`reclass.deselection.decided`), a `human_portal_task` opened when deselecting;
 *   recordDecision: the decision row.
 * Guardrails encode the Agents paragraph: never fund an advance for a loan Fannie Mae has flagged Stop Advance; never
 * release custodial P&I collected on an SDA loan before Fannie Mae's recovery draft settles; `officer` when unreimbursed
 * advances exceed $25,000 per loan or 60 days after an exit.
 */
import { defineTools, compute, decision, guard, humanWhen, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { ScheduledMonth } from "../../domain/investor/remittance.ts";
import { predictSda, applyRecovery, type SdaState } from "../../domain/investor/sda.ts";
import { sdaStatusVariance, form496Line12, type AdvanceRow } from "../../domain/investor/ops.ts";
import type { RemittanceType } from "../../domain/investor/types.ts";
import type { Cycle } from "../../domain/investor/ops-5-2.ts";
import {
  sdaEntryModel, predictSdaEntries, validateConnectReport, ingestConnectReport, reconcileSdaReport, recordSdaContractualPayment, expectSdaRecovery, matchRecoveryDraft, recordSdaExit, resumeScheduledDraft, matchReimbursementCredits,
  bookDelinquencyAdvances, validatePurchaseAdvice, ingestPurchaseAdvice, recordDeselectionDecision, sdaStatusFromEvents, RULE_SET_VERSION_5_4,
  type Emitter, type EomLoanFacts, type SdaReconcileLoan, type AppliedInstallment, type AcceptedContractualLar, type SdaExitReason, type Subject, type AdvanceDraft,
} from "../../domain/investor/ops-5-4.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const em = (ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const stateOf = (i: ToolInput): SdaState => { const st = i.state as SdaState | undefined; if (!st) throw new RangeError("state (SdaState) is required"); return st; };
const sdaFacts = (i: ToolInput) => ({ lpi: date(i, "lpi"), type: (str(i, "type") || "SS") as RemittanceType, option: (str(i, "option") || "special") as "special" | "regular", period_end: date(i, "period_end") });

// ---- guardrails: Stop Advance as Fannie Mae reported it, read back from the loan's event history --------------------------
const sdaActive = (ctx: CommandContext, loanId: string): boolean => sdaStatusFromEvents(ctx.events.byLoan(loanId)).status === "active";
const recoveryDraftSettled = (ctx: CommandContext, loanId: string): boolean => ctx.events.byLoan(loanId).some((e) => e.type === "remittances.drafted" && (e.payload as { sda_recovery?: unknown }).sda_recovery === true);
interface AnyLine { readonly account?: { readonly scope?: string; readonly account?: string }; readonly amountCents?: unknown }
const linesOf = (i: ToolInput): AnyLine[] => { const s = i.entry_set as { lines?: unknown } | undefined; return Array.isArray(s?.lines) ? (s.lines as AnyLine[]) : []; };
const acct = (l: AnyLine): string => String(l.account?.account ?? "");
const amt = (l: AnyLine): bigint => { try { return cents(l.amountCents); } catch { return 0n; } };
const CORPORATE = /corporate|servicer_advance|servicing_fee_income|gfee_payable|transfer_clearing/i;
const scopeOf = (l: AnyLine): "custodial" | "corporate" | "loan" => (l.account?.scope === "custodial" || l.account?.scope === "corporate" ? l.account.scope : /custodial/i.test(acct(l)) ? "custodial" : CORPORATE.test(acct(l)) ? "corporate" : "loan");
const holdPiUntilRecoveryDraft = guard("HOLD_PI_UNTIL_RECOVERY_DRAFT", "5.4 guardrail: never release custodial P&I collected on an SDA loan before Fannie Mae's recovery draft settles", (i, ctx) => {
  const ls = linesOf(i); const release = ls.some((l) => /custodial_pi/i.test(acct(l)) && amt(l) < 0n) && ls.some((l) => scopeOf(l) === "corporate" && amt(l) > 0n);
  const loan = loanOf(i, ctx);
  return release && sdaActive(ctx, loan) && !recoveryDraftSettled(ctx, loan) ? "collected P&I stays in custodial_pi_cash until Fannie Mae's Stop Advance recovery draft settles" : undefined;
});
/** Reads the thing being done (an advance booked / funded for the loan) against the loan's event history — never a caller's `fnma_status` label. */
const noAdvanceOnStopAdvance = guard("NO_ADVANCE_ON_STOP_ADVANCE", "5.4 guardrail: never fund an advance for a loan Fannie Mae has flagged Stop Advance", (i, ctx) => {
  const fund = flag(i, "fund_advance") || i.op === "book_advances" || (i.op === "resume_draft" && cents(i.expected_draft_cents) > cents(i.custodial_available_cents));
  return fund && sdaActive(ctx, loanOf(i, ctx)) ? "Fannie Mae has set Stop Advance for the loan: no delinquency advance is funded (F-1-20)" : undefined;
});
const unreimbursedToOfficer = humanWhen("UNREIMBURSED_25K_OR_60D", "5.4 guardrail: escalate to officer when unreimbursed advances exceed $25,000 per loan or 60 days after an exit", (i) => cents(i.unreimbursed_cents) > 2_500_000n || num(i, "days_since_exit") > 60, "unreimbursed advances beyond $25,000 or 60 days after exit: officer");
const recordDecision: Omit<ToolDef, "process" | "agent"> = { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) };
const subjectOf = (i: ToolInput): Subject | undefined => { const s = i.period_subject as { kind?: unknown; id?: unknown } | undefined; return s && typeof s.kind === "string" && typeof s.id === "string" ? { kind: s.kind, id: s.id } : undefined; };

export const TOOLS_5_4: readonly ToolDef[] = defineTools("5.4", "custodial-recon", [
  { name: "predictSdaEntry", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_4, handler: compute((i, ctx) => {
      if (i.op === "period_end") { const subject = subjectOf(i); return predictSdaEntries(em(ctx), { period_end: date(i, "period_end"), loans: rows<EomLoanFacts>(i, "loans"), ...(str(i, "servicer_number") ? { servicer_number: str(i, "servicer_number") } : {}), ...(subject ? { period_subject: subject } : {}) }); }
      const f = sdaFacts(i); const st = predictSda(f.lpi, f.type, f.option, f.period_end);
      return { ...st, entry_model: st.predicted_entry_period ? sdaEntryModel(st.predicted_entry_period) : null }; }) },
  { name: "parseRemittanceDetail", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_4, handler: compute((i, ctx) => {
      if (i.op === "ingest") { need(i, "report"); return ingestConnectReport(em(ctx), validateConnectReport(i.report as Record<string, unknown>)); }
      if (i.op === "purchase_advice") { need(i, "advice"); return ingestPurchaseAdvice(em(ctx), validatePurchaseAdvice(i.advice as Record<string, unknown>)); }
      const lines = rows<{ fnma_loan_number: string; expected_pi_cents: bigint; stop_advance_credit_cents?: bigint; recovery_cents?: bigint }>(i, "lines"); if (!lines.length) throw new RangeError("lines are required");
      return lines.map((l) => ({ fnma_loan_number: l.fnma_loan_number, expected_pi_cents: l.expected_pi_cents, stop_advance_credit_cents: l.stop_advance_credit_cents ?? 0n, recovery_cents: l.recovery_cents ?? 0n, net_cents: l.expected_pi_cents - (l.stop_advance_credit_cents ?? 0n) - (l.recovery_cents ?? 0n), fm_pi_receivable_delta_cents: l.stop_advance_credit_cents ?? 0n })); }) },
  { name: "rollForwardReceivables", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_4, handler: compute((i, ctx, rt) => {
      const loanId = loanOf(i, ctx);
      if (i.op === "reconcile") { need(i, "report_id", "period"); const r = reconcileSdaReport(em(ctx), { report_id: str(i, "report_id"), period: str(i, "period"), loans: rows<SdaReconcileLoan>(i, "loans") });
        const escalations = r.variances.map((d) => rt.escalations.open({ kind: "sev2", loanId: d.loan_id, severity: "sev2", payload: { reason: `Stop Advance status variance (${d.variance!.kind}): ours ${d.predicted_status} (${d.variance!.our_lpi}), Fannie Mae ${d.fnma_status} (${d.variance!.fnma_lpi ?? "no LPI"})`, report_id: str(i, "report_id"), period: str(i, "period"), our_lpi: d.variance!.our_lpi, fnma_lpi: d.variance!.fnma_lpi, receivable_variance_cents: d.variance!.receivable_variance_cents, reporting_history: (rows<SdaReconcileLoan>(i, "loans").find((l) => l.loan_id === d.loan_id)?.reporting_history ?? []) as unknown as Record<string, unknown>[] } }, ctx.actor).id);
        return { ...r, escalations }; }
      if (i.op === "book_advances") { need(i, "custodial_account_id", "funded_from"); const drafts = rows<{ period: string; draft_date: string; amount_cents: unknown }>(i, "drafts").map((d): AdvanceDraft => ({ period: String(d.period), draft_date: D(String(d.draft_date)), amount_cents: cents(d.amount_cents) }));
        const r = bookDelinquencyAdvances(em(ctx), { loan_id: loanId, custodial_account_id: str(i, "custodial_account_id"), funded_from: str(i, "funded_from") as "partner_line" | "supermortgage_corporate", drafts, ...(str(i, "cycle") ? { cycle: str(i, "cycle") as Cycle } : {}) });
        const posted = r.entry_sets.map((s) => ctx.ledger.post(s, ctx.now).id); return { ...r, entry_set_ids: posted }; }
      if (i.op === "contractual_payment") { return recordSdaContractualPayment(em(ctx), { loan_id: loanId, state: stateOf(i), pi_cents: cents(i.pi_cents), lpi_before: date(i, "lpi_before"), installments: rows<AppliedInstallment>(i, "installments") }); }
      if (i.op === "exit") { need(i, "reason"); const payoff = i.payoff as { payoff_upb_cents: bigint; payoff_interest_cents: bigint; proceeds_cents: bigint } | undefined;
        return recordSdaExit(em(ctx), { loan_id: loanId, state: stateOf(i), reason: str(i, "reason") as SdaExitReason, exited_on: date(i, "exited_on"), ...(payoff ? { payoff: { payoff_upb_cents: cents(payoff.payoff_upb_cents), payoff_interest_cents: cents(payoff.payoff_interest_cents), proceeds_cents: cents(payoff.proceeds_cents) } } : {}) }); }
      if (i.op === "resume_draft") { need(i, "period", "draft_date", "custodial_account_id"); const r = resumeScheduledDraft(em(ctx), { loan_id: loanId, period: str(i, "period"), cycle: (str(i, "cycle") || "standard") as Cycle, draft_date: date(i, "draft_date"), expected_draft_cents: cents(i.expected_draft_cents), custodial_available_cents: cents(i.custodial_available_cents), facility_available_cents: cents(i.facility_available_cents), custodial_account_id: str(i, "custodial_account_id"), at_ms: Date.parse(str(i, "now") || ctx.now) });
        if (r.entry_set) ctx.ledger.post(r.entry_set, ctx.now); return r; }
      const st = stateOf(i); const delta = cents(i.fm_pi_receivable_delta_cents);
      const v = sdaStatusVariance({ predicted: st.status, predicted_months: num(i, "predicted_months") || 0, fnma_status: (str(i, "fnma_status") || "advancing") as "stop_advance" | "advancing", our_lpi: date(i, "our_lpi"), fnma_lpi: (i.fnma_lpi as PlainDate | null | undefined) ?? null, reporting_history: Array.isArray(i.reporting_history) ? (i.reporting_history as { period: string; lpi: PlainDate; status: string }[]) : [] });
      ctx.events.append({ type: "sda.reconciled", loanId, actor: ctx.actor, payload: { fnma_status: str(i, "fnma_status") || "advancing", variance: v.variance ? v.variance.kind : null, fm_pi_receivable_cents: st.fm_pi_receivable_cents + delta } });
      if (v.variance) rt.escalations.open({ kind: "sev2", loanId, severity: "sev2", payload: { reason: `Stop Advance status variance: ours ${st.status} (${v.variance.predicted_months} months, LPI ${v.variance.our_lpi}), Fannie Mae ${str(i, "fnma_status")} (LPI ${v.variance.fnma_lpi ?? "unknown"})`, reporting_history: v.variance.reporting_history as unknown as Record<string, unknown>[] } }, ctx.actor);
      return { fm_pi_receivable_cents: st.fm_pi_receivable_cents + delta, servicer_advances_outstanding_cents: st.servicer_advances_outstanding_cents, ...v }; }),
    moneyFields: ["expected_draft_cents"], guardrails: [noAdvanceOnStopAdvance, unreimbursedToOfficer] },
  { name: "matchAdjustments", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_4, handler: compute((i, ctx, rt) => {
      const loanId = loanOf(i, ctx);
      if (i.op === "expect_recovery") { need(i, "accepted"); return expectSdaRecovery(em(ctx), { loan_id: loanId, state: stateOf(i), accepted: i.accepted as AcceptedContractualLar, cleared_periods: rows<ScheduledMonth>(i, "cleared_periods") }); }
      if (i.op === "recovery_draft" || i.recovery_cents !== undefined) { const st = stateOf(i);
        if (i.op !== "recovery_draft" && !i.debit_id) { const r = applyRecovery(st, cents(i.recovery_cents)); ctx.events.append({ type: "sda.adjustment.matched", loanId, actor: ctx.actor, payload: { kind: r.to_fnma_receivable_cents > 0n ? "fnma_recovery" : "servicer_retention", to_fnma_receivable_cents: r.to_fnma_receivable_cents, to_servicer_advances_cents: r.to_servicer_advances_cents, fm_pi_receivable_after_cents: st.fm_pi_receivable_cents } }); return r; }
        return matchRecoveryDraft(em(ctx), { loan_id: loanId, state: st, draft_cents: cents(i.draft_cents ?? i.recovery_cents), debit_id: (i.debit_id as string | undefined) ?? null, settled_on: i.settled_on ? date(i, "settled_on") : null, report_line_id: (i.report_line_id as string | undefined) ?? null }); }
      const m = matchReimbursementCredits(em(ctx), { loan_id: loanId, advances: rows<AdvanceRow>(i, "advances"), credits: rows<bigint>(i, "credits").map(cents), cycles_elapsed: num(i, "cycles_elapsed") || 0, exit_reason: (str(i, "exit_reason") || null) as SdaExitReason | null, report_line_ids: Array.isArray(i.report_line_ids) ? (i.report_line_ids as string[]) : [] });
      const escalation = m.escalation === "irr_package" ? rt.escalations.open({ kind: "officer", loanId, severity: "sev2", payload: { reason: "Investor Reporting Representative package: delinquency advances not reimbursed within two draft cycles of the exit", package: "irr_package", exit_reason: str(i, "exit_reason") || null, outstanding_periods: m.advances.filter((a) => a.status === "outstanding").map((a) => a.period), outstanding_cents: m.advances.filter((a) => a.status === "outstanding").reduce((s, a) => s + a.amount_cents, 0n), credited_cents: m.credited_cents, cycles_elapsed: num(i, "cycles_elapsed") || 0 } }, ctx.actor).id : null;
      return { ...m, escalation_id: escalation }; }),
    guardrails: [holdPiUntilRecoveryDraft] },
  { name: "buildForm496Line12", kind: "read", handler: compute((i) => { const r = rows<{ loan_id: string; sda_status: SdaState["status"]; fm_pi_receivable_reported_cents: bigint }>(i, "rows"); if (!r.length) throw new RangeError("rows are required"); return form496Line12(r); }) },
  { name: "openPortalTask", kind: "act", ruleSetVersion: RULE_SET_VERSION_5_4, handler: compute((i, ctx, rt) => {
      if (i.op === "deselection") { need(i, "report_id", "decision"); const loanId = loanOf(i, ctx);
        const r = recordDeselectionDecision(em(ctx), { loan_id: loanId, report_id: str(i, "report_id"), decision: str(i, "decision") as "deselect" | "keep", decided_on: date(i, "decided_on"), rationale: str(i, "rationale") || str(i, "reason") });
        const task = r.portal_task ? rt.escalations.open({ kind: "human_portal_task", loanId, payload: { reason: "Eligible for Deselection: enter the deselection in Fannie Mae Connect by CD15 (F-1-25)", report_id: str(i, "report_id"), decided_on: str(i, "decided_on") } }, ctx.actor) : null;
        return { ...r, task_id: task?.id ?? null }; }
      return rt.escalations.open({ kind: "human_portal_task", loanId: loanOf(i, ctx), payload: (i.payload as Record<string, unknown> | undefined) ?? { reason: i.reason ?? null } }, ctx.actor); }),
    decision: (i) => ({ action: i.op === "deselection" ? "deselection_decision" : "openPortalTask", rationale: str(i, "rationale") || str(i, "reason") || "fnma_portal_operator: report pull or deselection entry" }) },
  recordDecision,
]);
