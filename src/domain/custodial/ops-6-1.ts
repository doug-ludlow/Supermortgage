/**
 * §6.1 operating rules — Establish P&I custodial account (Form 1013). The
 * calculators live in ./accounts.ts (eligibility, plan, titles, gates) and the
 * executed-form verification / 3-BD notice outcome in ./ops.ts; this file is
 * every state change the process makes, each appended to the event store by a
 * real act so the §6.1 timer rows arm and are satisfied for real:
 *
 *   planCustodialAccounts   `custodial.account.planned{kind}`        arms FNMA_F103_FORM1013_IN_EFFECT_GATE (kind=pi)
 *   prepareCbamPackage      `escalation.created{human_portal_task, task=cbam_form}` arms SM_CBAM_TASK_SLA_3BD; `custodial.form.drafted`
 *   sendFormForSignature    `escalation.completed` (the CBAM task) + `custodial.form.sent_for_signature{sent_at}` arms SM_CBAM_SIGNATURE_PENDING_5BD
 *   ingestCbamFormStatus    `custodial.form.fully_signed` (satisfies the 5-BD row) / `custodial.form.signatures_declined` (declineForm, T8)
 *   markFormInEffect        `custodial.form.in_effect{kind, executed_document_hash}` opens the Form 1013 gate (T7: any mismatch reopens the task)
 *   activateAccount         `custodial.account.activated{activated_on}` arms FNMA_A4102_RATING_MONITOR_RECUR; partner notified
 *   checkDepositoryRatings  `custodial.depository.rating_checked` (per account, satisfies/re-arms the monitor) and
 *                           `custodial.depository.ineligible_detected{detected_on}` (arms the 3-BD notice, T5)
 *   ingestLockboxBatch      `lockbox.batch.received{received_on}` arms FNMA_C1101_LOCKBOX_DEPOSIT_2BD (T6)
 *   confirmCustodialDeposit `custodial.deposit.confirmed` (bank credit matched) satisfies it
 *   initiateDeposit         `custodial.deposit.initiated` — refused by the Form 1013 gate while the form is not in effect (T4)
 *   ingestClearingCredit    `custodial.clearing.credited{credited_on}` arms FNMA_A4102_CLEARING_TO_CUSTODIAL_1BD
 *   sweepClearingToCustodial`custodial.clearing.swept` satisfies it — rule 4 fee split, balanced posting set
 *
 * Aggregates: every account/form event is on the custodial account (the spec's
 * `custodial_account_events` projection is per account; a form belongs to exactly
 * one account — "separate Form 1013 or Form 1014 for each custodial account"),
 * depository events on the depository, lockbox and clearing events on the batch
 * / credit they time. bigint cents throughout; dates are PlainDate on the
 * servicer or Fannie Mae ET calendar as the row says.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, type Calendar } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { Machine } from "../../kernel/fsm/machine.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { accountPlan, titleString, titleMatches, evaluateDepositoryEligibility, depositGate, formMachine, ineligibilityNoticeDueMs, LARGE_BANK_ASSETS_CENTS, type AccountUse, type Depository, type FormStatus } from "./accounts.ts";
import { verifyExecutedForm, type FormFacts, type PostingSet } from "./ops.ts";
import type { BankLine } from "./reconciliation.ts";

export const ET = "America/New_York";
export const CUSTODIAL_RECON: Actor = { kind: "agent", id: "custodial-recon" };
export const FNMA_CUSTODIAL_TEAM = "custodial_account@fanniemae.com";
/** The CBAM portal work item the agent opens (role `fnma_portal_operator`); SM_CBAM_TASK_SLA_3BD keys on `escalation.created{kind=human_portal_task, task=cbam_form}`. */
export const CBAM_PORTAL_TASK = "cbam_form";
/** Timers a declined DocuSign cancels (with a reason — never deleted). The Form 1013 gate is not among them: the account still waits for `in_effect`. */
export const SIGNATURE_TIMERS: readonly string[] = ["SM_CBAM_SIGNATURE_PENDING_5BD"];
/** FDIC evidence older than this is `unknown` (edge "Vendor outage"): the account is not activated on it. */
export const FDIC_EVIDENCE_MAX_AGE_DAYS = 35;

export const ACCOUNT_AGG = (id: string): { kind: "custodial_account"; id: string } => ({ kind: "custodial_account", id });
export const DEPOSITORY_AGG = (id: string): { kind: "depository"; id: string } => ({ kind: "depository", id });
export const LOCKBOX_BATCH_AGG = (id: string): { kind: "lockbox_batch"; id: string } => ({ kind: "lockbox_batch", id });
export const CLEARING_CREDIT_AGG = (id: string): { kind: "clearing_credit"; id: string } => ({ kind: "clearing_credit", id });
/** A date-anchored act is stamped midday Eastern so the engine anchors on the same civil date. */
export const atNoonEt = (d: PlainDate): string => new Date(zonedEpochMs(d, "12:00", ET)).toISOString();
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && /T/.test(v);
const nineDigits = (s: string): boolean => /^\d{9}$/.test(s);
const sha256 = (v: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).digest("hex")}`;

// ---- ports (the app's EscalationService / TimerEngine satisfy these structurally) ----
export interface EscalationPort {
  open(input: { kind: "human_portal_task" | "officer"; ownerRole?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string };
  complete(id: string, by: Actor, evidenceDocumentId?: string): unknown;
}
export interface TimerPort {
  open(): readonly { id: string; code: string; subject: { kind: string; id: string }; status: string }[];
  cancel(id: string, reason: string, actor?: Actor): void;
  all(): readonly { id: string; code: string; subject: { kind: string; id: string }; status: string; cancelledReason?: string }[];
}

// ============================================================ account plan (rule 2, T1)
export type AccountKind = "pi" | "ti" | "clearing";
export type AccountStatus = "planned" | "form_pending" | "active" | "pending_replacement" | "closing" | "closed";
export interface PlannedCustodialAccount {
  readonly account_id: string; readonly kind: AccountKind; readonly form_kind: "1013" | "1014" | null; readonly remittance_type: AccountUse | null;
  readonly pool_class: "mbs" | "portfolio_mrs" | "na"; readonly is_drafting_account: boolean; readonly title: string; readonly status: "planned"; readonly ledger_accounts: readonly string[];
}
export interface ArrangementInput {
  readonly arrangement_id: string; readonly servicer_name: string; readonly master_servicer_name: string;
  readonly master_servicer_numbers: readonly string[]; readonly subservicer_number: string;
  readonly portfolio: readonly { remittance_type: AccountUse; pool_class: "mbs" | "portfolio_mrs" }[];
  /** Decision 2 default: one titled clearing account per depository with same-day sweep. */
  readonly clearing_account?: boolean; readonly depository_id?: string;
}
const rtKey = (t: AccountUse): string => t.replace("/", "");
/**
 * `subservicing.arrangement.created` (1.2) → one P&I account per remittance type × pool class (S/S split MBS / portfolio-MRS),
 * exactly one drafting account per remittance type, the T&I set (6.2) and, by default, a titled clearing account; each planned
 * account gets its ledger rows and `custodial.account.planned{kind}` — the Form 1013 gate arms on the P&I ones.
 */
export function planCustodialAccounts(events: EventStore, i: ArrangementInput, actor: Actor = CUSTODIAL_RECON): { accounts: PlannedCustodialAccount[]; events: DomainEvent[] } {
  if (!i.arrangement_id) throw new RangeError("arrangement_id is required");
  if (!i.portfolio.length) throw new RangeError("portfolio is empty: no remittance types to plan accounts for");
  if (!i.servicer_name || !i.master_servicer_name) throw new RangeError("servicer_name and master_servicer_name are required (F-1-03 title)");
  if (!i.master_servicer_numbers.length || !i.master_servicer_numbers.every(nineDigits)) throw new RangeError("master_servicer_numbers must be 9-digit Fannie Mae servicer numbers");
  if (!nineDigits(i.subservicer_number)) throw new RangeError("subservicer_number must be a 9-digit Fannie Mae servicer number");
  const plan = accountPlan(i.portfolio);
  const accounts: PlannedCustodialAccount[] = plan.map((p) => {
    if (p.kind === "pi") {
      const rt = p.remittance_type!; const pool = p.pool_class ?? "na";
      const id = `${i.arrangement_id}:PI:${rtKey(rt)}${p.pool_class ? `:${p.pool_class.toUpperCase()}` : ""}`;
      return { account_id: id, kind: "pi", form_kind: "1013", remittance_type: rt, pool_class: pool, is_drafting_account: p.is_drafting_account, title: titleString(i.servicer_name, "pi", i.master_servicer_name), status: "planned", ledger_accounts: [`custodial_pi_cash:${id}`, `fnma_remittance_payable:${rt}:${pool}`, "servicer_advance_receivable"] };
    }
    const id = `${i.arrangement_id}:TI`;
    return { account_id: id, kind: "ti", form_kind: "1014", remittance_type: null, pool_class: "na", is_drafting_account: false, title: titleString(i.servicer_name, "ti", i.master_servicer_name), status: "planned", ledger_accounts: [`custodial_ti_cash:${id}`] };
  });
  if (i.clearing_account !== false) { const id = `${i.arrangement_id}:CLR`; accounts.push({ account_id: id, kind: "clearing", form_kind: null, remittance_type: null, pool_class: "na", is_drafting_account: false, title: titleString(i.servicer_name, "pi", i.master_servicer_name), status: "planned", ledger_accounts: [`clearing_cash:${id}`] }); }
  const out = accounts.map((a) => events.append({ type: "custodial.account.planned", aggregate: ACCOUNT_AGG(a.account_id), actor, payload: { account_id: a.account_id, kind: a.kind, form_kind: a.form_kind, remittance_type: a.remittance_type, pool_class: a.pool_class, is_drafting_account: a.is_drafting_account, title: a.title, status: "planned", arrangement_id: i.arrangement_id, master_servicer_numbers: [...i.master_servicer_numbers], subservicer_number: i.subservicer_number, depository_id: i.depository_id ?? null, ledger_accounts: [...a.ledger_accounts] } }));
  return { accounts, events: out };
}

// ============================================================ account state machine
export interface AccountGuards { readonly eligibility_passed?: boolean; readonly bank_account_opened?: boolean; readonly form_in_effect?: boolean; readonly debit_whitelist_confirmed?: boolean; readonly statement_feed_receiving?: boolean; readonly title_verified?: boolean; readonly balance_zero?: boolean; readonly no_open_items?: boolean; readonly closed_in_cbam?: boolean; readonly final_form496_retained?: boolean; }
const missing = (ctx: AccountGuards, keys: (keyof AccountGuards)[]): string | undefined => { const m = keys.filter((k) => ctx[k] !== true); return m.length ? `guard not met: ${m.join(", ")}` : undefined; };
/** `custodial_accounts.status` per the 6.1 state machine; agent for every transition, the portal actions are the operator's. */
export const accountMachine = new Machine<AccountStatus, AccountGuards>({
  name: "custodial_account", initial: "planned", states: ["planned", "form_pending", "active", "pending_replacement", "closing", "closed"], terminal: ["closed"],
  transitions: [
    { from: "planned", to: "form_pending", on: "bank_account_opened", guard: (t) => missing(t.ctx, ["eligibility_passed", "bank_account_opened"]) },
    { from: "form_pending", to: "active", on: "activate", guard: (t) => missing(t.ctx, ["form_in_effect", "debit_whitelist_confirmed", "statement_feed_receiving", "title_verified"]) },
    { from: "active", to: "pending_replacement", on: "change_requested" }, { from: "pending_replacement", to: "active", on: "replacement_effective" },
    { from: "active", to: "closing", on: "close_requested", guard: (t) => missing(t.ctx, ["balance_zero", "no_open_items"]) },
    { from: "closing", to: "closed", on: "closed", guard: (t) => missing(t.ctx, ["closed_in_cbam", "final_form496_retained"]) },
  ],
});
/** planned → form_pending: the depository passed rule 1 for this account's use and the bank account exists (KYC, signature card). */
export function recordBankAccountOpened(events: EventStore, i: { account_id: string; status: AccountStatus; depository_id: string; account_use: AccountUse | null; eligibility: { eligible: boolean; rule: string }; opened_on: PlainDate; signature_card_document_id: string | null }, actor: Actor = CUSTODIAL_RECON): { status: AccountStatus; event: DomainEvent } {
  if (!i.account_id || !i.depository_id) throw new RangeError("account_id and depository_id are required");
  if (!isDate(i.opened_on)) throw new RangeError("opened_on must be a date");
  const t = accountMachine.attempt(i.status, "bank_account_opened", actor, { eligibility_passed: i.eligibility.eligible, bank_account_opened: true });
  if (!t.ok) throw new RangeError(`account ${i.account_id}: ${t.reason}`);
  const event = events.append({ type: "custodial.account.form_pending", aggregate: ACCOUNT_AGG(i.account_id), actor, occurredAt: atNoonEt(i.opened_on), payload: { account_id: i.account_id, depository_id: i.depository_id, account_use: i.account_use, eligibility_rule: i.eligibility.rule, opened_on: i.opened_on, signature_card_document_id: i.signature_card_document_id, status: t.to } });
  return { status: t.to, event };
}

// ============================================================ CBAM package and portal task (agent design; SM_CBAM_TASK_SLA_3BD)
export interface CbamPackage {
  readonly form_id: string; readonly custodial_account_id: string; readonly form_kind: "1013" | "1014";
  readonly master_servicer_numbers: readonly string[]; readonly subservicer_number: string;
  readonly depository: { readonly aba: string; readonly branch_name: string; readonly physical_address: string };
  readonly account_number: string; readonly remittance_type: AccountUse; readonly interest_bearing: boolean; readonly effective_date: PlainDate;
  readonly servicer_rep: { readonly user_id: string; readonly role: string }; readonly depository_rep: { readonly name: string; readonly title: string; readonly email: string };
  readonly title: string; readonly checklist?: readonly string[];
}
/** CBAM field rules (User Guide 5.27.26): 9-digit servicer numbers, a real ABA, a physical branch address (no PO boxes), one remittance type per Form 1013, an `officer` as the servicer representative, a depository contact, and the F-1-03 title. */
export function validateCbamPackage(p: CbamPackage): string[] {
  const problems: string[] = [];
  if (!p.form_id) problems.push("form_id missing");
  if (!p.custodial_account_id) problems.push("custodial_account_id missing");
  if (p.form_kind !== "1013" && p.form_kind !== "1014") problems.push("form_kind must be 1013 or 1014");
  if (!p.master_servicer_numbers.length || !p.master_servicer_numbers.every(nineDigits)) problems.push("master servicer numbers must be 9 digits");
  if (!nineDigits(p.subservicer_number)) problems.push("subservicer number must be 9 digits");
  if (!nineDigits(p.depository.aba)) problems.push("ABA must be 9 digits");
  if (!p.depository.branch_name) problems.push("branch name missing");
  if (!p.depository.physical_address || /\bP\.?\s*O\.?\s*box\b/i.test(p.depository.physical_address)) problems.push("physical branch address required (no PO boxes)");
  if (!/^\d{4,17}$/.test(p.account_number)) problems.push("custodial account number must be 4–17 digits");
  if (!["A/A", "S/A", "S/S"].includes(p.remittance_type)) problems.push("Form 1013 allows a single remittance type: A/A, S/A or S/S");
  if (!isDate(p.effective_date)) problems.push("effective date missing");
  if (p.servicer_rep.role !== "officer") problems.push("servicer representative must be an officer (Letter of Authorization binds the company)");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.depository_rep.email) || !p.depository_rep.name) problems.push("depository representative name and e-mail required");
  if (!/for the benefit of Fannie Mae/.test(p.title) || !/\(Custodial Account\)$/.test(p.title)) problems.push("title must be the F-1-03 custodial title");
  return problems;
}
/**
 * Builds the `human_portal_task` package (role `fnma_portal_operator`) and the DocuSign signature escalation (role `officer` — an
 * officer certification under baseline §8(3)); the executed form is verified against this package by `markFormInEffect`.
 */
export function prepareCbamPackage(events: EventStore, escalations: EscalationPort, p: CbamPackage, actor: Actor = CUSTODIAL_RECON): { form_id: string; status: "in_draft"; package_hash: string; portal_task_id: string; signature_escalation_id: string; event: DomainEvent } {
  const problems = validateCbamPackage(p);
  if (problems.length) throw new RangeError(`CBAM package for ${p.form_id || "?"} is not complete: ${problems.join("; ")}`);
  const package_hash = sha256(p);
  const task = escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", payload: { task: CBAM_PORTAL_TASK, form_id: p.form_id, custodial_account_id: p.custodial_account_id, form_kind: p.form_kind, channel: "cbam", package_hash, remittance_type: p.remittance_type, effective_date: p.effective_date, aba: p.depository.aba, instructions: "enter the package, click Generate & Send for eSignatures, record the CBAM form number" } }, actor);
  const sig = escalations.open({ kind: "officer", severity: "medium", payload: { task: "docusign_form_signature", form_id: p.form_id, custodial_account_id: p.custodial_account_id, form_kind: p.form_kind, portal_task_id: task.id, package_hash, certification: "Letter of Authorization (baseline §8(3))" } }, actor);
  const event = events.append({ type: "custodial.form.drafted", aggregate: ACCOUNT_AGG(p.custodial_account_id), actor, payload: { form_id: p.form_id, custodial_account_id: p.custodial_account_id, kind: p.form_kind, status: "in_draft", package_hash, portal_task_id: task.id, signature_escalation_id: sig.id, remittance_type: p.remittance_type, effective_date: p.effective_date } });
  return { form_id: p.form_id, status: "in_draft", package_hash, portal_task_id: task.id, signature_escalation_id: sig.id, event };
}

// ============================================================ send for signature (SM_CBAM_TASK_SLA_3BD satisfied; SM_CBAM_SIGNATURE_PENDING_5BD armed)
/** The CBAM portal task `escalation.created` for this form, read back from the store so the operator's record is validated against the task the agent opened. */
export function cbamPortalTaskFor(events: EventStore, portalTaskId: string, formId: string): DomainEvent | undefined {
  return events.ofType("escalation.created").find((e) => e.aggregate?.kind === "escalation" && e.aggregate.id === portalTaskId && e.payload["kind"] === "human_portal_task" && e.payload["task"] === CBAM_PORTAL_TASK && e.payload["form_id"] === formId);
}
/**
 * The operator's "Generate & Send for eSignatures" record: the CBAM form number is captured, the portal task completes
 * (`escalation.completed`, the SLA subject) and `custodial.form.sent_for_signature{sent_at}` starts the 5-BD signature clock —
 * DocuSign routes to the servicer representative first, then the depository; the officer chases at 10 BD.
 */
export function sendFormForSignature(events: EventStore, escalations: EscalationPort, i: { form_id: string; custodial_account_id: string; form_kind: "1013" | "1014"; status: FormStatus; cbam_form_number: string; sent_at: PlainDate; portal_task_id: string }, actor: Actor, cal: Calendar = servicer): { status: "pending_signatures"; signature_due_on: PlainDate; officer_chase_on: PlainDate; event: DomainEvent } {
  if (!i.form_id || !i.custodial_account_id) throw new RangeError("form_id and custodial_account_id are required");
  if (!/^\S+$/.test(i.cbam_form_number ?? "")) throw new RangeError("cbam_form_number is required (CBAM assigns it on Generate & Send)");
  if (!isDate(i.sent_at)) throw new RangeError("sent_at must be a date");
  const t = formMachine.attempt(i.status, "send", actor, {});
  if (!t.ok) throw new RangeError(`form ${i.form_id}: ${t.reason}`);
  if (!cbamPortalTaskFor(events, i.portal_task_id, i.form_id)) throw new RangeError(`portal task ${i.portal_task_id} is not the CBAM task for form ${i.form_id}`);
  escalations.complete(i.portal_task_id, actor);
  const signature_due_on = addBusinessDays(i.sent_at, 5, cal), officer_chase_on = addBusinessDays(i.sent_at, 10, cal);
  const event = events.append({ type: "custodial.form.sent_for_signature", aggregate: ACCOUNT_AGG(i.custodial_account_id), actor, occurredAt: atNoonEt(i.sent_at), payload: { form_id: i.form_id, custodial_account_id: i.custodial_account_id, kind: i.form_kind, cbam_form_number: i.cbam_form_number, sent_at: i.sent_at, portal_task_id: i.portal_task_id, status: "pending_signatures", routing: ["servicer_representative", "depository_representative"], signature_due_on, officer_chase_on } });
  return { status: "pending_signatures", signature_due_on, officer_chase_on, event };
}

// ============================================================ CBAM / DocuSign status ingestion (fully_signed; declined → T8)
export type CbamStatus = "In Draft" | "Pending Signatures" | "Signatures Declined" | "Fully Signed" | "In Effect" | "Pending Replacement";
export interface CbamStatusRecord {
  readonly form_id: string; readonly custodial_account_id: string; readonly form_kind: "1013" | "1014"; readonly status: FormStatus; readonly cbam_status: CbamStatus; readonly cbam_form_number: string;
  readonly servicer_signed_at?: string; readonly depository_signed_at?: string; readonly certificate_of_completion_id?: string; readonly declined_by?: string; readonly decline_reason?: string;
}
export interface DeclineResult { readonly status: "signatures_declined"; readonly escalation_id: string; readonly timers_cancelled: { id: string; code: string; reason: string }[]; readonly timers_deleted: 0; readonly funds_moved: false; readonly attachments: ["F-1-03 title language", "custodial_account@fanniemae.com"]; readonly event: DomainEvent; }
/**
 * The agent parses the CBAM status (User Guide: In Draft → Pending Signatures → (Signatures Declined) → Fully Signed → In Effect →
 * Pending Replacement). "Fully Signed" needs both DocuSign timestamps in routing order and appends `custodial.form.fully_signed`;
 * "Signatures Declined" runs the T8 path; "In Effect" is never taken from a parsed status — only `markFormInEffect` (executed hash) sets it.
 */
export function ingestCbamFormStatus(events: EventStore, escalations: EscalationPort, timers: TimerPort, r: CbamStatusRecord, actor: Actor): { status: FormStatus; event: DomainEvent | null; decline: DeclineResult | null } {
  if (!r.form_id || !r.custodial_account_id) throw new RangeError("form_id and custodial_account_id are required");
  if (!r.cbam_form_number) throw new RangeError("cbam_form_number is required");
  switch (r.cbam_status) {
    case "Fully Signed": {
      if (!isIso(r.servicer_signed_at) || !isIso(r.depository_signed_at)) throw new RangeError("Fully Signed needs the servicer and depository DocuSign timestamps");
      if (Date.parse(r.depository_signed_at) < Date.parse(r.servicer_signed_at)) throw new RangeError("DocuSign routing is servicer representative first, then depository");
      const t = formMachine.attempt(r.status, "signed", actor, {});
      if (!t.ok) throw new RangeError(`form ${r.form_id}: ${t.reason}`);
      const event = events.append({ type: "custodial.form.fully_signed", aggregate: ACCOUNT_AGG(r.custodial_account_id), actor, occurredAt: r.depository_signed_at, payload: { form_id: r.form_id, custodial_account_id: r.custodial_account_id, kind: r.form_kind, cbam_form_number: r.cbam_form_number, servicer_signed_at: r.servicer_signed_at, depository_signed_at: r.depository_signed_at, certificate_of_completion_id: r.certificate_of_completion_id ?? null, status: t.to } });
      return { status: t.to, event, decline: null };
    }
    case "Signatures Declined": {
      const d = declineForm(events, escalations, timers, { form_id: r.form_id, custodial_account_id: r.custodial_account_id, status: r.status, declined_by: r.declined_by ?? "depository representative", reason: r.decline_reason ?? "declined in DocuSign" }, actor);
      return { status: d.status, event: d.event, decline: d };
    }
    case "In Effect": throw new RangeError("6.1 guardrail: `in_effect` is set by the executed-document verification (markFormInEffect), never from a parsed portal status");
    case "Pending Replacement": {
      const t = formMachine.attempt(r.status, "change_requested", actor, {});
      if (!t.ok) throw new RangeError(`form ${r.form_id}: ${t.reason}`);
      const event = events.append({ type: "custodial.form.change_requested", aggregate: ACCOUNT_AGG(r.custodial_account_id), actor, payload: { form_id: r.form_id, custodial_account_id: r.custodial_account_id, kind: r.form_kind, cbam_form_number: r.cbam_form_number, status: t.to } });
      return { status: t.to, event, decline: null };
    }
    case "Pending Signatures": if (r.status === "pending_signatures") return { status: r.status, event: null, decline: null }; throw new RangeError("Pending Signatures is recorded by sendFormForSignature (the operator's send)");
    case "In Draft": if (r.status === "in_draft") return { status: r.status, event: null, decline: null }; throw new RangeError(`form ${r.form_id} is ${r.status}; CBAM shows In Draft`);
    default: throw new RangeError(`unknown CBAM status ${String(r.cbam_status)}`);
  }
}
/**
 * 6.1-T8 / edge "Depository declines the DocuSign": `signatures_declined`, an `officer` escalation with the Guide title language and
 * Fannie Mae's contact attached, no funds move, the signature timer cancelled with a reason (never deleted; the Form 1013 gate stays
 * armed), and — with the SLA row narrowed to the CBAM task — no new 3-BD SLA arms on the officer escalation.
 */
export function declineForm(events: EventStore, escalations: EscalationPort, timers: TimerPort, i: { form_id: string; custodial_account_id: string; status: FormStatus; declined_by: string; reason: string }, actor: Actor): DeclineResult {
  if (!i.form_id || !i.custodial_account_id) throw new RangeError("form_id and custodial_account_id are required");
  const t = formMachine.attempt(i.status, "declined", actor, {});
  if (!t.ok) throw new RangeError(`form ${i.form_id}: ${t.reason}`);
  const before = timers.all().length;
  const reason = `DocuSign declined by ${i.declined_by}: ${i.reason}`;
  const cancelled: { id: string; code: string; reason: string }[] = [];
  for (const inst of timers.open()) {
    const onForm = inst.subject.kind === "custodial_form" && inst.subject.id === i.form_id;
    const onAccount = inst.subject.kind === "custodial_account" && inst.subject.id === i.custodial_account_id && SIGNATURE_TIMERS.includes(inst.code);
    if (onForm || onAccount) { timers.cancel(inst.id, reason, actor); cancelled.push({ id: inst.id, code: inst.code, reason }); }
  }
  if (timers.all().length !== before) throw new RangeError("timer rows are append-only: a cancel never deletes");
  const attachments: ["F-1-03 title language", "custodial_account@fanniemae.com"] = ["F-1-03 title language", FNMA_CUSTODIAL_TEAM];
  const event = events.append({ type: "custodial.form.signatures_declined", aggregate: ACCOUNT_AGG(i.custodial_account_id), actor, payload: { form_id: i.form_id, custodial_account_id: i.custodial_account_id, status: t.to, declined_by: i.declined_by, reason: i.reason, funds_moved: false, timers_cancelled: cancelled.map((c) => c.code) } });
  const esc = escalations.open({ kind: "officer", severity: "high", payload: { task: "docusign_declined_negotiation", form_id: i.form_id, custodial_account_id: i.custodial_account_id, event: "custodial.form.signatures_declined", declined_by: i.declined_by, reason: i.reason, attachments, funds_moved: false, timers_cancelled: cancelled.map((c) => c.code) } }, actor);
  return { status: "signatures_declined", escalation_id: esc.id, timers_cancelled: cancelled, timers_deleted: 0, funds_moved: false, attachments, event };
}

// ============================================================ executed document → in_effect (T7; FNMA_F103_FORM1013_IN_EFFECT_GATE opens)
export interface InEffectInput { readonly form_id: string; readonly custodial_account_id: string; readonly form_kind: "1013" | "1014"; readonly status: FormStatus; readonly plan: FormFacts; readonly executed: FormFacts; readonly executed_document_hash: string | null; readonly executed_document_id?: string; readonly as_of: PlainDate; readonly remittance_types?: readonly AccountUse[]; }
/**
 * The agent verifies the executed PDF against the plan (account number, title, ABA, remittance type, effective date): any mismatch
 * reopens the portal task and the form stays as it was; a verified form with its executed-document hash becomes `in_effect` once the
 * effective date is reached, and `custodial.form.in_effect{kind}` opens the account's Form 1013 gate.
 */
export function markFormInEffect(events: EventStore, escalations: EscalationPort, i: InEffectInput, actor: Actor = CUSTODIAL_RECON): { in_effect: boolean; status: FormStatus; mismatches: (keyof FormFacts)[]; reopened_task_id: string | null; event: DomainEvent | null; reason: string | null } {
  if (!i.form_id || !i.custodial_account_id) throw new RangeError("form_id and custodial_account_id are required");
  if (!i.executed_document_hash) throw new RangeError("6.1 guardrail: a form is never marked in_effect without the executed document hash");
  if (!isDate(i.as_of)) throw new RangeError("as_of must be a date");
  const v = verifyExecutedForm({ plan: i.plan, executed: i.executed, executed_document_hash: i.executed_document_hash });
  if (!v.matches) {
    const task = escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", payload: { task: CBAM_PORTAL_TASK, reopened: true, form_id: i.form_id, custodial_account_id: i.custodial_account_id, form_kind: i.form_kind, channel: "cbam", mismatches: v.mismatches, reason: v.reason, executed_document_hash: i.executed_document_hash } }, actor);
    events.append({ type: "custodial.form.verification_failed", aggregate: ACCOUNT_AGG(i.custodial_account_id), actor, payload: { form_id: i.form_id, custodial_account_id: i.custodial_account_id, kind: i.form_kind, mismatches: v.mismatches, reopened_task_id: task.id, executed_document_hash: i.executed_document_hash } });
    return { in_effect: false, status: i.status, mismatches: v.mismatches, reopened_task_id: task.id, event: null, reason: v.reason };
  }
  const t = formMachine.attempt(i.status, "effective", actor, { effective_reached: i.as_of >= i.plan.effective_date });
  if (!t.ok) return { in_effect: false, status: i.status, mismatches: [], reopened_task_id: null, event: null, reason: t.reason };
  const event = events.append({ type: "custodial.form.in_effect", aggregate: ACCOUNT_AGG(i.custodial_account_id), actor, occurredAt: atNoonEt(i.as_of), payload: { form_id: i.form_id, custodial_account_id: i.custodial_account_id, kind: i.form_kind, status: t.to, executed_document_hash: i.executed_document_hash, executed_document_id: i.executed_document_id ?? null, effective_date: i.plan.effective_date, remittance_type: i.plan.remittance_type, remittance_types: i.remittance_types ? [...i.remittance_types] : [i.plan.remittance_type], account_number_last4: i.plan.account_number.slice(-4) } });
  return { in_effect: true, status: t.to, mismatches: [], reopened_task_id: null, event, reason: null };
}

// ============================================================ activation (FNMA_A4102_RATING_MONITOR_RECUR armed; partner notified)
export interface ActivationInput {
  readonly account_id: string; readonly kind: "pi" | "ti"; readonly remittance_type: AccountUse | null; readonly pool_class: "mbs" | "portfolio_mrs" | "na"; readonly depository_id: string; readonly status: AccountStatus;
  readonly form_status: FormStatus; readonly debit_whitelist_confirmed_at: string | null; readonly statement_feed_id: string | null; readonly statement_feed_test_files_received: boolean;
  readonly expected_title: string; readonly observed_title: string; readonly activated_on: PlainDate;
}
/**
 * `form_pending` → `active` only when the form is `in_effect`, the ACH debit whitelist is confirmed, the statement feed is receiving
 * test files and the signature-card title matches byte-for-byte (rule 3); `custodial.account.activated{activated_on}` starts the
 * rating monitor and the partner gets PARTNER_CUSTODIAL_ACCOUNT_ACTIVATED (non-regulatory).
 */
export function activateAccount(events: EventStore, i: ActivationInput, actor: Actor = CUSTODIAL_RECON): { activated: boolean; status: AccountStatus; blocked_by: string[]; event: DomainEvent | null; partner_notification: DomainEvent | null } {
  if (!i.account_id || !i.depository_id) throw new RangeError("account_id and depository_id are required");
  if (!isDate(i.activated_on)) throw new RangeError("activated_on must be a date");
  const title = titleMatches(i.expected_title, i.observed_title);
  const guards: AccountGuards = { form_in_effect: i.form_status === "in_effect", debit_whitelist_confirmed: !!i.debit_whitelist_confirmed_at, statement_feed_receiving: !!i.statement_feed_id && i.statement_feed_test_files_received, title_verified: title.ok };
  const t = accountMachine.attempt(i.status, "activate", actor, guards);
  if (!t.ok) {
    const blocked = (Object.keys(guards) as (keyof AccountGuards)[]).filter((k) => guards[k] !== true).map((k) => (k === "title_verified" && !title.ok ? "title_mismatch" : k));
    return { activated: false, status: i.status, blocked_by: blocked.length ? blocked : [t.reason], event: null, partner_notification: null };
  }
  const event = events.append({ type: "custodial.account.activated", aggregate: ACCOUNT_AGG(i.account_id), actor, occurredAt: atNoonEt(i.activated_on), payload: { account_id: i.account_id, kind: i.kind, remittance_type: i.remittance_type, pool_class: i.pool_class, depository_id: i.depository_id, activated_on: i.activated_on, status: t.to, debit_whitelist_confirmed_at: i.debit_whitelist_confirmed_at, statement_feed_id: i.statement_feed_id, title: i.expected_title, rating_monitor: "FNMA_A4102_RATING_MONITOR_RECUR" } });
  const partner_notification = events.append({ type: "partner.notified", aggregate: ACCOUNT_AGG(i.account_id), actor, occurredAt: event.occurredAt, payload: { reason: "custodial_account_activated", template: "PARTNER_CUSTODIAL_ACCOUNT_ACTIVATED", regulatory: false, channel: "email", account_id: i.account_id, kind: i.kind, remittance_type: i.remittance_type, activated_on: i.activated_on } });
  return { activated: true, status: t.to, blocked_by: [], event, partner_notification };
}

// ============================================================ rating monitor (rule 1; FNMA_A4102_RATING_MONITOR_RECUR; ineligible → 3-BD notice, T5)
export type EligibilityStatus = "eligible" | "ineligible" | "unknown";
export interface RatingCheckInput {
  readonly depository: Depository & { readonly id: string; readonly aba?: string }; readonly ratings_as_of: PlainDate; readonly checked_on: PlainDate;
  /** The active accounts at this depository, each evaluated for its own use (A/A and S/A accounts have the lower IDC/KBRA floor). */
  readonly accounts: readonly { account_id: string; use: AccountUse }[];
  /** FDIC BankFind evidence date (insurance, assets, capital); older than 35 days or absent → `unknown`. */
  readonly fdic_as_of: PlainDate | null; readonly prior_ratings?: Depository["ratings"]; readonly source_document_ids?: readonly string[];
}
export interface RatingCheckResult { readonly eligibility_status: EligibilityStatus; readonly results: { account_id: string; use: AccountUse; eligible: boolean; rule: string }[]; readonly next_check_due: PlainDate; readonly notify_by: PlainDate | null; readonly ineligible_detected: DomainEvent | null; readonly events: DomainEvent[]; }
function failedTest(d: Depository, uses: readonly AccountUse[]): { agency: "sp" | "moodys" | "idc" | "kbra"; rating: string | number | null; floor: string | number } {
  const r = d.ratings;
  if (d.total_assets_cents >= LARGE_BANK_ASSETS_CENTS) return r.sp_st !== undefined || r.sp_lt !== undefined ? { agency: "sp", rating: r.sp_st ?? r.sp_lt ?? null, floor: r.sp_st !== undefined ? "A-3" : "BBB-" } : { agency: "moodys", rating: r.moodys_st ?? r.moodys_lt ?? null, floor: r.moodys_st !== undefined ? "P-3" : "Baa3" };
  const strict = uses.includes("S/S");
  return r.idc !== undefined ? { agency: "idc", rating: r.idc, floor: strict ? 125 : 75 } : { agency: "kbra", rating: r.kbra ?? null, floor: strict ? "C+" : "C" };
}
/**
 * The scheduled `custodial.depository.rating_check`: rule 1 per account use with the FDIC evidence age rule; one
 * `custodial.depository.rating_checked` per account (the recurring monitor's subject) and, on any failure, one
 * `custodial.depository.ineligible_detected{detected_on}` on the depository — due 3 `business_days_fannie_et` 17:00 ET.
 */
export function checkDepositoryRatings(events: EventStore, i: RatingCheckInput, actor: Actor = CUSTODIAL_RECON): RatingCheckResult {
  if (!i.depository.id) throw new RangeError("depository.id is required");
  if (!isDate(i.ratings_as_of) || !isDate(i.checked_on)) throw new RangeError("ratings_as_of and checked_on must be dates");
  if (!i.accounts.length) throw new RangeError("no accounts to evaluate at this depository");
  const fdicStale = i.fdic_as_of === null || daysBetween(i.fdic_as_of, i.checked_on) > FDIC_EVIDENCE_MAX_AGE_DAYS || i.fdic_as_of > i.checked_on;
  const next_check_due = addMonths(i.checked_on, 1);
  const results = i.accounts.map((a) => { const r = evaluateDepositoryEligibility(i.depository, a.use); return { account_id: a.account_id, use: a.use, eligible: !fdicStale && r.eligible, rule: fdicStale ? `unknown: FDIC evidence ${i.fdic_as_of ? `dated ${i.fdic_as_of} is older than ${FDIC_EVIDENCE_MAX_AGE_DAYS} days` : "absent"}` : r.rule }; });
  const status: EligibilityStatus = fdicStale ? "unknown" : results.every((r) => r.eligible) ? "eligible" : "ineligible";
  const out: DomainEvent[] = results.map((r) => events.append({ type: "custodial.depository.rating_checked", aggregate: ACCOUNT_AGG(r.account_id), actor, occurredAt: atNoonEt(i.checked_on), payload: { depository_id: i.depository.id, account_id: r.account_id, account_use: r.use, eligible: r.eligible, eligibility_status: status, rule: r.rule, ratings: { ...i.depository.ratings }, total_assets_cents: i.depository.total_assets_cents, insured: i.depository.insured, well_capitalized: i.depository.well_capitalized, ratings_as_of: i.ratings_as_of, fdic_as_of: i.fdic_as_of, checked_on: i.checked_on, next_check_due, source_document_ids: [...(i.source_document_ids ?? [])] } }));
  let ineligible_detected: DomainEvent | null = null, notify_by: PlainDate | null = null;
  if (status === "ineligible") {
    const failing = results.filter((r) => !r.eligible);
    const test = failedTest(i.depository, failing.map((f) => f.use));
    const dueMs = ineligibilityNoticeDueMs(i.checked_on); notify_by = wallClock(dueMs, ET).date;
    ineligible_detected = events.append({ type: "custodial.depository.ineligible_detected", aggregate: DEPOSITORY_AGG(i.depository.id), actor, occurredAt: atNoonEt(i.checked_on), payload: { depository_id: i.depository.id, depository_name: i.depository.name, aba: i.depository.aba ?? null, detected_on: i.checked_on, agency: test.agency, rating: test.rating, prior_rating: i.prior_ratings ? (test.agency === "idc" ? i.prior_ratings.idc ?? null : test.agency === "kbra" ? i.prior_ratings.kbra ?? null : test.agency === "sp" ? i.prior_ratings.sp_st ?? i.prior_ratings.sp_lt ?? null : i.prior_ratings.moodys_st ?? i.prior_ratings.moodys_lt ?? null) : null, floor: test.floor, failing_accounts: failing.map((f) => f.account_id), eligibility_status: "ineligible", account_status: "watch", notify_by, notify_by_at: new Date(dueMs).toISOString(), notify_to: FNMA_CUSTODIAL_TEAM } });
    out.push(ineligible_detected);
  }
  return { eligibility_status: status, results, next_check_due, notify_by, ineligible_detected, events: out };
}

// ============================================================ lockbox batches and custodial deposits (C-1.1-01; FNMA_C1101_LOCKBOX_DEPOSIT_2BD, T6)
export interface LockboxBatchRecord { readonly batch_id: string; readonly lockbox_agent: string; readonly received_on: PlainDate; readonly items: readonly { sequence: number; amount_cents: Cents; bank_reference: string; scanline?: string }[]; readonly total_cents: Cents; readonly clearing_account_id: string | null; readonly custodial_account_id: string; }
/** The lockbox agent's batch (BAI2 lockbox file): validated (items, control total, receipt date) and appended as `lockbox.batch.received{received_on}` — clearing by BD+1, custodial by BD+2 on the servicer calendar. */
export function ingestLockboxBatch(events: EventStore, b: LockboxBatchRecord, actor: Actor = CUSTODIAL_RECON, cal: Calendar = servicer): { clearing_due_on: PlainDate; custodial_due_on: PlainDate; event: DomainEvent } {
  if (!b.batch_id || !b.lockbox_agent) throw new RangeError("batch_id and lockbox_agent are required");
  if (!isDate(b.received_on)) throw new RangeError("received_on must be the lockbox receipt date");
  if (!b.items.length) throw new RangeError(`lockbox batch ${b.batch_id} has no items`);
  if (b.items.some((it) => it.amount_cents <= 0n || !it.bank_reference)) throw new RangeError(`lockbox batch ${b.batch_id}: every item needs a positive amount and a bank reference`);
  const sum = b.items.reduce((s, it) => s + it.amount_cents, 0n);
  if (sum !== b.total_cents) throw new RangeError(`lockbox batch ${b.batch_id}: items sum to ${sum} cents, control total ${b.total_cents}`);
  if (!b.custodial_account_id) throw new RangeError("custodial_account_id is required");
  const clearing_due_on = addBusinessDays(b.received_on, 1, cal), custodial_due_on = addBusinessDays(b.received_on, 2, cal);
  const event = events.append({ type: "lockbox.batch.received", aggregate: LOCKBOX_BATCH_AGG(b.batch_id), actor, occurredAt: atNoonEt(b.received_on), payload: { batch_id: b.batch_id, lockbox_agent: b.lockbox_agent, received_on: b.received_on, item_count: b.items.length, total_cents: b.total_cents, clearing_account_id: b.clearing_account_id, custodial_account_id: b.custodial_account_id, clearing_due_on, custodial_due_on, bank_references: b.items.map((it) => it.bank_reference) } });
  return { clearing_due_on, custodial_due_on, event };
}
export interface DepositConfirmation { readonly subject: { kind: "lockbox_batch" | "clearing_credit" | "payment"; id: string }; readonly custodial_account_id: string; readonly bank_line: BankLine; readonly expected_cents: Cents; readonly deposited_on: PlainDate; }
/** The custodial bank's credit matched to the batch / receipt it clears: `custodial.deposit.confirmed` on the same subject — the 24-hour, 1-BD and 2-BD deposit rows are satisfied by nothing else. */
export function confirmCustodialDeposit(events: EventStore, c: DepositConfirmation, actor: Actor = CUSTODIAL_RECON): { matched: true; event: DomainEvent } {
  if (!c.subject?.id || !c.custodial_account_id) throw new RangeError("subject and custodial_account_id are required");
  if (!c.bank_line?.id || c.bank_line.amount_cents <= 0n) throw new RangeError("bank_line must be a credit");
  if (!isDate(c.deposited_on)) throw new RangeError("deposited_on must be a date");
  if (c.bank_line.amount_cents !== c.expected_cents) throw new RangeError(`bank credit ${c.bank_line.id} is ${c.bank_line.amount_cents} cents; ${c.subject.kind} ${c.subject.id} expects ${c.expected_cents} — not matched`);
  const event = events.append({ type: "custodial.deposit.confirmed", aggregate: c.subject, actor, occurredAt: atNoonEt(c.deposited_on), payload: { custodial_account_id: c.custodial_account_id, subject_kind: c.subject.kind, subject_id: c.subject.id, ...(c.subject.kind === "lockbox_batch" ? { batch_id: c.subject.id } : {}), bank_line_id: c.bank_line.id, amount_cents: c.bank_line.amount_cents, value_date: c.bank_line.value_date, deposited_on: c.deposited_on, matched_by: "bank_credit" } });
  return { matched: true, event };
}

// ============================================================ deposit command behind the Form 1013 gate (T4)
export class DepositGateClosed extends RangeError {
  readonly gate: string; readonly task: ReturnType<typeof depositGate> extends infer R ? (R extends { ok: false; task: infer T } ? T : never) : never;
  constructor(gate: string, reason: string, task: DepositGateClosed["task"]) { super(`${gate}: deposit refused — ${reason}`); this.name = "DepositGateClosed"; this.gate = gate; this.task = task; }
}
export interface DepositCommand { readonly deposit_id: string; readonly account_id: string; readonly form: { status: FormStatus; kind: "1013" | "1014"; remittance_types?: readonly AccountUse[] }; readonly loan_type?: AccountUse; readonly amount_cents: Cents; readonly source: "lockbox" | "clearing_sweep" | "wire" | "ach_credit" | "office_mail"; readonly deposited_on: PlainDate; }
/** `assertGateOpen`: a deposit (or a CRS drafting instruction) into an account whose Form 1013 is not in effect is refused with the gate code; an armed gate instance is the source of truth when a timer engine is given. */
export function initiateDeposit(events: EventStore, timers: TimerPort | null, d: DepositCommand, actor: Actor = CUSTODIAL_RECON): DomainEvent {
  if (!d.deposit_id || !d.account_id) throw new RangeError("deposit_id and account_id are required");
  if (d.amount_cents <= 0n) throw new RangeError("amount_cents must be positive");
  if (!isDate(d.deposited_on)) throw new RangeError("deposited_on must be a date");
  const g = depositGate(d.form, d.loan_type);
  if (!g.ok) throw new DepositGateClosed(g.gate, g.reason, g.task);
  const armed = timers?.open().find((t) => (t.code === "FNMA_F103_FORM1013_IN_EFFECT_GATE" || t.code === "FNMA_F103_FORM1014_IN_EFFECT_GATE") && t.subject.kind === "custodial_account" && t.subject.id === d.account_id);
  if (armed) throw new DepositGateClosed(armed.code, `gate instance ${armed.id} is still armed (no custodial.form.in_effect for ${d.account_id})`, null);
  return events.append({ type: "custodial.deposit.initiated", aggregate: ACCOUNT_AGG(d.account_id), actor, occurredAt: atNoonEt(d.deposited_on), payload: { deposit_id: d.deposit_id, custodial_account_id: d.account_id, amount_cents: d.amount_cents, source: d.source, deposited_on: d.deposited_on, gate: d.form.kind === "1013" ? "FNMA_F103_FORM1013_IN_EFFECT_GATE" : "FNMA_F103_FORM1014_IN_EFFECT_GATE", gate_open: true } });
}

// ============================================================ clearing account → custodial (A4-1-02 / F-1-03 rule 4; FNMA_A4102_CLEARING_TO_CUSTODIAL_1BD)
export interface ClearingPayment { readonly payment_id: string; readonly loan_id: string; readonly principal_cents: Cents; readonly interest_gross_cents: Cents; readonly upb_prior_cents: Cents; readonly servicing_fee_rate_pct: string; readonly late_charges_retained_cents: Cents; }
/** Rule 4: `servicing_fee = round_half_up(UPB_prior × servicing_fee_rate / 12)` in cents per loan. */
export function servicingFeeCents(upbPriorCents: Cents, servicingFeeRatePct: string): Cents {
  return divRound(upbPriorCents * Decimal.parse(servicingFeeRatePct).unscaled, 100n * 12n * Decimal.ONE.unscaled, "HALF_UP");
}
export interface SweepComputation { readonly gross_cents: Cents; readonly servicing_fee_cents: Cents; readonly late_charges_retained_cents: Cents; readonly sweep_cents: Cents; readonly per_loan: { payment_id: string; loan_id: string; gross_cents: Cents; servicing_fee_cents: Cents; late_charges_retained_cents: Cents; sweep_cents: Cents }[]; }
/** Rule 4: the sweep to custodial is Σ(principal + interest_gross) − servicing_fee − late_charges_retained (F-1-03: the servicer's share comes out before the transfer). */
export function clearingSweep(payments: readonly ClearingPayment[]): SweepComputation {
  if (!payments.length) throw new RangeError("no payments to sweep");
  const per_loan = payments.map((p) => { const gross = p.principal_cents + p.interest_gross_cents; const fee = servicingFeeCents(p.upb_prior_cents, p.servicing_fee_rate_pct); const sweep = gross - fee - p.late_charges_retained_cents; if (sweep < 0n) throw new RangeError(`payment ${p.payment_id}: fee and late charges exceed the payment`); return { payment_id: p.payment_id, loan_id: p.loan_id, gross_cents: gross, servicing_fee_cents: fee, late_charges_retained_cents: p.late_charges_retained_cents, sweep_cents: sweep }; });
  const sum = (k: "gross_cents" | "servicing_fee_cents" | "late_charges_retained_cents" | "sweep_cents") => per_loan.reduce((s, l) => s + l[k], 0n);
  return { gross_cents: sum("gross_cents"), servicing_fee_cents: sum("servicing_fee_cents"), late_charges_retained_cents: sum("late_charges_retained_cents"), sweep_cents: sum("sweep_cents"), per_loan };
}
export interface ClearingCreditRecord { readonly clearing_account_id: string; readonly line: BankLine; readonly credited_on: PlainDate; readonly source: "bai2_prior_day" | "intraday" | "camt053"; readonly payments: readonly ClearingPayment[]; }
/** A bank credit landing in the titled clearing account (statement or intraday feed): `custodial.clearing.credited{credited_on}` — the custodial deposit is due 1 servicer business day later, including any time the funds sat in the general ledger. */
export function ingestClearingCredit(events: EventStore, c: ClearingCreditRecord, actor: Actor = CUSTODIAL_RECON, cal: Calendar = servicer): { sweep_due_on: PlainDate; event: DomainEvent } {
  if (!c.clearing_account_id || !c.line?.id) throw new RangeError("clearing_account_id and a bank line are required");
  if (c.line.amount_cents <= 0n) throw new RangeError(`bank line ${c.line.id} is not a credit`);
  if (!isDate(c.credited_on)) throw new RangeError("credited_on must be the bank credit date");
  const gross = c.payments.reduce((s, p) => s + p.principal_cents + p.interest_gross_cents, 0n);
  if (c.payments.length && gross !== c.line.amount_cents) throw new RangeError(`clearing credit ${c.line.id}: payments total ${gross} cents, bank credit ${c.line.amount_cents}`);
  const sweep_due_on = addBusinessDays(c.credited_on, 1, cal);
  const event = events.append({ type: "custodial.clearing.credited", aggregate: CLEARING_CREDIT_AGG(c.line.id), actor, occurredAt: atNoonEt(c.credited_on), payload: { clearing_account_id: c.clearing_account_id, credit_id: c.line.id, amount_cents: c.line.amount_cents, value_date: c.line.value_date, credited_on: c.credited_on, source: c.source, sweep_due_on, payment_ids: c.payments.map((p) => p.payment_id) } });
  return { sweep_due_on, event };
}
export interface SweepInput { readonly clearing_account_id: string; readonly custodial_account_id: string; readonly credit_id: string; readonly credited_on: PlainDate; readonly swept_on: PlainDate; readonly payments: readonly ClearingPayment[]; }
/** The sweep of one clearing credit into the P&I custodial account with the rule-4 fee split; `custodial.clearing.swept` on the credit satisfies the 1-BD row, and the balanced posting set is what `ledger.post` books. */
export function sweepClearingToCustodial(events: EventStore, s: SweepInput, actor: Actor = CUSTODIAL_RECON, cal: Calendar = servicer): { computation: SweepComputation; posting: PostingSet; on_time: boolean; due_on: PlainDate; event: DomainEvent } {
  if (!s.clearing_account_id || !s.custodial_account_id || !s.credit_id) throw new RangeError("clearing_account_id, custodial_account_id and credit_id are required");
  if (!isDate(s.credited_on) || !isDate(s.swept_on)) throw new RangeError("credited_on and swept_on must be dates");
  if (s.swept_on < s.credited_on) throw new RangeError("swept_on precedes the bank credit");
  const computation = clearingSweep(s.payments);
  const due_on = addBusinessDays(s.credited_on, 1, cal); const on_time = s.swept_on <= due_on;
  const rule = "6.1 rule 4 (F-1-03 servicing-fee split)";
  const posting: PostingSet = { description: `sweep clearing credit ${s.credit_id} to ${s.custodial_account_id}`, effective_on: s.swept_on, lines: [
    { account: `custodial_pi_cash:${s.custodial_account_id}`, amount_cents: computation.sweep_cents, rule_ref: rule },
    { account: "corporate_cash", amount_cents: computation.servicing_fee_cents + computation.late_charges_retained_cents, rule_ref: rule },
    { account: `clearing_cash:${s.clearing_account_id}`, amount_cents: -computation.gross_cents, rule_ref: rule },
  ] };
  const event = events.append({ type: "custodial.clearing.swept", aggregate: CLEARING_CREDIT_AGG(s.credit_id), actor, occurredAt: atNoonEt(s.swept_on), payload: { clearing_account_id: s.clearing_account_id, custodial_account_id: s.custodial_account_id, credit_id: s.credit_id, gross_cents: computation.gross_cents, servicing_fee_cents: computation.servicing_fee_cents, late_charges_retained_cents: computation.late_charges_retained_cents, amount_cents: computation.sweep_cents, credited_on: s.credited_on, swept_on: s.swept_on, due_on, on_time, per_loan: computation.per_loan.map((l) => ({ ...l })) } });
  return { computation, posting, on_time, due_on, event };
}

// ============================================================ Form 629 custodial evidence (FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE)
/** Facts for evaluator `6.1.activeAccountsForEveryRemittanceType`: every remittance type in the transfer file needs an `active` P&I account and an `active` T&I account whose Form 1014 lists it. */
export function custodialEvidenceFacts(i: { transfer_remittance_types: readonly AccountUse[]; accounts: readonly { kind: AccountKind; status: AccountStatus; remittance_type?: AccountUse | null; remittance_types?: readonly AccountUse[] }[] }): { remittance_types: AccountUse[]; active_pi_account_types: AccountUse[]; active_ti_account_types: AccountUse[] } {
  const active = i.accounts.filter((a) => a.status === "active");
  return { remittance_types: [...new Set(i.transfer_remittance_types)], active_pi_account_types: [...new Set(active.filter((a) => a.kind === "pi" && a.remittance_type).map((a) => a.remittance_type!))], active_ti_account_types: [...new Set(active.filter((a) => a.kind === "ti").flatMap((a) => [...(a.remittance_types ?? [])]))] };
}
/** Form 629 (1.2) needs custodial evidence ≥ 30 days before the transfer date, so the accounts must be `active` by then. */
export function custodialEvidenceDueOn(transferDate: PlainDate): PlainDate { return addDays(transferDate, -30); }
