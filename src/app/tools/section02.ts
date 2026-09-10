/**
 * §2 tools — cashiering (2.1–2.7). Tool strings verbatim from each process's
 * "Agents" paragraph; guardrails encode that paragraph's "cannot"/"never"
 * sentences and the officer thresholds.
 */
import { defineTools, read, write, readWrite, history, escalate, noticeOps, ledgerPost, timerOps, compute, gate, guard, needsRole, never, port, cents, abs, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { assertGate } from "../evaluators.ts";
import { lockboxItems, parseBai2 } from "../../infra/integrations/codecs/bai2.ts";
import { designatedPrincipalFromAddenda } from "../../domain/cashiering/biweekly.ts";
import { reamortize } from "../../domain/cashiering/curtailment.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import type { LoanCashState } from "../../domain/cashiering/types.ts";

const OFFICER_LEDGER_LIMIT = 1_000_000n; // $10,000 (2.1 escalations)
const ledgerTotal = (i: ToolInput): bigint => { const set = i.entry_set as { lines?: readonly { amountCents?: unknown }[] } | undefined; return (set?.lines ?? []).reduce((s, l) => s + abs(cents(l.amountCents)), 0n) / 2n; };

/** Lockbox images come with the BAI2 file; "OCR" returns the item's scanline-decoded fields for the item key. */
const lockboxImageOcr = compute(async (i, ctx, rt) => {
  const files = await port(rt, "lockbox").fetch(str(i, "since") || ctx.now);
  for (const f of files) for (const it of lockboxItems(parseBai2(f.content))) {
    if (it.bankReference === str(i, "bank_reference") || `${it.batchId}:${it.sequence}` === str(i, "item_key")) {
      const m = /^(\d{10})/.exec(it.scanline);
      return { item_key: `${it.batchId}:${it.sequence}`, amount_cents: it.amountCents, deposit_date: it.depositDate, scanline: it.scanline, loan_number_candidate: m?.[1] ?? null, identification_confidence: m ? 0.99 : 0.5 };
    }
  }
  return null;
});
const requestContact = { name: "borrower_comms.request_contact", kind: "act" as const, handler: escalate("human_agent"),
  guardrails: [never("AUTOMATION_DISCLOSED", "2.1 escalations: automation is disclosed at the start of every call/chat", (i) => i.automation_disclosed === false, "automation must be disclosed before the contact")],
  decision: (i: ToolInput) => ({ action: "borrower_comms.request_contact", rationale: str(i, "reason") || "borrower asked for a human (warm transfer)" }) };
const noticeSend = { name: "notice.send", kind: "act" as const, handler: noticeOps("send") };
const escalationCreate = { name: "escalation.create", kind: "act" as const, handler: escalate("officer") };
const timers = { name: "timer.*", kind: "act" as const, handler: timerOps() };
const overlays = { name: "cases.get_overlays", kind: "read" as const, handler: read("case_overlays") };
const loanTerms = { name: "loan_terms.get", kind: "read" as const, handler: read("loan_terms") };

const p21: ToolDef[] = defineTools("2.1", "cashiering", [
  { name: "payments.read/write", kind: "write", moneyFields: ["received_on"], handler: readWrite("payments", "payment.written"),
    guardrails: [never("IDENTIFICATION_CONFIDENCE", "2.1 guardrails: no posting below 0.97 identification confidence without borrower confirmation", (i) => i.op === "write" && data(i).status === "posted" && Number(data(i).identification_confidence ?? 1) < 0.97 && data(i).borrower_confirmed !== true, "identification confidence below 0.97 and no borrower confirmation"),
      never("CONFORMING_NOT_REFUSED", "2.1 guardrails: cannot refuse a conforming payment (§1024.35(b)(1))", (i) => i.op === "write" && data(i).status === "refused" && data(i).conforming === true, "a conforming payment cannot be refused"),
      never("LIEN_MATCH", "2.1 guardrails: cannot apply first-lien funds to another lien", (i) => i.op === "write" && data(i).lien_applied !== undefined && data(i).lien_applied !== data(i).lien, "funds stay on the lien they were received for"),
      never("INSTRUMENT_ORDER", "2.1 guardrails: cannot allocate outside the instrument order", (i) => i.op === "write" && data(i).allocation_order_overridden === true, "allocation follows the instrument order"),
      never("NOE_RULE_CHECK", "2.1 guardrails: an allocation on a loan with an open NoE requires the case owner's rule check", (i) => i.op === "write" && data(i).open_noe === true && data(i).noe_rule_check_passed !== true, "open NoE: case owner's rule check missing")] },
  { name: "ledger.post", kind: "act", handler: ledgerPost(), guardrails: [needsRole("MANUAL_ADJUSTMENT_10K", "2.1 escalations: any manual ledger adjustment > $10,000 goes to the officer", (i) => i.manual === true && ledgerTotal(i) > OFFICER_LEDGER_LIMIT, ["officer"], "manual ledger adjustment above $10,000")] },
  loanTerms, overlays,
  { name: "suspense.read", kind: "read", handler: read("suspense_items") },
  { name: "lockbox.image_ocr", kind: "read", handler: lockboxImageOcr },
  requestContact, noticeSend, escalationCreate, timers,
]);

const suspenseRw = (process: string): Omit<ToolDef, "process" | "agent"> => ({ name: "suspense.read/write", kind: "write", handler: readWrite("suspense_items", "suspense.written"),
  guardrails: [never("NO_HOLD_FULL_PITI", "2.2 guardrails: cannot hold a full PITI payment", (i) => i.op === "write" && data(i).action === "hold" && cents(data(i).amount_cents) >= cents(data(i).piti_cents) && cents(data(i).piti_cents) > 0n, "a full periodic payment is applied, never held"),
    never("SINGLE_BUCKET", "2.2 guardrails: cannot apply a partial to a single bucket outside the $50 rule", (i) => i.op === "write" && data(i).action === "apply_single_bucket" && data(i).within_50_rule !== true, "single-bucket application only under the $50 rule"),
    never("RETURN_DURING_LOSSMIT", "2.2 guardrails: cannot return funds while a loss-mit case is active without the case owner", (i) => i.op === "write" && data(i).action === "return" && data(i).lossmit_case_active === true && data(i).case_owner_approved !== true, "active loss-mit case: case owner's approval missing"),
    ...(process === "2.6" ? [never("NO_RETURN_DURING_TRIAL", "2.6 guardrails: cannot return trial funds during an active trial", (i) => i.op === "write" && data(i).action === "return" && data(i).trial_active === true, "trial funds stay held while the trial is active")] : []),
    needsRole("RETURN_10K_NON_BORROWER", "2.2 escalations: returns > $10,000 to a non-borrower need the officer (6.5)", (i) => i.op === "write" && data(i).action === "return" && data(i).payee_is_borrower === false && cents(data(i).amount_cents) > OFFICER_LEDGER_LIMIT, ["officer"], "return above $10,000 to a non-borrower")] });
const applyViaCashiering = (extra: ReturnType<typeof never>[] = []): Omit<ToolDef, "process" | "agent"> => ({ name: "ledger.apply_via_cashiering", kind: "act", handler: ledgerPost(),
  guardrails: [never("ACCUMULATION_RULE", "2.2 guardrails: cannot bypass the accumulation rule (enforced in the ledger command)", (i) => flag(i, "accumulation_rule_bypassed"), "the accumulation rule is enforced in the ledger command"), ...extra] });

const p22: ToolDef[] = defineTools("2.2", "cashiering", [
  suspenseRw("2.2"),
  { name: "payments.history", kind: "read", handler: history("payments") },
  loanTerms, overlays,
  { name: "lockbox.image_ocr", kind: "read", handler: lockboxImageOcr },
  requestContact,
  { ...noticeSend, guardrails: [never("HOLD_NOTICE_1BD", "2.2 guardrails: the hold notice is sent within 1 BD of the hold", (i) => flag(i, "hold_notice") && num(i, "business_days_since_hold") > 1, "hold notice is past its 1 BD window — escalate, do not silently send late")] },
  applyViaCashiering(), timers, escalationCreate,
]);

const p23: ToolDef[] = defineTools("2.3", "cashiering", [
  { name: "autodraft.read/write", kind: "write", handler: readWrite("autodraft_enrollments", "autodraft.written"), guardrails: [never("NO_CONDITIONING", "2.3 guardrails: cannot condition anything on enrollment", (i) => i.op === "write" && data(i).conditioned_benefit !== undefined, "no benefit or term may be conditioned on autodraft enrollment")] },
  { name: "consent.capture", kind: "write", handler: write("consents", "consent.captured"),
    guardrails: [never("DISCLOSE_AND_OFFER_HUMAN", "2.3 guardrails: must disclose automation and offer a human at the start of every voice/chat enrollment", (i) => ["voice", "chat"].includes(String(data(i).channel)) && (data(i).automation_disclosed !== true || data(i).human_offered !== true), "voice/chat enrollment without automation disclosure and a human offer"),
      never("NO_ACCOUNT_READBACK", "2.3 guardrails: cannot read back full account numbers", (i) => data(i).account_number_read_back === true, "full account numbers are never read back")] },
  { name: "account_validation.verify", kind: "act", handler: compute((i, ctx, rt) => { const method = str(i, "method"); const status = method === "prenote" ? (flag(i, "return_received") ? "failed_prenote" : "validated_prenote") : method === "microdeposit" ? (flag(i, "amounts_confirmed") ? "validated_microdeposit" : "pending_microdeposit") : method === "instant" ? (flag(i, "vendor_match") ? "validated_instant" : "failed_instant") : "unvalidated"; rt.store.put("account_validations", str(i, "enrollment_id"), { method, status, verified_at: ctx.now }, ctx.actor, ctx.now); return { enrollment_id: str(i, "enrollment_id"), validation_status: status }; }) },
  { name: "nacha.build_entry", kind: "act", handler: compute((i, ctx, rt) => { const e = { enrollment_id: str(i, "enrollment_id"), amount_cents: cents(i.amount_cents), settlement_date: str(i, "settlement_date"), sec_code: str(i, "sec_code") || "PPD", trace: `${str(i, "enrollment_id")}:${str(i, "settlement_date")}` }; rt.store.put("nacha_entries", e.trace, { ...e, status: "built" }, ctx.actor, ctx.now); return e; }),
    guardrails: [never("ENROLLMENT_ACTIVE", "2.3 guardrails: cannot originate a debit without an active enrollment", (i) => i.enrollment_status !== "active", "enrollment is not active"),
      gate("2.3.accountValidated", "2.3 guardrails: a passed validation gate before the first live debit"),
      never("TEN_DAY_NOTICE", "2.3 guardrails: a satisfied 10-day-notice check (Reg E §1005.10(d)) for variable amounts", (i) => flag(i, "variable_amount") && i.ten_day_notice_satisfied !== true, "variable-amount debit without a satisfied 10-day notice"),
      never("NO_UNAUTHORIZED_REINITIATION", "2.3 guardrails: cannot reinitiate an unauthorized return", (i) => ["R05", "R07", "R10", "R11", "R29", "R51"].includes(str(i, "reinitiating_return_code")), "an unauthorized return is never reinitiated"),
      never("NSF_RETRY_MAX2", "2.3 guardrails: cannot exceed two NSF retries", (i) => num(i, "nsf_reinitiations") >= 2, "two NSF reinitiations already made")] },
  { name: "nacha.cancel_entry", kind: "write", handler: compute((i, ctx, rt) => { const rec = rt.store.put("nacha_entries", str(i, "trace"), { status: "cancelled", cancel_reason: str(i, "reason") }, ctx.actor, ctx.now); ctx.events.append({ type: "ach.entry.cancelled", loanId: ctx.loanId, actor: ctx.actor, payload: { trace: str(i, "trace"), reason: str(i, "reason") } }); return rec.data; }) },
  noticeSend,
  { name: "contacts.log", kind: "write", handler: write("contacts", "contact.logged") },
  { name: "fraud_monitor.score", kind: "act", handler: compute((i, ctx, rt) => { const signals = (i.signals as readonly string[]) ?? []; const score = Math.min(1, signals.length * 0.25 + (flag(i, "velocity_anomaly") ? 0.25 : 0)); const level = score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low"; if (level === "high") rt.escalations.open({ kind: "officer", loanId: ctx.loanId, payload: { reason: "fraud finding ≥ high", signals, score } }, ctx.actor); return { score, level, signals }; }) },
  escalationCreate, timers,
]);

const p24: ToolDef[] = defineTools("2.4", "cashiering", [
  { name: "payments.read", kind: "read", handler: read("payments") },
  applyViaCashiering([never("DESIGNATED_ONLY", "2.4 guardrails: never curtail undesignated funds", (i) => i.purpose === "curtailment" && i.designation !== "curtailment", "only funds designated as curtailment reduce principal"),
    never("CURE_FIRST", "2.4 guardrails: never bypass the cure-first gate", (i) => i.purpose === "curtailment" && flag(i, "delinquent") && cents(i.unpaid_installments_cents) > 0n, "due installments are satisfied before principal (C-1.2-01)"),
    never("MBS_POOL_RULES", "2.4 guardrails: never re-amortize on MBS loans without checking the pool rules (2.4-Q2)", (i) => i.purpose === "reamortization" && flag(i, "mbs") && i.pool_rules_checked !== true, "MBS loan: pool rules not checked"),
    never("NOT_A_MODIFICATION", "2.4 guardrails: never treat a re-amortization as a modification", (i) => i.purpose === "reamortization" && i.as_modification === true, "a re-amortization is not a modification")]),
  { name: "amortization.compute", kind: "act", handler: compute((i) => { if (i.state) return reamortize(i.state as LoanCashState, num(i, "remaining_term_months"), D(str(i, "executed_on"))); return { pi_cents: levelPayment(cents(i.upb_cents), ratePercent(str(i, "rate_pct")), num(i, "term_months")) }; }) },
]);

const p25: ToolDef[] = defineTools("2.5", "cashiering", [
  { name: "payments.read", kind: "read", handler: read("payments") },
  { name: "nacha.parse_addenda", kind: "act", handler: compute((i) => ({ designated_principal_cents: designatedPrincipalFromAddenda(i.addenda as string | undefined) })) },
  { name: "lockbox.image_ocr", kind: "read", handler: lockboxImageOcr },
  { name: "arrangements.read/write", kind: "write", handler: readWrite("third_party_arrangements", "arrangement.written"), guardrails: [never("NO_CONTRACTOR_MARKETING", "2.5 guardrails: never market or recommend a contractor", (i) => i.op === "write" && data(i).recommended === true, "the servicer never recommends a contractor")] },
  applyViaCashiering([never("NO_UNDESIGNATED_PRINCIPAL", "2.5 guardrails: never treat an undesignated extra as principal", (i) => i.purpose === "principal" && i.designation !== "principal", "undesignated extra funds are not principal"),
    never("ACCEPT_CONFORMING", "2.5 guardrails: never refuse a conforming contractor payment", (i) => i.action === "refuse" && flag(i, "conforming"), "a conforming contractor payment is accepted like any other")]),
  noticeSend,
  { ...requestContact, guardrails: [...requestContact.guardrails, never("FREE_INHOUSE_OPTION", "2.5 guardrails: always mention the free in-house option when discussing programs", (i) => i.topic === "contractor_program" && i.free_inhouse_option_mentioned !== true, "the free in-house biweekly option must be mentioned")] },
]);

const p26: ToolDef[] = defineTools("2.6", "cashiering", [
  { name: "trial_schedule.read", kind: "read", handler: read("trial_schedules") },
  suspenseRw("2.6"),
  applyViaCashiering([never("TRIAL_MONTH_BELOW_AMOUNT", "2.6 guardrails: cannot mark a trial month satisfied below the trial amount", (i) => i.purpose === "trial_month" && cents(i.received_cents) < cents(i.trial_amount_cents), "received is below the trial amount"),
    never("NO_LC_FROM_TRIAL_FUNDS", "2.6 guardrails: cannot apply late charges from trial funds", (i) => i.purpose === "trial_month" && cents(i.late_charge_cents) > 0n, "late charges are never taken from trial funds"),
    never("BOOKING_GATES", "2.6 guardrails: cannot book the modification while residual/waiver gates are open", (i) => i.purpose === "book_modification" && (flag(i, "residual_open") || flag(i, "waiver_gate_open")), "residual/waiver gates are still open")]),
  { name: "fees.suspend/waive", kind: "write", handler: compute((i, ctx, rt) => { const op = i.op === "waive" ? "waived" : "suspended"; const rec = rt.store.put("fees", str(i, "fee_id"), { status: op, reason: str(i, "reason"), by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now); ctx.events.append({ type: `fee.${op}`, loanId: ctx.loanId, actor: ctx.actor, payload: { fee_id: str(i, "fee_id"), reason: str(i, "reason") } }); return rec.data; }) },
  { name: "smdu.submit_trial_payment", kind: "act", handler: compute(async (i, ctx, rt) => { try { return await port(rt, "smdu").reportTppPayment(str(i, "case_id"), { dueDate: str(i, "due_date"), receivedOn: str(i, "received_on"), amountCents: String(cents(i.amount_cents)) }); } catch (e) { const t = rt.escalations.open({ kind: "human_portal_task", loanId: ctx.loanId, caseId: str(i, "case_id"), payload: { package: { case_id: str(i, "case_id"), due_date: str(i, "due_date"), received_on: str(i, "received_on"), amount_cents: String(cents(i.amount_cents)) }, reason: (e as Error).message, sla: "1 business_days_fannie_et" } }, ctx.actor); return { portal_task_id: t.id, fallback: "SMDU UI" }; } }) },
]);

const p27: ToolDef[] = defineTools("2.7", "cashiering", [
  { name: "fees.read", kind: "read", handler: read("fees") },
  { name: "fees.assess", kind: "write", handler: write("fees", "fee.assessed"),
    guardrails: [never("GRACE_GATE", "2.7 guardrails: cannot assess without the grace gate", (i) => i.grace_gate_open !== true, "grace period has not ended (NOTE_6A_LATE_CHARGE_GRACE_GATE)"),
      guard("POSTING_BACKLOG_GATE", "2.7 guardrails: cannot assess without the posting-backlog gate (SM_CASHIERING_POSTING_BACKLOG_GATE)", (i) => { if (!i.facts) return "posting-backlog facts missing: pass facts.items_received_or_identified_on_or_before_gate"; try { assertGate("2.1.noPostingBacklog", i.facts as Record<string, unknown>); return undefined; } catch (e) { return (e as Error).message; } }),
      never("CAPS", "2.7 guardrails: cannot exceed note/state caps", (i) => cents(data(i).amount_cents) > cents(i.cap_cents) && cents(i.cap_cents) > 0n, "amount exceeds the note/state cap"),
      never("ONCE_PER_INSTALLMENT", "2.7 guardrails: cannot assess twice", (i) => num(i, "assessed_for_installment") >= 1, "a late charge already exists for this installment"),
      never("NOT_FROM_PI_ESCROW", "2.7 guardrails: cannot collect from P&I/escrow", (i) => ["pi", "escrow"].includes(str(i, "collect_from")), "late charges are never taken from P&I or escrow"),
      never("OVERLAYS", "2.7 guardrails: cannot assess post-petition or during forbearance/SCRA", (i) => flag(i, "post_petition") || flag(i, "forbearance_active") || flag(i, "scra_active"), "bankruptcy, forbearance or SCRA overlay is active")] },
  { name: "fees.waive", kind: "write", handler: write("fees", "fee.waived"), guardrails: [needsRole("COURTESY_LIMIT", "2.7 guardrails: cannot waive beyond the courtesy limit without the officer", (i) => flag(i, "beyond_courtesy_limit"), ["officer"], "waiver beyond the courtesy limit")] },
  { name: "fees.reverse", kind: "write", handler: write("fees", "fee.reversed") },
  overlays,
  { name: "payments.history", kind: "read", handler: history("payments") },
  noticeSend, escalationCreate,
]);

export const SECTION_02_TOOLS: readonly ToolDef[] = [...p21, ...p22, ...p23, ...p24, ...p25, ...p26, ...p27];
