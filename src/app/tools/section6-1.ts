/**
 * §6.1 tools — Establish P&I custodial account (Form 1013). The nine tool strings are verbatim from the process's
 * Agents paragraph (spec/registry/agents.json; src/app/tools.test.ts refuses any other) and every write/act runs
 * through src/domain/custodial/ops-6-1.ts, so each 6.1 timer row is armed and satisfied by a real act:
 *
 *   custodial.plan_accounts  → planCustodialAccounts   `custodial.account.planned{kind}` (Form 1013 gate arms on kind=pi)
 *   cbam.prepare_package     → prepareCbamPackage      the CBAM `human_portal_task{task=cbam_form}` (SM_CBAM_TASK_SLA_3BD) and the officer signature escalation
 *   documents.write          → markFormInEffect        an executed Form 1013/1014 PDF (sha256) is verified against the plan; `custodial.form.in_effect` or the reopened task
 *   ratings.read             → checkDepositoryRatings  op=check: `custodial.depository.rating_checked` per account, `ineligible_detected` (3-BD notice)
 *   timer.start/satisfy      → the act behind each satisfying event (never a bare append): sent_for_signature, fully_signed /
 *                              signatures_declined, activated, lockbox.batch.received, deposit.confirmed / initiated, clearing.credited / swept
 *   email.send               → `custodial.depository.fnma_notified` for the ineligible-depository notice (allowlisted recipients only)
 *
 * Guardrails (6.1 agent design): account numbers never leave the CBAM/depository/partner channels; a form is never `in_effect`
 * without the executed document hash; satisfaction is event-driven — `timer.start/satisfy` refuses an event type it has no act for.
 */
import { defineTools, write, escalate, timerOps, compute, never, cents, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { ToolRuntime } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { evaluateDepositoryEligibility, fdicUninsuredExposure, type Depository, type AccountUse, type FormStatus } from "../../domain/custodial/accounts.ts";
import type { FormFacts } from "../../domain/custodial/ops.ts";
import { planCustodialAccounts, prepareCbamPackage, sendFormForSignature, ingestCbamFormStatus, markFormInEffect, activateAccount, checkDepositoryRatings, ingestLockboxBatch, confirmCustodialDeposit, initiateDeposit, ingestClearingCredit, sweepClearingToCustodial, recordBankAccountOpened, FNMA_CUSTODIAL_TEAM, type ArrangementInput, type CbamPackage, type CbamStatusRecord, type ActivationInput, type RatingCheckInput, type LockboxBatchRecord, type DepositConfirmation, type DepositCommand, type ClearingCreditRecord, type SweepInput, type AccountStatus } from "../../domain/custodial/ops-6-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const obj = <T>(i: ToolInput, k: string): T => { const v = i[k]; if (!v || typeof v !== "object") throw new RangeError(`${k} is required`); return v as T; };
const ALLOWLISTED_CHANNELS = new Set(["cbam", "depository", "partner"]);
const FNMA_DOMAIN = /@fanniemae\.com$/i;
const ACCOUNT_NUMBER_SHAPED = /\b\d{9,17}\b/;
const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** The recipient allowlist is data, not a caller flag: Fannie Mae addresses, or a domain registered for the depository / partner channel in `email_allowlist`. */
function assertAllowlisted(rt: ToolRuntime, to: string, channel: string): void {
  if (FNMA_DOMAIN.test(to)) return;
  const row = rt.store.get("email_allowlist", domainOf(to));
  if (!row || row.data.channel !== channel) throw new RangeError(`recipient ${to} is not on the allowlist for channel ${channel || "(none)"} (email_allowlist)`);
}
/** The store's current form / account facts a satisfy-op may rely on when the caller does not restate them. */
const formStatusOf = (rt: ToolRuntime, i: ToolInput): FormStatus => (str(i, "status") || String(rt.store.get("custodial_forms", str(i, "form_id"))?.data.status ?? "in_draft")) as FormStatus;
const accountStatusOf = (rt: ToolRuntime, i: ToolInput): AccountStatus => (str(i, "status") || String(rt.store.get("custodial_accounts", str(i, "account_id") || str(i, "custodial_account_id"))?.data.status ?? "planned")) as AccountStatus;
const putForm = (rt: ToolRuntime, ctx: CommandContext, i: ToolInput, patch: Record<string, unknown>): void => { rt.store.put("custodial_forms", str(i, "form_id"), { form_id: str(i, "form_id"), custodial_account_id: str(i, "custodial_account_id"), form_type: str(i, "form_kind") || "1013", ...patch }, ctx.actor, ctx.now); };

/** `timer.start/satisfy` op=satisfy: the act that produces each 6.1 event. Anything else is refused — satisfaction is event-driven, never a bare append. */
function satisfyingAct(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const type = str(i, "event_type"); need(i, "event_type");
  switch (type) {
    case "custodial.form.sent_for_signature": {
      need(i, "form_id", "custodial_account_id", "cbam_form_number", "portal_task_id");
      const r = sendFormForSignature(ctx.events, rt.escalations, { form_id: str(i, "form_id"), custodial_account_id: str(i, "custodial_account_id"), form_kind: (str(i, "form_kind") || "1013") as "1013" | "1014", status: formStatusOf(rt, i), cbam_form_number: str(i, "cbam_form_number"), sent_at: D(str(i, "sent_at") || ctx.now.slice(0, 10)), portal_task_id: str(i, "portal_task_id") }, ctx.actor);
      putForm(rt, ctx, i, { status: r.status, cbam_form_number: str(i, "cbam_form_number"), sent_at: str(i, "sent_at") || ctx.now.slice(0, 10), signature_due_on: r.signature_due_on, human_portal_task_id: str(i, "portal_task_id") });
      return { status: r.status, signature_due_on: r.signature_due_on, officer_chase_on: r.officer_chase_on, event: r.event };
    }
    case "custodial.form.fully_signed": case "custodial.form.signatures_declined": case "custodial.form.change_requested": {
      need(i, "form_id", "custodial_account_id", "cbam_status", "cbam_form_number");
      const rec: CbamStatusRecord = { form_id: str(i, "form_id"), custodial_account_id: str(i, "custodial_account_id"), form_kind: (str(i, "form_kind") || "1013") as "1013" | "1014", status: formStatusOf(rt, i), cbam_status: str(i, "cbam_status") as CbamStatusRecord["cbam_status"], cbam_form_number: str(i, "cbam_form_number"),
        ...(typeof i.servicer_signed_at === "string" ? { servicer_signed_at: i.servicer_signed_at } : {}), ...(typeof i.depository_signed_at === "string" ? { depository_signed_at: i.depository_signed_at } : {}), ...(typeof i.certificate_of_completion_id === "string" ? { certificate_of_completion_id: i.certificate_of_completion_id } : {}),
        ...(typeof i.declined_by === "string" ? { declined_by: i.declined_by } : {}), ...(typeof i.decline_reason === "string" ? { decline_reason: i.decline_reason } : {}) };
      const r = ingestCbamFormStatus(ctx.events, rt.escalations, ctx.timers, rec, ctx.actor);
      putForm(rt, ctx, i, { status: r.status, ...(rec.servicer_signed_at ? { servicer_signed_at: rec.servicer_signed_at } : {}), ...(rec.depository_signed_at ? { depository_signed_at: rec.depository_signed_at } : {}) });
      return { status: r.status, event: r.event, decline: r.decline ? { escalation_id: r.decline.escalation_id, timers_cancelled: r.decline.timers_cancelled, timers_deleted: r.decline.timers_deleted, funds_moved: r.decline.funds_moved } : null };
    }
    case "custodial.form.in_effect": {
      need(i, "form_id", "custodial_account_id", "plan", "executed", "executed_document_hash");
      const r = markFormInEffect(ctx.events, rt.escalations, { form_id: str(i, "form_id"), custodial_account_id: str(i, "custodial_account_id"), form_kind: (str(i, "form_kind") || "1013") as "1013" | "1014", status: formStatusOf(rt, i), plan: obj<FormFacts>(i, "plan"), executed: obj<FormFacts>(i, "executed"), executed_document_hash: str(i, "executed_document_hash"), ...(typeof i.executed_document_id === "string" ? { executed_document_id: i.executed_document_id } : {}), as_of: D(str(i, "as_of") || ctx.now.slice(0, 10)) }, ctx.actor);
      if (r.in_effect) putForm(rt, ctx, i, { status: r.status, executed_document_hash: str(i, "executed_document_hash") });
      return r;
    }
    case "custodial.account.form_pending": {
      need(i, "account_id", "depository_id", "eligibility");
      const r = recordBankAccountOpened(ctx.events, { account_id: str(i, "account_id"), status: accountStatusOf(rt, i), depository_id: str(i, "depository_id"), account_use: (str(i, "account_use") || null) as AccountUse | null, eligibility: obj<{ eligible: boolean; rule: string }>(i, "eligibility"), opened_on: date(i, "opened_on"), signature_card_document_id: str(i, "signature_card_document_id") || null }, ctx.actor);
      rt.store.put("custodial_accounts", str(i, "account_id"), { status: r.status, depository_id: str(i, "depository_id"), opened_at: str(i, "opened_on") }, ctx.actor, ctx.now);
      return r;
    }
    case "custodial.account.activated": {
      need(i, "account_id", "depository_id", "expected_title", "observed_title");
      const a: ActivationInput = { account_id: str(i, "account_id"), kind: (str(i, "kind") || "pi") as "pi" | "ti", remittance_type: (str(i, "remittance_type") || null) as AccountUse | null, pool_class: (str(i, "pool_class") || "na") as ActivationInput["pool_class"], depository_id: str(i, "depository_id"), status: accountStatusOf(rt, i),
        form_status: (str(i, "form_status") || String(rt.store.get("custodial_forms", str(i, "form_id"))?.data.status ?? "in_draft")) as FormStatus, debit_whitelist_confirmed_at: str(i, "debit_whitelist_confirmed_at") || null, statement_feed_id: str(i, "statement_feed_id") || null, statement_feed_test_files_received: flag(i, "statement_feed_test_files_received"), expected_title: str(i, "expected_title"), observed_title: str(i, "observed_title"), activated_on: D(str(i, "activated_on") || ctx.now.slice(0, 10)) };
      const r = activateAccount(ctx.events, a, ctx.actor);
      if (r.activated) rt.store.put("custodial_accounts", a.account_id, { status: r.status, opened_at: a.activated_on, debit_whitelist_confirmed_at: a.debit_whitelist_confirmed_at, statement_feed_id: a.statement_feed_id, title: a.expected_title }, ctx.actor, ctx.now);
      return { activated: r.activated, status: r.status, blocked_by: r.blocked_by, event: r.event };
    }
    case "custodial.depository.rating_checked": case "custodial.depository.ineligible_detected": return ratingCheck(i, ctx);
    case "lockbox.batch.received": {
      need(i, "batch_id", "lockbox_agent", "received_on", "custodial_account_id");
      const items = rows<{ sequence: number; amount_cents: unknown; bank_reference: string; scanline?: string }>(i, "items").map((it) => ({ sequence: Number(it.sequence), amount_cents: cents(it.amount_cents), bank_reference: String(it.bank_reference ?? ""), ...(it.scanline ? { scanline: it.scanline } : {}) }));
      const b: LockboxBatchRecord = { batch_id: str(i, "batch_id"), lockbox_agent: str(i, "lockbox_agent"), received_on: date(i, "received_on"), items, total_cents: i.total_cents === undefined ? items.reduce((s, it) => s + it.amount_cents, 0n) : cents(i.total_cents), clearing_account_id: str(i, "clearing_account_id") || null, custodial_account_id: str(i, "custodial_account_id") };
      return ingestLockboxBatch(ctx.events, b, ctx.actor);
    }
    case "custodial.deposit.confirmed": {
      need(i, "subject", "custodial_account_id", "bank_line", "expected_cents", "deposited_on");
      const line = obj<{ id: string; amount_cents: unknown; value_date: string; reference?: string }>(i, "bank_line");
      const c: DepositConfirmation = { subject: obj<DepositConfirmation["subject"]>(i, "subject"), custodial_account_id: str(i, "custodial_account_id"), bank_line: { id: String(line.id), amount_cents: cents(line.amount_cents), value_date: D(String(line.value_date)), ...(line.reference ? { reference: line.reference } : {}) }, expected_cents: cents(i.expected_cents), deposited_on: date(i, "deposited_on") };
      return confirmCustodialDeposit(ctx.events, c, ctx.actor);
    }
    case "custodial.deposit.initiated": {
      need(i, "deposit_id", "account_id", "form", "amount_cents", "deposited_on");
      const d: DepositCommand = { deposit_id: str(i, "deposit_id"), account_id: str(i, "account_id"), form: obj<DepositCommand["form"]>(i, "form"), ...(typeof i.loan_type === "string" ? { loan_type: i.loan_type as AccountUse } : {}), amount_cents: cents(i.amount_cents), source: (str(i, "source") || "wire") as DepositCommand["source"], deposited_on: date(i, "deposited_on") };
      return initiateDeposit(ctx.events, ctx.timers, d, ctx.actor);
    }
    case "custodial.clearing.credited": {
      need(i, "clearing_account_id", "line", "credited_on");
      const line = obj<{ id: string; amount_cents: unknown; value_date: string; reference?: string }>(i, "line");
      const c: ClearingCreditRecord = { clearing_account_id: str(i, "clearing_account_id"), line: { id: String(line.id), amount_cents: cents(line.amount_cents), value_date: D(String(line.value_date)), ...(line.reference ? { reference: line.reference } : {}) }, credited_on: date(i, "credited_on"), source: (str(i, "source") || "bai2_prior_day") as ClearingCreditRecord["source"], payments: Array.isArray(i.payments) ? payments(i) : [] };
      return ingestClearingCredit(ctx.events, c, ctx.actor);
    }
    case "custodial.clearing.swept": {
      need(i, "clearing_account_id", "custodial_account_id", "credit_id", "credited_on", "payments");
      const s: SweepInput = { clearing_account_id: str(i, "clearing_account_id"), custodial_account_id: str(i, "custodial_account_id"), credit_id: str(i, "credit_id"), credited_on: date(i, "credited_on"), swept_on: D(str(i, "swept_on") || ctx.now.slice(0, 10)), payments: payments(i) };
      const r = sweepClearingToCustodial(ctx.events, s, ctx.actor);
      return { computation: r.computation, posting: r.posting, on_time: r.on_time, due_on: r.due_on, event: r.event };
    }
    default: throw new RangeError(`satisfaction is event-driven: ${type} is not an act of process 6.1 (timer.start/satisfy never appends a bare event)`);
  }
}
const payments = (i: ToolInput): SweepInput["payments"] => rows<Record<string, unknown>>(i, "payments").map((p) => ({ payment_id: String(p.payment_id ?? ""), loan_id: String(p.loan_id ?? ""), principal_cents: cents(p.principal_cents), interest_gross_cents: cents(p.interest_gross_cents), upb_prior_cents: cents(p.upb_prior_cents), servicing_fee_rate_pct: String(p.servicing_fee_rate_pct ?? "0"), late_charges_retained_cents: cents(p.late_charges_retained_cents) }));
/** `ratings.read` op=check / the rating-monitor act: the scheduled `custodial.depository.rating_check` over the depository's current ratings and the accounts it holds. */
function ratingCheck(i: ToolInput, ctx: CommandContext): unknown {
  const d = obj<Depository & { id: string; aba?: string }>(i, "depository"); if (!d.id) throw new RangeError("depository.id is required");
  const r: RatingCheckInput = { depository: { ...d, total_assets_cents: cents(d.total_assets_cents) }, ratings_as_of: D(str(i, "ratings_as_of") || ctx.now.slice(0, 10)), checked_on: D(str(i, "checked_on") || ctx.now.slice(0, 10)), accounts: rows<{ account_id: string; use: AccountUse }>(i, "accounts"), fdic_as_of: str(i, "fdic_as_of") ? D(str(i, "fdic_as_of")) : null, ...(i.prior_ratings ? { prior_ratings: i.prior_ratings as Depository["ratings"] } : {}), ...(Array.isArray(i.source_document_ids) ? { source_document_ids: i.source_document_ids as string[] } : {}) };
  const out = checkDepositoryRatings(ctx.events, r, ctx.actor);
  return { eligibility_status: out.eligibility_status, results: out.results, next_check_due: out.next_check_due, notify_by: out.notify_by, ineligible_detected: out.ineligible_detected?.id ?? null };
}

export const TOOLS_6_1: readonly ToolDef[] = defineTools("6.1", "custodial-recon", [
  { name: "depository.evaluate", kind: "read", handler: compute((i) => { const d = i.depository as Depository | undefined; if (!d) throw new RangeError("depository is required"); const use = (str(i, "account_use") || "S/S") as AccountUse; const r = evaluateDepositoryEligibility({ ...d, total_assets_cents: cents(d.total_assets_cents) }, use);
      return { ...r, account_use: use, decision: { rule_applied: r.rule, rule_set: "rule_sets.fnma.custodial.2023-07", inputs: { insured: d.insured, well_capitalized: d.well_capitalized, total_assets_cents: cents(d.total_assets_cents), ratings: d.ratings } } }; }) },
  { name: "fdic.lookup", kind: "read", handler: compute((i, _c, rt) => { need(i, "cert"); const r = rt.store.get("depositories", str(i, "cert")); if (!r) return { found: false, insured: null, well_capitalized: null, as_of: null, stale: true };
      const ageDays = (Date.parse(str(i, "now") || new Date().toISOString()) - Date.parse(String(r.data.fdic_as_of ?? ""))) / 86_400_000;
      return { found: true, insured: r.data.insured ?? null, well_capitalized: r.data.well_capitalized ?? null, as_of: r.data.fdic_as_of ?? null, stale: !(ageDays <= 35), uninsured_exposure_cents: fdicUninsuredExposure(cents(i.balance_cents), num(i, "ownership_categories") || 1) }; }) },
  { name: "ratings.read", kind: "act", handler: compute((i, ctx, rt) => { if (i.op === "check") return ratingCheck(i, ctx); need(i, "depository_id"); return rt.store.list("depository_ratings", (d) => d.depository_id === i.depository_id).map((r) => ({ id: r.id, ...r.data })); }),
    decision: (i) => (i.op === "check" ? { action: "ratings.read:check", rationale: "6.1 rule 1: scheduled depository rating check per account use (A4-1-02)", ruleCode: "FNMA_A4102_RATING_MONITOR_RECUR" } : null) },
  { name: "custodial.plan_accounts", kind: "write", handler: compute((i, ctx, rt) => { need(i, "arrangement_id", "servicer_name", "master_servicer_name", "subservicer_number");
      const a: ArrangementInput = { arrangement_id: str(i, "arrangement_id"), servicer_name: str(i, "servicer_name"), master_servicer_name: str(i, "master_servicer_name"), master_servicer_numbers: rows<string>(i, "master_servicer_numbers"), subservicer_number: str(i, "subservicer_number"), portfolio: rows(i, "portfolio"), ...(i.clearing_account === false ? { clearing_account: false } : {}), ...(typeof i.depository_id === "string" ? { depository_id: i.depository_id } : {}) };
      const r = planCustodialAccounts(ctx.events, a, ctx.actor);
      for (const acct of r.accounts) rt.store.put("custodial_accounts", acct.account_id, { ...acct, master_servicer_numbers: [...a.master_servicer_numbers], subservicer_number: a.subservicer_number, ledger_accounts: [...acct.ledger_accounts] }, ctx.actor, ctx.now);
      return { accounts: r.accounts, titles: { pi: r.accounts.find((x) => x.kind === "pi")?.title ?? null, ti: r.accounts.find((x) => x.kind === "ti")?.title ?? null } }; }) },
  { name: "cbam.prepare_package", kind: "write", handler: compute((i, ctx, rt) => { const p = obj<CbamPackage>(i, "package");
      const r = prepareCbamPackage(ctx.events, rt.escalations, p, ctx.actor);
      rt.store.put("cbam_packages", p.form_id, { ...p, package_hash: r.package_hash, prepared_at: ctx.now, channel: "cbam", portal_task_id: r.portal_task_id, signature_escalation_id: r.signature_escalation_id }, ctx.actor, ctx.now);
      rt.store.put("custodial_forms", p.form_id, { form_id: p.form_id, custodial_account_id: p.custodial_account_id, form_type: p.form_kind, remittance_types: [p.remittance_type], effective_date: p.effective_date, status: r.status, human_portal_task_id: r.portal_task_id, package_hash: r.package_hash }, ctx.actor, ctx.now);
      return { form_id: p.form_id, status: r.status, package_hash: r.package_hash, portal_task_id: r.portal_task_id, signature_escalation_id: r.signature_escalation_id }; }),
    guardrails: [never("ACCOUNT_NUMBER_CHANNEL", "6.1 guardrail: the agent can never transmit an account number outside the allowlisted CBAM/depository/partner channels", (i) => typeof i.channel === "string" && !ALLOWLISTED_CHANNELS.has(str(i, "channel")), "account numbers travel only over CBAM, the depository or the partner channel")] },
  { name: "documents.write", kind: "write", handler: compute((i, ctx, rt) => {
      if (str(i, "kind") !== "executed_form") return write("documents", "document.written")(i, ctx, rt);
      // The executed Form 1013/1014 PDF from CBAM: stored with its SHA-256, then verified against the plan — `in_effect` only on a match (6.1-T7).
      need(i, "id", "sha256", "form_id", "custodial_account_id", "plan", "executed");
      const doc = write("documents", "document.written")({ ...i, data: { ...data(i), kind: "executed_form", sha256: str(i, "sha256"), form_id: str(i, "form_id"), retention: "corporate_7y" } }, ctx, rt);
      const v = markFormInEffect(ctx.events, rt.escalations, { form_id: str(i, "form_id"), custodial_account_id: str(i, "custodial_account_id"), form_kind: (str(i, "form_kind") || "1013") as "1013" | "1014", status: formStatusOf(rt, i), plan: obj<FormFacts>(i, "plan"), executed: obj<FormFacts>(i, "executed"), executed_document_hash: str(i, "sha256"), executed_document_id: str(i, "id"), as_of: D(str(i, "as_of") || ctx.now.slice(0, 10)) }, ctx.actor);
      if (v.in_effect) putForm(rt, ctx, i, { status: v.status, executed_document_id: str(i, "id"), executed_document_hash: str(i, "sha256") });
      return { document: doc, verification: v }; }) },
  { name: "escalation.create", kind: "act", handler: escalate("officer") },
  { name: "timer.start/satisfy", kind: "act", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "list"; if (op === "satisfy") return satisfyingAct(i, ctx, rt); return timerOps()({ ...i, op: op === "start" ? "arm" : op }, ctx); }),
    guardrails: [never("IN_EFFECT_NEEDS_HASH", "6.1 guardrail: cannot mark a form `in_effect` without the executed document hash", (i) => str(i, "event_type") === "custodial.form.in_effect" && !str(i, "executed_document_hash"), "custodial.form.in_effect requires executed_document_hash")] },
  { name: "email.send", kind: "act", handler: compute((i, ctx, rt) => { need(i, "to", "subject");
      const to = str(i, "to"), channel = str(i, "channel");
      assertAllowlisted(rt, to, channel);
      const e = ctx.events.append({ type: "email.sent", loanId: ctx.loanId, actor: ctx.actor, payload: { to, subject: str(i, "subject"), template: str(i, "template") || null, channel: channel || (FNMA_DOMAIN.test(to) ? "cbam" : null) } });
      // 6.1 timer table: FNMA_A4102_DEPOSITORY_INELIGIBLE_NOTIFY_3BD is satisfied by the notice to the Fannie Mae custodial team (email + CBAM note; partner copied).
      if (to.toLowerCase() === FNMA_CUSTODIAL_TEAM && (str(i, "reason") === "depository_ineligible" || str(i, "template") === "CUST-DEP-INELIG-v1")) {
        if (!flag(i, "partner_copied")) throw new RangeError("the ineligible-depository notice copies the master servicer (A2-1-07: partner copied)");
        ctx.events.append({ type: "custodial.depository.fnma_notified", loanId: ctx.loanId, ...(i.aggregate ? { aggregate: i.aggregate as { kind: string; id: string } } : {}), actor: ctx.actor, causationId: e.id, payload: { to: FNMA_CUSTODIAL_TEAM, template: "CUST-DEP-INELIG-v1", partner_copied: true, cbam_note: flag(i, "cbam_note"), depository_id: str(i, "depository_id") || null, notified_at: ctx.now } });
      }
      return { sent: true, to, channel: channel || null }; }),
    guardrails: [never("ALLOWLISTED_RECIPIENTS", "6.1 agent design: `email.send` to allowlisted recipients only", (i) => typeof i.to === "string" && !FNMA_DOMAIN.test(str(i, "to")) && !ALLOWLISTED_CHANNELS.has(str(i, "channel")), "a recipient outside fanniemae.com must be on the depository or partner channel (registered in email_allowlist)"),
      never("NO_ACCOUNT_NUMBER_IN_EMAIL", "6.1 guardrail: account numbers never leave the allowlisted CBAM/depository/partner channels", (i) => ACCOUNT_NUMBER_SHAPED.test(str(i, "body")) && !(ALLOWLISTED_CHANNELS.has(str(i, "channel")) || FNMA_DOMAIN.test(str(i, "to"))), "the body carries an account-number-shaped string and the recipient is not on the CBAM, depository or partner channel")] },
]);
