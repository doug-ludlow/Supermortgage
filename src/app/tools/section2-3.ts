/**
 * §2.3 process-owned tools — additional bus tools for 2.3 defined with `defineTools("2.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section02.ts). Every tool string must be one
 * spec/registry/agents.json names for 2.3; src/app/tools.test.ts refuses the rest (and refuses a duplicate
 * `<process> <name>`), so every 2.3 tool string already lives in ./section02.ts and this file extends one of them:
 * `withAutodraftLifecycle` adds the enrollment-lifecycle ops of 2.3 to `autodraft.read/write` — the code path through
 * which the events the 2.3 timer rows arm on and are satisfied by are appended by source (src/domain/cashiering/ops.ts):
 *
 *   op=authorize            rule 1: the Nacha/Reg E authorization checklist (`authorizationDefects`) — a defect refuses; a
 *                           voice channel never authorizes (01 §3.5 / 15 U.S.C. 7001(c)(6)); `autodraft.enrollment.authorized`
 *                           (arms SM_AUTODRAFT_COPY_DELIVERY_1BD) and the copy `AUTODRAFT-CONFIRM-v1` through the Notice
 *                           Registry when recipients are given (`notice.sent{enrollment_confirmation}` closes the clock).
 *   op=validate             `autodraft.validation.completed{status}` → `active` with `next_draft_on` (NACHA_WEB_ACCOUNT_VALIDATION_GATE).
 *   op=settle               a debit settled for an installment: `autodraft.entry.settled`, the 2.1 payment row (channel
 *                           `ach_debit_origin`, `payment.received`; the 2.1 posting run — the daily sweep — allocates it and
 *                           emits `payment.posted` with the rule-8 entry sets), `last_debit_cents`.
 *   op=return               rule 7: `ach.return.received{reason_code}` (arms NACHA_NSF_REINITIATION_180_MAX2), the payment's entry sets reversed, the payment
 *                           reversed (`payment.reversed`), one retry in 3–5 banking days (`ach.entry.reinitiation_scheduled`,
 *                           federal calendar +3), `AUTODRAFT-RETURN-v1` through the registry, `suspended_returns` on the second
 *                           R01/R09 for the same installment (`autodraft.status.changed`).
 *   op=amount_change_check  rule 5 / Reg E §1005.10(d)(1): a changed amount needs a notice sent ≥ 10 days before the debit
 *                           unless an escrow/ARM statement already stated the exact amount and date (`statement`); the
 *                           dedicated `AUTODRAFT-AMOUNT-CHANGE-v1` goes through the registry (`notice.sent{kind=variable_amount_10d}`
 *                           satisfies REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10).
 *
 * The enrollment row (`autodraft_enrollments` in the entity store) carries the 2.3 Enrollment record; cents are stored as
 * decimal strings. docs/ux/BACKEND-DELTAS.md (32.8) records this delta.
 */
import { cents, str, num, noticeOps, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, addDays, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { CashieringOps } from "../../domain/cashiering/ops.ts";
import { authorizationDefects, variableAmountNoticeStatus, type Authorization, type Enrollment, type ReturnCode } from "../../domain/cashiering/autodraft.ts";
import type { Notice } from "../../notices/service.ts";

type Handler = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown;
const KIND = "autodraft_enrollments";
const LIFECYCLE_OPS = new Set(["authorize", "validate", "settle", "return", "amount_change_check"]);
const RETURN_REASON: Readonly<Record<string, string>> = { R01: "insufficient funds", R09: "uncollected funds", R02: "account closed", R03: "no account", R04: "invalid account number", R20: "non-transaction account", R08: "payment stopped", R10: "customer advises not authorized", R11: "customer advises entry not in accordance with the authorization" };
const s = (c: Cents): string => c.toString();
const opt = (v: unknown): Cents | null => (v === undefined || v === null || v === "" ? null : cents(v));

/** The 2.3 Enrollment record from the store row (`authorize` writes it; later ops re-read it). */
function enrollmentFrom(d: Record<string, unknown>, id: string, loanId: string): Enrollment {
  const a = (d.authorization ?? {}) as Record<string, unknown>;
  const authorization: Authorization = { borrower_name: String(a.borrower_name ?? ""), loan_number_masked: String(a.loan_number_masked ?? ""), routing: String(a.routing ?? ""), account_last4: String(a.account_last4 ?? d.account_last4 ?? ""), account_type: (a.account_type as Authorization["account_type"]) ?? "checking",
    amount_rule: (a.amount_rule as Authorization["amount_rule"]) ?? "full_periodic_payment", variable_amount_statement: a.variable_amount_statement === true, frequency: (a.frequency as Authorization["frequency"]) ?? "monthly", first_debit_on: D(String(a.first_debit_on ?? d.next_draft_on ?? "2000-01-01")),
    authorized_on: D(String(a.authorized_on ?? "2000-01-01")), company_name: String(a.company_name ?? ""), revocation_instructions: a.revocation_instructions === true, optional_statement: a.optional_statement === true, esign_consent: a.esign_consent === true, sec: (a.sec as Authorization["sec"]) ?? "WEB",
    ...(typeof a.recording_ref === "string" ? { recording_ref: a.recording_ref } : {}), ...(typeof a.ai_disclosure_logged_at === "string" ? { ai_disclosure_logged_at: a.ai_disclosure_logged_at } : {}) };
  return { id, loan_id: loanId, status: (d.status as Enrollment["status"]) ?? "requested", authorization, draft_day: Number(d.draft_day ?? 1), extra_principal_cents: cents(d.extra_principal_cents), include_fees: d.include_fees === true, next_draft_on: typeof d.next_draft_on === "string" && d.next_draft_on ? D(d.next_draft_on) : null,
    validation_status: (d.validation_status as Enrollment["validation_status"]) ?? "pending", reinitiations: Array.isArray(d.reinitiations) ? (d.reinitiations as string[]).map((x) => D(x)) : [], returns_on_current_installment: Number(d.returns_on_current_installment ?? 0), last_debit_cents: opt(d.last_debit_cents),
    notices: Array.isArray(d.notices) ? (d.notices as Record<string, unknown>[]).map((n) => ({ template: String(n.template), sent_on: D(String(n.sent_on)), amount_cents: cents(n.amount_cents), debit_on: D(String(n.debit_on)) })) : [], ...(typeof d.authorized_on === "string" ? { authorized_on: D(d.authorized_on) } : {}) };
}
function save(rt: ToolRuntime, ctx: CommandContext, e: Enrollment, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return rt.store.put(KIND, e.id, { enrollment_id: e.id, loan_id: e.loan_id, status: e.status, authorization: { ...e.authorization }, draft_day: e.draft_day, extra_principal_cents: s(e.extra_principal_cents), include_fees: e.include_fees, next_draft_on: e.next_draft_on, validation_status: e.validation_status,
    reinitiations: [...e.reinitiations], returns_on_current_installment: e.returns_on_current_installment, last_debit_cents: e.last_debit_cents === null ? null : s(e.last_debit_cents), notices: e.notices.map((n) => ({ ...n, amount_cents: s(n.amount_cents) })), account_last4: e.authorization.account_last4, ...(e.authorized_on ? { authorized_on: e.authorized_on } : {}), version_at: ctx.now, ...extra }, ctx.actor, ctx.now).data;
}
const load = (rt: ToolRuntime, i: ToolInput, ctx: CommandContext): Enrollment => { const id = str(i, "id") || str(i, "enrollment_id"); const rec = rt.store.get(KIND, id); if (!rec) throw new RangeError(`no autodraft enrollment ${id} on this loan`); return enrollmentFrom(rec.data, id, str(i, "loan_id") || ctx.loanId); };
const today = (ctx: CommandContext, i: ToolInput, k = "on"): PlainDate => D(str(i, k) || ctx.now.slice(0, 10));
const ops = (ctx: CommandContext) => new CashieringOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor });
const contact = (i: ToolInput, e: Enrollment): Record<string, unknown> => ({ account_last4: e.authorization.account_last4, servicer_phone: str(i, "servicer_phone") || "(800) 555-0100", exclusive_address: str(i, "exclusive_address") || "PO Box 2, Testville TX 75001", remittance_address: str(i, "remittance_address") || "Supermortgage, PO Box 7, Testville TX 75001", servicer_address: str(i, "servicer_address") || "PO Box 1, Testville TX 75001", esign_consent: e.authorization.esign_consent });
/** Render + send through the Notice Registry when the caller names recipients (the copy, the return notice, the 10-day notice). */
async function sendNotice(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, template: string, payload: Record<string, unknown>, asOf: PlainDate): Promise<Notice | null> {
  if (!Array.isArray(i.recipients) || !i.recipients.length || !rt.notices) return null;
  return (await noticeOps("render_send")({ template_code: template, loan_id: str(i, "loan_id") || ctx.loanId, recipients: i.recipients, payload, as_of: asOf, ...(i.channel_context ? { channel_context: i.channel_context } : {}) }, ctx, rt)) as Notice;
}

async function authorize(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  if (str(i, "channel") === "voice") throw new CommandRefused("autodraft.read/write", "CONSENT_VOICE_VOID", "2.3 rule 1 / 01 §3.5 / 15 U.S.C. 7001(c)(6): a spoken yes never authorizes a debit — the ConsentCard link is sent instead", "authorization cannot be captured on a voice channel");
  const e = load(rt, i, ctx);
  const a = (i.authorization && typeof i.authorization === "object" ? (i.authorization as Record<string, unknown>) : {}) as Partial<Authorization> & Record<string, unknown>;
  const authorizedOn = today(ctx, i, "authorized_on");
  const authorization: Authorization = { ...e.authorization, ...a, account_last4: String(a.account_last4 ?? e.authorization.account_last4 ?? ""), authorized_on: authorizedOn, first_debit_on: D(String(a.first_debit_on ?? e.authorization.first_debit_on)), esign_consent: a.esign_consent === true || (a.esign_consent === undefined && e.authorization.esign_consent) } as Authorization;
  const defects = authorizationDefects(authorization);
  if (defects.length) throw new CommandRefused("autodraft.read/write", "AUTH_ELEMENTS_MISSING", "2.3 rule 1: every Nacha / Reg E authorization element is present before an enrollment is authorized", `missing: ${defects.join(", ")}`);
  e.authorization = authorization; if (i.draft_day !== undefined) e.draft_day = num(i, "draft_day");
  const { copy_due_by } = ops(ctx).authorizeEnrollment(e, authorizedOn);
  const amountText = authorization.amount_rule === "fixed" ? `a fixed amount of ${money(cents(i.fixed_amount_cents))}` : `your full monthly payment${i.periodic_payment_cents !== undefined ? ` (currently ${money(cents(i.periodic_payment_cents))})` : ""}${e.extra_principal_cents > 0n ? ` plus ${money(e.extra_principal_cents)} additional principal` : ""}`;
  const n = await sendNotice(i, ctx, rt, "AUTODRAFT-CONFIRM-v1", { ...contact(i, e), borrower_name: authorization.borrower_name, authorized_on: authorizedOn, account_type: authorization.account_type, account_masked: `******${authorization.account_last4}`, routing: authorization.routing, amount_text: amountText, frequency_text: `${authorization.frequency} on the ${ordinal(e.draft_day)}`, first_debit_on: authorization.first_debit_on, company_name: authorization.company_name, range_election: false, business_days_after_authorization: 0 }, authorizedOn);
  if (n && n.status === "sent") ops(ctx).sendEnrollmentConfirmation(e, authorizedOn, authorization.esign_consent ? "electronic" : "mail");
  return { ...save(rt, ctx, e, { card_instance_id: str(i, "card_instance_id") || null }), copy_due_by, confirmation_notice_id: n?.id ?? null, confirmation_status: n?.status ?? null };
}
function validate(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const e = load(rt, i, ctx);
  const status = (str(i, "status") || "validated_api") as Parameters<CashieringOps["completeValidation"]>[1];
  const next = str(i, "next_draft_on") ? D(str(i, "next_draft_on")) : e.authorization.first_debit_on;
  ops(ctx).completeValidation(e, status, today(ctx, i), next);
  return save(rt, ctx, e);
}
function settle(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const e = load(rt, i, ctx); const amount = cents(i.amount_cents); const settledOn = D(str(i, "settlement_date") || ctx.now.slice(0, 10)); const due = str(i, "installment_due_date"); const loanId = e.loan_id;
  if (e.status !== "active") throw new CommandRefused("autodraft.read/write", "ENROLLMENT_ACTIVE", "2.3 guardrails: cannot originate a debit without an active enrollment", `enrollment is ${e.status}, not active`);
  const payment_id = str(i, "payment_id") || `ACH-${loanId.slice(0, 8)}-${settledOn}`; const trace = str(i, "trace") || `${e.id}:${settledOn}`;
  ctx.events.append({ type: "autodraft.entry.settled", loanId, aggregate: { kind: "autodraft_enrollment", id: e.id }, actor: ctx.actor, payload: { enrollment_id: e.id, trace, settlement_date: settledOn, amount_cents: s(amount), installment_due_date: due, payment_id, company_entry_description: "MORTGAGE PMT" } });
  // the settled debit is a received payment: 2.1's posting run (`payments.read/write{op=post}`, the daily sweep) allocates it through the engine and posts the rule-8 entry sets
  rt.store.put("payments", payment_id, { payment_id, loan_id: loanId, amount_cents: s(amount), received_on: settledOn, credited_as_of: settledOn, channel: "ach_debit_origin", designation: "contractual", status: "received", identification_confidence: 1, conforming: true, installment_due_date: due, autodraft_trace: trace, enrollment_id: e.id }, ctx.actor, ctx.now);
  ctx.events.append({ type: "payment.received", loanId, aggregate: { kind: "payment", id: payment_id }, actor: ctx.actor, payload: { payment_id, loan_id: loanId, amount_cents: s(amount), received_on: settledOn, channel: "ach_debit_origin", designation: "contractual", trace } });
  e.last_debit_cents = amount; e.next_draft_on = str(i, "next_draft_on") ? D(str(i, "next_draft_on")) : e.next_draft_on;
  return { ...save(rt, ctx, e), payment_id, trace };
}
async function handleReturn(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const e = load(rt, i, ctx); const code = str(i, "code") as ReturnCode; const returnedOn = D(str(i, "returned_on") || ctx.now.slice(0, 10)); const loanId = e.loan_id;
  if (!/^R\d{2}$/.test(code)) throw new RangeError("code must be a Nacha return reason code (R01 …)");
  const original = str(i, "original_entry_on") ? D(str(i, "original_entry_on")) : null; const amount = opt(i.amount_cents); const payment_id = str(i, "payment_id");
  const d = ops(ctx).handleReturn(e, code, returnedOn, { authorization_valid: i.authorization_valid !== false, ...(i.defect_ours !== undefined ? { defect_ours: i.defect_ours === true } : {}), ...(original ? { original_entry_on: original } : {}), retryOn: (from) => addBusinessDays(from, num(i, "retry_banking_days") || 3, federal), ...(str(i, "trace") ? { trace: str(i, "trace") } : {}), ...(amount !== null ? { amount_cents: amount } : {}) });
  if (d.reverse_payment && payment_id) {
    const pay = rt.store.get("payments", payment_id)?.data ?? {};
    // the rule-8 entry sets the posting run wrote (receipt · allocation · cash split) come back out in reverse order; the installment is due again
    const sets = Array.isArray(pay.ledger_entry_set_ids) ? [...(pay.ledger_entry_set_ids as string[])].reverse() : []; const reversed: string[] = [];
    for (const setId of sets) { try { reversed.push(ctx.ledger.reverse(setId, returnedOn, `returned item ${code} (${payment_id})`, ctx.now).id); } catch { /* already reversed */ } }
    rt.store.put("payments", payment_id, { ...pay, status: "reversed", reversal: { reason: "returned_item", return_code: code, reversed_at: ctx.now, entry_set_ids: reversed } }, ctx.actor, ctx.now);
    ctx.events.append({ type: "payment.reversed", loanId, aggregate: { kind: "payment", id: payment_id }, actor: ctx.actor, payload: { payment_id, loan_id: loanId, reason: "returned_item", return_code: code, reversed_on: returnedOn, amount_cents: amount !== null ? s(amount) : (pay.amount_cents as string | undefined) ?? null, enrollment_id: e.id, installment_due_date: str(i, "installment_due_date") || (pay.installment_due_date as string | undefined) || null } });
  }
  let notice: Notice | null = null;
  if (d.notice) notice = await sendNotice(i, ctx, rt, d.notice, { ...contact(i, e), amount_cents: amount ?? cents((rt.store.get("payments", payment_id)?.data.amount_cents as string | undefined) ?? "0"), settlement_date: original ?? returnedOn, returned_on: returnedOn, return_code: code, return_reason: RETURN_REASON[code] ?? "returned", installment_due_date: str(i, "installment_due_date") || original || returnedOn,
    nsf_fee_cents: opt(i.nsf_fee_cents), retry_on: d.retry_on, company_entry_description: d.company_entry_description, suspended_on: returnedOn, reason_text: "two debits for the same installment were returned for insufficient funds", resume_condition: "you confirm with us that the account can be debited again", periodic_payment_cents: opt(i.periodic_payment_cents) ?? e.last_debit_cents ?? 0n, due_day: ordinal(Number((str(i, "installment_due_date") || "2000-01-01").slice(8, 10))), revoked_on: returnedOn }, returnedOn);
  return { ...save(rt, ctx, e), disposition: { ...d, retry_on: d.retry_on, retry_banking_days: d.retry_on && returnedOn ? daysBetween(returnedOn, d.retry_on) : null }, notice_id: notice?.id ?? null, notice_status: notice?.status ?? null, notice_template: d.notice };
}
async function amountChangeCheck(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const e = load(rt, i, ctx); const next = cents(i.next_amount_cents); const debitOn = D(str(i, "debit_on")); const on = today(ctx, i, "today");
  // an escrow / ARM statement counts only when it states the exact amount and date (2.3 rule 5) — recorded as a notice the borrower already received
  const st = i.statement && typeof i.statement === "object" ? (i.statement as Record<string, unknown>) : null;
  if (st && typeof st.template === "string" && st.amount_cents !== undefined && typeof st.debit_on === "string" && typeof st.sent_on === "string") e.notices.push({ template: st.template, sent_on: D(st.sent_on), amount_cents: cents(st.amount_cents), debit_on: D(st.debit_on) });
  const r = variableAmountNoticeStatus(e, next, debitOn, on);
  if (r.ok) { save(rt, ctx, e); return { ok: true, satisfied_by: r.satisfied_by, next_amount_cents: s(next), debit_on: debitOn, sent: false }; }
  if (r.action === "hold_entry_escalate") { save(rt, ctx, e); ctx.events.append({ type: "autodraft.entry.held", loanId: e.loan_id, aggregate: { kind: "autodraft_enrollment", id: e.id }, actor: ctx.actor, payload: { enrollment_id: e.id, settlement_date: debitOn, amount_cents: s(next), reason: "variable-amount notice not sent 10 days before the debit", deadline: r.deadline, action: r.action } }); return { ok: false, action: r.action, deadline: r.deadline, sent: false }; }
  const prior = opt(i.prior_amount_cents) ?? e.last_debit_cents ?? 0n;
  const n = await sendNotice(i, ctx, rt, "AUTODRAFT-AMOUNT-CHANGE-v1", { ...contact(i, e), debit_on: debitOn, new_amount_cents: next, prior_amount_cents: prior, account_masked: `******${e.authorization.account_last4}`, reason: str(i, "reason") || "your escrow payment changed after the annual escrow analysis", days_before_debit: daysBetween(on, debitOn) }, on);
  const sent = ops(ctx).sendVariableAmountNotice(e, next, debitOn, on);
  save(rt, ctx, e);
  return { ok: false, action: r.action, deadline: r.deadline, sent: true, on_time: sent.payload.on_time, notice_id: n?.id ?? null, notice_status: n?.status ?? null, next_amount_cents: s(next), debit_on: debitOn };
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (c: Cents): string => USD.format(Number(c) / 100);
const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** `autodraft.read/write{op ∈ authorize|validate|settle|return|amount_change_check}` → the 2.3 lifecycle; every other op is the base read/write. */
export function withAutodraftLifecycle(base: Handler): Handler {
  return (i, ctx, rt) => {
    const op = str(i, "op");
    if (!LIFECYCLE_OPS.has(op)) return base(i, ctx, rt);
    switch (op) {
      case "authorize": return authorize(i, ctx, rt);
      case "validate": return validate(i, ctx, rt);
      case "settle": return settle(i, ctx, rt);
      case "return": return handleReturn(i, ctx, rt);
      default: return amountChangeCheck(i, ctx, rt);
    }
  };
}
export const AUTODRAFT_LIFECYCLE_OPS: ReadonlySet<string> = LIFECYCLE_OPS;
/** The registry retry window 2.3 rule 7 names (3–5 banking days) for a reinitiation scheduled by `op=return`. */
export const reinitiationWithinWindow = (returnedOn: PlainDate, retryOn: PlainDate): boolean => { const min = addBusinessDays(returnedOn, 3, federal); const max = addBusinessDays(returnedOn, 5, federal); return retryOn >= min && retryOn <= max && retryOn > addDays(returnedOn, 0); };

export const TOOLS_2_3: readonly ToolDef[] = [];
