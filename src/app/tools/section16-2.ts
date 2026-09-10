/**
 * §16.2 tools — the spec's tool strings for process 16.2, verbatim, via
 * `defineTools("16.2", "<agent>", defs)` from ../tools.ts (see section13.ts). Spread by ./section16.ts.
 * `payoff-release` runs receipt-to-close: matches funds to quotes and records the receipt / good-funds
 * clearing (`matchPayoffFunds` → `payoff.funds.received` / `payoff.funds.cleared`, `payoff_funds`), decides
 * the variance disposition and the short-payoff path (`disposeVariance` → `payoff.funds.short|over`,
 * `suspense.item.created{reason_code}`, `notice.sent{template=NTC_PAYOFF_SHORTAGE_DEMAND}`, `payoff.shortage.resolved`,
 * `suspense.item.closed{status=refunded}` with `NTC_PAYOFF_OVERAGE_REFUND_ADVICE`, and the §1024.35(b)(6) `case.noe.opened`
 * 4.1's clocks arm on), posts to zero with the Outputs ledger sets and reverses a returned item (`postPayoff` →
 * `payoff.applied`, `loan.paid_in_full`, `payoff.reversed` + `investor_event_exceptions.detected{family=removal}` that arms
 * the BD2 17:00 ET correction clock and cancels every timer the payoff armed), computes Fannie Mae's share
 * (`computeFnmaPayoffShare` → `payoff_settlements`), builds the CRS batch and records the draft settlement
 * (`buildCrsBatch` → `payoff.remittance.instructed|settled`), projects, submits and ingests the LSDU acknowledgment of
 * the removal event (`projectRemovalPayoff` → `removal.payoff`, `investor_events.submitted`, `investor_events.accepted`,
 * `investor_events.resolved{status=superseded, family=removal}` when a correction supersedes the original LAR 60) and fans
 * out / completes housekeeping (`createHousekeepingTasks` → `payoff.housekeeping.created|completed`,
 * `autodraft.enrollment.terminated`, `disbursement.issued{kind=payoff_refund}`, `escrow.statement.sent{statement_type=short_year_payoff}`,
 * `notice.sent{template=NTC_PAYOFF_PAID_IN_FULL}`).
 * Guardrails encode the spec's sentences: no `removal.payoff` without `payoff.funds.cleared` (the `payoff_funds` row the
 * intake cleared — never a caller's attestation); no demand for more than a reliance-protected figure; absorbed shortages
 * > $500 need `officer` approval; no reversal of a closed-period payoff and no correction after the BD2 17:00 ET close;
 * CRS amounts must equal `payoff_settlements` values; the LLM never computes money; short funds are never applied during
 * the cure window (rule 5); advances are never inside the payoff draft (F-1-09); recording costs are never netted (F-1-05);
 * no ACH-debit payoff above $25,000 (good-funds policy).
 */
import { defineTools, compute, never, needsRole, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Recipient } from "../../notices/channel.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { matchFunds, disposeVariance, applyToZero, applyUncuredPerNote, perNoteEntrySet, crsBatch, advanceSpecialRemittance, housekeepingTasks, payoffDate, goodFundsClearing, fnmaPayoffShare, fnmaDraftDate, finalityAtMs, payoffActivityPeriod, lar60DueMs, reversalExceptionEvent, acceptRemovalAck, PAYOFF_ARMING_EVENTS, payoffLedgerSets, reversePayoff, lar60Removal, autodraftStop, postPayoffReceipt, refundOverage, escrowRefund, statementShortageNoe, AGENT_ABSORB_LIMIT_CENTS, ACH_DEBIT_PAYOFF_MAX_CENTS, type OpenQuote, type SettlementRow, type PayoffBuckets, type FundsMethod, type RemittanceType, type HousekeepingTask, type ReversalTask } from "../../domain/payoff/ops-16-2.ts";
import { projectLar96 } from "../../domain/investor/lar.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const ms = (i: ToolInput, k: string): number | null => (typeof i[k] === "number" ? (i[k] as number) : typeof i[k] === "string" && i[k] !== "" ? Date.parse(i[k] as string) : null);
const rtype = (i: ToolInput): RemittanceType => ((str(i, "remittance_type") || "AA").toUpperCase() as RemittanceType);
const custodial = (i: ToolInput) => ({ pi: str(i, "custodial_pi_id") || "C-PI", ti: str(i, "custodial_ti_id") || "C-TI", clearing: str(i, "custodial_clearing_id") || "C-CLR" });
const AGENT = "payoff-release";
const ET = "America/New_York";
const today = (ctx: CommandContext): PlainDate => wallClock(Date.parse(ctx.now), ET).date;
const LLM_NEVER_COMPUTES_MONEY = never("LLM_NEVER_COMPUTES_MONEY", "16.2 guardrail: the LLM never computes money", (i) => str(i, "amounts_source") === "llm" || i.override_cents !== undefined || i.override_lines !== undefined || i.processed_bd1_reported_bd2 !== undefined, "money comes from the calculators and payoff_settlements, never from the model (the S/S BD1/BD2 exception is derived from the fannie_et calendar, not asserted)");
let REG: ReturnType<typeof loadOverriddenRegistry> | null = null;
const registry = () => (REG ??= loadOverriddenRegistry());

/** The good-funds gate: the `payoff_funds` row the intake cleared (`payoff.funds.cleared` in the loan's log) — a caller's `funds_cleared` attestation is not evidence. */
function clearedFunds(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, what: string): string {
  const loanId = str(i, "loan_id"); const id = str(i, "funds_id");
  const row = id ? rt.store.get("payoff_funds", id) : undefined;
  if (!row || String(row.data.loan_id) !== loanId || !["cleared", "applied"].includes(String(row.data.status))) throw new RangeError(`${what} needs payoff.funds.cleared (SM_PAYOFF_GOODFUNDS_GATE): payoff_funds ${id || "?"} is ${String(row?.data.status ?? "unknown")} for ${loanId}`);
  if (!ctx.events.byLoan(loanId).some((e) => e.type === "payoff.funds.cleared" && e.payload.funds_id === row.id)) throw new RangeError(`${what}: no payoff.funds.cleared event for payoff_funds ${row.id} in the loan's log (the event log is the record)`);
  return row.id;
}
function openEscalations(rt: ToolRuntime, ctx: CommandContext, loanId: string, list: readonly { kind: EscalationKind; owner_role: string; severity: string | null; reason: string }[], extra: Record<string, unknown> = {}): string[] {
  return list.map((e) => rt.escalations.open({ kind: e.kind, ownerRole: e.owner_role, loanId, ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason, ...extra } }, ctx.actor).id);
}
function emitCleared(i: ToolInput, ctx: CommandContext, loanId: string, fundsId: string, clearedAtIso: string, amount: bigint, creditedAsOf: PlainDate): void {
  ctx.events.append({ type: "payoff.funds.cleared", loanId, actor: ctx.actor, payload: { funds_id: fundsId, cleared_at: clearedAtIso, processed_at: clearedAtIso, amount_cents: amount, remittance_type: rtype(i).toLowerCase(), credited_as_of: creditedAsOf, method: str(i, "method") || null } });
}
/** Renders and sends through the Notice Registry when it is wired (its `notice.sent{template}` is the timer event); otherwise the tool's own `notice.sent{template}` records the send. */
async function sendNotice(ctx: CommandContext, rt: ToolRuntime, loanId: string, template: string, payload: Record<string, unknown>, recipients: readonly Recipient[]): Promise<{ notice_id: string | null; template: string; sent: PlainDate }> {
  const sent = today(ctx);
  if (rt.notices) { const n = rt.notices.render({ templateCode: template, loanId, recipients, payload, asOf: sent }); const out = await rt.notices.send(n.id, {}); return { notice_id: out.id, template, sent }; }
  ctx.events.append({ type: "notice.sent", loanId, actor: ctx.actor, payload: { template, notice_id: null, recipients: recipients.map((r) => ({ party_id: r.partyId, name: r.name })), sent, sent_at: ctx.now } });
  return { notice_id: null, template, sent };
}
const recipientsOf = (i: ToolInput): Recipient[] => ((i.recipients as readonly Partial<Recipient>[] | undefined) ?? []).map((r) => ({ partyId: String(r.partyId ?? ""), name: String(r.name ?? ""), mailingAddress: (r.mailingAddress as string | null | undefined) ?? null, ...(r.email ? { email: r.email } : {}), ...(r.consent ? { consent: r.consent } : {}) }));
/** Cancels the open timers on the loan that a payoff armed (rule 6: housekeeping cancelled/reversed) or that a named code list covers. */
function cancelTimers(ctx: CommandContext, loanId: string, reason: string, codes?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const t of ctx.timers.forSubject("loan", loanId)) {
    if (t.status !== "armed" && t.status !== "breached") continue;
    const trig = registry().get(t.code)?.triggerPattern?.type ?? "";
    if (codes ? codes.has(t.code) : PAYOFF_ARMING_EVENTS.has(trig)) { ctx.timers.cancel(t.id, reason, ctx.actor); out.push(t.code); }
  }
  return out;
}
const LETTER_CONSTANTS = { servicer_name: "Supermortgage", servicer_address: "PO Box 1, Testville TX 75001", team_phone: "(800) 555-0199", team_name: "Payoff & Lien Release Team", toll_free: "(800) 555-0100", website: "portal.example.com/help", mortgagee_name: "Fannie Mae, its successors and assigns" };
const LINE_LABEL: Record<string, string> = { accrued_interest: "Interest at the note rate", principal: "Unpaid principal balance", nib_deferred: "Deferred (non-interest-bearing) principal", nib_forborne: "Forborne principal", escrow_advance: "Escrow advances", late_charges: "Late charges", nsf_other_fees: "NSF and other fees", corporate_advances: "Corporate advances", recording_release_fee: "Recording / release fee" };

export const TOOLS_16_2: readonly ToolDef[] = defineTools("16.2", AGENT, [
  // ---- receipt: match to a quote, payoff date (rule 1), good-funds clearing (method policy), payoff_funds row ----------------------------------
  { name: "matchPayoffFunds", kind: "write", moneyFields: ["amount_cents", "received_at"], handler: compute((i, ctx, rt) => {
      if (i.op === "clear") {
        need(i, "loan_id", "funds_id"); const row = rt.store.require("payoff_funds", str(i, "funds_id"));
        if (["cleared", "applied"].includes(String(row.data.status))) return { funds_id: row.id, status: row.data.status, cleared_at: row.data.cleared_at };
        const clearedAt = ms(i, "cleared_at") ?? Date.parse(ctx.now);
        const rec = rt.store.put("payoff_funds", row.id, { status: "cleared", cleared_at: toIso(clearedAt) }, ctx.actor, ctx.now);
        emitCleared(i, ctx, str(i, "loan_id"), rec.id, toIso(clearedAt), cents(rec.data.amount_cents), D(String(rec.data.credited_as_of)));
        return { funds_id: rec.id, status: "cleared", cleared_at: toIso(clearedAt) };
      }
      need(i, "loan_id", "amount_cents", "method", "received_at");
      const receivedAt = ms(i, "received_at")!; const receivedOn = wallClock(receivedAt, ET).date; const amount = cents(i.amount_cents);
      if (amount <= 0n) throw new RangeError("amount_cents must be positive");
      const quotes = (i.quotes as OpenQuote[] | undefined) ?? rt.store.list("payoff_quotes").map((r) => ({ quote_id: r.id, loan_id: String(r.data.loan_id ?? ""), total_cents: cents(r.data.total_cents), good_through: D(String(r.data.good_through ?? "2000-01-01")), verification_token: (r.data.verification_token as string | undefined) ?? null }));
      const match = matchFunds({ amount_cents: amount, bank_reference: str(i, "bank_reference") || null, received_on: receivedOn, quotes });
      const pd = payoffDate({ received_on: receivedOn, remittance_type: rtype(i), paid_by: (str(i, "paid_by") || "borrower") as "borrower", settlement_date: optDate(i, "settlement_date"), due_on: optDate(i, "due_on") });
      const gf = goodFundsClearing({ method: str(i, "method") as FundsMethod, amount_cents: amount, received_at_ms: receivedAt, bank_verified: flag(i, "bank_verified"), settlement_date: optDate(i, "settlement_date"), now_ms: Date.parse(ctx.now) });
      if (gf.status === "refused") throw new RangeError(gf.refusal!);
      const id = str(i, "funds_id") || `pf-${str(i, "loan_id")}-${receivedOn}`;
      const rec = rt.store.put("payoff_funds", id, { loan_id: str(i, "loan_id"), quote_id: match.matched?.quote_id ?? null, received_at: toIso(receivedAt), credited_as_of: pd.payoff_date, payoff_date_basis: pd.basis, method: str(i, "method"), amount_cents: amount, source_party_id: str(i, "source_party_id") || null, bank_reference: str(i, "bank_reference") || null,
        cleared_at: gf.status === "cleared" && gf.cleared_at_ms !== null ? toIso(gf.cleared_at_ms) : null, expected_clear_at: gf.cleared_at_ms !== null ? toIso(gf.cleared_at_ms) : null, good_funds_hold: gf.hold, settlement_date: optDate(i, "settlement_date"), status: gf.status === "cleared" ? "cleared" : "held", match_status: match.status, match_basis: match.basis, research_by: match.research_by,
        variance_cents: match.matched ? amount - match.matched.total_cents : null, variance_reason: match.matched ? null : "unmatched: research within 1 BD (6.5)" }, ctx.actor, ctx.now);
      const payload = { funds_id: rec.id, amount: amount, amount_cents: amount, method: str(i, "method"), source_party: str(i, "source_party_id") || null, quote_id: match.matched?.quote_id ?? null, bank_ref: str(i, "bank_reference") || null, receipt: receivedOn, received_at: toIso(receivedAt), credited_as_of: pd.payoff_date, status: rec.data.status };
      ctx.events.append({ type: "payoff.funds.received", loanId: str(i, "loan_id"), actor: ctx.actor, payload });
      ctx.events.append({ type: "payoff.funds_received", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { ...payload, alias_of: "payoff.funds.received" } });   // 3.x/7.x spelling (spec Inputs: alias); 3.3's REGX_1024_17I4_SHORT_YEAR_PAYOFF_60 arms on it
      if (gf.status === "cleared" && gf.cleared_at_ms !== null) emitCleared(i, ctx, str(i, "loan_id"), rec.id, toIso(gf.cleared_at_ms), amount, pd.payoff_date);
      return { funds_id: rec.id, ...match, payoff_date: pd.payoff_date, payoff_date_basis: pd.basis, good_funds: gf, status: rec.data.status }; }),
    guardrails: [never("NO_ACH_DEBIT_PAYOFF_OVER_25K", "16.2 good-funds policy (officer-approved; open question 4): no ACH debit payoffs above $25,000 without a wire", (i) => str(i, "method") === "ach_debit" && cents(i.amount_cents) > ACH_DEBIT_PAYOFF_MAX_CENTS, "wire only above $25,000; ≤ $25,000 carries a 5-BD good-funds hold"), LLM_NEVER_COMPUTES_MONEY] },
  // ---- rule 2 / rule 5 / rule 10: tolerance table, demand letter, cure, absorption authority, day-30 application per the note, overage and post-payoff refunds, the statement NoE
  { name: "disposeVariance", kind: "act", moneyFields: ["amount_cents", "exact_total_cents", "cure_received_cents"], handler: compute(async (i, ctx, rt) => {
      const loanId = str(i, "loan_id");
      if (i.op === "apply_per_note") {
        need(i, "loan_id", "received_on", "today", "funds_cents", "installments");
        const balances = { principal_cents: ctx.ledger.balance({ scope: "loan", loanId, account: "principal" }), interest_due_cents: ctx.ledger.balance({ scope: "loan", loanId, account: "interest_due" }) };   // the note's balances from the ledger, never the caller's
        const r = applyUncuredPerNote({ received_on: date(i, "received_on"), today: date(i, "today"), funds_cents: cents(i.funds_cents), installments: (i.installments as { due_on: PlainDate; amount_cents: bigint; interest_cents?: bigint }[]).map((x) => ({ due_on: D(String(x.due_on)), amount_cents: cents(x.amount_cents), ...(x.interest_cents !== undefined ? { interest_cents: cents(x.interest_cents) } : {}) })), reliance_state: flag(i, "reliance_state"), balances });
        // rule 5: the application follows an uncured demand — the borrower was notified of the day-30 consequence by NTC_PAYOFF_SHORTAGE_DEMAND (read from the loan's log, never asserted)
        const demand = ctx.events.byLoan(loanId).find((e) => e.type === "notice.sent" && e.payload.template === "NTC_PAYOFF_SHORTAGE_DEMAND");
        if (r.eligible && !demand) throw new RangeError("no NTC_PAYOFF_SHORTAGE_DEMAND in the loan's event log: the day-30 application per the note follows an uncured demand (rule 5)");
        let setId: string | null = null;
        if (r.eligible) {
          const set = perNoteEntrySet(loanId, r, date(i, "today")); setId = set ? ctx.ledger.post(set, ctx.now).id : null;
          const si = rt.store.get("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-short_payoff`); if (si) rt.store.put("suspense_items", si.id, { status: "applied_per_note", applied_on: date(i, "today"), installments_cents: r.installments_cents, curtailment_cents: r.curtailment_cents, ledger_set_id: setId }, ctx.actor, ctx.now);
          ctx.events.append({ type: "payoff.shortage.resolved", loanId, actor: ctx.actor, payload: { outcome: "applied_per_note", disposition: "none", funds_cents: cents(i.funds_cents), installments_paid: r.installments_paid, curtailment_cents: r.curtailment_cents, extra_interest_cents: r.extra_interest_cents, unapplied_cents: r.unapplied_cents, loan_status: r.loan_status, borrower_notified: !!demand, demand_notice_id: demand?.payload.notice_id ?? null, ledger_set_id: setId } });
        }
        return { ...r, borrower_notified: r.eligible && !!demand, ledger_set_id: setId, escalation_ids: r.escalation ? openEscalations(rt, ctx, loanId, [r.escalation]) : [] };
      }
      if (i.op === "demand") {
        // rule 5: demand within 1 BD to the party that remitted, with the exact shortfall, the per diem where interest keeps accruing, the cure deadline and the day-30 consequence
        need(i, "loan_id", "amount_cents", "exact_total_cents", "received_on", "recipients");
        const receipt = date(i, "received_on"); const amount = cents(i.amount_cents), exact = cents(i.exact_total_cents);
        const d = disposeVariance({ amount_cents: amount, exact_total_cents: exact, reliance_state: flag(i, "reliance_state"), within_good_through: flag(i, "within_good_through"), received_on: receipt });
        if (!d.demand) throw new RangeError(`no demand: the variance ${d.variance_cents} disposes as ${d.disposition}`);
        const recipients = recipientsOf(i); if (!recipients.length) throw new RangeError("recipients: the party that remitted (closing agent / borrower)");
        const si = rt.store.get("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-short_payoff`); if (!si || si.data.reason !== "short_payoff") throw new RangeError("no suspense_items{short_payoff} row: run disposeVariance on the receipt first");
        const perDiem = cents(i.per_diem_cents); const sent = today(ctx); const cureBy = addBusinessDays(sent, 5, servicer);   // SM_PAYOFF_SHORTAGE_CURE_5BD: +5 BD from the demand
        const payload = { ...LETTER_CONSTANTS, notice_date: sent, account_last4: str(i, "account_last4") || loanId.slice(-4), borrower_name: str(i, "borrower_name") || recipients[0]!.name, property_address: str(i, "property_address") || "", addressee_name: recipients[0]!.name, addressee_role: str(i, "addressee_role") || String(si.data.remitter ?? "borrower"), received_on: receipt, amount_received_cents: amount, remitter: str(i, "remitter") || String(si.data.remitter ?? recipients[0]!.name), funds_status: "short_payoff", exact_total_cents: exact, shortage_cents: -d.variance_cents, per_diem_applies: perDiem > 0n && !flag(i, "reliance_state"), per_diem_cents: perDiem, cure_by: i.cure_by ? date(i, "cure_by") : cureBy, uncured_on: d.uncured_on, state: str(i, "state") || null, reliance_protected: flag(i, "reliance_state") && flag(i, "within_good_through"), ...((i.letter as Record<string, unknown> | undefined) ?? {}) };
        const n = await sendNotice(ctx, rt, loanId, "NTC_PAYOFF_SHORTAGE_DEMAND", payload, recipients);
        rt.store.put("suspense_items", si.id, { demand_sent_on: sent, demand_notice_id: n.notice_id, cure_by: payload.cure_by }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.shortage.demand_sent", loanId, actor: ctx.actor, payload: { suspense_item_id: si.id, notice_id: n.notice_id, template: n.template, sent, shortage_cents: -d.variance_cents, cure_by: payload.cure_by, uncured_on: d.uncured_on } });
        return { ...n, shortage_cents: -d.variance_cents, cure_by: payload.cure_by, uncured_on: d.uncured_on, suspense_item_id: si.id };
      }
      if (i.op === "post_payoff_receipt") {
        // rule 10 / T11: a debit that still occurs, a duplicate wire or the borrower's extra check → suspense_items{post_payoff_receipt} → refund within 10 BD; never applied to fees
        need(i, "loan_id", "amount_cents", "received_on", "remitter");
        const r = postPayoffReceipt({ received_on: date(i, "received_on"), amount_cents: cents(i.amount_cents), remitter: str(i, "remitter"), source: (str(i, "source") || "autodraft") as "autodraft" });
        const c = custodial(i);
        const set = ctx.ledger.post({ effectiveDate: r.refund_by <= date(i, "received_on") ? r.refund_by : date(i, "received_on"), description: `post-payoff receipt held for refund ${loanId}`, lines: [{ account: { scope: "custodial", custodialAccountId: c.ti, account: "custodial_ti_cash" }, amountCents: r.refund_cents, ruleRef: "16.2.rule10.post_payoff_receipt" }, { account: { scope: "custodial", custodialAccountId: c.clearing, account: "clearing_cash" }, amountCents: -r.refund_cents, ruleRef: "16.2.rule10.post_payoff_receipt" }] }, ctx.now);
        const si = rt.store.put("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-post_payoff_receipt-${date(i, "received_on")}`, { loan_id: loanId, reason: "post_payoff_receipt", reason_code: "post_payoff_receipt", source: str(i, "source") || "autodraft", amount_cents: r.refund_cents, received_on: date(i, "received_on"), remitter: r.refund_to, refund_by: r.refund_by, status: "pending_refund", applied_to_fees: false, ledger_set_id: set.id }, ctx.actor, ctx.now);
        ctx.events.append({ type: "suspense.item.created", loanId, aggregate: { kind: "suspense_item", id: si.id }, actor: ctx.actor, payload: { id: si.id, suspense_item_id: si.id, status: "pending_refund", reason_code: "post_payoff_receipt", source: str(i, "source") || "autodraft", amount_cents: r.refund_cents, received_on: date(i, "received_on"), refund_by: r.refund_by, loan_id: loanId } });   // arms 6.5's SM_OVERPAYMENT_REFUND_10BD (anchor received_on)
        return { ...r, suspense_item_id: si.id, ledger_set_id: set.id };
      }
      if (i.op === "refund") {
        // the overage / post-payoff receipt refunded in full to the remitter with NTC_PAYOFF_OVERAGE_REFUND_ADVICE; closes SM_OVERPAYMENT_REFUND_10BD on `suspense.item.closed{status=refunded}`
        need(i, "loan_id", "suspense_item_id", "issued_on");
        const si = rt.store.require("suspense_items", str(i, "suspense_item_id")); const reason = String(si.data.reason_code ?? si.data.reason);
        if (!["overpayment", "post_payoff_receipt"].includes(reason)) throw new RangeError(`suspense item ${si.id} is ${reason}: only an overpayment or post_payoff_receipt is refunded here`);
        if (si.data.status === "refunded") return { suspense_item_id: si.id, status: "refunded", disbursement_id: si.data.refund_disbursement_id };
        const r = refundOverage({ loan_id: loanId, custodial_ti: custodial(i).ti, received_on: D(String(si.data.received_on)), issued_on: date(i, "issued_on"), amount_cents: cents(si.data.amount_cents) });
        const setId = ctx.ledger.post(r.entry_set, ctx.now).id;
        const disb = rt.store.put("disbursements", str(i, "disbursement_id") || `disb-${si.id}`, { loan_id: loanId, kind: "payoff_overage_refund", amount_cents: r.refund_cents, payee: str(i, "refund_payee") || String(si.data.remitter ?? ""), method: str(i, "refund_method") || "check", issued_on: date(i, "issued_on"), suspense_item_id: si.id, ledger_set_id: setId, status: "issued" }, ctx.actor, ctx.now);
        rt.store.put("suspense_items", si.id, { status: "refunded", refund_disbursement_id: disb.id, refunded_on: date(i, "issued_on") }, ctx.actor, ctx.now);
        ctx.events.append({ type: "disbursement.issued", loanId, actor: ctx.actor, payload: { disbursement_id: disb.id, kind: "payoff_overage_refund", amount_cents: r.refund_cents, suspense_item_id: si.id, issued_on: date(i, "issued_on") } });
        ctx.events.append({ type: "suspense.item.closed", loanId, aggregate: { kind: "suspense_item", id: si.id }, actor: ctx.actor, payload: { id: si.id, suspense_item_id: si.id, status: "refunded", reason_code: reason, loan_id: loanId, resolved_on: date(i, "issued_on"), disbursement_id: disb.id, on_time: r.on_time } });
        const recipients = recipientsOf(i); let notice: Awaited<ReturnType<typeof sendNotice>> | null = null;
        if (recipients.length) {
          const st = str(i, "settlement_id") ? rt.store.get("payoff_settlements", str(i, "settlement_id"))?.data ?? null : null;
          const payload = { ...LETTER_CONSTANTS, notice_date: today(ctx), account_last4: str(i, "account_last4") || loanId.slice(-4), borrower_name: str(i, "borrower_name") || recipients[0]!.name, property_address: str(i, "property_address") || "", received_on: String(si.data.received_on), payoff_date: String(st?.payoff_date ?? si.data.received_on), amount_received_cents: cents(i.amount_received_cents) || cents(si.data.amount_cents) + cents(st?.upb_cents) + cents(st?.interest_note_rate_cents), exact_total_cents: cents(i.exact_total_cents) || cents(st?.upb_cents) + cents(st?.interest_note_rate_cents), overage_cents: r.refund_cents, refund_cents: r.refund_cents, refund_method: String(disb.data.method), refund_payee: String(disb.data.payee), refund_issued_on: date(i, "issued_on"), refund_bd_after_receipt: r.bd_after_receipt, applied_to_fees_cents: r.applied_to_fees_cents, ...((i.letter as Record<string, unknown> | undefined) ?? {}) };
          notice = await sendNotice(ctx, rt, loanId, "NTC_PAYOFF_OVERAGE_REFUND_ADVICE", payload, recipients);
        }
        return { suspense_item_id: si.id, disbursement_id: disb.id, ...r, ledger_set_id: setId, notice };
      }
      if (i.op === "statement_noe") {
        // rule 5 / §1024.35(b)(6): the borrower alleges the statement understated the balance → 4.1's clocks run, the shortage is servicer_absorbed, the response cites the statement hash
        need(i, "loan_id", "noe_received_on", "statement_hash", "statement_total_cents", "exact_total_cents", "amount_cents");
        const r = statementShortageNoe({ noe_received_on: date(i, "noe_received_on"), statement_hash: str(i, "statement_hash"), statement_total_cents: cents(i.statement_total_cents), exact_total_cents: cents(i.exact_total_cents), amount_cents: cents(i.amount_cents), loan_id: loanId, ...(str(i, "case_id") ? { case_id: str(i, "case_id") } : {}) });
        const caseId = r.noe.case_id;
        rt.store.put("cases", caseId, { case_type: "noe", loan_id: loanId, receipt_date: r.noe.receipt_date, receipt_at: r.noe.receipt_at, state: r.noe.state, deadline_profiles: r.noe.assertions.map((a) => a.profile), status: "triaged", opened_by: "16.2", statement_hash: str(i, "statement_hash"), extension_used: false, linked_case_ids: [] }, ctx.actor, ctx.now);
        ctx.events.append({ type: "case.noe.opened", loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { ...r.noe, opened_by: "16.2", statement_hash: str(i, "statement_hash") } });
        const si = rt.store.get("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-short_payoff`); if (si) rt.store.put("suspense_items", si.id, { status: "absorbed", noe_case_id: caseId }, ctx.actor, ctx.now);
        if (str(i, "settlement_id") && rt.store.get("payoff_settlements", str(i, "settlement_id"))) rt.store.put("payoff_settlements", str(i, "settlement_id"), { shortage_cents: r.shortage_cents, shortage_disposition: r.shortage_disposition, noe_case_id: caseId }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.shortage.resolved", loanId, actor: ctx.actor, payload: { outcome: "absorbed", disposition: r.shortage_disposition, shortage_cents: r.shortage_cents, expense_account: r.expense_account, noe_case_id: caseId, statement_hash: str(i, "statement_hash") } });
        const esc = r.officer_approval_required ? openEscalations(rt, ctx, loanId, [{ kind: "officer", owner_role: "officer", severity: null, reason: `absorbed statement shortage ${r.shortage_cents} > ${AGENT_ABSORB_LIMIT_CENTS} (open question 2)` }], { case_id: caseId }) : [];
        return { ...r, case_id: caseId, escalation_ids: esc };
      }
      need(i, "loan_id", "amount_cents", "exact_total_cents");
      const r = disposeVariance({ amount_cents: cents(i.amount_cents), exact_total_cents: cents(i.exact_total_cents), reliance_state: flag(i, "reliance_state"), within_good_through: flag(i, "within_good_through"), statement_error: flag(i, "statement_error"), approver_role: ctx.actor.role ?? null, received_on: optDate(i, "received_on"), per_diem_cents: cents(i.per_diem_cents), cure_received_cents: cents(i.cure_received_cents), cure_received_on: optDate(i, "cure_received_on"), ...(i.additional_interest_allowed !== undefined ? { additional_interest_allowed: flag(i, "additional_interest_allowed") } : {}) });
      if (r.refusal) throw new RangeError(r.refusal);
      const receipt = optDate(i, "received_on");
      let cancelled: string[] = [];
      if (r.demand) {
        const si = rt.store.put("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-short_payoff`, { loan_id: loanId, reason: "short_payoff", reason_code: "short_payoff", amount_cents: cents(i.amount_cents), received_on: receipt, status: "held", never_applied_during_cure: true, demand_by: r.demand_by, uncured_on: r.uncured_on, remitter: str(i, "remitter") || null }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.funds.short", loanId, actor: ctx.actor, payload: { shortage_cents: -r.variance_cents, remitter: str(i, "remitter") || null, receipt, demand_by: r.demand_by, uncured_on: r.uncured_on, suspense_item_id: si.id } });
        // the 16.2 timer table satisfies SM_PAYOFF_POST_TO_ZERO_1BD by `loan.paid_in_full` *or* `payoff.funds.short` (the registry grammar keys one event, so the second closes it here);
        // 5.3's LAR 60 clock armed on `payoff.funds.cleared` has nothing to report until the shortage is cured (rule 5: no removal.payoff during the cure window)
        cancelled = cancelTimers(ctx, loanId, `payoff.funds.short: funds ${-r.variance_cents} short held in suspense_items{short_payoff} for the cure window (16.2 timer table: POST_TO_ZERO satisfied by payoff.funds.short; rule 5: no LAR 60 until cured)`, new Set(["SM_PAYOFF_POST_TO_ZERO_1BD", "FNMA_IRM_PAYOFF_AC60_NEXTBD_2000"]));
      }
      if (r.overage_refund_by_bd) {
        const si = rt.store.put("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-overpayment`, { loan_id: loanId, reason: "overpayment", reason_code: "overpayment", amount_cents: r.variance_cents, received_on: receipt, remitter: str(i, "remitter") || null, status: "pending_refund", applied_to_fees: false }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.funds.over", loanId, actor: ctx.actor, payload: { overage_cents: r.variance_cents, receipt, suspense_item_id: si.id } });
        ctx.events.append({ type: "suspense.item.created", loanId, aggregate: { kind: "suspense_item", id: si.id }, actor: ctx.actor, payload: { id: si.id, suspense_item_id: si.id, status: "pending_refund", reason_code: "overpayment", source: "payoff_overage", received_on: receipt, amount_cents: r.variance_cents, loan_id: loanId } });   // arms 6.5's SM_OVERPAYMENT_REFUND_10BD on `reason_code`
      }
      if (r.shortage_disposition !== "none") {
        if (str(i, "settlement_id") && rt.store.get("payoff_settlements", str(i, "settlement_id"))) rt.store.put("payoff_settlements", str(i, "settlement_id"), { shortage_cents: -r.variance_cents, shortage_disposition: r.shortage_disposition }, ctx.actor, ctx.now);
        const si = rt.store.get("suspense_items", str(i, "suspense_item_id") || `si-${loanId}-short_payoff`); if (si) rt.store.put("suspense_items", si.id, { status: r.outcome === "cured" ? "cured" : "absorbed" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.shortage.resolved", loanId, actor: ctx.actor, payload: { outcome: r.outcome === "cured" ? "cured" : "absorbed", disposition: r.shortage_disposition, shortage_cents: -r.variance_cents, paid_in_full_as_of: r.paid_in_full_as_of, additional_interest_cents: r.additional_interest_cents, expense_account: r.expense_account } });
      }
      const escalations = str(i, "dispute") === "closing_agent_reliance" ? openEscalations(rt, ctx, loanId, [{ kind: "attorney", owner_role: "attorney", severity: null, reason: "closing agent disputes the shortage under state reliance law" }], { state: str(i, "state") || null, shortage_cents: -r.variance_cents }) : [];
      return { ...r, timers_cancelled: cancelled, escalation_ids: escalations }; }),
    guardrails: [never("NO_DEMAND_OVER_RELIANCE_FIGURE", "16.2 guardrail: no demand for more than a reliance-protected figure", (i) => flag(i, "reliance_state") && flag(i, "within_good_through") && (i.op === "demand" || flag(i, "demand") || flag(i, "force_demand") || cents(i.demand_cents) > 0n), "reliance states: the statement figure binds — disposition is reliance_absorbed, never a demand"),
      needsRole("OFFICER_ABSORBS_OVER_500", "16.2 guardrail / open question 2: absorbed shortages > $500 need officer approval", (i) => (flag(i, "statement_error") || flag(i, "reliance_state") || i.op === "statement_noe") && cents(i.exact_total_cents) - cents(i.amount_cents) - cents(i.cure_received_cents) > AGENT_ABSORB_LIMIT_CENTS, ["officer"], "package: quote, statement, funds evidence, state reliance rule, variance analysis"),
      never("NO_FEES_FROM_POST_PAYOFF_RECEIPT", "16.2 rule 10: post-payoff receipts and overages are refunded, never applied to fees", (i) => (i.op === "post_payoff_receipt" || i.op === "refund") && (flag(i, "apply_to_fees") || cents(i.apply_to_fees_cents) > 0n), "refund the remitter in full within 10 BD"),
      LLM_NEVER_COMPUTES_MONEY] },
  // ---- rule 3 posting to zero with the Outputs ledger sets, finality, `payoff.applied` → `loan.paid_in_full`; rule 6 reversal ------------------
  { name: "postPayoff", kind: "write", moneyFields: ["amount_cents", "buckets"], handler: compute((i, ctx, rt) => {
      const loanId = str(i, "loan_id");
      if (i.op === "reverse") {
        need(i, "loan_id", "settlement_id", "returned_at", "cause");
        const st = rt.store.require("payoff_settlements", str(i, "settlement_id"));
        const tasks = rt.store.list("payoff_housekeeping_tasks", (d) => d.settlement_id === st.id).map((t) => ({ task: String(t.data.task) as HousekeepingTask, status: String(t.data.status), id: t.id }));
        const payoffOn = D(String(st.data.payoff_date));
        const r = reversePayoff({ payoff_on: payoffOn, returned_at_ms: ms(i, "returned_at")!, finality_at_ms: Date.parse(String(st.data.finality_at)), cause: str(i, "cause") as "returned_item", tasks: tasks as ReversalTask[], refund_disbursement_id: str(i, "refund_disbursement_id") || (st.data.overage_refund_disbursement_id as string | null | undefined) || null, fnma_share_cents: cents(st.data.fnma_share_cents), sending_bank_indemnity: flag(i, "sending_bank_indemnity"), officer_approved: ctx.actor.role === "officer" || flag(i, "officer_approved") });
        const escalationIds = openEscalations(rt, ctx, loanId, r.escalations, { settlement_id: st.id, cause: str(i, "cause"), returned_on: r.returned_on });
        if (r.branch === "reversed_post_close") {
          rt.store.put("payoff_settlements", st.id, { status: "reversed_post_close", fnma_liquidated_in_error: true, liquidated_in_error_at: ctx.now, amount_due_to_fnma_cents: r.amount_due_to_fnma_cents }, ctx.actor, ctx.now);
          ctx.events.append({ type: "payoff.reversed", loanId, actor: ctx.actor, payload: { settlement_id: st.id, branch: r.branch, cause: str(i, "cause"), returned_on: r.returned_on, fnma_liquidated_in_error: true, ledger_reopened: false, loan_status: r.loan_status } });
          return { ...r, settlement_id: st.id, escalation_ids: escalationIds, ledger_reversal_set_ids: [], timers_cancelled: [] };
        }
        const reversed = ((st.data.ledger_set_ids as string[] | undefined) ?? []).map((id) => ctx.ledger.reverse(id, r.ledger_reopen_as_of!, `payoff reversed (${str(i, "cause")}) — ledger reopened as of ${r.ledger_reopen_as_of}`, ctx.now).id);
        const ap = payoffActivityPeriod(payoffOn);
        const corr = rt.store.put("investor_events", `${(st.data.removal_event_id as string | undefined) ?? `rm-${loanId}-${st.data.payoff_date}`}-corr`, { loan_id: loanId, family: "removal", kind: "payoff_correction", action_code: "60", correction: true, corrects_event_id: (st.data.removal_event_id as string | undefined) ?? null, effective: r.correcting_removal_event!.effective, activity_period: ap.activity_period, period_end: ap.period_end, due_at_ms: r.correcting_removal_event!.due_at_ms, due_at: toIso(r.correcting_removal_event!.due_at_ms), correction_close_at: toIso(ap.correction_close_ms), status: "projected" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "removal.payoff.correction.projected", loanId, actor: ctx.actor, payload: { event_id: corr.id, corrects_event_id: corr.data.corrects_event_id, due_at: toIso(r.correcting_removal_event!.due_at_ms) } });
        // the exception on the reported removal: arms FNMA_IRM_REMOVAL_CORRECTION_BD2_1700 on the activity period's last day → BD2 17:00 ET of the following month (IRM §4-08)
        const exception = reversalExceptionEvent({ loan_id: loanId, correcting_event_id: corr.id, payoff_on: payoffOn, cause: str(i, "cause") as "returned_item", detected_at_ms: Date.parse(ctx.now) });
        ctx.events.append({ type: exception.type, loanId, actor: ctx.actor, payload: { ...exception.payload, corrects_event_id: corr.data.corrects_event_id, settlement_id: st.id, cause: str(i, "cause") } });
        if (r.refund_stop_pay) { const dId = str(i, "refund_disbursement_id") || String(st.data.overage_refund_disbursement_id); rt.store.put("disbursements", dId, { status: "stop_payment_requested", stop_pay_reason: `payoff reversed ${r.returned_on}` }, ctx.actor, ctx.now); ctx.events.append({ type: "disbursement.stop_pay.requested", loanId, actor: ctx.actor, payload: { disbursement_id: dId, reason: "payoff reversed" } }); }
        for (const t of r.task_reversals) { const row = tasks.find((x) => x.task === t.task); if (row) rt.store.put("payoff_housekeeping_tasks", row.id, { status: "reversed", reversal_action: t.action, reversed_at: ctx.now }, ctx.actor, ctx.now); }
        // rule 6: the timers the payoff armed (housekeeping, remittance, LAR) are cancelled with the tasks — the correction clock above is the one that now runs
        const cancelled = cancelTimers(ctx, loanId, `payoff reversed ${r.returned_on} (${str(i, "cause")}) before the ${toIso(r.correcting_removal_event!.due_at_ms)} close: housekeeping cancelled/reversed (rule 6)`);
        rt.store.put("payoff_settlements", st.id, { status: "reversed_pre_close", payoff_reversed: true, reversed_at: ctx.now, correcting_event_id: corr.id, ledger_reversal_set_ids: reversed, timers_cancelled: cancelled }, ctx.actor, ctx.now);
        if (st.data.funds_id) rt.store.put("payoff_funds", String(st.data.funds_id), { status: "reversed" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.reversed", loanId, actor: ctx.actor, payload: { settlement_id: st.id, branch: r.branch, cause: str(i, "cause"), returned_on: r.returned_on, ledger_reopened_as_of: r.ledger_reopen_as_of, refund_stop_pay: r.refund_stop_pay, tasks_reversed: r.task_reversals.map((t) => t.task), timers_cancelled: cancelled, correcting_event_id: corr.id, correction_close_at: toIso(ap.correction_close_ms) } });
        return { ...r, settlement_id: st.id, correcting_event_id: corr.id, exception_event: exception.payload, ledger_reversal_set_ids: reversed, timers_cancelled: cancelled, escalation_ids: escalationIds };
      }
      need(i, "loan_id", "amount_cents", "payoff_date", "buckets");
      const fundsId = clearedFunds(i, ctx, rt, "postPayoff");
      const b = i.buckets as PayoffBuckets; const amount = cents(i.amount_cents); const absorbed = cents(i.absorbed_shortage_cents); const payoffOn = date(i, "payoff_date"); const a = applyToZero(b, amount + absorbed);   // an absorbed shortage (servicer_absorbed / reliance_absorbed from disposeVariance) is servicer-funded so the loan pays in full
      if (a.held_in_suspense) throw new RangeError(`funds ${a.short_cents} short of the exact figure: held in suspense_items{short_payoff} for the cure window, never applied as a curtailment (rule 5) — run disposeVariance`);
      if (absorbed > 0n && !["servicer_absorbed", "reliance_absorbed"].includes(str(i, "shortage_disposition"))) throw new RangeError("absorbed_shortage_cents needs shortage_disposition servicer_absorbed or reliance_absorbed from disposeVariance");
      const nib = (b.nib_deferred ?? 0n) + (b.nib_forborne ?? 0n); const type = rtype(i); const processedOn = today(ctx);
      const share = str(i, "note_rate_pct") && str(i, "ptr_pct") && str(i, "lpi_due") ? fnmaPayoffShare({ type, upb_cents: b.principal, nib_cents: nib, note_rate_pct: str(i, "note_rate_pct"), ptr_pct: str(i, "ptr_pct"), lpi_due: date(i, "lpi_due"), payoff_on: payoffOn, participation_pct: str(i, "participation_pct") || "100", processed_on: processedOn, reported_on: optDate(i, "reported_on") }) : null;
      const ledger = payoffLedgerSets({ loan_id: loanId, custodial: custodial(i), payoff_on: payoffOn, received_cents: amount, application: a, buydown_cents: b.buydown_credit ?? 0n, share, remittance_type: type, absorbed_shortage_cents: absorbed });
      if (!ledger.balanced) throw new RangeError("payoff ledger sets do not balance");
      const setIds = ledger.sets.map((s) => ctx.ledger.post(s, ctx.now).id);
      const finality = finalityAtMs(payoffOn); const ap = payoffActivityPeriod(payoffOn);
      const id = str(i, "settlement_id") || `ps-${loanId}-${payoffOn}`;
      const rec = rt.store.put("payoff_settlements", id, { loan_id: loanId, payoff_date: payoffOn, processed_at: ctx.now, processed_on: processedOn, activity_period: ap.activity_period, remittance_type: type, participation_pct: str(i, "participation_pct") || "100", upb_cents: b.principal, nib_cents: nib, interest_note_rate_cents: b.accrued_interest, interest_ptr_cents: share?.interest_cents ?? null, servicing_fee_cents: share?.servicing_fee_cents ?? 0n, ss_interest_gap_cents: share?.ss_interest_gap_cents ?? 0n, scheduled_cycle_interest_cents: share?.scheduled_cycle_interest_cents ?? 0n, ss_bd1_bd2_exception: share?.ss_bd1_bd2_exception ?? false, fnma_share_cents: share?.total_cents ?? null,
        fees_collected: Object.fromEntries(a.lines.filter((l) => !["accrued_interest", "principal", "nib_deferred", "nib_forborne"].includes(l.account) && l.cents > 0n).map((l) => [l.account, l.cents])), advances_recovered_cents: b.corporate_advances ?? 0n, fnma_advance_repay_cents: cents(i.fnma_advance_repay_cents), buydown_remit_cents: b.buydown_credit ?? 0n, escrow_balance_cents: a.escrow_refund_pending_cents,
        shortage_cents: a.short_cents + absorbed, shortage_disposition: absorbed > 0n ? str(i, "shortage_disposition") : a.tolerance_expense_cents > 0n ? "waived_tolerance" : "none", tolerance_expense_cents: a.tolerance_expense_cents, absorbed_shortage_cents: absorbed, overage_cents: a.unapplied_cents, ledger_set_ids: setIds, servicer_funded_cents: ledger.servicer_funded_cents, finality_at: toIso(finality), lines: a.lines, zero: a.zero, funds_id: fundsId, amount_received_cents: amount, status: "paid_in_full" }, ctx.actor, ctx.now);
      rt.store.put("payoff_funds", fundsId, { status: "applied", settlement_id: rec.id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "payoff.applied", loanId, actor: ctx.actor, payload: { settlement_id: rec.id, payoff_date: payoffOn, processed_at: ctx.now, activity_period: ap.activity_period, applied_cents: a.applied_cents, tolerance_expense_cents: a.tolerance_expense_cents, overage_cents: a.unapplied_cents } });
      const escrowed = a.escrow_refund_pending_cents > 0n || flag(i, "escrowed");
      ctx.events.append({ type: "loan.paid_in_full", loanId, actor: ctx.actor, payload: { settlement_id: rec.id, payoff_date: payoffOn, funds_received_on: optDate(i, "funds_received_on") ?? payoffOn, remittance_type: type.toLowerCase(), proceeds_cents: share?.total_cents ?? a.applied_cents, escrowed, tax_service: flag(i, "tax_service"), tax_notify: escrowed || flag(i, "tax_service"), autodraft: flag(i, "autodraft"), mi_active: flag(i, "mi_active"), fnma_advance_repay_cents: cents(i.fnma_advance_repay_cents), participation_pct: str(i, "participation_pct") || "100", activity_period: ap.activity_period, finality_at: toIso(finality) } });
      return { settlement_id: rec.id, ...a, share, ledger_set_ids: setIds, servicer_funded_cents: ledger.servicer_funded_cents, activity_period: ap.activity_period, finality_at: toIso(finality) }; }),
    guardrails: [never("NO_POST_BEFORE_CLEARED", "16.2 timer SM_PAYOFF_GOODFUNDS_GATE: no posting before payoff.funds.cleared per the good-funds policy", (i) => i.op !== "reverse" && !str(i, "funds_id"), "name the payoff_funds row the intake cleared (matchPayoffFunds) — a funds_cleared attestation is not evidence"),
      never("NO_SHORT_APPLICATION", "16.2 rule 5: short funds are held in suspense_items{short_payoff} and never applied as a curtailment during the cure window", (i) => i.op !== "reverse" && typeof i.buckets === "object" && i.buckets !== null && applyToZero(i.buckets as PayoffBuckets, cents(i.amount_cents) + cents(i.absorbed_shortage_cents)).held_in_suspense !== null, "run disposeVariance: demand within 1 BD, cure 5 BD, day-30 application per the note"),
      never("NO_RECORDING_COST_NETTING", "F-1-05: the servicer must not net costs for recording the satisfaction out of the proceeds", (i) => flag(i, "net_recording_cost_from_proceeds"), "recording costs are collected only under C-1.2-05 or paid from corporate funds"),
      never("NO_REVERSAL_AFTER_CLOSE", "16.2 guardrail / IRM §4-08 (SVC-2026-03): no reversal of a closed-period payoff — the loan is not reactivated", (i) => i.op === "reverse" && flag(i, "reopen_ledger") && (flag(i, "period_closed") || ((ms(i, "returned_at") ?? 0) > (ms(i, "finality_at") ?? Number.POSITIVE_INFINITY))), "after BD2 17:00 ET the payoff is final: set fnma_liquidated_in_error and escalate to the officer"),
      LLM_NEVER_COMPUTES_MONEY] },
  // ---- rule 4 share by remittance type with the participation percentage; the advance special remittance (rule 7); the S/A–S/S draft dates ------
  { name: "computeFnmaPayoffShare", kind: "write", handler: compute((i, ctx, rt) => { need(i, "type", "upb_cents", "note_rate_pct", "ptr_pct", "lpi_due", "payoff_on");
      const type = (str(i, "type").toUpperCase()) as RemittanceType;
      const share = fnmaPayoffShare({ type, upb_cents: cents(i.upb_cents), nib_cents: cents(i.nib_cents), note_rate_pct: str(i, "note_rate_pct"), ptr_pct: str(i, "ptr_pct"), lpi_due: date(i, "lpi_due"), payoff_on: date(i, "payoff_on"), participation_pct: str(i, "participation_pct") || "100", processed_on: optDate(i, "processed_on") ?? today(ctx), reported_on: optDate(i, "reported_on") });
      const remittance = advanceSpecialRemittance({ payoff_on: date(i, "payoff_on"), fnma_share_cents: share.total_cents, buydown_remit_cents: cents(i.buydown_remit_cents), fnma_advance_repay_cents: cents(i.fnma_advance_repay_cents) });
      const out = { ...share, remittance, draft_on: fnmaDraftDate(type, date(i, "payoff_on")), rail: type === "AA" ? "crs_001" : "fnma_initiated_draft_from_lar" };
      if (str(i, "settlement_id") && rt.store.get("payoff_settlements", str(i, "settlement_id"))) rt.store.put("payoff_settlements", str(i, "settlement_id"), { fnma_share_cents: share.total_cents, interest_ptr_cents: share.interest_cents, servicing_fee_cents: share.servicing_fee_cents, ss_interest_gap_cents: share.ss_interest_gap_cents, scheduled_cycle_interest_cents: share.scheduled_cycle_interest_cents, participation_pct: share.participation_pct, fnma_advance_repay_cents: remittance.crs_352_cents, buydown_remit_cents: cents(i.buydown_remit_cents), crs_001_cents: remittance.crs_001_cents, special_remit_by: remittance.special_remit_by, draft_on: out.draft_on }, ctx.actor, ctx.now);
      return out; }),
    guardrails: [LLM_NEVER_COMPUTES_MONEY] },
  // ---- CRS batch (fnma-crs; UI upload by the fnma_portal_operator) and the draft settlement confirmation (CRS notifications / 6.3 match) --------
  { name: "buildCrsBatch", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "confirm") {
        need(i, "loan_id", "settlement_id", "amount_cents", "settled_on");
        const st = rt.store.require("payoff_settlements", str(i, "settlement_id")); const code = str(i, "crs_code") || null; const type = String(st.data.remittance_type ?? rtype(i)).toLowerCase();
        const expected = code === "352" ? cents(st.data.fnma_advance_repay_cents) : cents(st.data.fnma_share_cents) + cents(st.data.buydown_remit_cents);
        if (cents(i.amount_cents) !== expected) throw new RangeError(`draft ${cents(i.amount_cents)} ≠ payoff_settlements ${expected} (${code ?? type}) — classify the variance in 6.3 before confirming`);
        const rem = rt.store.put("remittances", str(i, "remittance_id") || `rem-${st.id}-${code ?? type}`, { loan_id: str(i, "loan_id"), settlement_id: st.id, crs_code: code, remittance_type: type, amount_cents: cents(i.amount_cents), settled_on: date(i, "settled_on"), bank_reference: str(i, "bank_reference") || null, status: "settled" }, ctx.actor, ctx.now);
        if (code !== "352") rt.store.put("payoff_settlements", st.id, { status: "remitted", remittance_id: rem.id, remitted_on: date(i, "settled_on") }, ctx.actor, ctx.now);
        else { const task = rt.store.get("payoff_housekeeping_tasks", `${st.id}-fnma_advance_repay`); if (task) rt.store.put("payoff_housekeeping_tasks", task.id, { status: "completed", completed_at: ctx.now, evidence_document_id: str(i, "bank_reference") || rem.id }, ctx.actor, ctx.now); }
        ctx.events.append({ type: "payoff.remittance.settled", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { settlement_id: st.id, remittance_id: rem.id, crs_code: code, remittance_type: type, amount_cents: cents(i.amount_cents), settled_on: date(i, "settled_on") } });
        return rem.data;
      }
      need(i, "lender_id", "settlements");
      const settlements = i.settlements as SettlementRow[]; const at = ms(i, "instructed_at") ?? Date.parse(ctx.now);
      if (!settlements.length) throw new RangeError("settlements: nothing to instruct");
      for (const s of settlements) {
        const sid = s.settlement_id ?? `ps-${s.loan_id}-${s.payoff_on}`; const stored = rt.store.get("payoff_settlements", sid);
        if (!stored) throw new RangeError(`no payoff_settlements row ${sid} for ${s.loan_id}: CRS amounts must equal payoff_settlements values`);
        if (stored.data.fnma_share_cents === undefined || stored.data.fnma_share_cents === null) throw new RangeError(`payoff_settlements ${sid} carries no fnma_share_cents: run computeFnmaPayoffShare first`);
        if (cents(stored.data.fnma_share_cents) !== s.fnma_share_cents) throw new RangeError(`CRS amount ${s.fnma_share_cents} ≠ payoff_settlements ${String(stored.data.fnma_share_cents)} for ${s.loan_id}`);
        if ((s.fnma_advance_repay_cents ?? 0n) !== cents(stored.data.fnma_advance_repay_cents)) throw new RangeError(`CRS 352 amount ${String(s.fnma_advance_repay_cents ?? 0n)} ≠ payoff_settlements ${String(cents(stored.data.fnma_advance_repay_cents))} for ${s.loan_id}`);
      }
      const b = crsBatch({ lender_id: str(i, "lender_id"), instructed_at_ms: at, settlements });
      const rec = rt.store.put("crs_batches", str(i, "batch_id") || `crs-${b.batch_on}-${rt.store.list("crs_batches").length + 1}`, { lender_id: str(i, "lender_id"), batch_on: b.batch_on, settlement_on: b.settlement_on, control_total_cents: b.control_total_cents, lines: b.lines, before_cutoff: b.before_cutoff, instructed_at: toIso(at), status: "prepared" }, ctx.actor, ctx.now);
      for (const l of b.lines) { const s = settlements.find((x) => x.fnma_loan_number === l.loan_number); ctx.events.append({ type: l.code === "001" ? "payoff.remittance.instructed" : "remittances.instructed", loanId: s?.loan_id ?? ctx.loanId, actor: ctx.actor, payload: { batch_id: rec.id, settlement_id: s?.settlement_id ?? null, crs_code: l.code, amount_cents: l.amount_cents, settlement_on: l.settlement_on, instructed_at: toIso(at) } }); }
      const task = rt.escalations.open({ kind: "human_portal_task", loanId: ctx.loanId, payload: { role: b.upload_task.role, batch_id: rec.id, package: b.upload_task.package, cut_off: zonedEpochMs(b.batch_on, "16:00", ET) }, ownerRole: "fnma_portal_operator", batchId: rec.id }, ctx.actor);
      return { batch_id: rec.id, portal_task_id: task.id, ...b }; }),
    guardrails: [never("ADVANCES_NEVER_IN_PROCEEDS", "F-1-09: the repayment of advances must not be included as part of the payoff proceeds", (i) => flag(i, "include_advances_in_001"), "advances go by special remittance (CRS 352) within 30 days"),
      never("CRS_EQUALS_SETTLEMENT", "16.2 guardrail: CRS amounts must equal payoff_settlements values", (i) => i.override_cents !== undefined || i.amount_adjustment_cents !== undefined || i.control_total_override_cents !== undefined, "correct payoff_settlements first; the batch is built from the stored share"),
      LLM_NEVER_COMPUTES_MONEY] },
  // ---- LAR 96 action code 60 via investor-reporting: projected from cleared funds, NIB validated locally, submitted (`removal.payoff`), acknowledged (LSDU ack ingestion) ----------
  { name: "projectRemovalPayoff", kind: "act", handler: compute((i, ctx, rt) => {
      const loanId = str(i, "loan_id");
      if (i.op === "submit") {
        need(i, "loan_id", "event_id"); const ev = rt.store.require("investor_events", str(i, "event_id"));
        if (ev.data.correction === true && Date.parse(ctx.now) > Date.parse(String(ev.data.correction_close_at ?? ev.data.due_at))) throw new RangeError(`correction ${ev.id} submitted after the BD2 17:00 ET close ${String(ev.data.correction_close_at ?? ev.data.due_at)}: the action code 60 is final (IRM §4-08) — coordinate with the Investor Reporting Representative (5.3)`);
        const rec = rt.store.put("investor_events", ev.id, { status: "submitted", submitted_at: ctx.now, channel: str(i, "channel") || "lsdu" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "investor_events.submitted", loanId, actor: ctx.actor, payload: { event_id: rec.id, event_type: "removal.payoff", family: "removal", status: "submitted", action_code: "60", correction: rec.data.correction === true, corrects_event_id: rec.data.corrects_event_id ?? null, submitted_at: ctx.now, principal_cents: cents(rec.data.principal_cents), interest_cents: cents(rec.data.interest_cents) } });   // 5.1/5.3's submission event: satisfies FNMA_IRM_PAYOFF_AC60_NEXTBD_2000
        return { event_id: rec.id, status: "submitted", submitted_at: ctx.now };
      }
      if (i.op === "accept") {
        // inbound LSDU acknowledgment (fnma-lsdu acks and exceptions): validated against the stored event and the period close before anything is appended
        need(i, "loan_id", "event_id", "ack_reference"); const ev = rt.store.require("investor_events", str(i, "event_id"));
        if (String(ev.data.loan_id) !== loanId) throw new RangeError(`investor event ${ev.id} belongs to ${String(ev.data.loan_id)}, not ${loanId}`);
        const acceptedAt = ms(i, "accepted_at") ?? Date.parse(ctx.now);
        const finality = ev.data.correction_close_at ? Date.parse(String(ev.data.correction_close_at)) : finalityAtMs(D(String(ev.data.action_date ?? ev.data.effective)));
        const r = acceptRemovalAck({ event_status: String(ev.data.status), correction: ev.data.correction === true, corrects_event_id: (ev.data.corrects_event_id as string | null | undefined) ?? null, ack_reference: str(i, "ack_reference"), accepted_at_ms: acceptedAt, finality_at_ms: finality });
        if (ev.data.status === "accepted") return { event_id: ev.id, status: "accepted", accepted_at: ev.data.accepted_at, supersedes_event_id: r.supersedes_event_id };
        const rec = rt.store.put("investor_events", ev.id, { status: "accepted", accepted_at: toIso(acceptedAt), ack_reference: str(i, "ack_reference"), ack_channel: str(i, "channel") || "lsdu" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "investor_events.accepted", loanId, actor: ctx.actor, payload: { event_id: rec.id, event_type: "removal.payoff", family: "removal", status: "accepted", action_code: "60", correction: rec.data.correction === true, ack_reference: str(i, "ack_reference"), accepted_at: toIso(acceptedAt) } });
        if (r.supersedes_event_id) {
          // the correcting LAR 60 accepted before BD2 17:00 ET supersedes the original: `investor_events.resolved{status=superseded, family=removal}` closes FNMA_IRM_REMOVAL_CORRECTION_BD2_1700
          const orig = rt.store.get("investor_events", r.supersedes_event_id);
          if (orig) rt.store.put("investor_events", orig.id, { status: "superseded", superseded_by: rec.id, superseded_at: toIso(acceptedAt) }, ctx.actor, ctx.now);
          ctx.events.append({ type: "investor_events.resolved", loanId, actor: ctx.actor, payload: { event_id: r.supersedes_event_id, status: "superseded", family: "removal", event_type: "removal.payoff", superseded_by: rec.id, ack_reference: str(i, "ack_reference"), resolved_at: toIso(acceptedAt), activity_period: rec.data.activity_period ?? null } });
          const st = rt.store.list("payoff_settlements", (d) => d.correcting_event_id === rec.id)[0]; if (st) rt.store.put("payoff_settlements", st.id, { correction_accepted_at: toIso(acceptedAt), removal_event_id: rec.id }, ctx.actor, ctx.now);
        }
        return { event_id: rec.id, status: "accepted", accepted_at: toIso(acceptedAt), supersedes_event_id: r.supersedes_event_id, accepted_on: r.accepted_on };
      }
      need(i, "loan_id", "fnma_loan_number", "principal_cents", "interest_cents", "payoff_date");
      const fundsId = clearedFunds(i, ctx, rt, "projectRemovalPayoff (removal.payoff)");
      const lar60 = lar60Removal({ upb_cents: cents(i.principal_cents), nib_cents: i.nib_cents === undefined || i.nib_cents === null ? null : cents(i.nib_cents), interest_cents: cents(i.interest_cents), participation_pct: str(i, "participation_pct") || "100" });   // T8: local validation blocks submission when NIB is omitted
      const payoffOn = date(i, "payoff_date"); const processedMs = ms(i, "processed_at") ?? Date.parse(ctx.now);
      const lar = projectLar96(str(i, "servicer_number") || "0", str(i, "fnma_loan_number"), { lpi_date: optDate(i, "lpi_date"), upb_cents: 0n, nib_cents: cents(i.nib_cents), interest_cents: lar60.interest_cents, principal_cents: lar60.principal_cents, other_fees_cents: 0n, action_code: "60", action_date: payoffOn });
      const dueMs = lar60DueMs(processedMs); const ap = payoffActivityPeriod(payoffOn);   // IRM §2-04: next fannie_et BD 20:00 ET, 17:00 ET when that day is BD2
      const rec = rt.store.put("investor_events", str(i, "event_id") || `rm-${loanId}-${payoffOn}`, { loan_id: loanId, family: "removal", kind: "payoff", action_code: "60", action_date: payoffOn, principal_cents: lar60.principal_cents, interest_cents: lar60.interest_cents, nib_cents: cents(i.nib_cents), lar96: lar.record, funds_id: fundsId, activity_period: ap.activity_period, period_end: ap.period_end, correction_close_at: toIso(ap.correction_close_ms), due_at_ms: dueMs, due_at: toIso(dueMs), status: "projected" }, ctx.actor, ctx.now);
      if (str(i, "settlement_id") && rt.store.get("payoff_settlements", str(i, "settlement_id"))) rt.store.put("payoff_settlements", str(i, "settlement_id"), { removal_event_id: rec.id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "removal.payoff.projected", loanId, actor: ctx.actor, payload: { event_id: rec.id, due_at_ms: dueMs, due_at: toIso(dueMs), activity_period: ap.activity_period, principal_cents: lar60.principal_cents, interest_cents: lar60.interest_cents } });
      return { event_id: rec.id, lar96: lar, lar60, lar60_due_ms: dueMs, lar60_due_at: toIso(dueMs), activity_period: ap.activity_period, correction_close_at: toIso(ap.correction_close_ms) }; }),
    guardrails: [never("NO_REMOVAL_WITHOUT_CLEARED_FUNDS", "16.2 guardrail: no removal.payoff without payoff.funds.cleared", (i) => i.op !== "submit" && i.op !== "accept" && !str(i, "funds_id"), "the good-funds gate blocks the LAR 60: name the payoff_funds row the intake cleared (a funds_cleared attestation is not evidence)"),
      never("NO_CORRECTION_AFTER_CLOSE", "IRM §4-08 / SVC-2026-03: no update to an action code 60 after the period closes — the loan is not reactivated", (i) => (i.op === "submit" || i.op === "accept") && flag(i, "period_closed"), "after BD2 17:00 ET the payoff is final: fnma_liquidated_in_error and the officer decide funding (5.3 open question 2)"),
      LLM_NEVER_COMPUTES_MONEY] },
  // ---- rule 9 housekeeping fan-out, completion with evidence (closes the per-task timers), the 2.3 autodraft termination, the paid-in-full letter, the 3.3 short-year statement ----
  { name: "createHousekeepingTasks", kind: "write", handler: compute(async (i, ctx, rt) => {
      const loanId = str(i, "loan_id"); const sid = str(i, "settlement_id");
      if (i.op === "complete") {
        need(i, "settlement_id", "loan_id", "task");
        const row = rt.store.require("payoff_housekeeping_tasks", `${sid}-${str(i, "task")}`); const task = str(i, "task") as HousekeepingTask;
        if (row.data.status === "reversed" || row.data.status === "cancelled") throw new RangeError(`housekeeping task ${task} is ${String(row.data.status)} (payoff reversed): nothing to complete`);
        const extra: Record<string, unknown> = {}; let evidence = str(i, "evidence_document_id");
        if (task === "autodraft_stop") {
          const enr = str(i, "enrollment_id") ? rt.store.get("autodraft_enrollments", str(i, "enrollment_id")) : undefined;
          const stop = autodraftStop({ payoff_on: D(String(row.data.due_on ?? i.payoff_date ?? ctx.now.slice(0, 10))), next_draft_on: enr?.data.next_draft_on ? D(String(enr.data.next_draft_on)) : optDate(i, "next_draft_on"), enrollment_status: String(enr?.data.status ?? str(i, "enrollment_status") ?? "active"), file_transmitted_on: optDate(i, "file_transmitted_on") });
          if (!stop.transition.ok && stop.transition.code !== "TERMINAL") throw new RangeError(`autodraft enrollment cannot be terminated: ${stop.transition.reason}`);
          if (enr) rt.store.put("autodraft_enrollments", enr.id, { status: stop.status, terminated_on: stop.terminate_on, termination_reason: "payoff", next_draft_on: null }, ctx.actor, ctx.now);
          ctx.events.append({ type: "autodraft.enrollment.terminated", loanId, actor: ctx.actor, payload: { enrollment_id: enr?.id ?? (str(i, "enrollment_id") || null), reason: "payoff", terminated_on: stop.terminate_on, stop_entry: stop.stop_entry, debit_risk: stop.debit_risk } });
          Object.assign(extra, { autodraft: stop });
        }
        if (task === "escrow_refund" && str(i, "disbursement_id")) ctx.events.append({ type: "disbursement.issued", loanId, actor: ctx.actor, payload: { disbursement_id: str(i, "disbursement_id"), kind: "payoff_refund", amount_cents: cents(i.amount_cents), settlement_id: sid } });
        if (task === "short_year_statement") { need(i, "statement_document_id"); evidence = evidence || str(i, "statement_document_id"); ctx.events.append({ type: "escrow.statement.sent", loanId, actor: ctx.actor, payload: { statement_type: "short_year_payoff", settlement_id: sid, statement_document_id: str(i, "statement_document_id"), sent_on: today(ctx) } }); }   // 3.3's REGX_1024_17I4_SHORT_YEAR_PAYOFF_60
        if (task === "paid_in_full_letter") {
          // NTC_PAYOFF_PAID_IN_FULL from the settlement row and the escrow-refund calculator (payoff date, amounts applied, §1024.34(b)(1)/§1024.17(i)(4)(ii) dates), never the caller's figures
          const st = rt.store.require("payoff_settlements", sid).data; const recipients = recipientsOf(i); if (!recipients.length) throw new RangeError("recipients: the borrower of record (or confirmed successor)");
          if (st.zero !== true || st.status === "reversed_pre_close" || st.status === "reversed_post_close") throw new RangeError(`paid-in-full letter needs a settlement posted to zero (payoff_settlements ${sid} is ${String(st.status)})`);
          const payoffOn = D(String(st.payoff_date)); const escrowBal = cents(st.escrow_balance_cents); const refund = escrowRefund({ loan_id: loanId, custodial_ti: custodial(i).ti, payoff_on: payoffOn, escrow_balance_cents: escrowBal });
          const lines = ((st.lines as { account: string; cents: bigint }[] | undefined) ?? []).filter((l) => l.cents > 0n);
          const applied = lines.reduce((t, l) => t + l.cents, 0n); const year = Number(payoffOn.slice(0, 4));
          const letter = (i.letter as Record<string, unknown> | undefined) ?? {};
          need(letter as ToolInput, "release_county", "release_days", "release_cite", "release_by");
          const payload = { ...LETTER_CONSTANTS, ...letter, notice_date: today(ctx), account_last4: str(i, "account_last4") || loanId.slice(-4), borrower_name: str(i, "borrower_name") || recipients[0]!.name, property_address: str(i, "property_address") || String(letter.property_address ?? ""),
            payoff_date: payoffOn, amount_received_cents: cents(st.amount_received_cents) || applied, applied: lines.map((l) => ({ label: LINE_LABEL[l.account] ?? l.account, cents: l.cents })), amount_applied_cents: applied, balance_after_cents: 0n,
            escrowed: escrowBal > 0n, escrow_refund_cents: refund.refund_cents, escrow_refund_by: refund.due_by, short_year_statement_by: refund.short_year_statement_by, mi_active: flag(i, "mi_active"), autodraft: flag(i, "autodraft"), interest_1098_cents: cents(st.interest_note_rate_cents), tax_year: year, tax_year_next: year + 1 };
          const n = await sendNotice(ctx, rt, loanId, "NTC_PAYOFF_PAID_IN_FULL", payload, recipients);
          evidence = evidence || n.notice_id || `notice:${n.template}:${n.sent}`; Object.assign(extra, { notice: n, escrow_refund_by: refund.due_by, short_year_statement_by: refund.short_year_statement_by });
        }
        if (!evidence) throw new RangeError("evidence_document_id is required");
        const rec = rt.store.put("payoff_housekeeping_tasks", row.id, { status: "completed", completed_at: ctx.now, evidence_document_id: evidence }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.housekeeping.completed", loanId, actor: ctx.actor, payload: { settlement_id: sid, task, evidence_document_id: evidence, completed_at: ctx.now } });
        return { ...rec.data, ...extra };
      }
      need(i, "settlement_id", "loan_id", "payoff_date");
      const rows = housekeepingTasks({ payoff_on: date(i, "payoff_date"), escrowed: flag(i, "escrowed"), mi_active: flag(i, "mi_active"), autodraft: flag(i, "autodraft"), fnma_advance_repay_cents: cents(i.fnma_advance_repay_cents), buydown_remit_cents: cents(i.buydown_remit_cents), enote: flag(i, "enote"), lpi_active: flag(i, "lpi_active"), tax_service: flag(i, "tax_service") });
      const out = rows.map((r) => rt.store.put("payoff_housekeeping_tasks", `${sid}-${r.task}`, { settlement_id: sid, loan_id: loanId, ...r }, ctx.actor, ctx.now).data);
      ctx.events.append({ type: "payoff.housekeeping.created", loanId, actor: ctx.actor, payload: { settlement_id: sid, tasks: rows.map((r) => r.task) } });
      return out; }),
    guardrails: [never("EVIDENCE_CLOSES_TASK", "16.2 audit and evidence: housekeeping task evidence (insurer acks, tracker acks, tax-service confirmations, refund disbursements) closes the task", (i) => i.op === "complete" && flag(i, "skip_evidence"), "attach the evidence document")] },
]);
