/**
 * §21.4 process-owned tools — bus tools for 21.4 defined with `defineTools("21.4", "pricing", defs)` from ../tools.ts.
 * Every tool string is one spec/registry/agents.json names for 21.4; src/app/tools.test.ts refuses the rest. Spread by
 * ./index.ts. The handlers are thin: the rules live in src/domain/application/ops-21-4.ts; the store keeps
 * `intent_records`, `fee_gate_checks`, `pricing_quotes`, `locks`, `lock_extensions`, `changed_circumstances` and
 * `commitments` (migration 0066); the LE receipt chain is read from 21.2's events; the best-efforts commitment goes
 * through the `secondary` service (29.1's adapter) or, until it is wired, the in-process adapter. Guardrails encode the
 * AI-design sentences: never a fee or a payment method before the gate opens (a hard code path: the handler refuses on
 * the `fee_gate_checks.result`); never particular lock terms to the borrower before `lock.approved`; never a rate/points/
 * credits change without a new lock version and a revised LE/CD; never two open commitments on a lineage; never
 * silence, an unanswered e-mail or the LE signature line alone as intent; never "no cost to lock" when a lock fee
 * exists; lender-caused delay is never charged to the borrower; the MLO of record (a human) approves every lock.
 */
import { defineTools, compute, decision, never, needsRole, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { creditor, type Calendar } from "../../kernel/calendar/business.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { Recipient } from "../../notices/channel.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import {
  CREDITOR_TZ, FixturePricing, InMemoryCommitmentAdapter, LockRefused, approveLock, applyFloatDown, assertNyNoticeInWindow, assessRevisedLe, cancelLock, checkFeeGate, civilDate, confirmLock, executeLock, expireLock, expiryDisplay, extendLock, imposeFee,
  intentInForce, lateLockWarning, leReceiptFromEvents, linkCommitment, lockConfirmationPayload, nyExpiryNoticeWindow, quoteExtension, recordIntent, reflectedDisclosure, rejectLock, relock, requestLock, warnExpiry, withdrawIntent,
  type CancelReason, type CommitmentPort, type DelayAttribution, type IntentRecord, type Lock, type LockExtension, type PricingPort, type PricingQuote, type ChangedCircumstance,
} from "../../domain/application/ops-21-4.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optIso = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && i[k] ? String(i[k]) : null);
const lockOf = (rt: ToolRuntime, i: ToolInput): Lock => { need(i, "lock_id"); return rt.store.require("locks", str(i, "lock_id")).data as unknown as Lock; };
const putLock = (rt: ToolRuntime, l: Lock, ctx: CommandContext): void => { rt.store.put("locks", l.lock_id, { ...l }, ctx.actor, ctx.now); };
const putCc = (rt: ToolRuntime, cc: ChangedCircumstance | null, ctx: CommandContext): void => { if (cc) rt.store.put("changed_circumstances", cc.cc_id, { ...cc }, ctx.actor, ctx.now); };
const intentsOf = (rt: ToolRuntime, app: string): IntentRecord[] => rt.store.list("intent_records", (d) => d.application_id === app).map((r) => r.data as unknown as IntentRecord);
const quoteOf = (rt: ToolRuntime, i: ToolInput, k = "quote_id"): PricingQuote => { need(i, k); return rt.store.require("pricing_quotes", str(i, k)).data as unknown as PricingQuote; };
/** 20.4's engine when wired (`services.pricing`); otherwise the fixture adapter over the rate sheets the caller supplies. */
const pricingOf = (rt: ToolRuntime, i: ToolInput): PricingPort => {
  const svc = rt.services.pricing as PricingPort | undefined; if (svc) return svc;
  const sheets = i.rate_sheets as ConstructorParameters<typeof FixturePricing>[0] | undefined; if (!sheets) throw new RangeError("rate_sheets (or a wired pricing service) is required");
  return new FixturePricing(sheets);
};
const commitmentsOf = (rt: ToolRuntime, ctx: CommandContext): CommitmentPort => {
  const svc = rt.services.secondary as CommitmentPort | undefined; if (svc) return svc;
  const adapter = new InMemoryCommitmentAdapter(ctx.events); (rt.services as Record<string, unknown>).secondary = adapter; return adapter;
};
const calendarOf = (i: ToolInput): Calendar => (i.calendar as Calendar | undefined) ?? creditor;
let REG: TimerRegistry | null = null;
const registryDef = (code: string) => { REG ??= loadOverriddenRegistry(); const d = REG.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };
const armed = (t: { status: string }) => t.status === "armed" || t.status === "breached";
/** The expiry clocks follow the lineage: cancel the instances armed for the superseded/extended terms and re-arm from the new event. */
const rearmExpiry = (ctx: CommandContext, app: string, trigger: DomainEvent, reason: string): void => {
  for (const code of ["SM_LOCK_EXPIRY_DEADLINE", "SM_LOCK_EXPIRY_WARN_7"]) {
    for (const t of ctx.timers.forSubject("application", app)) if (t.code === code && armed(t) && t.armedByEventId !== trigger.id) ctx.timers.cancel(t.id, reason, ctx.actor);
    if (!ctx.timers.byCode(code).some((t) => t.armedByEventId === trigger.id)) ctx.timers.arm(registryDef(code), trigger);
  }
};
const recipientsOf = (i: ToolInput): Recipient[] => (Array.isArray(i.recipients) ? (i.recipients as Recipient[]) : []);
const lockPackage = (l: Lock, extra: Record<string, unknown> = {}) => ({ lock_id: l.lock_id, lineage_id: l.lineage_id, version: l.version, kind: l.kind, quote_id: l.quote_id, rate_sheet_id: l.quote.rate_sheet_id, llpa_version: l.quote.llpa_version, terms: { note_rate: l.note_rate, price: l.price, points_cents: String(l.points_cents), lender_credit_cents: String(l.lender_credit_cents), period_days: l.lock_period_days },
  borrower_statement: l.borrower_statement, state_agreement_variant: l.state_agreement_variant, ...extra });
/** ops-21-4 refusals (LockRefused) surface as CommandRefused with the same code and citation. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof LockRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); throw e; } } }));

export const TOOLS_21_4: readonly ToolDef[] = defineTools("21.4", "pricing", refusing([
  // Pricing engine (20.4) call behind the port: a quote stamped with the rate sheet and LLPA version in force; kept for the request/approval chain.
  { name: "getQuote", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "loan_amount_cents", "product_code", "note_rate_pct", "lock_period_days"); const app = appOf(i, ctx);
      const q = pricingOf(rt, i).price({ application_id: app, loan_amount_cents: cents(i.loan_amount_cents), product_code: str(i, "product_code"), note_rate_pct: str(i, "note_rate_pct"), lock_period_days: Number(i.lock_period_days),
        ...(typeof i.points_pct === "string" ? { points_pct: i.points_pct } : {}), ...(typeof i.price_pct === "string" ? { price_pct: i.price_pct } : {}), ...(typeof i.lender_credit_pct === "string" ? { lender_credit_pct: i.lender_credit_pct } : {}), quote_id_fnma: optIso(i, "quote_id_fnma") }, at(i, "at", ctx));
      rt.store.put("pricing_quotes", q.quote_id, { ...q }, ctx.actor, ctx.now);
      return { quote: q, rate_sheet_id: q.rate_sheet_id, llpa_version: q.llpa_version, quote_id: q.quote_id, disclaimer_gate: "REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE (20.4) applies to any pre-LE written estimate" }; }),
    guardrails: [never("NO_COST_TO_LOCK_CLAIM", "21.4 AI design guardrail: never quote 'no cost to lock' when a lock fee exists", (i) => flag(i, "describe_as_no_cost") && cents(i.lock_fee_cents) > 0n, "a lock fee exists; the quote must state it"),
      never("PROHIBITED_BASIS_IN_PRICING", "21.4 AI design guardrail; Reg B §1002.4; 31.2 monitoring", (i) => i.prohibited_basis_inputs !== undefined && Array.isArray(i.prohibited_basis_inputs) && i.prohibited_basis_inputs.length > 0, "pricing never infers or uses a prohibited-basis characteristic")] },
  // Rule 1: assertGateOpen for imposeFee / capturePaymentMethod / orderAppraisal (24.1) / orderTitle (24.4) / orderFloodDetermination (24.5) / orderPropertyDataCollection — every attempt is a fee_gate_checks row; op=impose also authorizes the fee and posts it.
  { name: "checkFeeGate", kind: "write", moneyFields: ["amount_cents", "collected_cents"], handler: compute((i, ctx, rt) => {
      need(i, "command", "fee_kind", "amount_cents"); const app = appOf(i, ctx); const checked_at = at(i, "checked_at", ctx);
      const receipt = leReceiptFromEvents(ctx.events, app); const intent = intentInForce(intentsOf(rt, app), checked_at);
      const r = checkFeeGate(ctx.events, { application_id: app, command: str(i, "command"), fee_kind: str(i, "fee_kind"), amount_cents: cents(i.amount_cents), checked_at, le_effective_receipt_date: receipt?.effective_receipt_date ?? null, intent,
        vendor_invoice_cents: i.vendor_invoice_cents === undefined ? null : cents(i.vendor_invoice_cents), fee_item_id: optIso(i, "fee_item_id"), actor: `${ctx.actor.kind}:${ctx.actor.id}`, time_zone: str(i, "time_zone") || CREDITOR_TZ }, ctx.actor);
      rt.store.put("fee_gate_checks", r.check.check_id, { ...r.check }, ctx.actor, ctx.now);
      if (!r.open) {
        if (i.op === "impose" || str(i, "command") === "impose_fee" || str(i, "command") === "capture_payment_method") rt.escalations.open({ kind: "sev1", ownerRole: "compliance", applicationId: app, severity: "sev-1", payload: { reason: "fee_before_intent_attempt", check_id: r.check.check_id, result: r.check.result, command: r.check.command, amount_cents: String(r.check.amount_cents) } }, ctx.actor);
        throw new CommandRefused("checkFeeGate", r.check.result, "12 CFR 1026.19(e)(2)(i)(A)", `${r.check.command} refused: ${r.check.result} (payment method not captured; fee_gate_checks ${r.check.check_id})`);
      }
      if (i.op !== "impose") return { check_id: r.check.check_id, result: r.check.result, collected_cents: r.check.collected_cents, open: true, intent_id: intent?.intent_id ?? null, le_effective_receipt_date: receipt?.effective_receipt_date ?? null };
      need(i, "fee_item_id", "method");
      const f = imposeFee(ctx.events, ctx.ledger, { check: r.check, fee_item_id: str(i, "fee_item_id"), method: str(i, "method"), at: checked_at }, ctx.actor);
      return { check_id: r.check.check_id, result: r.check.result, collected_cents: f.amount_cents, open: true, imposed: true, ledger_set_id: f.ledger_set.id, event_id: f.event.id, intent_id: intent?.intent_id ?? null }; }),
    guardrails: [never("FEE_GATE_BYPASS", "12 CFR 1026.19(e)(2)(i)(A); 21.4 AI design: never impose or capture payment for any fee before the gate opens (hard code path, not a prompt)", (i) => flag(i, "bypass_gate") || flag(i, "partner_instructed_override"), "SM is 'any other person' under (e)(2)(i)(A) and is bound whatever the partner's instructions"),
      never("CREDIT_TOKEN_REUSE", "21.4 rule 1: a token collected for the credit-report fee is single-use", (i) => flag(i, "reuse_credit_report_token"), "a fresh authorization after the gate opens is required")] },
  // Rule 2: a documented intent statement validated against the LE's effective receipt date; premature statements are kept as evidence (valid=false).
  { name: "recordIntent", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx);
      if (i.op === "withdraw") { need(i, "intent_id"); const cur = rt.store.require("intent_records", str(i, "intent_id")).data as unknown as IntentRecord; const w = withdrawIntent(ctx.events, cur, at(i, "withdrawn_at", ctx), ctx.actor); rt.store.put("intent_records", w.record.intent_id, { ...w.record }, ctx.actor, ctx.now); return { intent_id: w.record.intent_id, withdrawn_at: w.record.withdrawn_at }; }
      need(i, "channel", "statement_text", "evidence_document_id");
      const receipt = leReceiptFromEvents(ctx.events, app);
      if (!receipt) throw new LockRefused("NO_LOAN_ESTIMATE", "12 CFR 1026.19(e)(2)(i)(A): intent is an indication 'to proceed with the transaction described by those disclosures'", "no Loan Estimate has been delivered; the statement cannot be validated against a receipt date");
      const r = recordIntent(ctx.events, { application_id: app, disclosure_id: str(i, "disclosure_id") || receipt.disclosure_id, le_effective_receipt_date: receipt.effective_receipt_date, received_at: at(i, "received_at", ctx), channel: str(i, "channel"), statement_text: str(i, "statement_text"),
        evidence_document_id: str(i, "evidence_document_id"), recorded_by: ctx.run?.runId ?? `${ctx.actor.kind}:${ctx.actor.id}`, time_zone: str(i, "time_zone") || CREDITOR_TZ }, ctx.actor);
      rt.store.put("intent_records", r.record.intent_id, { ...r.record }, ctx.actor, ctx.now);
      return { intent_id: r.record.intent_id, valid: r.record.valid, received_at: r.record.received_at, le_effective_receipt_date: r.record.le_effective_receipt_date, event: r.event.type, re_ask_after_receipt: !r.record.valid }; }),
    guardrails: [never("SILENCE_IS_NOT_INTENT", "Official Interpretation 19(e)(2)(i)(A)-2: a consumer's silence is not indicative of intent because it cannot be documented; 21.4 AI design guardrail", (i) => flag(i, "inferred_from_silence") || ["silence", "unanswered_email", "le_signature_line"].includes(str(i, "channel")), "silence, an unanswered e-mail or the LE signature line alone is never intent")] },
  // Rule 11 / guardrails: quote → guardrails (rate-sheet freshness, product, loan amount vs LE, no denial, intent) → pending_mlo_approval + the MLO package.
  { name: "requestLock", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "quote_id", "borrower_statement", "property_state", "le_loan_amount_cents"); const app = appOf(i, ctx); const requested_at = at(i, "requested_at", ctx);
      if (!leReceiptFromEvents(ctx.events, app)) throw new LockRefused("PRE_LE_LOCK", "21.4 open question 2: pre-LE locks are not offered", "no Loan Estimate has been delivered");
      const pricing = pricingOf(rt, i); const quote = quoteOf(rt, i);
      const r = requestLock(ctx.events, { application_id: app, quote, requested_at, borrower_statement: str(i, "borrower_statement"), property_state: str(i, "property_state"), pricing, time_zone: str(i, "time_zone") || CREDITOR_TZ, ...(typeof i.lineage_id === "string" ? { lineage_id: i.lineage_id } : {}), recorded_by: ctx.run?.runId ?? `${ctx.actor.kind}:${ctx.actor.id}`,
        facts: { le_loan_amount_cents: cents(i.le_loan_amount_cents), eligible_products: Array.isArray(i.eligible_products) ? (i.eligible_products as string[]) : [], denial_open: flag(i, "denial_open"), intent: intentInForce(intentsOf(rt, app), requested_at), property_state: str(i, "property_state") } }, ctx.actor);
      if (r.quote_refreshed) rt.store.put("pricing_quotes", r.lock.quote.quote_id, { ...r.lock.quote }, ctx.actor, ctx.now);
      const esc = rt.escalations.open({ kind: "mlo_of_record", applicationId: app, payload: lockPackage(r.lock, { guardrail_results: r.guardrails, quote_refreshed: r.quote_refreshed, stale_quote_id: r.stale_quote_id, sla: "SM_LOCK_MLO_APPROVAL_SLA_30MIN" }) }, ctx.actor);
      const lock: Lock = { ...r.lock, mlo_approval_escalation_id: esc.id }; putLock(rt, lock, ctx);
      return { lock_id: lock.lock_id, lineage_id: lock.lineage_id, status: lock.status, quote_id: lock.quote_id, rate_sheet_id: lock.quote.rate_sheet_id, quote_refreshed: r.quote_refreshed, stale_quote_id: r.stale_quote_id, guardrails: r.guardrails, escalation_id: esc.id, executed: false }; }),
    guardrails: [never("TERMS_BEFORE_MLO_APPROVAL", "12 CFR 1008.103 / Appendix A ('offers or negotiates terms'); 21.4 AI design: never present particular lock terms to the borrower before lock.approved", (i) => flag(i, "present_terms_to_borrower"), "the AI reads terms back only after the MLO of record approves"),
      never("LOCK_CONDITIONED_ON_DOCUMENTS", "12 CFR 1026.19(e)(2)(iii): no verifying documents may be required before the LE; a lock presupposes the LE", (i) => flag(i, "require_verifying_documents"), "the lock request may not be conditioned on documents")] },
  // Rule 11: every lock/relock/float-down/borrower-paid extension opens an `mlo_of_record` escalation with the one-screen package.
  { name: "openMloEscalation", kind: "write", handler: compute((i, ctx, rt) => {
      const l = lockOf(rt, i);
      const e = rt.escalations.open({ kind: "mlo_of_record", applicationId: l.application_id, payload: lockPackage(l, { stage: str(i, "stage") || l.kind, apor_spread_preview: i.apor_spread_preview ?? null, sla: "SM_LOCK_MLO_APPROVAL_SLA_30MIN" }) }, ctx.actor);
      putLock(rt, { ...l, mlo_approval_escalation_id: e.id }, ctx); return { escalation_id: e.id, owner_role: e.ownerRole, lock_id: l.lock_id }; }) },
  // State machine: op=approve (mlo_of_record, a human; quote_expired when the sheet moved) · op=assess_late_lock (the (e)(4)(ii) warning) · execute (default): locked_at, rate_set_date, expiry, the 3BD clock and the changed_circumstances row.
  { name: "executeLock", kind: "write", moneyFields: ["note_rate", "price", "points_cents", "lender_credit_cents"], handler: compute((i, ctx, rt) => {
      const l = lockOf(rt, i); const app = l.application_id; const pricing = () => pricingOf(rt, i);
      if (i.op === "approve") { need(i, "quote_id", "mlo_nmlsr_id"); const r = approveLock(ctx.events, l, { quote_id: str(i, "quote_id"), mlo_nmlsr_id: str(i, "mlo_nmlsr_id"), approved_at: at(i, "approved_at", ctx), pricing: pricing() }, ctx.actor); putLock(rt, r.lock, ctx); return { lock_id: l.lock_id, approved_at: r.lock.approved_at, mlo_nmlsr_id: r.lock.mlo_nmlsr_id, status: r.lock.status }; }
      if (i.op === "reject") { need(i, "reason"); const r = rejectLock(ctx.events, l, { reason: str(i, "reason"), at: at(i, "rejected_at", ctx) }, ctx.actor); putLock(rt, r.lock, ctx); return { lock_id: l.lock_id, status: r.lock.status }; }
      const executed_at = at(i, "executed_at", ctx); const cd_provided_at = optIso(i, "cd_provided_at"); const consummation_on = optDate(i, "consummation_on");
      const assessment = assessRevisedLe({ locked_at: executed_at, consummation_on, cd_provided_at, cal: calendarOf(i), tz: l.time_zone });
      const warning = assessment.reflected_on === "cd" && consummation_on && i.le_terms && typeof i.le_terms === "object"
        ? lateLockWarning({ loan_amount_cents: l.loan_amount_cents, before: { note_rate_pct: String((i.le_terms as Record<string, unknown>).note_rate_pct), points_cents: cents((i.le_terms as Record<string, unknown>).points_cents) }, after: { note_rate_pct: l.note_rate, points_cents: l.points_cents }, corrected_cd_received_on: civilDate(executed_at, l.time_zone), scheduled_consummation_on: consummation_on, cal: calendarOf(i) }) : null;
      if (i.op === "assess_late_lock") return { lock_id: l.lock_id, revised_le: assessment, warning };
      if (assessment.reflected_on === "cd" && !optIso(i, "borrower_warned_at")) throw new LockRefused("LATE_LOCK_WARNING_REQUIRED", "21.4 edge case: lock request after the CD is provided is allowed only with the 25.2 corrected-CD path and a borrower warning about a possible new waiting period", `warn the borrower first: ${warning?.text ?? assessment.reason}`);
      const r = executeLock(ctx.events, l, { executed_at, cal: calendarOf(i), consummation_on, cd_provided_at, intent: intentInForce(intentsOf(rt, app), executed_at), denial_open: flag(i, "denial_open"), recorded_by: ctx.run?.runId ?? `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor);
      putLock(rt, r.lock, ctx); putCc(rt, r.changed_circumstance, ctx);
      return { lock_id: r.lock.lock_id, lineage_id: r.lock.lineage_id, version: r.lock.version, status: r.lock.status, locked_at: r.lock.locked_at, rate_set_date: r.lock.rate_set_date, expires_on: r.lock.expires_on, expires_at: r.lock.expires_at, expiry_roll_applied: r.lock.expiry_roll_applied, expires_display: r.expiry.display,
        note_rate: r.lock.note_rate, price: r.lock.price, points_cents: r.lock.points_cents, lender_credit_cents: r.lock.lender_credit_cents, revised_le: r.revised_le, cc_id: r.changed_circumstance.cc_id, ny_window: r.ny_window, warning, borrower_warned_at: optIso(i, "borrower_warned_at"), event_id: r.event.id, mlo_nmlsr_id: r.lock.mlo_nmlsr_id }; }),
    guardrails: [needsRole("MLO_APPROVAL_IS_HUMAN", "12 CFR 1008.103 / Appendix A: an AI is not 'an individual'; feature flag origination.ai_mlo_intake=assisted", (i) => i.op === "approve" || i.op === "reject", ["mlo_of_record"], "only the MLO of record approves or returns lock terms"),
      never("RATE_CHANGE_WITHOUT_NEW_VERSION", "21.4 AI design guardrail: never change note rate, points or credits without a new lock version and a revised LE/CD", (i) => !!i.changes && ["note_rate", "price", "points_cents", "lender_credit_cents"].some((k) => k in (i.changes as Record<string, unknown>)), "use relock / applyFloatDown / a renegotiation version")] },
  // Outputs: NTC_SM_RATE_LOCK_CONFIRMATION (the lock agreement; NY/NJ/MA variants) rendered through the Notice Registry.
  { name: "renderLockConfirmation", kind: "write", handler: compute((i, ctx, rt) => {
      const l = lockOf(rt, i); need(i, "borrower_names", "property_address", "partner_name", "mlo_name", "mlo_nmlsr_id");
      const payload = lockConfirmationPayload(l, { borrower_names: (i.borrower_names as string[]), property_address: str(i, "property_address"), partner_name: str(i, "partner_name"), mlo_name: str(i, "mlo_name"), mlo_nmlsr_id: str(i, "mlo_nmlsr_id"), lock_fee_cents: cents(i.lock_fee_cents), commitment_fee_cents: cents(i.commitment_fee_cents) });
      rt.store.put("locks", l.lock_id, { confirmation_payload: payload }, ctx.actor, ctx.now);
      if (!rt.notices) return { lock_id: l.lock_id, payload, rendered: false };
      const n = rt.notices.render({ templateCode: "NTC_SM_RATE_LOCK_CONFIRMATION", recipients: recipientsOf(i), payload, asOf: civilDate(ctx.now, l.time_zone) });
      return { lock_id: l.lock_id, notice_id: n.id, status: n.status, payload, rendered: true, checklist_ok: n.checklist.passed }; }) },
  // Rule 9: best-efforts commitment for the same borrower and property through `secondary` (29.1) — one per lineage; `commitment.executed` → `lock.commitment.linked`.
  { name: "requestCommitment", kind: "write", handler: compute((i, ctx, rt) => {
      const l = lockOf(rt, i); const port = commitmentsOf(rt, ctx); const now = at(i, "at", ctx);
      if (i.op === "fallout") { need(i, "reason"); const f = port.recordFallout(l.lineage_id, str(i, "reason") as CancelReason, now); return { lineage_id: l.lineage_id, commitment: f.commitment, pair_off_expected: f.pair_off_expected }; }
      if (i.op === "key_data_change") { need(i, "change"); const c = port.keyDataChange(l, now, str(i, "change")); rt.store.put("commitments", c.commitment_id, { ...c }, ctx.actor, ctx.now); return { commitment_id: c.commitment_id, status: c.status, modifications: c.modifications }; }
      if (flag(i, "mandatory_enabled")) return { lock_id: l.lock_id, commitment_id: null, decoupled: true, note: "execution.mandatory_enabled=true: 29.2 hedges the pipeline; commitment_id stays null" };
      const c = port.requestBestEfforts(l, now); const r = linkCommitment(ctx.events, l, c, now, ctx.actor);
      putLock(rt, r.lock, ctx); rt.store.put("commitments", c.commitment_id, { ...c }, ctx.actor, ctx.now);
      return { lock_id: l.lock_id, commitment_id: c.commitment_id, commitment_id_fnma: c.commitment_id_fnma, expires_on: c.expires_on, open_commitments: port.open(l.lineage_id).length }; }),
    guardrails: [never("BEST_EFFORTS_TO_MANDATORY", "Fannie Mae Selling Guide C2-1.2-03: lenders may not change a best efforts commitment to a mandatory commitment (or vice versa)", (i) => flag(i, "convert_to_mandatory"), "a commitment type is never switched"),
      never("SECOND_OPEN_COMMITMENT", "21.4 AI design guardrail: never let a lock lineage carry two open Fannie Mae commitments (C2-1.2-02 duplicate commitment price adjustment)", (i) => flag(i, "force_duplicate_commitment"), "one open commitment per lineage")] },
  // 21.5 hook: the changed_circumstances row executeLock/extendLock inserted; op=reflect links the revised LE (21.5) or the corrected CD (25.2) that carries the lock terms.
  { name: "recordChangedCircumstance", kind: "write", handler: compute((i, ctx, rt) => {
      const l = lockOf(rt, i);
      const rows = rt.store.list("changed_circumstances", (d) => d.lock_id === l.lock_id).map((r) => r.data as unknown as ChangedCircumstance);
      if (i.op === "list") return { lock_id: l.lock_id, rows };
      const d = reflectedDisclosure(ctx.events, l);
      if (!d) return { lock_id: l.lock_id, reflected: false, rows };
      const cc = rows.find((r) => r.kind === "rate_lock") ?? rows[0];
      if (cc) rt.store.put("changed_circumstances", cc.cc_id, { revised_le_disclosure_id: d.disclosure_id, reflected_on: d.reflected_on }, ctx.actor, ctx.now);
      putLock(rt, { ...l, revised_le_disclosure_id: d.disclosure_id }, ctx);
      let retired: string | null = null;
      if (d.reflected_on === "cd") for (const t of ctx.timers.forSubject("application", l.application_id)) if (t.code === "REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD" && armed(t)) { ctx.timers.cancel(t.id, `satisfied by ${d.event.type} ${d.disclosure_id} (reflected_on=cd): a revised LE is barred by §1026.19(e)(4)(ii), the lock terms are on the corrected CD (25.2)`, ctx.actor); retired = t.id; }
      return { lock_id: l.lock_id, reflected: true, reflected_on: d.reflected_on, disclosure_id: d.disclosure_id, cc_id: cc?.cc_id ?? null, timer_retired: retired }; }) },
  // Rule 6: an extension quote — days past expiry, fee per the partner schedule, payer from the delay attribution, and which disclosure (if any) carries the fee.
  { name: "quoteExtension", kind: "read", handler: compute((i, _ctx, rt) => {
      need(i, "new_closing_on", "delay_attribution"); const l = lockOf(rt, i);
      return quoteExtension(l, { new_closing_on: D(str(i, "new_closing_on")), delay_attribution: str(i, "delay_attribution") as DelayAttribution, cd_provided_at: optIso(i, "cd_provided_at"), cal: calendarOf(i) }); }) },
  // Rule 6: lender/agent delay → honored at the locked terms at the lender's cost (MA rule, national policy); borrower delay → borrower pays, (e)(3)(iv)(C) changed circumstance → revised LE or corrected CD.
  { name: "extendLock", kind: "write", moneyFields: ["fee_cents"], handler: compute((i, ctx, rt) => {
      need(i, "new_closing_on", "delay_attribution"); const l = lockOf(rt, i); const requested_at = at(i, "requested_at", ctx);
      const r = extendLock(ctx.events, l, { requested_at, new_closing_on: D(str(i, "new_closing_on")), delay_attribution: str(i, "delay_attribution") as DelayAttribution, cd_provided_at: optIso(i, "cd_provided_at"), consummation_on: optDate(i, "consummation_on"), cal: calendarOf(i), mlo_nmlsr_id: optIso(i, "mlo_nmlsr_id") }, ctx.actor);
      putLock(rt, r.lock, ctx); rt.store.put("lock_extensions", r.extension.extension_id, { ...r.extension }, ctx.actor, ctx.now); putCc(rt, r.changed_circumstance, ctx);
      rearmExpiry(ctx, l.application_id, r.event, `lock extended ${r.extension.days} days to ${r.extension.new_expires_on}`);
      const ext: LockExtension = r.extension;
      return { lock_id: l.lock_id, extension_id: ext.extension_id, days: ext.days, fee_cents: ext.fee_cents, payer: ext.payer, consumer_charge_cents: r.quote.consumer_charge_cents, note_rate: r.lock.note_rate, new_expires_on: ext.new_expires_on, new_expires_at: ext.new_expires_at, revised_disclosure: r.quote.revised_disclosure, cc_id: r.changed_circumstance?.cc_id ?? null, cc_kind: r.changed_circumstance?.kind ?? null, reflected_on: r.changed_circumstance?.reflected_on ?? null }; }),
    guardrails: [never("LENDER_DELAY_CHARGED_TO_BORROWER", "Massachusetts Division of Banks letter (Rate Lock Commitments, 2003) applied nationally: a lock that expires through no fault of the borrower is honored; 21.4 rule 6", (i) => ["lender", "lender_agent"].includes(str(i, "delay_attribution")) && flag(i, "charge_borrower"), "a lender-caused delay is never the borrower's cost")] },
  // Rule 7: a new lock version at worst-case pricing (min(current, original)) unless the lender-delay rule applies; `lock.relocked` → revised LE and the 29.1 key-data update.
  { name: "relock", kind: "write", moneyFields: ["note_rate", "price"], handler: compute((i, ctx, rt) => {
      need(i, "quote_id", "mlo_nmlsr_id"); const l = lockOf(rt, i); const relocked_at = at(i, "relocked_at", ctx);
      const r = relock(ctx.events, l, { relocked_at, quote: quoteOf(rt, i), lender_delay: flag(i, "lender_delay"), cal: calendarOf(i), mlo_nmlsr_id: str(i, "mlo_nmlsr_id"), intent: intentInForce(intentsOf(rt, l.application_id), relocked_at), cd_provided_at: optIso(i, "cd_provided_at"), consummation_on: optDate(i, "consummation_on") }, ctx.actor);
      putLock(rt, r.superseded, ctx); putLock(rt, r.lock, ctx); putCc(rt, r.changed_circumstance, ctx);
      for (const t of ctx.timers.forSubject("application", l.application_id)) if (["SM_LOCK_EXPIRY_DEADLINE", "SM_LOCK_EXPIRY_WARN_7", "NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD"].includes(t.code) && armed(t) && t.armedAt < relocked_at) ctx.timers.cancel(t.id, `lock ${l.lock_id} superseded by relock ${r.lock.lock_id}`, ctx.actor);
      let commitment = null; if (l.commitment_id) { commitment = commitmentsOf(rt, ctx).keyDataChange(r.lock, relocked_at, "relock: note_rate/price"); rt.store.put("commitments", commitment.commitment_id, { ...commitment }, ctx.actor, ctx.now); }
      return { lock_id: r.lock.lock_id, supersedes_lock_id: l.lock_id, version: r.lock.version, note_rate: r.lock.note_rate, price: r.lock.price, worst_case_pricing_applied: r.lock.worst_case_pricing_applied, rate_set_date: r.lock.rate_set_date, expires_on: r.lock.expires_on, cc_id: r.changed_circumstance.cc_id, commitment, open_commitments: l.commitment_id ? commitmentsOf(rt, ctx).open(l.lineage_id).length : 0 }; }),
    guardrails: [needsRole("RELOCK_MLO_APPROVAL", "21.4 AI design: mlo_of_record approves every relock", (i) => flag(i, "mlo_approval_pending"), ["mlo_of_record"], "the relock terms await the MLO of record")] },
  // Rule 8: one float-down per lineage at market + margin for the scheduled fee; `lock.float_down.applied` → revised LE and the key-data update.
  { name: "applyFloatDown", kind: "write", moneyFields: ["note_rate", "float_down_fee_cents"], handler: compute((i, ctx, rt) => {
      need(i, "market_rate_pct", "mlo_nmlsr_id"); const l = lockOf(rt, i); const applied_at = at(i, "applied_at", ctx);
      const used = rt.store.list("locks", (d) => d.lineage_id === l.lineage_id && d.kind === "float_down").length;
      const r = applyFloatDown(ctx.events, l, { applied_at, market_rate_pct: str(i, "market_rate_pct"), mlo_nmlsr_id: str(i, "mlo_nmlsr_id"), intent: intentInForce(intentsOf(rt, l.application_id), applied_at), cal: calendarOf(i), lineage_float_downs: used, cd_provided_at: optIso(i, "cd_provided_at"), consummation_on: optDate(i, "consummation_on"), pricing: pricingOf(rt, i) }, ctx.actor);
      putLock(rt, r.superseded, ctx); putLock(rt, r.lock, ctx); putCc(rt, r.changed_circumstance, ctx);
      for (const t of ctx.timers.forSubject("application", l.application_id)) if (["SM_LOCK_EXPIRY_DEADLINE", "SM_LOCK_EXPIRY_WARN_7"].includes(t.code) && armed(t) && t.armedAt < applied_at) ctx.timers.cancel(t.id, `lock ${l.lock_id} superseded by float-down ${r.lock.lock_id}`, ctx.actor);
      let commitment = null; if (l.commitment_id) { commitment = commitmentsOf(rt, ctx).keyDataChange(r.lock, applied_at, "float_down: note_rate"); rt.store.put("commitments", commitment.commitment_id, { ...commitment }, ctx.actor, ctx.now); }
      return { lock_id: r.lock.lock_id, supersedes_lock_id: l.lock_id, version: r.lock.version, note_rate: r.lock.note_rate, float_down_fee_cents: r.lock.float_down_fee_cents, expires_on: r.lock.expires_on, cc_id: r.changed_circumstance.cc_id, commitment }; }) },
  // Expiry playbook: op=warn (7 days before), op=expire (the expiration instant), op=cancel (withdrawal / declination / ineligible → fees refunded, 29.1 fallout without pair-off), default playbook options.
  { name: "expireLock", kind: "write", handler: compute((i, ctx, rt) => {
      const l = lockOf(rt, i); const now = at(i, "at", ctx);
      if (i.op === "warn") { const w = warnExpiry(ctx.events, l, now, optDate(i, "closing_scheduled_on"), ctx.actor); return { lock_id: l.lock_id, warned: true, closing_inside_lock: w.closing_inside_lock, event_id: w.event.id }; }
      if (i.op === "expire") { const r = expireLock(ctx.events, l, now, ctx.actor); putLock(rt, r.lock, ctx); return { lock_id: l.lock_id, status: r.lock.status, playbook: r.playbook }; }
      if (i.op === "cancel") {
        need(i, "reason"); const r = cancelLock(ctx.events, ctx.ledger, l, { reason: str(i, "reason") as CancelReason, at: now, lock_fee_ledger_set_id: optIso(i, "lock_fee_ledger_set_id"), detail: str(i, "detail") }, ctx.actor); putLock(rt, r.lock, ctx);
        for (const t of ctx.timers.forSubject("application", l.application_id)) if (["SM_LOCK_EXPIRY_DEADLINE", "SM_LOCK_EXPIRY_WARN_7", "NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD"].includes(t.code) && armed(t)) ctx.timers.cancel(t.id, `lock cancelled: ${str(i, "reason")}`, ctx.actor);
        const f = l.commitment_id ? commitmentsOf(rt, ctx).recordFallout(l.lineage_id, str(i, "reason") as CancelReason, now) : null;
        return { lock_id: l.lock_id, status: r.lock.status, cancelled_reason: r.lock.cancelled_reason, refund_set_id: r.refund?.id ?? null, refund_cents: r.refund ? -r.refund.lines[0]!.amountCents : 0n, fallout: f ? { commitment_id: f.commitment?.commitment_id ?? null, pair_off_expected: f.pair_off_expected } : null };
      }
      return { lock_id: l.lock_id, expires_at: l.expires_at, status: l.status, options: ["extension quote (borrower-caused delay: borrower's cost)", "relock at worst-case pricing", "honor at locked terms (lender/agent delay — MA rule, national policy)"] }; }) },
  // Notices through the registry only: the NY §38.6(b)(4) expiration notice is refused outside its 12–20 business-day window; the confirmation send moves the lock to `confirmed`.
  { name: "sendNotice", kind: "write", handler: compute(async (i, ctx, rt) => {
      need(i, "template_code"); const l = lockOf(rt, i); const code = str(i, "template_code"); const sendOn = optDate(i, "send_on") ?? civilDate(ctx.now, l.time_zone);
      let payload = (i.payload as Record<string, unknown> | undefined) ?? (rt.store.get("locks", l.lock_id)?.data.confirmation_payload as Record<string, unknown> | undefined) ?? {};
      let window = null;
      if (code === "NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE") {
        if (!l.rate_set_date || !l.expires_on) throw new LockRefused("LOCK_STATE", "21.4 state machine", "no executed lock");
        const w = nyExpiryNoticeWindow(l.rate_set_date, l.expires_on, calendarOf(i)); const inWindow = assertNyNoticeInWindow(w, l.expires_on, sendOn, calendarOf(i));
        window = { ...w, send_on: sendOn, ...inWindow };
        payload = { notice_date: sendOn, borrower_names: (i.borrower_names as string[] | undefined) ?? (payload.borrower_names as string[] | undefined) ?? [], property_address: str(i, "property_address") || String(payload.property_address ?? ""), partner_name: str(i, "partner_name") || String(payload.partner_name ?? ""), locked_on: l.rate_set_date, expires_on: l.expires_on,
          expires_display: expiryDisplay(l.expires_on, l.time_zone), note_rate_pct: l.note_rate, business_days_before_expiry: inWindow.business_days_before_expiry, window_opens_on: w.opens_on, window_closes_on: w.closes_on, hard_copy_follow_up: flag(i, "cannot_print"), ...payload };
      }
      if (!rt.notices) return { lock_id: l.lock_id, template_code: code, sent: false, window, payload };
      const n = rt.notices.render({ templateCode: code, recipients: recipientsOf(i), payload, asOf: sendOn });
      const sent = await rt.notices.send(n.id, (i.channel_context as Record<string, unknown> | undefined) ?? {});
      if (code === "NTC_SM_RATE_LOCK_CONFIRMATION" && l.status === "executed") putLock(rt, confirmLock(l), ctx);
      return { lock_id: l.lock_id, template_code: code, notice_id: sent.id, status: sent.status, sent: true, window, state_agreement_variant: l.state_agreement_variant }; }),
    guardrails: [never("BORROWER_TEXT_FROM_TEMPLATE_ONLY", "docs/ARCHITECTURE.md: borrower-facing text only from templates", (i) => typeof i.free_text_body === "string" && i.free_text_body.length > 0, "compose through the Notice Registry template")] },
  // The decision row (agent_decisions schema in the AI design): rule set, model/prompt versions, rationale, confidence.
  { name: "writeDecision", kind: "write", handler: decision() },
]));
