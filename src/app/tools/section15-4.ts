/**
 * §15.4 tools — delinquency (P&I) advance recovery (`custodial-recon`). Every tool string is the spec's
 * verbatim, via `defineTools("15.4", "custodial-recon", defs)` from ../tools.ts (see section13.ts). Spread by ./section15.ts.
 *
 * Guardrails encode the Agents paragraph: never fund an advance on a Stop Advance loan (5.4 — an `advances` row drafted
 * on or after the Stop Advance start date, from the input or the loan's own `sda_status.*` history, is refused by the
 * position recompute); never book a recovery without a report-line reference; never write off without `officer` approval;
 * never net Fannie Mae's SDA receivable against our advances (a netted, negative receivable is refused too); an S/S special
 * servicing loan liquidated with a zero expectation is flagged (data error). Escalations: `fnma_portal_operator` (report
 * pulls); `officer` (write-offs > $500/loan; disputes at 60 days; E-3.5-01 removal decisions with 5.6).
 *
 * Events the 15.4 timers arm on / are satisfied by (timers-15-4.ts, and the 5.3/5.4 rows the spec's timer table reuses):
 * `schedule.tick{cadence=daily, at=00:30, job=deladv-position-sweep}` and `delinquency_advance_positions.written`
 * (`recomputeAdvancePosition`); `liquidation_facts.processed{processed_at}` (`setRecoveryExpectation` stage=processed — the
 * 5.3 LAR clock, satisfied by 5.3's `investor_events.submitted`); `foreclosure.sale.scheduled{mbs_regular_servicing, sale_at}`
 * (`setRecoveryExpectation` event=pre_fcl_removal — the E-3.5-01 gate); `advance_position.expectation_set{expected_recovery_event,
 * accepted_on, remittance_type, advances_outstanding}` and `sda_status.exited{reason, exited_on}` (`setRecoveryExpectation` on
 * an accepted exit); `advance_recoveries.booked{source, kind}`, `advances.reimbursed_by_fnma{all_outstanding=true}` and
 * `advance_position.closed{reason}` (`postRecoveryEntries`).
 */
import { defineTools, compute, decision, never, guard, needsRole, cents, str, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import { matchReimbursement } from "../../domain/reo/advances.ts";
import { advancePosition, advancesFundedDuringSda, sdaStatusFromEvents, positionSweepDue, positionSweepTick, recoveryExpectation, saMonth4Recovery, sdaExit, liquidationProcessed, saleScheduled, parseCashAdjustmentLines, openAdvances, outstandingCents, recoveryLedger, reversalLedger, entryLines, irrPackage, agingReport, writeOffDecision, type AdvanceRow, type AdvanceKind, type ExitEvent, type RemittanceType, type ServicingOption, type SdaStatus, type ExpectedRecoveryEvent, type CashAdjustmentLine, type RecoverySource, type PositionStatus } from "../../domain/reo/ops-15-4.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const given = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const advances = (i: ToolInput): AdvanceRow[] => (Array.isArray(i.advances) ? (i.advances as AdvanceRow[]) : []);
const loanOf = (i: ToolInput, ctx: CommandContext): string => str(i, "loan_id") || ctx.loanId || "";
const SERVICING_OPTIONS: ReadonlySet<string> = new Set(["special", "regular_mbs", "portfolio"]);
const servicingOption = (i: ToolInput): ServicingOption | null => { const v = str(i, "servicing_option"); if (!v) return null; if (!SERVICING_OPTIONS.has(v)) throw new RangeError(`servicing_option ${v} is not one of special/regular_mbs/portfolio`); return v as ServicingOption; };
/** Stop Advance status and start date: the caller's facts when given, else the loan's own `sda_status.*` history (5.4: `active` is set only from Fannie Mae data). */
const sdaOf = (i: ToolInput, ctx: CommandContext): { status: SdaStatus; start_date: PlainDate | null } => {
  if (given(i, "sda_status")) return { status: str(i, "sda_status") as SdaStatus, start_date: optDate(i, "sda_start_date") };
  const h = sdaStatusFromEvents(ctx.events.byLoan(loanOf(i, ctx)));
  return { status: h.status, start_date: optDate(i, "sda_start_date") ?? h.start_date };
};
const AGENT = "custodial-recon";
/** The S/A month-4 LAR 96 recovery is set as an expectation too (IRM p. 26) — not an exit, so it is not an `expected_recovery_event` of the position row. */
type ExpectationEvent = ExitEvent | "sa_month4";
const totalOutstanding = (rows: readonly AdvanceRow[]): bigint => outstandingCents(rows, "delinquency_pi") + outstandingCents(rows, "delinquency_interest_sa");

const NO_NETTING = never("NO_NETTING_FNMA_RECEIVABLE", "15.4 guardrail: never net Fannie Mae's SDA receivable against our advances (rule 2: it is Fannie Mae's, never ours to recover)", (i) => flag(i, "net_fnma_receivable") || cents(i.fnma_sda_receivable_cents) < 0n, "carry `fnma_sda_receivable_cents` separately (a netted, negative figure is not Fannie Mae's receivable); it is Fannie Mae's loss at liquidation");
const REPORT_LINE_REQUIRED = never("RECOVERY_NEEDS_REPORT_LINE", "15.4 guardrail: never book a recovery without a report-line reference (report id + row hash / purchase advice id / LAR id)", (i) => str(i, "source") !== "write_off" && !str(i, "report_line_ref"), "attach the Cash Adjustments / draft-notification / purchase-advice / LAR line reference");
const NO_FUNDING_ON_SDA = guard("NO_FUNDING_ON_SDA", "15.4 guardrail: never fund an advance on a Stop Advance loan (5.4; FNMA_F120_SDA_FUNDING_HOLD blocks advance funding while `sda_status.active`)",
  (i, ctx) => { const sda = sdaOf(i, ctx); const funded = advancesFundedDuringSda(advances(i), sda.status, sda.start_date); return funded.length > 0 ? `advances ${funded.join(", ")} were drafted on or after the Stop Delinquency Advance start date ${sda.start_date} — an advance funded on a Stop Advance loan; Fannie Mae has suspended drafting: reverse the funding (5.2) before the position is written` : undefined; });

export const TOOLS_15_4: readonly ToolDef[] = defineTools("15.4", AGENT, [
  // rule 2 — the daily position row. SM_DELADV_POSITION_DAILY: the sweep's 00:30 tick (`schedule.tick{cadence=daily, at=00:30, job=deladv-position-sweep}`)
  // arms the recurring row for a delinquent S/S or S/A loan whose clock is not already open; the written row satisfies it and it re-arms for the next day.
  { name: "recomputeAdvancePosition", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "remittance_type"); const asOf = optDate(i, "as_of") ?? D(ctx.now.slice(0, 10)); const loanId = loanOf(i, ctx);
      const row = advancePosition({ loan_id: loanId, as_of: asOf, remittance_type: str(i, "remittance_type") as RemittanceType, servicing_option: servicingOption(i) ?? "special", sda_status: sdaOf(i, ctx).status,
        advances: advances(i), fnma_sda_receivable_cents: cents(i.fnma_sda_receivable_cents), ...(given(i, "sa_interest_advanced_cents") ? { sa_interest_advanced_cents: cents(i.sa_interest_advanced_cents) } : {}), sa_month4_interest_cents: cents(i.sa_month4_interest_cents), gfee_advanced_cents: cents(i.gfee_advanced_cents),
        expected_recovery_event: (i.expected_recovery_event as ExpectedRecoveryEvent | undefined) ?? null, expected_by: optDate(i, "expected_by"), matched_cents: cents(i.matched_cents), variance_cents: cents(i.variance_cents), escalated: flag(i, "escalated") });
      const clockOpen = ctx.timers.forSubject("loan", loanId).some((t) => t.code === "SM_DELADV_POSITION_DAILY" && (t.status === "armed" || t.status === "breached"));
      const ticked = positionSweepDue(row) && !clockOpen;
      if (ticked) ctx.events.append(positionSweepTick(asOf, loanId));
      const rec = rt.store.put("delinquency_advance_positions", `${row.loan_id}:${row.as_of}`, { ...row }, ctx.actor, ctx.now);
      ctx.events.append({ type: "delinquency_advance_positions.written", loanId: row.loan_id, aggregate: { kind: "delinquency_advance_positions", id: rec.id }, actor: ctx.actor, payload: { as_of: row.as_of, status: row.status, servicer_pi_advances_outstanding_cents: row.servicer_pi_advances_outstanding_cents, sa_interest_advanced_cents: row.sa_interest_advanced_cents, fnma_sda_receivable_cents: row.fnma_sda_receivable_cents, daily_clock_armed: ticked } });
      return { ...row, daily_clock_armed: ticked }; }),
    guardrails: [NO_NETTING, NO_FUNDING_ON_SDA] },
  // rule 3 — expected recovery event / amount / deadline by exit (or the S/A month-4 LAR 96); zero expectation on an S/S special liquidation is a data error.
  // Three inbound records land here: the liquidation processed but not yet reported (stage=processed → `liquidation_facts.processed`, the 5.3 LAR clock:
  // "reimbursement cannot trigger" until the LAR is accepted); the 13.x sale scheduled (event=pre_fcl_removal → `foreclosure.sale.scheduled`, the E-3.5-01
  // gate); and the accepted exit transaction (`advance_position.expectation_set` — the arming event of the expectation timers, anchor `accepted_on` — plus
  // `sda_status.exited{reason}` when the loan was in Stop Advance, which lifts FNMA_F120_SDA_FUNDING_HOLD and arms SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES).
  { name: "setRecoveryExpectation", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "event");
      const loanId = loanOf(i, ctx); const event = str(i, "event") as ExpectationEvent; const rows = advances(i);
      const remittance = (str(i, "remittance_type") || (event === "sa_month4" ? "SA" : "SS")) as RemittanceType;
      const option = servicingOption(i);
      if (event === "liquidation_lar" && str(i, "stage") === "processed") {
        need(i, "processed_at", "action_code");
        const lp = liquidationProcessed({ fact_id: str(i, "fact_id") || `liquidation:${loanId}:${str(i, "processed_at").slice(0, 10)}`, processed_at: str(i, "processed_at"), action_code: str(i, "action_code"), sale_date: optDate(i, "sale_date"), mi_insured: flag(i, "mi_insured"), remittance_type: remittance, servicing_option: option ?? "special", advances: rows });
        ctx.events.append({ type: "liquidation_facts.processed", loanId, aggregate: { kind: "liquidation_facts", id: lp.payload.fact_id }, actor: ctx.actor, payload: { ...lp.payload, timer: lp.timer } });
        let escalation_id: string | null = null;
        if (lp.data_error === "regular_servicing_option_liquidated_in_pool") escalation_id = rt.escalations.open({ kind: "officer", loanId, severity: "sev1", payload: { reason: "E-3.5-01: a regular servicing option MBS loan was liquidated in the pool — advances recover through the removal (5.6), never a liquidation reimbursement", data_error: lp.data_error, fact_id: lp.payload.fact_id } }, ctx.actor).id;
        else if (lp.data_error === "zero_expectation_on_ss_special_liquidation") escalation_id = rt.escalations.open({ kind: "sev2", loanId, severity: "sev2", payload: { reason: "S/S special servicing loan liquidated with a zero delinquency-advance expectation — data error (15.4 guardrail)", data_error: lp.data_error, fact_id: lp.payload.fact_id } }, ctx.actor).id;
        return { ...lp, escalation_id };
      }
      if (event === "pre_fcl_removal") {
        const saleOn = optDate(i, "sale_on") ?? date(i, "accepted_on");
        const s = saleScheduled({ sale_on: saleOn, servicing_option: option, repurchase_or_reclass_accepted: flag(i, "repurchase_or_reclass_accepted"), advances: rows });
        ctx.events.append({ type: "foreclosure.sale.scheduled", loanId, actor: ctx.actor, payload: s.payload });
        let escalation_id: string | null = null;
        if (s.gate.blocked) {
          escalation_id = rt.escalations.open({ kind: "officer", loanId, severity: s.gate.escalation!.severity, payload: { reason: s.gate.reason, timer: s.gate.timer, sale_at: saleOn, remove_by: s.gate.remove_by, servicing_option: option, advances_outstanding_cents: s.payload.advances_outstanding_cents } }, ctx.actor).id;
          ctx.events.append({ type: "sale_package.release_blocked", loanId, actor: ctx.actor, payload: { timer: s.gate.timer, sale_at: saleOn, remove_by: s.gate.remove_by, reason: s.gate.reason, escalation_id } });
        }
        ctx.events.append({ type: "advance_position.expectation_set", loanId, actor: ctx.actor, payload: { expected_recovery_event: "pre_fcl_removal", accepted_on: saleOn, remittance_type: remittance, expected_by: s.expectation.expected_by, expected_cents: s.expectation.expected_cents, source: s.expectation.source, timer: s.expectation.timer, advances_outstanding: totalOutstanding(rows) > 0n, data_error: null, sale_package_release_blocked: s.gate.blocked } });
        return { ...s, escalation_id };
      }
      need(i, "accepted_on"); const acceptedOn = date(i, "accepted_on");
      if (event === "sa_month4") {
        const m4 = saMonth4Recovery({ period_end: acceptedOn, monthly_interest_cents: cents(i.monthly_interest_cents), months_advanced: given(i, "months_advanced") ? Number(i.months_advanced) : 3, sa_advances: rows.filter((a) => a.kind === "delinquency_interest_sa") });
        ctx.events.append({ type: "investor_events.projected", loanId, actor: ctx.actor, payload: { family: "sa_month4_recovery", action_code: "96", interest_negative: true, interest_cents: m4.interest_cents, report_period: m4.report_period, due_bd2: m4.due_bd2 } });
        ctx.events.append({ type: "advance_position.expectation_set", loanId, actor: ctx.actor, payload: { expected_recovery_event: "sa_month4", accepted_on: acceptedOn, period_end: acceptedOn, remittance_type: "SA", expected_by: m4.due_bd2, expected_cents: m4.recovered_cents, source: "sa_negative_interest_lar", timer: m4.timer, advances_outstanding: m4.advanced_before_cents > 0n, data_error: null } });
        return m4;
      }
      const e = recoveryExpectation({ remittance_type: remittance, servicing_option: option ?? "special", event, accepted_on: acceptedOn, advances: rows, ...(given(i, "sa_month4_interest_cents") ? { sa_month4_interest_cents: cents(i.sa_month4_interest_cents) } : {}) });
      if (e.escalation) rt.escalations.open({ kind: e.escalation.kind, loanId, severity: e.escalation.kind === "sev2" ? "sev2" : "sev1", payload: { reason: e.escalation.reason, data_error: e.data_error, event: e.expected_recovery_event } }, ctx.actor);
      const outstanding = totalOutstanding(rows);
      ctx.events.append({ type: "advance_position.expectation_set", loanId, actor: ctx.actor, payload: { expected_recovery_event: e.expected_recovery_event, accepted_on: acceptedOn, remittance_type: remittance, expected_by: e.expected_by, expected_cents: e.expected_cents, source: e.source, timer: e.timer, advances_outstanding: outstanding > 0n, data_error: e.data_error } });
      // 5.4 / F-1-20 exit table: the accepted trigger transaction ends Stop Delinquency Advance on a `predicted`/`active` loan
      const exit = sdaExit(event, sdaOf(i, ctx).status, acceptedOn);
      if (exit) ctx.events.append({ type: "sda_status.exited", loanId, actor: ctx.actor, payload: { reason: exit.reason, exited_on: exit.exited_on, expected_recovery_event: e.expected_recovery_event, advances_outstanding: outstanding > 0n, advances_outstanding_cents: outstanding, fnma_reimburses: e.fnma_reimburses } });
      return { ...e, sda_exit: exit }; }),
    guardrails: [NO_NETTING] },
  // inbound — Remittance Detail – Cash Adjustments / draft-notification credits → `draft_adjustments` with report-line references
  { name: "parseCashAdjustments", kind: "read", handler: compute((i) => { need(i, "report_id", "activity_period"); return parseCashAdjustmentLines({ report_id: str(i, "report_id"), activity_period: str(i, "activity_period"), lines: (Array.isArray(i.lines) ? i.lines : []) as CashAdjustmentLine[] }); }) },
  // rule 4 — FIFO by activity period, $0.05 per line; the result names what postRecoveryEntries may book
  { name: "matchRecoveries", kind: "act", handler: compute((i) => {
      need(i, "loan_id", "credit_cents", "report_line_ref");
      const rows = advances(i); const kind = (str(i, "kind") || "delinquency_pi") as AdvanceKind; const m = matchReimbursement(openAdvances(rows, kind), cents(i.credit_cents));
      const ids = new Set(m.matched);
      const after = rows.filter((a) => !ids.has(a.id));
      return { ...m, credit_cents: cents(i.credit_cents), report_line_ref: str(i, "report_line_ref"), source: (str(i, "source") || "fnma_liquidation_reimb") as RecoverySource, kind, recoveries: rows.filter((a) => ids.has(a.id)).map((a) => ({ advance_id: a.id, amount_cents: a.amount_cents, activity_period: a.activity_period })), remaining_outstanding_cents: totalOutstanding(after) }; }),
    guardrails: [REPORT_LINE_REQUIRED, NO_NETTING] },
  // rule 4 — Dr custodial_pi_cash for the credit as reported / Cr servicer_advance_receivable for the matched advances (posted through ops-15-4 `entryLines`, the
  // tested lines on the kernel chart); statuses; the corporate transfer; write-offs need the officer. The position closes only when the remaining outstanding is
  // known to be zero (from the `advances` rows, or an explicit `remaining_outstanding_cents`) — a partial booking never silences SM_DELADV_UNRECOVERED_60; a Fannie
  // Mae reimbursement that leaves nothing outstanding emits `advances.reimbursed_by_fnma{all_outstanding=true}` (SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES).
  { name: "postRecoveryEntries", kind: "act", handler: compute((i, ctx) => {
      need(i, "loan_id", "source", "amount_cents", "effective_date");
      const source = str(i, "source") as RecoverySource; const amount = cents(i.amount_cents); const effective = date(i, "effective_date"); const loanId = loanOf(i, ctx);
      const advanceIds = Array.isArray(i.advance_ids) ? (i.advance_ids as string[]) : []; const kind = str(i, "kind") || "delinquency_pi"; const custodialId = str(i, "custodial_account_id") || "C-PI";
      const received = given(i, "credit_cents") ? cents(i.credit_cents) : amount;
      let posted: unknown = null; let ledgerDetail: { received_cents: bigint; residual_cents: bigint; excess_cents: bigint } | null = null;
      if (source === "write_off") {
        const w = writeOffDecision({ amount_cents: amount, approved_by_role: ctx.actor.kind === "human" ? (ctx.actor.role ?? null) : null, exit_on: optDate(i, "exit_on") ?? effective, today: effective, advance_ids: advanceIds, report_line_ref: str(i, "report_line_ref") || null });
        if (!w.allowed) throw new RangeError(w.refusal ?? "write-off refused");
      } else if (source === "reversal") {
        const set: EntrySetInput = { effectiveDate: effective, description: `15.4 rule 8 reversal (${str(i, "report_line_ref")})`, lines: entryLines(reversalLedger(amount), custodialId, "15.4 rule 8") };
        posted = ctx.ledger.post(set, ctx.now);
      } else {
        const l = recoveryLedger(amount, str(i, "disbursed_to") === "corporate" ? "corporate" : "custodial", received);
        const set: EntrySetInput = { effectiveDate: effective, description: `15.4 rule 4 recovery (${str(i, "report_line_ref")})`, lines: entryLines(l.lines, custodialId, l.rule_ref) };
        posted = ctx.ledger.post(set, ctx.now); ledgerDetail = { received_cents: l.received_cents, residual_cents: l.residual_cents, excess_cents: l.excess_cents };
        if (l.corporate_transfer.scheduled) ctx.events.append({ type: "corporate_transfer.scheduled", loanId, actor: ctx.actor, payload: { amount_cents: l.corporate_transfer.amount_cents, from: l.corporate_transfer.from, to: l.corporate_transfer.to } });
        if (l.excess_cents > 0n) ctx.events.append({ type: "fnma_payable.booked", loanId, actor: ctx.actor, payload: { amount_cents: l.excess_cents, report_line_ref: str(i, "report_line_ref"), reason: "credit above the matched advances — never kept (15.4 edge case)" } });
      }
      const status = source === "write_off" ? "written_off" : source === "reversal" ? "outstanding" : source === "payoff_proceeds" || source === "repurchase_price" || source === "borrower_contractual" ? "recovered_from_borrower" : "reimbursed_by_fnma";
      ctx.events.append({ type: "advance_recoveries.booked", loanId, actor: ctx.actor, payload: { source, kind, amount_cents: amount, recovered_at: effective, report_line_ref: str(i, "report_line_ref") || null, advance_ids: advanceIds, ...(ledgerDetail ?? {}) } });
      for (const id of advanceIds) ctx.events.append({ type: "advances.status_changed", loanId, aggregate: { kind: "advances", id }, actor: ctx.actor, payload: { status, source } });
      // remaining outstanding after this booking: from the advances rows when supplied, else only an explicit figure; unknown never closes the position
      const rows = advances(i); const booked = new Set(advanceIds);
      const rest = rows.filter((a) => !booked.has(a.id));
      const remaining: bigint | null = rows.length > 0 ? totalOutstanding(rest) : given(i, "remaining_outstanding_cents") ? cents(i.remaining_outstanding_cents) : null;
      const allReimbursed = status === "reimbursed_by_fnma" && remaining === 0n && advanceIds.length > 0;
      if (allReimbursed) ctx.events.append({ type: "advances.reimbursed_by_fnma", loanId, actor: ctx.actor, payload: { all_outstanding: true, rows: advanceIds.length, source, report_line_ref: str(i, "report_line_ref") || null } });
      const closed = source !== "reversal" && remaining === 0n && advanceIds.length > 0;
      if (closed) ctx.events.append({ type: "advance_position.closed", loanId, actor: ctx.actor, payload: { reason: source === "write_off" ? "written_off" : "recovered", source } });
      return { booked: true, source, amount_cents: amount, status, ledger: posted, ledger_detail: ledgerDetail, remaining_outstanding_cents: remaining, all_reimbursed_by_fnma: allReimbursed, position_closed: closed }; }),
    moneyFields: ["amount_cents", "effective_date"],
    guardrails: [REPORT_LINE_REQUIRED, needsRole("WRITE_OFF_NEEDS_OFFICER", "15.4 guardrail: never write off without `officer` approval (write-offs > $500/loan are the officer's decision task)", (i) => str(i, "source") === "write_off", ["officer"], "write-off of a delinquency advance"), NO_NETTING] },
  // rule 4 — variance package for the Investor Reporting Representative (IRT is not the venue); `officer` at 60 days after the exit
  { name: "buildIrrPackage", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "exit_event", "exit_on");
      const p = irrPackage({ loan_id: str(i, "loan_id"), exit_event: str(i, "exit_event") as ExpectedRecoveryEvent, exit_on: date(i, "exit_on"), today: optDate(i, "today") ?? D(ctx.now.slice(0, 10)),
        activity_periods: (Array.isArray(i.activity_periods) ? i.activity_periods : []) as { period: string; drafted_cents: bigint; draft_id: string | null }[], lar: (i.lar as { id: string; ack_id: string | null; action_code: string; accepted_on: PlainDate } | undefined) ?? null,
        report_lines: (Array.isArray(i.report_lines) ? i.report_lines : []) as string[], expected_cents: cents(i.expected_cents), matched_cents: cents(i.matched_cents), variance_cents: cents(i.variance_cents), expected_by: optDate(i, "expected_by") });
      const esc = rt.escalations.open({ kind: p.escalation.kind, loanId: str(i, "loan_id"), severity: p.escalation.severity, payload: { reason: p.escalation.reason, recipient: p.recipient, channel: p.channel, package: p.contents, officer_due: p.officer_due } }, ctx.actor);
      return { ...p, escalation_id: esc.id }; }) },
  // outputs — monthly unreimbursed-advance aging report (partner / FHFA-liquidity view)
  { name: "agingReport", kind: "read", handler: compute((i, ctx, rt) => {
      const asOf = optDate(i, "as_of") ?? D(ctx.now.slice(0, 10));
      const positions = Array.isArray(i.positions) ? (i.positions as { loan_id: string; exit_on: PlainDate | null; outstanding_cents: bigint; status: PositionStatus; expected_recovery_event: ExpectedRecoveryEvent | null }[]) : rt.store.list("delinquency_advance_positions").map((r) => ({ loan_id: String(r.data.loan_id), exit_on: (r.data.exit_on as PlainDate | undefined) ?? null, outstanding_cents: cents(r.data.servicer_pi_advances_outstanding_cents), status: (r.data.status as PositionStatus | undefined) ?? "accruing", expected_recovery_event: (r.data.expected_recovery_event as ExpectedRecoveryEvent | undefined) ?? null }));
      return agingReport({ as_of: asOf, positions }); }) },
  // decision record {loan_id, as_of, remittance_type, servicing_option, outstanding_cents, periods[], expected_event, expected_by, matched[], variance_cents, action, evidence_ids[]}
  { name: "recordDecision", kind: "act", handler: decision() },
]);
