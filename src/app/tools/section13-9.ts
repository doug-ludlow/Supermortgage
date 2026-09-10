/**
 * §13.9 process-owned tool paths. 13.9 names no tools of its own in agents.json (`TOOLS_13_9` stays empty;
 * src/app/tools.test.ts refuses any other name for the process), so the SCRA rate-cap ops ride on the 13.8 tool
 * `scra.case.get/open/close` — the 13.8 block of ./section13.ts delegates unknown ops to `scraCaseOps_13_9` and calls
 * `scraPeriodEnded_13_9` from op=close. Each op validates through src/domain/foreclosure/ops-13-9.ts and appends the
 * events the process's registry rows arm on and are satisfied by (a bare literal never stands in for an emitter):
 *   op=rate_request      scra.request.received{sufficient_evidence, received_on, basis, within_statutory_window, honored}
 *                        (+ scra.orders.requested and an attorney escalation on a written assertion without evidence — T9)
 *   op=rate_decline      scra.rate_request.declined (attorney only)
 *   op=rate_activate     scra.rate_reduction.applied{…} · scra.recalculation.completed{forgiven_cents} · scra.subsidy.activated ·
 *                        scra.relief.started{kind=interest_rate_cap} · late_charges.waived · notice.sent{template=NTC_SCRA_3937_RATE_CONFIRMATION} ·
 *                        notice.sent{template=NTC_SCRA_3937_OVERPAYMENT_ELECTION} + the rule-7 ledger sets and a `loan_terms` version
 *   op=form_1022_sent    form_1022.sent{channel, due_by} (+ fnma.upload.submitted{kind=form_1022} for MBS)
 *   op=fnma_ack          form_1022.acknowledged · fnma.upload.accepted{kind=form_1022} · investor.event.accepted{kind=lar_83} (inbound acks)
 *   op=arm_adjustment    arm.adjustment.scheduled{scra_cap_active=true, scheduled_on} · investor.event.submitted{kind=lar_83}
 *   op=subsidy_recalc    scra.subsidy.recalculated (+ the annual letter and a Form 1022 payment-change row)
 *   op=custodial_receipt custodial.receipt.matched{kind=scra_subsidy} / custodial.receipt.exception (designated custodial account feed)
 *   op=election          scra.overpayment.elected{election} · scra.overpayment.election_recorded (+ ledger set, statement line)
 *   op=election_lapse    the default election (decision 13.9-3) after 30 days: the same events with defaulted=true + the borrower letter
 *   op=rate_end_letter   notice.sent{template=NTC_SCRA_3937_RATE_END} 60 days before restoration
 *   op=restore           scra.rate_reduction.ended · scra.rate.restored (+ Form 1022 restoration row, loan_terms version)
 *   op=rate_period       read: the loan's period, recalculations, submissions, election and open timers
 * Money math is code: every figure comes from the loan's baseline `loan_terms`, the 2.7 `fees` rows and the calculators;
 * a money field on the input is refused.
 */
import { str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import type { AccountRef, LoanAccount, CorporateAccount, CustodialAccount } from "../../kernel/ledger/ledger.ts";
import type { Recipient } from "../../notices/channel.ts";
import type { Posting } from "../../domain/foreclosure/ops.ts";
import { rateRequest, declineRequest, activateRatePeriod, form1022Submission, ingestFnmaAck, armAdjustmentDuringCap, subsidyReadjustment, custodialReceiptMatch, recordElection, electionLapse, periodEnded, rateEndLetter, restoreRate, monthlyDifferential, DEFAULT_METHOD, type EmittedEvent, type CapMethod } from "../../domain/foreclosure/ops-13-9.ts";
import { capEffectivePaymentDue, restorationInstallment } from "../../domain/foreclosure/scra.ts";

export const TOOLS_13_9: readonly ToolDef[] = [];

type Row = Record<string, unknown>;
const todayOf = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && v.length >= 10 ? D(v.slice(0, 10)) : null);
const optStr = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const big = (v: unknown): bigint => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const append = (ctx: CommandContext, loanId: string, e: EmittedEvent): void => { ctx.events.append({ type: e.type, loanId, actor: ctx.actor, payload: e.payload }); };
const loanRows = (rt: ToolRuntime, kind: string, loanId: string) => rt.store.list(kind).filter((r) => r.data.loan_id === loanId);

/** 13.9 guardrail "money math is code; the model never edits amounts": a money figure on the input is refused (op=custodial_receipt takes the bank feed's `amount_cents` — the bank's record, not the agent's). */
const MONEY_INPUT_FIELDS = ["forgiven_cents", "overpayment_cents", "upb_cents", "pi_cents", "new_payment_cents", "capped_pi_cents", "restored_pi_cents", "expected_cents", "late_charges_waived_cents", "servicing_fee_cents", "fnma_differential_cents"] as const;
const refuseMoney = (i: ToolInput): void => { const k = MONEY_INPUT_FIELDS.find((f) => i[f] !== undefined); if (k) throw new RangeError(`${k} is not an input — money math is code; the handler computes it from loan_terms, the fees rows and the calculators (13.9 guardrail)`); };

// ---- ledger account mapping (rule 7; accounts named by the spec's Operational prerequisites) ----
const LOAN_SIDE = new Set(["scra_overpayment_payable", "late_charges", "principal", "suspense_unapplied", "installments_due", "interest_due"]);
const CUSTODIAL_SIDE = new Set(["custodial_mi_cash"]);
const acct = (rt: ToolRuntime, loanId: string, account: string): AccountRef => {
  if (LOAN_SIDE.has(account)) return { scope: "loan", loanId, account: (account === "installments_due" ? "suspense_unapplied" : account) as LoanAccount };
  if (CUSTODIAL_SIDE.has(account)) { const mi = rt.store.list("custodial_accounts").find((r) => r.data.purpose === "military_indulgence"); return { scope: "custodial", custodialAccountId: mi?.id ?? "military_indulgence", account: account as CustodialAccount }; }
  return { scope: "corporate", account: (account === "cash" ? "corporate_cash" : account) as CorporateAccount };
};
const postSet = (ctx: CommandContext, rt: ToolRuntime, loanId: string, description: string, postings: readonly Posting[]): string | null => {
  if (postings.length === 0) return null;
  const set = ctx.ledger.post({ effectiveDate: todayOf(ctx), description, lines: postings.map((p) => ({ account: acct(rt, loanId, p.account), amountCents: p.debit - p.credit, ruleRef: p.rule_ref })) }, ctx.now);
  return set.id;
};

// ---- loan facts (the loan row, the baseline loan_terms version, the 2.7 fees rows) ----
interface LoanFacts { readonly loan: Row; readonly terms: Row & { id: string }; readonly original_principal_cents: bigint; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_due: PlainDate; readonly pi_cents: bigint; readonly next_due_on: PlainDate; readonly mbs: boolean; readonly product: string; readonly origination_on: PlainDate | null; }
const loanFacts = (rt: ToolRuntime, i: ToolInput, loanId: string): LoanFacts => {
  const loan = rt.store.get("loans", loanId)?.data ?? {};
  const baseline = loanRows(rt, "loan_terms", loanId).filter((r) => !r.data.rate_override_kind && r.data.status !== "superseded").map((r) => ({ ...(r.data as Row), id: r.id } as Row & { id: string })).sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0];
  if (!baseline) throw new RangeError(`no baseline loan_terms row for loan ${loanId} — the recalculation needs the original schedule (money math is code)`);
  const nextDue = dateOf(loan.next_due_on) ?? dateOf(loan.next_due_date) ?? dateOf(i.next_due_on);
  if (!nextDue) throw new RangeError("loans.next_due_on is required — the first unpaid installment bounds the paid-at-note-rate run");
  const fpd = dateOf(baseline.first_payment_due); if (!fpd) throw new RangeError("loan_terms.first_payment_due is required");
  const product = String(loan.product ?? loan.amortization_type ?? baseline.product ?? "fixed").toLowerCase();
  const mbs = flag(i, "mbs") || ["mbs", "scheduled_scheduled"].includes(String(loan.pool_type ?? loan.remittance_type ?? "").toLowerCase());
  return { loan, terms: baseline, original_principal_cents: big(baseline.original_principal_cents ?? baseline.original_upb_cents), note_rate_pct: String(baseline.note_rate_pct ?? baseline.note_rate ?? ""), term_months: Number(baseline.term_months ?? 0), first_payment_due: fpd, pi_cents: big(baseline.pi_cents), next_due_on: nextDue, mbs, product: product.includes("arm") ? "arm" : product, origination_on: dateOf(loan.origination_date) ?? dateOf(loan.note_date) ?? dateOf(i.origination_on) };
};
const lateCharges = (rt: ToolRuntime, loanId: string) => loanRows(rt, "fees", loanId).filter((r) => r.data.fee_type === "late_charge" && !r.data.waived_at && big(r.data.waived_cents) === 0n).map((r) => { const amount = big(r.data.amount_cents); const collected = big(r.data.collected_cents); return { fee_id: r.id, assessed_on: dateOf(r.data.assessed_on) ?? D("1970-01-01"), cents: collected > 0n ? collected : amount, paid: collected >= amount && amount > 0n }; });
const latestDmdcStatus = (rt: ToolRuntime, loanId: string): "Y" | "N" | "Z" | null => { const v = loanRows(rt, "scra_verifications", loanId).sort((a, b) => (String(a.data.status_date ?? "") < String(b.data.status_date ?? "") ? 1 : -1))[0]; const s = v?.data.on_active_duty; return s === "Y" || s === "N" || s === "Z" ? s : null; };
const scraCase = (rt: ToolRuntime, loanId: string): Row | null => loanRows(rt, "scra_cases", loanId).map((r) => r.data).sort((a, b) => (String(a.service_begin_on ?? "") < String(b.service_begin_on ?? "") ? 1 : -1))[0] ?? null;
const periodFor = (rt: ToolRuntime, i: ToolInput, loanId: string): (Row & { id: string }) | null => {
  const pid = optStr(i.period_id); if (pid) { const r = rt.store.get("scra_rate_periods", pid); return r && r.data.loan_id === loanId ? { ...r.data, id: r.id } : null; }
  return loanRows(rt, "scra_rate_periods", loanId).map((r) => ({ ...(r.data as Row), id: r.id } as Row & { id: string })).sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0))[0] ?? null;
};
const requirePeriod = (rt: ToolRuntime, i: ToolInput, loanId: string): Row & { id: string } => { const p = periodFor(rt, i, loanId); if (!p) throw new RangeError(`no SCRA rate period on loan ${loanId} — op=rate_request first`); return p; };
const recipients = (rt: ToolRuntime, i: ToolInput, loanId: string): Recipient[] => {
  const given = Array.isArray(i.recipients) ? (i.recipients as Row[]) : [];
  if (given.length) return given.map((r) => ({ partyId: String(r.party_id ?? r.partyId ?? ""), name: String(r.name ?? ""), mailingAddress: optStr(r.mailing_address ?? r.mailingAddress) }));
  const loan = rt.store.get("loans", loanId)?.data ?? {};
  return loan.borrower_party_id ? [{ partyId: String(loan.borrower_party_id), name: String(loan.borrower_name ?? "Borrower"), mailingAddress: optStr(loan.mailing_address) }] : [];
};
/** Renders and sends through the Notice Registry when it is wired (its `notice.sent{template}` is the timer event); otherwise the tool's own `notice.sent{template, sent}` records the send. */
async function sendNotice(ctx: CommandContext, rt: ToolRuntime, loanId: string, template: string, payload: Record<string, unknown>, to: readonly Recipient[]): Promise<{ notice_id: string | null; template: string; sent: PlainDate }> {
  const sent = todayOf(ctx);
  if (rt.notices) { const n = rt.notices.render({ templateCode: template, loanId, recipients: to, payload, asOf: sent }); const out = await rt.notices.send(n.id, {}); return { notice_id: out.id, template, sent }; }
  ctx.events.append({ type: "notice.sent", loanId, actor: ctx.actor, payload: { template, notice_id: null, recipients: to.map((r) => ({ party_id: r.partyId, name: r.name })), sent, sent_at: ctx.now, ...payload } });
  return { notice_id: null, template, sent };
}

/** 13.8 op=close → `scra.period.ended`: the loan's active rate period enters its one-year tail (rule 9). */
export function scraPeriodEnded_13_9(ctx: CommandContext, rt: ToolRuntime, loanId: string, serviceEndOn: PlainDate): string | null {
  const p = loanRows(rt, "scra_rate_periods", loanId).map((r) => ({ ...(r.data as Row), id: r.id } as Row & { id: string })).find((r) => r.status === "active");
  if (!p) return null;
  const t = periodEnded({ period_id: p.id, status: String(p.status), service_end_on: serviceEndOn }); if (!t) return null;
  rt.store.put("scra_rate_periods", p.id, { status: "tail", service_end_on: serviceEndOn, cap_ends_on: t.cap_ends_on, restoration_due: t.restoration_due, end_letter_due: t.end_letter_due }, ctx.actor, ctx.now);
  append(ctx, loanId, t.event);
  return p.id;
}

/** The 13.9 ops of `scra.case.get/open/close`; `undefined` means "not one of mine" so the section's handler can raise its own RangeError for an unknown op. */
export function scraCaseOps_13_9(op: string, i: ToolInput, ctx: CommandContext, rt: ToolRuntime, loanId: string, caseId: string): unknown {
  if (op === "rate_period") {
    const p = periodFor(rt, i, loanId); if (!p) return null;
    return { ...p, recalculations: loanRows(rt, "scra_recalculations", loanId).filter((r) => r.data.period_id === p.id).map((r) => r.data), submissions: loanRows(rt, "form_1022_submissions", loanId).filter((r) => r.data.period_id === p.id).map((r) => ({ ...(r.data as Row), id: r.id } as Row & { id: string })), election: rt.store.list("scra_overpayment_elections").find((r) => r.data.period_id === p.id)?.data ?? null, timers: ctx.timers.forSubject("loan", loanId).filter((t) => t.status === "armed" || t.status === "breached").map((t) => ({ code: t.code, status: t.status, due_date: t.dueDate ?? null })) };
  }
  if (op === "rate_request") {
    refuseMoney(i);
    const f = loanFacts(rt, i, loanId); const sc = scraCase(rt, loanId);
    const begin = dateOf(i.service_begin_on) ?? dateOf(sc?.service_begin_on); if (!begin) throw new RangeError("service_begin_on is required (the orders' call-up date or the 13.8 case)");
    const r = rateRequest({ loan_id: loanId, received_on: dateOf(i.received_on) ?? todayOf(ctx), channel: str(i, "channel") || "mail", written_notice: i.written_notice !== false && str(i, "channel") !== "call", orders_document_id: optStr(i.orders_document_id), dmdc_certificate_id: optStr(i.dmdc_certificate_id), form_180_document_id: optStr(i.form_180_document_id), dmdc_status_on_file: latestDmdcStatus(rt, loanId), origination_on: f.origination_on, service_begin_on: begin, service_end_on: dateOf(i.service_end_on) ?? dateOf(sc?.service_end_on), note_rate_pct: f.note_rate_pct });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const prior = loanRows(rt, "scra_rate_periods", loanId); const open = prior.find((p) => ["requested", "active", "tail"].includes(String(p.data.status)));
    if (open) throw new RangeError(`loan ${loanId} already has a ${open.data.status} SCRA rate period ${open.id}`);
    const id = optStr(i.period_id) ?? (prior.length ? `srp-${loanId}-${prior.length + 1}` : `srp-${loanId}`);
    const rec = rt.store.put("scra_rate_periods", id, { loan_id: loanId, scra_case_id: sc?.case_id ?? caseId, seq: prior.length + 1, basis: r.basis, notice_received_on: r.events[0]!.payload.received_on, service_begin_on: begin, cap_effective_payment_due: r.cap_effective_payment_due, statutory_effective_on: r.statutory_effective_on, service_end_on: dateOf(i.service_end_on) ?? dateOf(sc?.service_end_on), cap_ends_on: r.cap_ends_on, method: (str(i, "method") || DEFAULT_METHOD) as CapMethod, pre_cap_rate: f.note_rate_pct, capped_rate: null, pre_cap_pi_cents: f.pi_cents, capped_pi_cents: null, status: "requested", sufficient_evidence: r.sufficient_evidence, within_statutory_window: r.within_statutory_window, honored: r.honored, channel: str(i, "channel") || "mail", orders_document_id: optStr(i.orders_document_id), dmdc_certificate_id: optStr(i.dmdc_certificate_id), form_180_document_id: optStr(i.form_180_document_id) }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, period_id: rec.id } });
    const esc = r.escalation ? rt.escalations.open({ kind: "attorney", loanId, payload: { reason: r.escalation.reason, period_id: rec.id } }, ctx.actor) : null;
    return { ...rec.data, period_id: rec.id, denial_allowed: false, request_orders: r.request_orders, escalation_id: esc?.id ?? null, timer: r.sufficient_evidence ? "SM_SCRA_RATE_ACTIVATE_5BD" : null };
  }
  if (op === "rate_decline") {
    const p = requirePeriod(rt, i, loanId);
    const r = declineRequest({ actor_role: ctx.actor.kind === "human" ? ctx.actor.role ?? null : null, status: String(p.status ?? ""), reason: str(i, "reason"), decided_on: todayOf(ctx) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    rt.store.put("scra_rate_periods", p.id, { status: "declined", declined_reason: str(i, "reason"), declined_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
    append(ctx, loanId, { type: r.event!.type, payload: { ...r.event!.payload, period_id: p.id } });
    return { period_id: p.id, status: "declined" };
  }
  if (op === "rate_activate") return rateActivate(i, ctx, rt, loanId);
  if (op === "form_1022_sent") {
    const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId);
    const r = form1022Submission({ period_id: p.id, reason: str(i, "reason") || "rate_reduction", reduction_month: dateOf(i.reduction_month) ?? dateOf(p.activated_on) ?? todayOf(ctx), mbs: f.mbs, sent_on: dateOf(i.sent_on) ?? todayOf(ctx), message_id: optStr(i.message_id), file_id: optStr(i.file_id) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const rec = rt.store.put("form_1022_submissions", optStr(i.submission_id) ?? `f1022-${loanId}-${r.month}-${str(i, "reason") || "rate_reduction"}`, { loan_id: loanId, period_id: p.id, reason: str(i, "reason") || "rate_reduction", month: r.month, due_by: r.due_by, sent_at: ctx.now, message_id: optStr(i.message_id), file_id: optStr(i.file_id), fnma_ack: null, channel: r.channel, on_time: r.on_time }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, submission_id: rec.id } });
    return { ...rec.data, submission_id: rec.id, timer: f.mbs ? "FNMA_F119_MBS_UPLOAD_CD15" : "FNMA_F119_FORM1022_BD9" };
  }
  if (op === "fnma_ack") {
    const sid = str(i, "submission_id"); if (!sid) throw new RangeError("submission_id is required — the acknowledgement references a tracked submission");
    const s = rt.store.get("form_1022_submissions", sid); if (!s || s.data.loan_id !== loanId) throw new RangeError(`no form_1022_submissions row ${sid} on loan ${loanId}`);
    const r = ingestFnmaAck({ submission_id: sid, channel: String(s.data.channel ?? ""), reason: optStr(s.data.reason), month: optStr(s.data.month), already_acked: optStr(s.data.fnma_ack), ack_id: str(i, "ack_id"), accepted: i.accepted !== false, accepted_on: dateOf(i.accepted_on) ?? todayOf(ctx), reason_code: optStr(i.reason_code) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    rt.store.put("form_1022_submissions", sid, { fnma_ack: r.event!.payload.accepted ? str(i, "ack_id") : null, fnma_ack_status: r.event!.payload.accepted ? "accepted" : "rejected", acked_at: ctx.now }, ctx.actor, ctx.now);
    append(ctx, loanId, { type: r.event!.type, payload: { ...r.event!.payload, period_id: s.data.period_id ?? null } });
    const esc = r.escalation ? rt.escalations.open({ kind: r.escalation.kind === "fnma_portal_operator" ? "human_portal_task" : r.escalation.kind, loanId, payload: { reason: r.escalation.reason, submission_id: sid } }, ctx.actor) : null;
    return { submission_id: sid, event: r.event!.type, accepted: r.event!.payload.accepted, escalation_id: esc?.id ?? null };
  }
  if (op === "arm_adjustment") {
    const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId);
    const r = armAdjustmentDuringCap({ period_id: p.id, status: String(p.status ?? ""), product: f.product, adjusted_rate_pct: str(i, "adjusted_rate_pct"), scheduled_on: dateOf(i.scheduled_on) ?? todayOf(ctx), cap_ends_on: dateOf(p.cap_ends_on) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const scheduledOn = dateOf(i.scheduled_on) ?? todayOf(ctx);
    const sub = rt.store.put("form_1022_submissions", optStr(i.submission_id) ?? `lar83-${loanId}-${scheduledOn}`, { loan_id: loanId, period_id: p.id, reason: "payment_change", month: scheduledOn.slice(0, 7), due_by: scheduledOn, sent_at: ctx.now, message_id: null, fnma_ack: null, channel: "transaction_83", applied_rate_pct: r.applied_rate_pct, adjusted_rate_pct: str(i, "adjusted_rate_pct") }, ctx.actor, ctx.now);
    rt.store.put("scra_rate_periods", p.id, { capped_rate: r.applied_rate_pct, latest_arm_rate_pct: str(i, "adjusted_rate_pct"), arm_frozen: r.capped }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, submission_id: sub.id } });
    return { period_id: p.id, submission_id: sub.id, applied_rate_pct: r.applied_rate_pct, capped: r.capped, events: r.events.map((e) => e.type), timer: "FNMA_F119_ARM_TXN83" };
  }
  if (op === "subsidy_recalc") return subsidyRecalc(i, ctx, rt, loanId);
  if (op === "custodial_receipt") {
    const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId);
    const month = str(i, "month") || todayOf(ctx).slice(0, 7);
    const dueOn = /^\d{4}-\d{2}$/.test(month) ? D(`${month}-01`) : todayOf(ctx);
    const expected = String(p.status) === "active" || String(p.status) === "tail" ? monthlyDifferential({ original_principal_cents: f.original_principal_cents, note_rate_pct: f.note_rate_pct, term_months: f.term_months, first_payment_due: f.first_payment_due, pi_cents: f.pi_cents, installment_due_on: dueOn }) : 0n;
    const prior = loanRows(rt, "custodial_mi_receipts", loanId);
    const r = custodialReceiptMatch({ period_id: p.id, status: String(p.status ?? ""), receipt_id: str(i, "receipt_id"), amount_cents: big(i.amount_cents), received_on: dateOf(i.received_on) ?? todayOf(ctx), month, expected_cents: expected, prior_shortfall_cents: prior.reduce((s, x) => s + big(x.data.shortfall_cents), 0n), already_matched_month: prior.some((x) => x.data.month === month && x.data.matched === true) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const setId = postSet(ctx, rt, loanId, `SCRA military-indulgence disbursement ${month} (F-1-19): receipt ${str(i, "receipt_id")}`, r.postings);
    const rec = rt.store.put("custodial_mi_receipts", str(i, "receipt_id"), { loan_id: loanId, period_id: p.id, month, amount_cents: big(i.amount_cents), expected_cents: expected, shortfall_cents: r.shortfall_cents, matched: r.matched, received_on: dateOf(i.received_on) ?? todayOf(ctx), ledger_set_id: setId }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, ledger_set_id: setId } });
    const esc = r.escalation ? rt.escalations.open({ kind: r.escalation.kind === "fnma_portal_operator" ? "human_portal_task" : r.escalation.kind, loanId, severity: r.escalation.severity ?? "sev3", payload: { reason: r.escalation.reason, month, shortfall_cents: r.shortfall_cents, aggregate_shortfall_cents: r.aggregate_shortfall_cents } }, ctx.actor) : null;
    return { ...rec.data, receipt_id: rec.id, matched: r.matched, officer_informed: r.officer_informed, escalation_id: esc?.id ?? null, timer: "FNMA_F119_MI_DISBURSEMENT_CHECK_M2" };
  }
  if (op === "election") {
    refuseMoney(i);
    const p = requirePeriod(rt, i, loanId); const el = rt.store.list("scra_overpayment_elections").find((r) => r.data.period_id === p.id);
    if (!el) throw new RangeError(`no overpayment election pending on period ${p.id}`);
    const r = recordElection({ period_id: p.id, election: str(i, "election"), current_election: String(el.data.election ?? "pending"), overpayment_cents: big(el.data.amount_cents), next_payment_cents: big(p.capped_pi_cents), recorded_on: dateOf(i.recorded_on) ?? todayOf(ctx), by: `${ctx.actor.kind}:${ctx.actor.id}` });
    if (!r.allowed) throw new RangeError(r.refusal!);
    const setId = postSet(ctx, rt, loanId, `SCRA overpayment ${r.election} (13.9 rule 7): period ${p.id}`, r.postings);
    rt.store.put("scra_overpayment_elections", el.id, { election: r.election, elected_at: ctx.now, ledger_set_id: setId, statement_line: r.statement_line }, ctx.actor, ctx.now);
    const line = rt.store.put("statement_lines", `stl-${loanId}-${el.id}`, { loan_id: loanId, on: todayOf(ctx), description: r.statement_line, amount_cents: big(el.data.amount_cents), kind: "scra_overpayment", ledger_set_id: setId }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, ledger_set_id: setId, statement_line_id: line.id } });
    return { period_id: p.id, election: r.election, amount_cents: big(el.data.amount_cents), ledger_set_id: setId, postings: r.postings, statement_line: r.statement_line, sufficient_alone: r.sufficient_alone, shortfall_cents: r.shortfall_cents, election_recorded: true, timer: "SM_SCRA_OVERPAYMENT_ELECTION_30" };
  }
  if (op === "election_lapse") return electionLapseOp(i, ctx, rt, loanId);
  if (op === "rate_end_letter") return rateEndLetterOp(i, ctx, rt, loanId);
  if (op === "restore") {
    refuseMoney(i);
    const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId);
    const r = restoreRate({ period_id: p.id, status: String(p.status ?? ""), cap_ends_on: dateOf(p.cap_ends_on), today: todayOf(ctx), pre_cap_pi_cents: big(p.pre_cap_pi_cents), pre_cap_rate: String(p.pre_cap_rate ?? f.note_rate_pct), product: f.product, method: String(p.method ?? DEFAULT_METHOD), latest_arm_rate_pct: optStr(p.latest_arm_rate_pct) });
    if (!r.allowed) throw new RangeError(r.refusal!);
    rt.store.put("scra_rate_periods", p.id, { status: "ended", ended_on: todayOf(ctx), restoration_pi_cents: r.restored_pi_cents, restoration_due: r.restoration_due }, ctx.actor, ctx.now);
    for (const t of loanRows(rt, "loan_terms", loanId).filter((x) => x.data.rate_override_kind === "scra" && !x.data.effective_to)) rt.store.put("loan_terms", t.id, { effective_to: r.restoration_due, status: "superseded" }, ctx.actor, ctx.now);
    const sub = rt.store.put("form_1022_submissions", `f1022-${loanId}-${todayOf(ctx).slice(0, 7)}-rate_restoration`, { loan_id: loanId, period_id: p.id, reason: "rate_restoration", month: todayOf(ctx).slice(0, 7), due_by: null, sent_at: null, message_id: null, fnma_ack: null, channel: f.mbs ? "mbs_upload" : "email_form1022", status: "queued" }, ctx.actor, ctx.now);
    for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, form_1022_submission_id: sub.id } });
    return { period_id: p.id, status: "ended", restoration_due: r.restoration_due, restored_pi_cents: r.restored_pi_cents, restored_rate_pct: r.restored_rate_pct, form_1022_submission_id: sub.id, timer: "SCRA_3937A1_CAP_TAIL_1Y" };
  }
  return undefined;
}

async function rateActivate(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, loanId: string): Promise<unknown> {
  refuseMoney(i);
  const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId); const sc = scraCase(rt, loanId);
  const begin = dateOf(p.service_begin_on)!; const end = dateOf(p.service_end_on) ?? dateOf(sc?.service_end_on);
  const method = (str(i, "method") || String(p.method ?? DEFAULT_METHOD)) as CapMethod;
  if (method !== "standard" && method !== "interest_subsidy") throw new RangeError("method must be standard or interest_subsidy (decision 13.9-1)");
  const r = activateRatePeriod({ period_id: p.id, loan_id: loanId, status: String(p.status ?? ""), sufficient_evidence: p.sufficient_evidence === true || Boolean(optStr(i.orders_document_id) ?? optStr(i.dmdc_certificate_id) ?? optStr(i.form_180_document_id)), activated_on: todayOf(ctx), method, mbs: f.mbs, original_principal_cents: f.original_principal_cents, note_rate_pct: f.note_rate_pct, term_months: f.term_months, first_payment_due: f.first_payment_due, pi_cents: f.pi_cents, service_begin_on: begin, service_end_on: end, next_due_on: f.next_due_on, late_charges: lateCharges(rt, loanId) });
  if (!r.allowed) throw new RangeError(r.refusal!);
  const setId = postSet(ctx, rt, loanId, `SCRA 6% cap reallocation (13.9 rule 7): ${r.rows.length} installments from ${r.cap_effective_payment_due}, forgiven ${r.forgiven_total_cents} cents${r.late_charge_fee_ids.length ? `; late charges ${r.late_charge_fee_ids.join(", ")}` : ""}`, r.postings);
  const investorSetId = postSet(ctx, rt, loanId, `SCRA military-indulgence receivable ${r.new_payment_due.slice(0, 7)} (F-1-19 MBS funding)`, r.investor_postings);
  for (const row of r.rows) rt.store.put("scra_recalculations", `srr-${p.id}-${row.due}`, { loan_id: loanId, period_id: p.id, installment_n: row.n, installment_due_on: row.due, upb_before_cents: row.upb_before_cents, interest_note_cents: row.interest_note_cents, interest_capped_cents: row.interest_capped_cents, forgiven_cents: row.forgiven_cents, principal_cents: row.principal_cents, payment_received_cents: f.pi_cents, reallocation_entry_set_id: setId, overpayment_cents: row.forgiven_cents }, ctx.actor, ctx.now);
  for (const fid of r.late_charge_fee_ids) rt.store.put("fees", fid, { waived_at: ctx.now, waived_cents: big(rt.store.get("fees", fid)?.data.amount_cents), waiver_reason: "scra_rate_cap", state: "waived" }, ctx.actor, ctx.now);
  const version = loanRows(rt, "loan_terms", loanId).length + 1;
  const terms = rt.store.put("loan_terms", `lt-${loanId}-scra-${version}`, { loan_id: loanId, version, rate_override_kind: "scra", note_rate_pct: r.capped_rate, rate: r.capped_rate, pi_cents: r.new_payment_cents, effective_from: r.cap_effective_payment_due, effective_to: r.cap_ends_on, arm_frozen: f.product === "arm", method, baseline_terms_id: f.terms.id, status: "active" }, ctx.actor, ctx.now);
  const period = rt.store.put("scra_rate_periods", p.id, { status: r.status, method, capped_rate: r.capped_rate, capped_pi_cents: r.new_payment_cents, pre_cap_pi_cents: f.pi_cents, cap_effective_payment_due: r.cap_effective_payment_due, cap_ends_on: r.cap_ends_on, service_end_on: end, activated_on: todayOf(ctx), new_payment_due: r.new_payment_due, forgiven_cents: r.forgiven_total_cents, overpayment_cents: r.overpayment_cents, fnma_differential_cents: r.fnma_differential_cents, servicing_fee_cents: r.servicing_fee_cents, mbs: f.mbs, loan_terms_version_id: terms.id, reallocation_entry_set_id: setId, investor_entry_set_id: investorSetId, restoration_due: r.cap_ends_on ? restorationInstallment(r.cap_ends_on) : null }, ctx.actor, ctx.now);
  for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, ledger_set_id: setId, loan_terms_version_id: terms.id } });
  ctx.events.append({ type: "delinquency.status_code.queued", loanId, actor: ctx.actor, payload: { code: "32", reason_code: "014", reason: "military_indulgence_rate_cap", period_id: p.id } });
  const to = recipients(rt, i, loanId);
  const sumCents = r.scheduled_principal_cents + r.next_interest_capped_cents;   // the checklist "sum" rule compares the payment to a code-computed sum, never a caller figure
  const letter = await sendNotice(ctx, rt, loanId, "NTC_SCRA_3937_RATE_CONFIRMATION", { period_id: p.id, kind: "activation", request_on: p.notice_received_on ?? null, effective_due: r.cap_effective_payment_due, note_rate_pct: f.note_rate_pct, cap_ends_on: r.cap_ends_on, overpayment_cents: r.overpayment_cents, new_payment_cents: method === "interest_subsidy" ? sumCents : r.new_payment_cents, sum_cents: method === "interest_subsidy" ? sumCents : r.new_payment_cents, principal_cents: method === "interest_subsidy" ? r.scheduled_principal_cents : r.new_payment_cents - r.next_interest_capped_cents, interest_cents: r.next_interest_capped_cents, escrow_cents: 0n, new_payment_due: r.new_payment_due, shortfall_cents: r.shortfall_cents }, to);
  let election: { id: string } | null = null; let electionLetter: { notice_id: string | null; sent: PlainDate } | null = null;
  if (r.overpayment_cents > 0n) {
    election = rt.store.put("scra_overpayment_elections", `soe-${p.id}`, { loan_id: loanId, period_id: p.id, amount_cents: r.overpayment_cents, election: "pending", elected_at: null, default_applied_at: null, letter_sent_on: todayOf(ctx), due: addDays(todayOf(ctx), 30) }, ctx.actor, ctx.now);
    electionLetter = await sendNotice(ctx, rt, loanId, "NTC_SCRA_3937_OVERPAYMENT_ELECTION", { period_id: p.id, election_id: election.id, overpayment_cents: r.overpayment_cents, defaulted: false, pending: true, due: addDays(todayOf(ctx), 30), next_payment_cents: r.new_payment_cents, shortfall_cents: r.shortfall_cents }, to);
  }
  const form1022 = rt.store.put("form_1022_submissions", `f1022-${loanId}-${todayOf(ctx).slice(0, 7)}-rate_reduction`, { loan_id: loanId, period_id: p.id, reason: "rate_reduction", month: todayOf(ctx).slice(0, 7), due_by: null, sent_at: null, message_id: null, fnma_ack: null, channel: f.mbs ? "mbs_upload" : "email_form1022", status: "queued" }, ctx.actor, ctx.now);
  return { ...period.data, period_id: p.id, rows: r.rows, forgiven_total_cents: r.forgiven_total_cents, upb_before_cap_cents: r.upb_before_cap_cents, upb_after_cents: r.upb_after_cents, new_payment_cents: r.new_payment_cents, subsidy_payment_cents: r.subsidy_payment_cents, standard_payment_cents: r.standard_payment_cents, fnma_differential_cents: r.fnma_differential_cents, servicing_fee_cents: r.servicing_fee_cents, late_charges_waived_cents: r.late_charges_waived_cents, late_charges_refunded_cents: r.late_charges_refunded_cents, late_charge_fee_ids: r.late_charge_fee_ids, overpayment_cents: r.overpayment_cents, shortfall_cents: r.shortfall_cents, sufficient_alone: r.sufficient_alone, delinquent_at_entry: r.delinquent_at_entry, postings: r.postings, ledger_set_id: setId, investor_entry_set_id: investorSetId, loan_terms_version_id: terms.id, confirmation_letter: letter, election_id: election?.id ?? null, election_letter: electionLetter, form_1022_submission_id: form1022.id, gate: "SCRA_3937_FEES_IN_CAP_GATE", timers: ["SM_SCRA_RATE_ACTIVATE_5BD", "FNMA_D23401_RATE_CONFIRMATION_LETTER_5BD", f.mbs ? "FNMA_F119_MBS_UPLOAD_CD15" : "FNMA_F119_FORM1022_BD9", ...(method === "interest_subsidy" ? ["FNMA_F119_SUBSIDY_ADJUST_12M"] : []), ...(r.overpayment_cents > 0n ? ["SM_SCRA_OVERPAYMENT_ELECTION_30"] : [])] };
}

async function subsidyRecalc(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, loanId: string): Promise<unknown> {
  refuseMoney(i);
  const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId);
  const r = subsidyReadjustment({ period_id: p.id, status: String(p.status ?? ""), method: String(p.method ?? ""), as_of: dateOf(i.as_of) ?? todayOf(ctx), original_principal_cents: f.original_principal_cents, note_rate_pct: f.note_rate_pct, term_months: f.term_months, first_payment_due: f.first_payment_due, pi_cents: f.pi_cents, next_due_on: f.next_due_on });
  if (!r.allowed) throw new RangeError(r.refusal!);
  rt.store.put("scra_rate_periods", p.id, { capped_pi_cents: r.new_payment_cents, last_subsidy_adjust_on: dateOf(i.as_of) ?? todayOf(ctx), next_subsidy_adjust_on: r.next_adjust_on }, ctx.actor, ctx.now);
  for (const t of loanRows(rt, "loan_terms", loanId).filter((x) => x.data.rate_override_kind === "scra" && !x.data.effective_to)) rt.store.put("loan_terms", t.id, { pi_cents: r.new_payment_cents }, ctx.actor, ctx.now);
  for (const e of r.events) append(ctx, loanId, e);
  const letter = await sendNotice(ctx, rt, loanId, "NTC_SCRA_3937_RATE_CONFIRMATION", { period_id: p.id, kind: "annual_readjustment", request_on: p.notice_received_on ?? null, effective_due: p.cap_effective_payment_due ?? null, note_rate_pct: f.note_rate_pct, cap_ends_on: p.cap_ends_on ?? null, overpayment_cents: 0n, new_payment_cents: r.new_payment_cents, sum_cents: r.principal_cents + r.interest_cents, principal_cents: r.principal_cents, interest_cents: r.interest_cents, escrow_cents: 0n, new_payment_due: f.next_due_on, shortfall_cents: 0n }, recipients(rt, i, loanId));
  const sub = rt.store.put("form_1022_submissions", `f1022-${loanId}-${todayOf(ctx).slice(0, 7)}-payment_change`, { loan_id: loanId, period_id: p.id, reason: "payment_change", month: todayOf(ctx).slice(0, 7), due_by: null, sent_at: null, message_id: null, fnma_ack: null, channel: f.mbs ? "mbs_upload" : "email_form1022", status: "queued" }, ctx.actor, ctx.now);
  return { period_id: p.id, new_payment_cents: r.new_payment_cents, principal_cents: r.principal_cents, interest_cents: r.interest_cents, upb_cents: r.upb_cents, next_adjust_on: r.next_adjust_on, letter, form_1022_submission_id: sub.id, timer: "FNMA_F119_SUBSIDY_ADJUST_12M" };
}

async function electionLapseOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, loanId: string): Promise<unknown> {
  refuseMoney(i);
  const p = requirePeriod(rt, i, loanId); const el = rt.store.list("scra_overpayment_elections").find((r) => r.data.period_id === p.id);
  if (!el) throw new RangeError(`no overpayment election on period ${p.id}`);
  const r = electionLapse({ period_id: p.id, current_election: String(el.data.election ?? "pending"), letter_sent_on: dateOf(el.data.letter_sent_on), overpayment_cents: big(el.data.amount_cents), next_payment_cents: big(p.capped_pi_cents), today: todayOf(ctx) });
  if (!r.allowed) throw new RangeError(r.refusal!);
  const setId = postSet(ctx, rt, loanId, `SCRA overpayment default election ${r.applied} (decision 13.9-3): period ${p.id}`, r.postings);
  rt.store.put("scra_overpayment_elections", el.id, { election: r.applied, elected_at: null, default_applied_at: ctx.now, ledger_set_id: setId }, ctx.actor, ctx.now);
  rt.store.put("statement_lines", `stl-${loanId}-${el.id}`, { loan_id: loanId, on: todayOf(ctx), description: "SCRA overpayment applied to principal", amount_cents: big(el.data.amount_cents), kind: "scra_overpayment", ledger_set_id: setId }, ctx.actor, ctx.now);
  for (const e of r.events) append(ctx, loanId, { type: e.type, payload: { ...e.payload, ledger_set_id: setId } });
  const letter = await sendNotice(ctx, rt, loanId, "NTC_SCRA_3937_OVERPAYMENT_ELECTION", { period_id: p.id, election_id: el.id, overpayment_cents: big(el.data.amount_cents), defaulted: true, pending: false, due: r.due, next_payment_cents: big(p.capped_pi_cents), shortfall_cents: 0n }, recipients(rt, i, loanId));
  return { period_id: p.id, due: r.due, applied: r.applied, defaulted: true, borrower_notice: r.borrower_notice, letter, ledger_set_id: setId, timer: "SM_SCRA_OVERPAYMENT_ELECTION_30" };
}

async function rateEndLetterOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, loanId: string): Promise<unknown> {
  const p = requirePeriod(rt, i, loanId); const f = loanFacts(rt, i, loanId);
  const r = rateEndLetter({ period_id: p.id, status: String(p.status ?? ""), cap_ends_on: dateOf(p.cap_ends_on), today: todayOf(ctx), already_sent_on: dateOf(p.end_letter_sent_on) });
  if (!r.allowed) throw new RangeError(r.refusal!);
  const letter = await sendNotice(ctx, rt, loanId, r.template, { period_id: p.id, service_end_on: p.service_end_on ?? null, cap_ends_on: p.cap_ends_on ?? null, restoration_due: r.restoration_due, note_rate_pct: String(p.pre_cap_rate ?? f.note_rate_pct), restored_payment_cents: f.product === "arm" ? null : big(p.pre_cap_pi_cents), escrow_cents: 0n }, recipients(rt, i, loanId));
  rt.store.put("scra_rate_periods", p.id, { end_letter_sent_on: letter.sent }, ctx.actor, ctx.now);
  return { period_id: p.id, due: r.due, restoration_due: r.restoration_due, letter };
}

/** Rule 2 helper for callers that only know the call-up date (the whole first installment due after entry is capped). */
export { capEffectivePaymentDue };
