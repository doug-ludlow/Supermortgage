/**
 * §2 tools — cashiering (2.1–2.7). Tool strings verbatim from each process's
 * "Agents" paragraph; guardrails encode that paragraph's "cannot"/"never"
 * sentences and the officer thresholds.
 */
import { defineTools, read, write, readWrite, history, escalate, noticeOps, ledgerPost, timerOps, compute, gate, guard, needsRole, never, port, cents, abs, str, num, flag, data, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { assertGate, evaluateGate } from "../evaluators.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import { lockboxItems, parseBai2 } from "../../infra/integrations/codecs/bai2.ts";
import { designatedPrincipalFromAddenda } from "../../domain/cashiering/biweekly.ts";
import { reamortize } from "../../domain/cashiering/curtailment.ts";
import { graceEndFor, receivedTowardBasis, basisCents, type WaiverReason } from "../../domain/cashiering/latecharges.ts";
import { LateChargeOps } from "../../domain/cashiering/ops-2-7.ts";
import { CashieringOps } from "../../domain/cashiering/ops.ts";
import { withStatementSummary } from "./section2-2.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { BUCKET_ORDER, instrumentProfile, type InstrumentProfile, type LoanCashState } from "../../domain/cashiering/types.ts";

const OFFICER_LEDGER_LIMIT = 1_000_000n; // $10,000 (2.1 escalations)
const ledgerTotal = (i: ToolInput): bigint => { const set = i.entry_set as { lines?: readonly { amountCents?: unknown }[] } | undefined; return (set?.lines ?? []).reduce((s, l) => s + abs(cents(l.amountCents)), 0n) / 2n; };
/** 2.1 AI agent design: the agent's `ledger.post` runs "only through the allocation/reversal commands"; a human's manual adjustment is the officer-threshold path. */
const LEDGER_COMMANDS = new Set(["payment.allocate", "payment.post", "payment.reverse"]);
/** 2.1 guardrails "cannot allocate outside the instrument order": a written allocation plan's buckets must follow F-1-09's order (BUCKET_ORDER) within each installment. */
const outOfInstrumentOrder = (d: Record<string, unknown>): boolean => {
  if (d.allocation_order_overridden === true) return true;
  if (!Array.isArray(d.allocations)) return false;
  const profile: InstrumentProfile = d.instrument_profile === "pre_1999" || d.instrument_profile === "uniform_1999_plus" ? d.instrument_profile : typeof d.instrument_date === "string" ? instrumentProfile(D(d.instrument_date)) : "uniform_1999_plus";
  const rank = new Map<string, number>(BUCKET_ORDER[profile].map((b, k) => [b, k]));
  const last = new Map<string, number>();
  for (const a of d.allocations as readonly { bucket?: unknown; installment_due_date?: unknown }[]) {
    const r = rank.get(String(a.bucket)); if (r === undefined) continue;
    const key = String(a.installment_due_date ?? "");
    if ((last.get(key) ?? -1) > r) return true;
    last.set(key, r);
  }
  return false;
};

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

/**
 * 2.1 rule 1: `received_on` is immutable once set; corrections are reversals. The bus's money-field check only sees `changes`, so the
 * handler enforces the rule on the `data` path too: an agent attempt is refused (`command.refused`-style event + CommandRefused); an
 * officer's write proceeds with `received_on` left untouched and the reversal path recorded — nobody edits the date in place.
 */
const paymentsReadWrite = (() => {
  const rw = readWrite("payments", "payment.written");
  return (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown => {
    if (i.op !== "write" || typeof i.id !== "string") return rw(i, ctx, rt);
    const existing = rt.store.get("payments", i.id)?.data;
    const attempted = (i.changes as Record<string, unknown> | undefined)?.received_on ?? data(i).received_on;
    if (existing?.received_on === undefined || attempted === undefined || attempted === existing.received_on) return rw(i, ctx, rt);
    ctx.events.append({ type: "payment.received_on.correction_refused", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, aggregate: { kind: "payments", id: i.id }, actor: ctx.actor,
      payload: { payment_id: i.id, current: existing.received_on, attempted, rule: "2.1 rule 1: received_on is immutable once set; corrections are reversals (payment.reverse + re-receipt)", actor: `${ctx.actor.kind}:${ctx.actor.id}` } });
    if (!hasRole(ctx.actor, ["officer"])) throw new CommandRefused("payments.read/write", "RECEIVED_ON_IMMUTABLE", "2.1 rule 1 / guardrails: the agent cannot change `received_on`", `received_on is immutable once set (${String(existing.received_on)}); correct by reversal`);
    const { received_on: _d, ...restData } = data(i); const { received_on: _c, ...restChanges } = (i.changes as Record<string, unknown> | undefined) ?? {};
    void _d; void _c;
    const out = rw({ ...i, data: restData, changes: restChanges }, ctx, rt) as Record<string, unknown>;
    return { ...out, received_on_correction: { attempted, refused: true, path: "payment.reverse" } };
  };
})();

const p21: ToolDef[] = defineTools("2.1", "cashiering", [
  { name: "payments.read/write", kind: "write", moneyFields: ["received_on"], handler: paymentsReadWrite,
    guardrails: [never("IDENTIFICATION_CONFIDENCE", "2.1 guardrails: no posting below 0.97 identification confidence without borrower confirmation", (i) => i.op === "write" && data(i).status === "posted" && Number(data(i).identification_confidence ?? 1) < 0.97 && data(i).borrower_confirmed !== true, "identification confidence below 0.97 and no borrower confirmation"),
      never("CONFORMING_NOT_REFUSED", "2.1 guardrails: cannot refuse a conforming payment (§1024.35(b)(1))", (i) => i.op === "write" && data(i).status === "refused" && data(i).conforming === true, "a conforming payment cannot be refused"),
      never("LIEN_MATCH", "2.1 guardrails: cannot apply first-lien funds to another lien", (i) => i.op === "write" && data(i).lien_applied !== undefined && data(i).lien_applied !== data(i).lien, "funds stay on the lien they were received for"),
      never("INSTRUMENT_ORDER", "2.1 guardrails: cannot allocate outside the instrument order (F-1-09 order per instrument profile)", (i) => i.op === "write" && outOfInstrumentOrder(data(i)), "allocation follows the instrument order"),
      never("NOE_RULE_CHECK", "2.1 guardrails: an allocation on a loan with an open NoE requires the case owner's rule check", (i) => i.op === "write" && data(i).open_noe === true && data(i).noe_rule_check_passed !== true, "open NoE: case owner's rule check missing")] },
  { name: "ledger.post", kind: "act", handler: ledgerPost(), guardrails: [
      guard("LEDGER_VIA_COMMANDS", "2.1 AI agent design: `ledger.post` (only through the allocation/reversal commands)", (i, ctx) => (ctx.actor.kind === "agent" && !LEDGER_COMMANDS.has(str(i, "via")) ? `the agent posts ledger entries only through payment.allocate/payment.post/payment.reverse (via=${str(i, "via") || "none"})` : undefined)),
      needsRole("MANUAL_ADJUSTMENT_10K", "2.1 escalations: any manual ledger adjustment > $10,000 goes to the officer", (i) => i.manual === true && ledgerTotal(i) > OFFICER_LEDGER_LIMIT, ["officer"], "manual ledger adjustment above $10,000")] },
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
  withStatementSummary(suspenseRw("2.2")),                                  // + op=statement_summary: the 7.1 (d)(3)/(d)(5) read model (section2-2.ts)
  { name: "payments.history", kind: "read", handler: history("payments") },
  loanTerms, overlays,
  { name: "lockbox.image_ocr", kind: "read", handler: lockboxImageOcr },
  requestContact,
  { ...noticeSend, guardrails: [guard("HOLD_NOTICE_1BD", "2.2 guardrails: must send the hold notice within 1 BD of the hold", (i) => (flag(i, "hold_notice") && num(i, "business_days_since_hold") > 1 && !(flag(i, "late_send_acknowledged") && str(i, "escalation_id")) ? "hold notice is past its 1 BD window — it still goes, but only with late_send_acknowledged=true and the escalation_id of the breach (never silently late)" : undefined))] },
  applyViaCashiering(), timers, escalationCreate,
]);

const p23: ToolDef[] = defineTools("2.3", "cashiering", [
  { name: "autodraft.read/write", kind: "write", handler: readWrite("autodraft_enrollments", "autodraft.written"), guardrails: [never("NO_CONDITIONING", "2.3 guardrails: cannot condition anything on enrollment", (i) => i.op === "write" && data(i).conditioned_benefit !== undefined, "no benefit or term may be conditioned on autodraft enrollment")] },
  { name: "consent.capture", kind: "write", handler: write("consents", "consent.captured"),
    guardrails: [never("DISCLOSE_AND_OFFER_HUMAN", "2.3 guardrails: must disclose automation and offer a human at the start of every voice/chat enrollment", (i) => ["voice", "chat"].includes(String(data(i).channel)) && (data(i).automation_disclosed !== true || data(i).human_offered !== true), "voice/chat enrollment without automation disclosure and a human offer"),
      never("NO_ACCOUNT_READBACK", "2.3 guardrails: cannot read back full account numbers", (i) => data(i).account_number_read_back === true, "full account numbers are never read back")] },
  { name: "account_validation.verify", kind: "act", handler: compute((i, ctx, rt) => { const method = str(i, "method"); const status = method === "prenote" ? (flag(i, "return_received") ? "failed_prenote" : "validated_prenote") : method === "microdeposit" ? (flag(i, "amounts_confirmed") ? "validated_microdeposit" : "pending_microdeposit") : method === "instant" ? (flag(i, "vendor_match") ? "validated_instant" : "failed_instant") : "unvalidated"; rt.store.put("account_validations", str(i, "enrollment_id"), { method, status, verified_at: ctx.now }, ctx.actor, ctx.now);
      if (status !== "pending_microdeposit") ctx.events.append({ type: "autodraft.validation.completed", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, aggregate: { kind: "autodraft_enrollment", id: str(i, "enrollment_id") }, actor: ctx.actor, payload: { enrollment_id: str(i, "enrollment_id"), method, status, validated_at: status.startsWith("validated_") ? ctx.now : null } });   // NACHA_PRENOTE_WAIT_3BANKING_DAYS: `autodraft.validation.completed{status=validated_prenote}`
      return { enrollment_id: str(i, "enrollment_id"), validation_status: status }; }) },
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
  // `fees.suspend/waive` is defined in ./section2-6.ts (TOOLS_2_6): it runs through the late-charge engine and carries the 2.7 courtesy guardrail.
  { name: "smdu.submit_trial_payment", kind: "act", handler: compute(async (i, ctx, rt) => {
      const pkg = { case_id: str(i, "case_id"), due_date: str(i, "due_date"), received_on: str(i, "received_on"), amount_cents: String(cents(i.amount_cents)) };
      try {
        const ack = await port(rt, "smdu").reportTppPayment(pkg.case_id, { dueDate: pkg.due_date, receivedOn: pkg.received_on, amountCents: pkg.amount_cents });
        ctx.events.append({ type: "smdu.trial_payment.reported", loanId: ctx.loanId, actor: ctx.actor, payload: { ...pkg, via: "b2b", reported_at: ctx.now, ack } });   // FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD
        return ack;
      } catch (e) {
        const t = rt.escalations.open({ kind: "human_portal_task", loanId: ctx.loanId, caseId: pkg.case_id, payload: { package: pkg, reason: (e as Error).message, sla: "1 business_days_fannie_et" } }, ctx.actor);
        ctx.events.append({ type: "human_portal_task.created", loanId: ctx.loanId, actor: ctx.actor, payload: { kind: "smdu_trial_payment", portal_task_id: t.id, ...pkg, sla: "1 business_days_fannie_et", satisfied_by: "smdu.trial_payment.reported{via=human_portal_task} on completion" } });
        return { portal_task_id: t.id, fallback: "SMDU UI" };
      } }) },
]);

/**
 * 2.7 gate facts for the fee commands. Callers pass `facts` (the audit record of the test), and when the loan's cash state is on the
 * input the facts the engine can derive — grace end, prior charges on the installment, courtesy count — are filled in from it, so an
 * omitted fact is never a silently open gate: every evaluator below reads NaN/undefined as closed.
 */
const lcFacts = (i: ToolInput): Record<string, unknown> => {
  const f: Record<string, unknown> = { ...((i.facts as Record<string, unknown> | undefined) ?? {}) };
  const state = i.state as LoanCashState | undefined;
  const due = str(i, "installment_due_date");
  if (state) {
    if (due) {
      f.grace_end_on ??= graceEndFor(state, D(due));
      f.late_charges_for_installment_not_reversed ??= (state.fees ?? []).filter((x) => x.fee_type === "late_charge" && x.installment_due_date === due && x.state !== "reversed").length;
    }
    f.run_on ??= str(i, "run_on");
    f.courtesy_waivers_rolling_12m ??= state.courtesy_waivers_12m ?? 0;
    // Rule 3(ii) / D2-3.2-01: after a plan default "the servicer is authorized to accrue late charges from the date the borrower defaulted" —
    // an installment due on/after `defaulted_on` is assessable, so the forbearance overlay is not "active" for it (2.7-T5, example N).
    const fb = (state.overlays ?? []).find((o) => o.kind === "forbearance_active" && (!due || o.from <= due) && (!o.to || !due || o.to >= due));
    f.forbearance_active ??= !!fb && !(fb.defaulted_on && due && due >= fb.defaulted_on);
    f.installment_due_date ??= due; f.defaulted_on ??= fb?.defaulted_on ?? "";
    f.scra_reduced_rate_period_active ??= (state.overlays ?? []).some((o) => o.kind === "scra_reduced_rate" && (!due || o.from <= due) && (!o.to || !due || o.to >= due));
    f.post_petition ??= (state.overlays ?? []).some((o) => o.kind === "bankruptcy_active" && (!due || o.from <= due) && (!o.to || !due || o.to >= due));
    // §1026.36(c)(2) facts from the state (rule 1 credited-funds test): periodic payment credited by grace end; the only shortfall is prior fees.
    const inst = due ? state.installments.find((x) => x.due_date === due) : undefined;
    if (inst) {
      const credited = receivedTowardBasis(state, D(due)) >= basisCents(state, inst);
      f.periodic_payment_credited_by_grace_end ??= credited;
      f.only_shortfall_is_prior_fees ??= credited && state.late_charges_due_cents + state.nsf_fees_due_cents + state.other_fees_due_cents > 0n;
    }
  }
  return f;
};
const gateOn = (ref: string, code: string, citation: string) => guard(code, citation, (i) => { const r = evaluateGate(ref, lcFacts(i)); return r.open ? undefined : `${r.reason ?? "gate closed"} (${ref}; pass facts.${ref === "2.1.noPostingBacklog" ? "items_received_or_identified_on_or_before_gate_date" : ref === "2.7.graceGateOpen" ? "run_on/grace_end_on" : ref === "2.7.onlyOnePerInstallment" ? "late_charges_for_installment_not_reversed" : "…"} or the loan state)`; });
const withOps = (ctx: CommandContext) => new CashieringOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor });
const withLcOps = (ctx: CommandContext) => new LateChargeOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor });
const feeRecord = (f: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

const p27: ToolDef[] = defineTools("2.7", "cashiering", [
  { name: "fees.read", kind: "read", handler: read("fees") },
  { name: "fees.assess", kind: "write",
    /** Engine path (`state` on the input): the 2.7 calculator decides and records the fee; record path: a facts-gated store write of an assessment made elsewhere. */
    handler: compute((i, ctx, rt) => {
      if (!i.state) return write("fees", "fee.assessed")(i, ctx, rt);
      const state = i.state as LoanCashState;
      // Rule 1: the credited-funds test is the engine's (receivedTowardBasis from the installment's status/credited_as_of) unless the caller carries the credited figure.
      const r = withLcOps(ctx).assess({ state, installment_due_date: D(str(i, "installment_due_date")), ...(i.received_toward_basis_cents !== undefined && i.received_toward_basis_cents !== null ? { received_toward_basis_cents: cents(i.received_toward_basis_cents) } : {}), run_on: D(str(i, "run_on") || ctx.now.slice(0, 10)), unposted_receipts_on_or_before_grace: Number(i.unposted_receipts_on_or_before_grace ?? 0) });
      if (r.outcome === "assessed" || r.outcome === "accrued_suspended") rt.store.put("fees", r.fee.id, feeRecord({ ...r.fee, loan_id: state.loan_id }), ctx.actor, ctx.now);
      return r;
    }),
    guardrails: [gateOn("2.7.graceGateOpen", "GRACE_GATE", "2.7 guardrails: cannot assess without the grace gate (NOTE_6A_LATE_CHARGE_GRACE_GATE)"),
      gateOn("2.1.noPostingBacklog", "POSTING_BACKLOG_GATE", "2.7 guardrails: cannot assess without the posting-backlog gate (SM_CASHIERING_POSTING_BACKLOG_GATE)"),
      gateOn("2.7.onlyOnePerInstallment", "ONCE_PER_INSTALLMENT", "2.7 guardrails: cannot assess twice (NOTE_6A_ONLY_ONCE_GATE)"),
      gateOn("2.7.noPyramiding", "NO_PYRAMIDING", "2.7 guardrails / §1026.36(c)(2): no charge when the periodic payment was credited by grace end and the only shortfall is prior fees (REGZ_1026_36C2_NO_PYRAMID_GATE)"),
      never("CAPS", "2.7 guardrails: cannot exceed note/state caps", (i) => i.cap_cents !== undefined && cents(data(i).amount_cents ?? i.amount_cents) > cents(i.cap_cents), "amount exceeds the note/state cap"),
      never("NOT_FROM_PI_ESCROW", "2.7 guardrails: cannot collect from P&I/escrow", (i) => ["pi", "escrow"].includes(str(i, "collect_from")), "late charges are never taken from P&I or escrow"),
      never("OVERLAYS", "2.7 guardrails: cannot assess post-petition or during forbearance/SCRA", (i) => { const f = lcFacts(i); return f.post_petition === true || f.forbearance_active === true || f.scra_reduced_rate_period_active === true || flag(i, "scra_active"); }, "bankruptcy, forbearance or SCRA overlay is active")] },
  { name: "fees.waive", kind: "write",
    handler: compute((i, ctx, rt) => {
      if (!i.state) return write("fees", "fee.waived")(i, ctx, rt);
      const state = i.state as LoanCashState;
      const r = withOps(ctx).waive(state, str(i, "fee_id"), str(i, "reason") as WaiverReason, ctx.actor, D(ctx.now.slice(0, 10)));
      if (!r.ok) throw new CommandRefused("fees.waive", r.code, "2.7 rule 5 (waivers: automatic reasons; one courtesy per loan per 12 months)", r.reason);
      rt.store.put("fees", str(i, "fee_id"), { state: "waived", waived_reason: str(i, "reason"), waived_cents: r.waived_cents.toString(), by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
      return r;
    }),
    guardrails: [guard("COURTESY_LIMIT", "2.7 guardrails: cannot waive beyond the courtesy limit without the officer (SM_LC_COURTESY_WAIVER_LIMIT_12M)", (i, ctx) => {
      if (str(i, "reason") !== "courtesy" && !flag(i, "beyond_courtesy_limit")) return undefined;
      if (hasRole(ctx.actor, ["officer"])) return undefined;
      const r = evaluateGate("2.7.courtesyWaiverLimit", lcFacts(i));
      return r.open && !flag(i, "beyond_courtesy_limit") ? undefined : `${r.reason ?? "waiver beyond the courtesy limit"}; requires officer`; })] },
  { name: "fees.reverse", kind: "write",
    /** Engine path (`state` on the input): rule 6 — a payment re-dated on time reverses the installment's charge, refunds what was collected and corrects 8.1; record path: a store write of a reversal made elsewhere. */
    handler: compute((i, ctx, rt) => {
      if (!i.state) return write("fees", "fee.reversed")(i, ctx, rt);
      const state = i.state as LoanCashState;
      const r = withLcOps(ctx).redate(state, D(str(i, "installment_due_date")), D(str(i, "credited_as_of")), { correction_ref: str(i, "correction_ref") || `${ctx.actor.kind}:${ctx.actor.id}`, ...(i.delinquency_reported === false ? { delinquency_reported: false } : {}) });
      if (r.reversed) rt.store.put("fees", r.reversed.id, feeRecord({ ...r.reversed, loan_id: state.loan_id, refund_cents: r.refund_cents }), ctx.actor, ctx.now);
      return { reversed: r.reversed ? feeRecord({ ...r.reversed }) : null, refund_cents: r.refund_cents.toString(), credit_reporting_correction: r.credit_reporting_correction };
    }) },
  overlays,
  { name: "payments.history", kind: "read", handler: history("payments") },
  noticeSend, escalationCreate,
]);

export const SECTION_02_TOOLS: readonly ToolDef[] = [...p21, ...p22, ...p23, ...p24, ...p25, ...p26, ...p27];
