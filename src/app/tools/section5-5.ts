/**
 * §5.5 tools — Guaranty fee relief (`custodial-recon`). Every tool string is one spec/registry/agents.json names for 5.5,
 * via `defineTools("5.5", "custodial-recon", defs)` from ../tools.ts; src/app/tools.test.ts refuses the rest. The
 * section's original 5.5 block moved here from ./section05.ts. Spread by ./index.ts (TOOLS_5_5).
 *
 * The handlers are thin shells over src/domain/investor/ops-5-5.ts (and the calculators in ops.ts), which own the event
 * vocabulary the 5.5 timer rows arm on and are satisfied by. Guardrails read the thing being done, not a caller's
 * description of it: relief status and balances come from the loan's history, the accepted LAR from 5.1's row on the
 * loan, current-ness from `loan.became_current`, the bill from the parsed `draft_notifications` row.
 *   parseGfeeBill: the monthly bill/draft notification validated and parsed into `draft_notifications`
 *     (`draft_type = mbs_gfee`) → `gfee.bill.parsed{draft_type=mbs_gfee}` on 5.1's period aggregate, which satisfies
 *     FNMA_F120_GFEE_BILL_RETRIEVE_CD5 and arms FNMA_F120_GFEE_RELIEF_RECONCILE_BILL;
 *   computeGfeeCheckFigures: rule 1 check figures per loan (prior scheduled UPB × g-fee ÷ 12 ± buy-up/buy-down);
 *   reconcileRelief{op}: default — one loan's relief prediction reconciled at period end (`gfee_relief_status.predicted`
 *     once at four consecutive months, `gfee_relief.reconciled` each time; the sda_status consistency assertion of T2 and
 *     the regular-option divergence of T5); `bill` — every predicted/active relief loan reconciled to the parsed bill
 *     (`gfee_relief.bill_reconciled{all_reconciled}`, the RECONCILE_BILL satisfaction; a relief loan reappearing without
 *     a contractual payment opens an `officer` escalation); with `bill_total_cents` — the bill-level variance (T4,
 *     `officer` above the greater of $500 or 0.5%); `activate` — Fannie Mae's bill zeros/omits the loan
 *     (`gfee_relief_status.active`); `exit` — an F-1-20 exit recorded (`gfee_relief_status.exited{reason}`; "current"
 *     needs the loan's `loan.became_current` fact and arms the resume clock);
 *   fundDraft{op}: default — the CD7 draft funded through the T−1 16:00 ET funding check (`remittances.funded{kind=gfee}`
 *     on the period, the DRAFT_CD7 satisfaction; an uncollected g-fee is a posted `advances(kind=gfee)` transfer);
 *     `resume` — the resumed g-fee draft of a loan that became current, funded through 5.2's funding check on the loan;
 *   matchDebit{op}: `expect_recovery` — the accepted contractual LAR (by `event_id`, from the loan's history) sets the
 *     recovery expectation (`gfee.recovery.expected`, SM_GFEE_RECOVERY_MATCH_2_CYCLES); default — the bill's recovery
 *     draft matched FIFO (`gfee.recovery.matched{kind}`: Fannie Mae recovery, then servicer retention) and the balanced
 *     entry sets posted (Cr `servicer_advance_receivable(gfee)`);
 *   recordDecision: the decision row.
 * Guardrails encode the Agents paragraph: never fund from T&I; `officer` when the bill total differs from the check-figure
 * total by more than the greater of $500 or 0.5%, or when a relief loan reappears on the bill without a contractual
 * payment; the shared 5.2 dual control above $250,000 and the shared 5.4 rule that no advance is funded for a loan Fannie
 * Mae has flagged Stop Advance (SVC-2026-02 removed the g-fee advance for Stop Delinquency Advance loans) — read from the
 * loan the call is about (`loan_id`, else the context loan).
 */
import { defineTools, compute, decision, never, needsRole, humanWhen, guard, cents, str, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { gfeeCheckFigure, fundingDecision } from "../../domain/investor/remittance.ts";
import type { SdaState } from "../../domain/investor/sda.ts";
import type { RemittanceType } from "../../domain/investor/types.ts";
import { gfeeBillLine, gfeeBillVariance } from "../../domain/investor/ops.ts";
import { sdaStatusFromEvents } from "../../domain/investor/ops-5-4.ts";
import type { Cycle } from "../../domain/investor/ops-5-2.ts";
import { parseGfeeBill, fundGfeeDraft, predictGfeeRelief, activateGfeeRelief, reconcileReliefToBill, expectGfeeRecovery, matchGfeeRecoveryDebit, recordGfeeReliefExit, resumeGfeeDraft, RULE_SET_VERSION_5_5, type Emitter, type GfeeBillRow, type GfeeReliefExitReason } from "../../domain/investor/ops-5-5.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const em = (ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const optCents = (i: ToolInput, k: string): { [key: string]: bigint } => (i[k] === undefined || i[k] === null ? {} : { [k]: cents(i[k]) });
const TI = /custodial_ti|ti_custodial|escrow/i;
/** Stop Advance as Fannie Mae reported it, from the loan's `sda_status.*` history (5.4 state machine: `active` is set only from Fannie Mae data). */
const sdaActive = (ctx: CommandContext, loanId: string): boolean => sdaStatusFromEvents(ctx.events.byLoan(loanId)).status === "active";
const recordDecision: Omit<ToolDef, "process" | "agent"> = { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) };
const billVariance = (i: ToolInput) => gfeeBillVariance({ bill_total_cents: cents(i.bill_total_cents), computed_total_cents: cents(i.computed_total_cents), per_loan: Array.isArray(i.per_loan) ? rows<{ loan_id: string; bill_cents: bigint; computed_cents: bigint }>(i, "per_loan") : [] });

export const TOOLS_5_5: readonly ToolDef[] = defineTools("5.5", "custodial-recon", [
  { name: "parseGfeeBill", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_5, handler: compute((i, ctx, rt) => {
      need(i, "servicer_number", "period");
      const bill = parseGfeeBill(em(ctx), { servicer_number: str(i, "servicer_number"), period: str(i, "period"), lines: rows<{ fnma_loan_number: string; loan_id?: string | null; amount_cents: bigint }>(i, "lines"), source: typeof i.source === "string" ? i.source : null, document_id: typeof i.document_id === "string" ? i.document_id : null, notification_id: typeof i.notification_id === "string" ? i.notification_id : null });
      const { subject: _subject, ...row } = bill;
      rt.store.put("draft_notifications", bill.notification_id, { ...row, lines: row.lines.map((l) => ({ ...l })), zero_lines: [...row.zero_lines], status: "parsed", parsed_at: ctx.now }, ctx.actor, ctx.now);
      return { ...row, total_cents: bill.amount_cents, subject: bill.subject }; }) },
  { name: "computeGfeeCheckFigures", kind: "read", handler: compute((i) => rows<{ fnma_loan_number: string; prior_scheduled_upb_cents: bigint; gfee_pct: string; adjustment_cents?: bigint }>(i, "loans").map((l) => ({ fnma_loan_number: l.fnma_loan_number, check_figure_cents: gfeeBillLine(l.prior_scheduled_upb_cents, l.gfee_pct, l.adjustment_cents ?? 0n), base_cents: gfeeCheckFigure(l.prior_scheduled_upb_cents, l.gfee_pct) }))) },
  { name: "reconcileRelief", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_5, handler: compute((i, ctx, rt) => {
      const loanId = loanOf(i, ctx);
      if (i.op === "bill") { need(i, "notification_id"); const rec = rt.store.require("draft_notifications", str(i, "notification_id")).data as unknown as Omit<GfeeBillRow, "subject">;
        if (rec.draft_type !== "mbs_gfee") throw new RangeError(`draft notification ${str(i, "notification_id")} is not an MBS guaranty-fee bill`);
        const r = reconcileReliefToBill(em(ctx), { ...rec, subject: { kind: "period", id: `${rec.servicer_number}:${rec.period}` } });
        rt.store.put("draft_notifications", rec.notification_id, { status: r.all_reconciled ? "reconciled" : "variance", relief_reconciled_at: ctx.now, relief_variances: [...r.variances] }, ctx.actor, ctx.now);
        const escalations = r.variances.map((loan) => rt.escalations.open({ kind: "officer", loanId: loan, severity: "sev2", payload: { reason: "relief loan reappeared on the g-fee bill without a contractual payment", period: r.period, notification_id: r.notification_id, bill_line_cents: r.relief_loans.find((l) => l.loan_id === loan)?.bill_line_cents ?? 0n } }, ctx.actor).id);
        return { ...r, escalations }; }
      if (i.op === "activate") { need(i, "period", "fnma_start_date"); return activateGfeeRelief(em(ctx), { loan_id: loanId, period: str(i, "period"), bill_line_cents: i.bill_line_cents === undefined || i.bill_line_cents === null ? null : cents(i.bill_line_cents), fnma_start_date: date(i, "fnma_start_date"), ...optCents(i, "outstanding_fnma_gfee_cents"), ...optCents(i, "servicer_gfee_advances_cents") }); }
      if (i.op === "exit") { need(i, "reason"); return recordGfeeReliefExit(em(ctx), { loan_id: loanId, reason: str(i, "reason") as GfeeReliefExitReason, exited_on: typeof i.exited_on === "string" && i.exited_on ? D(i.exited_on) : null }); }
      if (i.bill_total_cents !== undefined) return billVariance(i);
      return predictGfeeRelief(em(ctx), { loan_id: loanId, lpi: date(i, "lpi"), period_end: date(i, "period_end"), type: (str(i, "type") || "SS") as RemittanceType, option: (str(i, "option") || "special") as "special" | "regular", sda_status: (str(i, "sda_status") || "not_applicable") as SdaState["status"], bill_line_cents: cents(i.bill_line_cents), ...optCents(i, "servicer_gfee_advances_cents") }); }),
    guardrails: [humanWhen("BILL_VARIANCE_OFFICER", "5.5 guardrail: bill total differs from the check-figure total by more than the greater of $500 or 0.5% → officer", (i) => i.bill_total_cents !== undefined && billVariance(i).escalation === "officer", "systemic PTR/UPB variance: officer review"),
      humanWhen("RELIEF_LOAN_REAPPEARED", "5.5 guardrail: a relief loan reappearing on the bill without a contractual payment → officer", (i) => flag(i, "relief_loan_on_bill") && !flag(i, "contractual_payment_reported"), "relief loan billed without a contractual payment")] },
  { name: "fundDraft", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_5, handler: compute((i, ctx) => { need(i, "draft_date"); const loanId = loanOf(i, ctx);
      if (i.op === "resume") { need(i, "period", "custodial_account_id"); const r = resumeGfeeDraft(em(ctx), { loan_id: loanId, period: str(i, "period"), ...(i.cycle ? { cycle: str(i, "cycle") as Cycle } : {}), draft_date: date(i, "draft_date"), expected_draft_cents: cents(i.expected_draft_cents), custodial_available_cents: cents(i.custodial_available_cents), facility_available_cents: cents(i.facility_available_cents), custodial_account_id: str(i, "custodial_account_id"), at_ms: Date.parse(str(i, "now") || ctx.now) });
        if (r.entry_set) ctx.ledger.post(r.entry_set, ctx.now); return { ...r, source_account: str(i, "source_account") || "corporate" }; }
      need(i, "servicer_number");
      const r = fundGfeeDraft(em(ctx), { servicer_number: str(i, "servicer_number"), period: typeof i.period === "string" && i.period ? i.period : null, draft_date: date(i, "draft_date"), expected_draft_cents: cents(i.expected_draft_cents), custodial_available_cents: cents(i.custodial_available_cents), facility_available_cents: cents(i.facility_available_cents), custodial_account_id: typeof i.custodial_account_id === "string" && i.custodial_account_id ? i.custodial_account_id : null, loan_id: loanId, at_ms: Date.parse(str(i, "now") || ctx.now) });
      if (r.entry_set) ctx.ledger.post(r.entry_set, ctx.now);
      return { ...r.advance, ...r, source_account: str(i, "source_account") || "corporate" }; }), moneyFields: ["expected_draft_cents"],
    guardrails: [never("NO_TI_FUNDING", "5.5 guardrail: never fund from T&I", (i) => TI.test(str(i, "source_account")), "g-fee drafts are never funded from the T&I custodial account"),
      needsRole("DUAL_CONTROL_250K", "5.2 guardrail (shared): transfer > $250,000 requires officer approval", (i) => fundingDecision(cents(i.expected_draft_cents), cents(i.custodial_available_cents)).dual_control, ["officer"], "dual control on the corporate advance"),
      // SVC-2026-02 (5.5 verified requirement): "removed … the residual requirement to advance guaranty fees for loans in the Stop Delinquency Advance process" — the loan is the one the call is about, not only an explicit `loan_id`.
      guard("NO_ADVANCE_ON_STOP_ADVANCE", "5.4 guardrail (shared): never fund an advance for a loan Fannie Mae has flagged Stop Advance", (i, ctx) => (fundingDecision(cents(i.expected_draft_cents), cents(i.custodial_available_cents)).advance && sdaActive(ctx, loanOf(i, ctx)) ? "Fannie Mae has set Stop Advance for the loan: no g-fee advance is funded (SVC-2026-02)" : undefined))] },
  { name: "matchDebit", kind: "write", ruleSetVersion: RULE_SET_VERSION_5_5, handler: compute((i, ctx) => { const loanId = loanOf(i, ctx);
      if (i.op === "expect_recovery") { need(i, "event_id"); return expectGfeeRecovery(em(ctx), { loan_id: loanId, event_id: str(i, "event_id"), payment_gfees_cents: rows<bigint>(i, "payment_gfees_cents").map((g) => cents(g)) }); }
      need(i, "debit_cents", "custodial_account_id");
      const r = matchGfeeRecoveryDebit(em(ctx), { loan_id: loanId, debit_cents: cents(i.debit_cents), payment_gfees_cents: rows<bigint>(i, "payment_gfees_cents").map((g) => cents(g)), custodial_account_id: str(i, "custodial_account_id"), debit_id: typeof i.debit_id === "string" ? i.debit_id : null, settled_on: typeof i.settled_on === "string" ? D(i.settled_on) : null });
      const posted = r.entry_sets.map((set) => ctx.ledger.post(set, ctx.now).id);
      return { ...r, posted_entry_sets: posted }; }) },
  recordDecision,
]);
