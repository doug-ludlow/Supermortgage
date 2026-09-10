/**
 * §6 tools — custodial account management (6.1–6.5). Tool strings verbatim
 * from the Agents paragraphs; guardrails encode the "cannot"/"never"
 * sentences and the ledger's allowed-transfer matrix (evaluated on the
 * accounts an entry set touches). Agent: `custodial-recon` throughout.
 *
 * 6.4's paragraph names `escrow.read_trial_balance`, `suspense.read`,
 * `loss_draft.read`, `positive_pay.read/void`, `ledger.post_advance`
 * (corporate → T&I only) and `form496a.generate`; spec/registry/agents.json
 * extracted an empty list for 6.4, and the bus test requires every registered
 * tool to be one the registry names. The 6.4 tools are therefore defined here
 * in full (`SECTION_06_4_TOOLS`) and join the bus the moment the registry row
 * carries them — until then they are exercised directly in 6-4.spec.test.ts.
 *
 * Every handler emits the domain events the §6 timer rows are satisfied by:
 * `suspense.item.created/status_changed/matched/closed`,
 * `reconciliation_item.opened/resolved`, `custodial.reconciliation.drafted/
 * completed`, `custodial.shortage.funded`, `custodial.advance.funded`,
 * `disbursement.voided`, `custodial.depository.fnma_notified` and
 * `ledger.period.closed{recon_due_on}` (the computed 45-day anchor).
 */
import { defineTools, read, write, history, escalate, ledgerPost, compute, never, needsRole, humanWhen, guard, cents, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { hasRole } from "../roles.ts";
import { loadAgentsFile } from "../agents.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { evaluateDepositoryEligibility, accountPlan, titleString, fdicUninsuredExposure, type Depository, type AccountUse } from "../../domain/custodial/accounts.ts";
import { draftVariance, tiCompositionSnapshot, lossDraftAgedMonths, staleCheckWorkflow, reconWriteOff, isStaleCheck, type SectionI, type FormTemplate, type EscrowTrialBalanceRow, type LossDraftRow } from "../../domain/custodial/reconciliation.ts";
import { identify, isSuspenseTerminal, suspenseWriteOff, type Receipt, type CandidateLoan } from "../../domain/custodial/suspense.ts";
import { crsAaRequest } from "../../domain/investor/remittance.ts";
import { ingestStatement, unidentifiedDebit, generateCustodialForm, periodClosedEvent, tiTransferMatrixViolation, advanceDirectionViolation, paidNotIssued, type Section3Item, type CustodialFormInput } from "../../domain/custodial/ops.ts";
import { interestDisbursedIfSettled } from "../../domain/custodial/ops-6-2.ts";
import { restoreVoidedCheckFunds } from "../../domain/custodial/ops-6-4.ts";
import { bankReadStatement63, timerOps63, documentsWrite63, afterReclass63, DRAFT_VARIANCE_SIGN } from "./section6-3.ts";
import { timerOps65 } from "./section6-5.ts";
import { CommandRefused } from "../commands.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const ALLOWLISTED_CHANNELS = new Set(["cbam", "depository", "partner"]);
const TI_ALLOWED_DESTINATIONS = /^(custodial_ti_|corporate_interest_fee$|refund_destination_verified$|approved_disbursement_payee$)/;
const RECLASS_ACCOUNTS = /(custodial_.*corporate_reimbursement|corporate_reimbursement|corporate_cash|corporate_bank_fee|suspense|shortage_surplus|in_transit|fnma_shortage_surplus|interest_due_corporate|custodial_pi_cash|custodial_ti)/;
const FNMA_CUSTODIAL_TEAM = "custodial_account@fanniemae.com";

const documentsWrite: Omit<ToolDef, "process" | "agent"> = { name: "documents.write", kind: "write", handler: write("documents", "document.written") };
const escalationCreate: Omit<ToolDef, "process" | "agent"> = { name: "escalation.create", kind: "act", handler: escalate("officer") };
type EntrySetLike = Parameters<typeof tiTransferMatrixViolation>[0];
const entrySet = (i: ToolInput): EntrySetLike => i.entry_set as EntrySetLike;

// ---- 6.1 Form 1013 ---------------------------------------------------------
// The 6.1 tools (depository.evaluate, fdic.lookup, ratings.read, custodial.plan_accounts, cbam.prepare_package,
// documents.write, escalation.create, timer.start/satisfy, email.send) are defined in ./section6-1.ts (TOOLS_6_1),
// routed through src/domain/custodial/ops-6-1.ts so every 6.1 timer row is armed and satisfied by a real act.

// ---- 6.2 Form 1014 ---------------------------------------------------------
const p62 = defineTools("6.2", "custodial-recon", [
  { name: "ledger.post", kind: "write", handler: compute((i, ctx) => { const set = ledgerPost()(i, ctx);
      // 6.2 timer table: FNMA_A4102_TI_INTEREST_DISBURSE_30 is satisfied when all of the credit has moved out (borrower allocations posted and/or corporate sweep) —
      // proven from the ledger's interest-pending balance for the account after this posting (ops-6-2 interestDisbursedIfSettled), never from a caller's flag.
      if (str(i, "interest_credit_id")) interestDisbursedIfSettled({ events: ctx.events, ledger: ctx.ledger, actor: ctx.actor, now: ctx.now }, { interest_credit_id: str(i, "interest_credit_id"), custodial_account_id: str(i, "custodial_account_id") || null, entry_set: entrySet(i), posted_on: D((set as { effectiveDate: string }).effectiveDate) });
      return set; }), moneyFields: ["entry_set"],
    guardrails: [never("NO_BORROWER_TO_BORROWER_ESCROW", "6.4 guardrail: the agent cannot move funds between borrowers' escrow balances; only corporate ↔ T&I and T&I → payee/borrower transfers exist in the matrix", (i) => /between borrowers/.test(tiTransferMatrixViolation(entrySet(i)) ?? ""), "no borrower's escrow funds another borrower"),
      never("TI_ALLOWED_TRANSFER_MATRIX", "6.2 guardrail: T&I funds move only to custodial_ti_*, a borrower's verified refund destination, a payee on an approved disbursement, or the corporate interest/fee account — enforced by the ledger's allowed-transfer matrix on the accounts the entry set touches", (i) => tiTransferMatrixViolation(entrySet(i)) !== undefined || (typeof i.ti_destination === "string" && !TI_ALLOWED_DESTINATIONS.test(str(i, "ti_destination"))), "destination is outside the allowed-transfer matrix"),
      needsRole("CORPORATE_SWEEP_10K", "6.2 escalations: any sweep to corporate above $10,000 per credit → officer", (i) => (str(i, "ti_destination") === "corporate_interest_fee" || flag(i, "corporate_sweep")) && cents(i.amount_cents) > 1_000_000n, ["officer"], "sweeps above $10,000 per credit need an officer"),
      needsRole("CORPORATE_FUNDS_SHORTFALL", "6.2 escalations: interest disposition when to_borrowers > I − E (corporate must fund) → officer", (i) => flag(i, "corporate_funds_shortfall"), ["officer"], "corporate funding of the statutory-interest shortfall is an officer decision")] },
  { name: "escrow.read_balances", kind: "read", handler: compute((i, _c, rt) => rt.store.list("escrow_accounts", (d) => !i.loan_id || d.loan_id === i.loan_id).map((r) => ({ id: r.id, loan_id: r.data.loan_id, balance_cents: r.data.balance_cents ?? 0n }))) },
  { name: "jurisdiction.read", kind: "read", handler: compute((i, _c, rt) => { need(i, "state"); return rt.store.get("jurisdiction_rules", str(i, "state"))?.data ?? null; }) },
]);

// ---- 6.3 / 6.4 shared: the form generator stores the workbook and PDF (hashed) and emits drafted/completed ----
const generateForm = (kindDefault: CustodialFormInput["kind"]) => compute((i, ctx, rt) => {
  const s = i.section_i as SectionI | undefined; if (!s) throw new RangeError("section_i is required");
  const composition = i.composition as Record<string, bigint> | undefined; if (!composition) throw new RangeError("composition is required");
  const kind = (kindDefault === "496a" ? "496a" : (str(i, "kind") || kindDefault)) as CustodialFormInput["kind"];
  const period = str(i, "period"); const accountId = str(i, "custodial_account_id") || str(i, "account_id") || "unknown";
  const g = generateCustodialForm({ kind, period, custodial_account_id: accountId, section_i: s, cashbook_cents: cents(i.cashbook_cents), composition, section_iii: Array.isArray(i.section_iii) ? (i.section_iii as Section3Item[]) : [],
    ...(i.template ? { template: i.template as FormTemplate } : {}), ...(typeof i.servicer_number === "string" ? { servicer_number: i.servicer_number } : {}), ...(typeof i.remittance_type === "string" ? { remittance_type: i.remittance_type } : {}),
    aa_autodraft_on: flag(i, "aa_autodraft_on"), preparer_run_id: str(i, "preparer_run_id") || ctx.actor.id, posting_run_ids: Array.isArray(i.posting_run_ids) ? (i.posting_run_ids as string[]) : [],
    human_approval_on: flag(i, "human_approval_on"), officer_approval_id: str(i, "officer_approval_id") || null, complete: flag(i, "complete"),
    attestation: i.attestation ? (i.attestation as NonNullable<CustodialFormInput["attestation"]>) : null });
  const id = str(i, "id") || `${g.form_kind === "monthly_form_496a" ? "f496a" : "f496"}-${accountId}-${period}`;
  const xlsx = rt.store.put("documents", `${id}.xlsx`, { kind: `${g.form_kind}_xlsx`, reconciliation_id: id, sha256: g.xlsx_sha256, template_sha256: g.workbook.template_sha256, cells: g.workbook.cells, content: g.workbook.xlsx.content, retention: "life_of_loan_plus_4y" }, ctx.actor, ctx.now);
  const pdf = rt.store.put("documents", `${id}.pdf`, { kind: `${g.form_kind}_pdf`, reconciliation_id: id, sha256: g.pdf_sha256, text: g.workbook.pdf.text, retention: "life_of_loan_plus_4y" }, ctx.actor, ctx.now);
  const rec = rt.store.put("custodial_reconciliations", id, { kind: g.form_kind, period, custodial_account_id: accountId, status: g.status, total_cents: g.total_cents, lines: g.lines, adjusted_bank_cents: g.adjusted_depository_cents, cashbook_cents: cents(i.cashbook_cents), difference_cents: g.difference_cents, review: g.review, generated_document_id: xlsx.id, rendered_document_id: pdf.id, xlsx_sha256: g.xlsx_sha256, pdf_sha256: g.pdf_sha256, attestation: g.attestation, ...(g.status === "completed" ? { completed_at: ctx.now } : {}) }, ctx.actor, ctx.now);
  const agg = { kind: "custodial_account", id: accountId };
  ctx.events.append({ type: "custodial.reconciliation.drafted", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { kind: g.form_kind, period, reconciliation_id: rec.id, status: g.status } });
  if (g.status === "completed") ctx.events.append({ type: "custodial.reconciliation.completed", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { kind: g.form_kind, period, reconciliation_id: rec.id, xlsx_sha256: g.xlsx_sha256, pdf_sha256: g.pdf_sha256 } });
  return { id: rec.id, form_kind: g.form_kind, status: g.status, total_cents: g.total_cents, lines: g.lines, adjusted_depository_cents: g.adjusted_depository_cents, difference_cents: g.difference_cents, review: g.review, attestation: g.attestation, generated_document_id: xlsx.id, rendered_document_id: pdf.id, xlsx_sha256: g.xlsx_sha256, pdf_sha256: g.pdf_sha256, cells: g.workbook.cells, missing_fields: g.workbook.missing_fields, events: g.events };
});

// ---- 6.3 Form 496 ----------------------------------------------------------
const p63 = defineTools("6.3", "custodial-recon", [
  // 6.3 rule 1 / rule 2 (iv) / draft coverage — ./section6-3.ts (ops-6-3: receiveStatement, classifyResiduals, confirmDraftCoverage)
  { name: "bank.read_statement", kind: "write", handler: bankReadStatement63 },
  { name: "ledger.read", kind: "read", handler: read("ledger_accounts") },
  { name: "ledger.post_reclass", kind: "write", handler: compute((i, ctx) => { const set = ledgerPost()(i, ctx);
      const itemId = str(i, "reconciliation_item_id"); const status = str(i, "item_status") || "posted";
      // 6.3 timer table: SM_RECON_ITEM_AGE_* are satisfied by the item's `cleared`/`posted`/`funded`; SM_CUSTODIAL_SHORTAGE_FUND_2BD by `custodial.shortage.funded`.
      // the item is its own aggregate (ops-6-3 ITEM_AGG): the AGE_30/60/90 clocks opened on `reconciliation_item.opened` for that item are the ones this resolves.
      if (itemId) ctx.events.append({ type: "reconciliation_item.resolved", loanId: ctx.loanId, aggregate: { kind: "reconciliation_item", id: itemId }, actor: ctx.actor, payload: { item_id: itemId, status, root_cause: str(i, "root_cause"), evidence_refs: i.evidence_refs, resolved_on: ctx.now.slice(0, 10) } });
      if (status === "funded" || str(i, "reason") === "shortage_funding") ctx.events.append({ type: "custodial.shortage.funded", loanId: ctx.loanId, ...(i.aggregate ? { aggregate: i.aggregate as { kind: string; id: string } } : {}), actor: ctx.actor, payload: { item_id: itemId || null, amount_cents: cents(i.amount_cents), approval_tier: str(i, "approval_tier") || null } });
      afterReclass63(i, ctx, set);   // `surplus_id` → `fnma.shortage_surplus.explained` (FNMA_IRM102_SURPLUS_UNEXPLAINED_90)
      return set; }), moneyFields: ["entry_set"],
    guardrails: [DRAFT_VARIANCE_SIGN, never("RECLASS_SCOPE", "6.3 agent design: `ledger.post_reclass` is restricted to custodial ↔ corporate reimbursement, suspense, shortage/surplus and in-transit accounts", (i) => { const s = i.entry_set as { lines?: { account?: { account?: string } }[] } | undefined; return !!s?.lines?.length && !s.lines.every((l) => RECLASS_ACCOUNTS.test(String(l.account?.account ?? ""))); }, "a reclass may touch only reimbursement, suspense, shortage/surplus and in-transit accounts"),
      never("NO_PLUG", "6.3 agent design: never posts a balancing plug — every posting carries a root cause", (i) => flag(i, "plug") || /^(plug|balancing|unexplained|)$/i.test(str(i, "root_cause").trim()), "unexplained differences stay open with a research task"),
      never("EVIDENCE_AND_CONFIDENCE", "6.3 agent design: posts only when confidence ≥ 0.95 and both sides carry documentary evidence", (i) => !(typeof i.confidence === "number" && i.confidence >= 0.95 && Array.isArray(i.evidence_refs) && (i.evidence_refs as unknown[]).length >= 2), "auto-post needs confidence ≥ 0.95 and evidence on both sides"),
      guard("RECON_WRITE_OFF_25", "6.3 rule 5: write-offs need `officer` sign-off (≤ $25.00 rounding class only)", (i, ctx) => { if (str(i, "item_status") !== "written_off") return undefined; const r = reconWriteOff({ amount_cents: cents(i.amount_cents), actor_is_officer: hasRole(ctx.actor, ["officer"]), reason: str(i, "root_cause") }); return r.allowed ? undefined : r.refusal ?? "write-off refused"; })] },
  { name: "fnma.read_cash_position", kind: "read", handler: compute((i, _c, rt) => rt.store.list("fnma_cash_position", (d) => !i.period || d.period === i.period).map((r) => ({ id: r.id, ...r.data }))) },
  { name: "fnma.read_draft_notifications", kind: "read", handler: compute((i, _c, rt) => { const notes = rt.store.list("draft_notifications", (d) => !i.period || d.period === i.period).map((r) => ({ id: r.id, ...r.data }));
      if (i.expected_cents !== undefined && i.bank_debit_cents !== undefined) return { notifications: notes, variance: draftVariance(cents(i.expected_cents), cents(i.bank_debit_cents), Array.isArray(i.adjustments) ? (i.adjustments as { loan: string; amount_cents: bigint; reason: string }[]) : []) };
      return { notifications: notes }; }) },
  { name: "crs.prepare_batch", kind: "write", handler: compute((i) => { need(i, "today"); const r = crsAaRequest(cents(i.amount_cents), date(i, "today"), flag(i, "last_work_day_of_month")); return { ...r, reason: str(i, "reason") || "shortage_remit_1bd", portal_task_role: "fnma_portal_operator" }; }) },
  { name: "form496.generate", kind: "write", handler: generateForm("ss") },
  { ...documentsWrite, handler: documentsWrite63 },   // `kind=fnma_remittance_pi_detail` → `fnma.remittance_detail.report_received` (line 9 source)
  escalationCreate,
  // `close_period` (month-end cut-off: `ledger.period.closed` with the computed day-45 anchor + `period.opened` remittance schedule) and `close_day` (17:00 daily three-way close) — ./section6-3.ts
  { name: "timer.*", kind: "act", handler: timerOps63 },
  { name: "partner.notify", kind: "act", handler: compute((i, ctx) => { need(i, "reason"); ctx.events.append({ type: "partner.notified", loanId: ctx.loanId, actor: ctx.actor, payload: { reason: str(i, "reason"), amount_cents: cents(i.amount_cents) } }); return { notified: true, reason: str(i, "reason") }; }),
    guardrails: [never("PARTNER_NOTICE_SCOPE", "6.3 escalations: partner treasury is notified for > $25,000 shortages, breaches and unauthorized debits", (i) => !["shortage_over_25k", "breach", "unauthorized_debit", "nsf_draft"].includes(str(i, "reason")) && !flag(i, "officer_directed"), "partner notices are for > $25,000 shortages, breaches and unauthorized debits")] },
]);

// ---- 6.4 Form 496A ---------------------------------------------------------
const VOID_REASONS = new Set(["stale", "reissue", "escheat", "paid_not_issued", "returned_refund"]);
const p64 = defineTools("6.4", "custodial-recon", [
  { name: "escrow.read_trial_balance", kind: "read", handler: compute((i, _c, rt) => {
      const accounts = (Array.isArray(i.escrow_accounts) ? (i.escrow_accounts as EscrowTrialBalanceRow[]) : rt.store.list("escrow_accounts").map((r) => ({ loan_id: String(r.data.loan_id ?? r.id), balance_cents: cents(r.data.balance_cents), contractual_payment_cents: cents(r.data.contractual_payment_cents), ...(r.data.category === "renovation" ? { category: "renovation" as const } : {}) })));
      const drafts = Array.isArray(i.loss_drafts) ? (i.loss_drafts as LossDraftRow[]) : rt.store.list("loss_drafts", (d) => d.status !== "disbursed").map((r) => ({ loan_id: String(r.data.loan_id ?? ""), amount_cents: cents(r.data.amount_cents), received_on: D(String(r.data.received_on ?? "1970-01-01")), explanation: (r.data.explanation as string | undefined) ?? null }));
      const periodEnd = str(i, "period_end"); if (!periodEnd) return { accounts, snapshot: null };
      return { accounts, snapshot: tiCompositionSnapshot({ period_end: D(periodEnd), escrow_accounts: accounts, loss_drafts: drafts, buydown_cents: cents(i.buydown_cents), unapplied_cents: cents(i.unapplied_cents), advances_funded_cents: i.advances_funded_cents === undefined ? accounts.reduce((s, a) => s + (a.balance_cents < 0n ? -a.balance_cents : 0n), 0n) : cents(i.advances_funded_cents), interest_pending_cents: cents(i.interest_pending_cents), other_cents: cents(i.other_cents) }) }; }) },
  { name: "suspense.read", kind: "read", handler: read("suspense_items") },
  { name: "loss_draft.read", kind: "read", handler: compute((i, ctx, rt) => { const asOf = D(str(i, "as_of") || ctx.now.slice(0, 10));
      return rt.store.list("loss_drafts", (d) => (!i.loan_id || d.loan_id === i.loan_id)).map((r) => { const months = lossDraftAgedMonths(D(String(r.data.received_on ?? asOf)), asOf); return { id: r.id, ...r.data, age_months: months, aged_7m: months >= 7, explanation_required: months >= 7 && r.data.status !== "disbursed" }; }); }) },
  { name: "positive_pay.read/void", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "paid_file") {
        // the bank's paid file: paid checks clear (`disbursement.cleared` → SM_TI_OUTSTANDING_CHECK_90 / SM_STALE_CHECK_180); a paid check with no issued record is 6.4-T7's critical exception, `fraud` case and bank claim within 1 BD.
        const paid = rows<{ check_number: string; amount_cents: bigint; paid_on: string }>(i, "paid");
        const issued = rt.store.list("outstanding_checks").map((r) => ({ check_number: String(r.data.check_number ?? r.id), amount_cents: cents(r.data.amount_cents) }));
        const x = paidNotIssued({ paid: paid.map((p) => ({ check_number: p.check_number, amount_cents: cents(p.amount_cents), paid_on: D(p.paid_on) })), issued });
        const cleared: string[] = [];
        for (const p of paid) { if (x.exceptions.some((e) => e.check_number === p.check_number)) continue; const rec = rt.store.get("outstanding_checks", p.check_number); rt.store.put("outstanding_checks", p.check_number, { ...(rec?.data ?? {}), check_number: p.check_number, status: "paid", paid_on: p.paid_on, positive_pay_status: "paid_matched" }, ctx.actor, ctx.now); cleared.push(p.check_number);
          const agg = { kind: "disbursement", id: p.check_number };
          ctx.events.append({ type: "disbursement.cleared", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { check_number: p.check_number, paid_on: p.paid_on } });
          ctx.events.append({ type: "disbursement.closed", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { check_number: p.check_number, status: "cleared", paid_on: p.paid_on } }); }
        for (const e of x.exceptions) { rt.escalations.open({ kind: "fraud_officer", severity: "critical", payload: { check_number: e.check_number, amount_cents: e.amount_cents, exception: "paid_not_issued", bank_claim_by: e.bank_claim_by, fraud_case: true } }, ctx.actor); ctx.events.append({ type: "reconciliation_item.opened", loanId: ctx.loanId, aggregate: { kind: "disbursement", id: e.check_number }, actor: ctx.actor, payload: { category: "bank_debit_unposted", kind: "paid_not_issued", severity: "critical", amount_cents: e.amount_cents, bank_claim_by: e.bank_claim_by } }); }
        return { cleared, exceptions: x.exceptions };
      }
      if (i.op !== "void") return rt.store.list("outstanding_checks", (d) => (!i.status || d.status === i.status) && (!i.custodial_account_id || d.custodial_account_id === i.custodial_account_id)).map((r) => ({ id: r.id, ...r.data, stale: isStaleCheck(D(String(r.data.issued_on ?? ctx.now.slice(0, 10))), D(ctx.now.slice(0, 10))) }));
      need(i, "check_number", "reason");
      const rec = rt.store.get("outstanding_checks", str(i, "check_number"));
      const issuedOn = D(str(i, "issued_on") || String(rec?.data.issued_on ?? ctx.now.slice(0, 10)));
      const w = staleCheckWorkflow({ check_number: str(i, "check_number"), payee: str(i, "payee") || String(rec?.data.payee ?? ""), issued_on: issuedOn, amount_cents: cents(i.amount_cents ?? rec?.data.amount_cents), as_of: D(ctx.now.slice(0, 10)), originating_balance: (str(i, "originating_balance") || "refund_payable") as "refund_payable" | "escrow" | "loss_draft_liability", custodial_account_id: str(i, "custodial_account_id") || String(rec?.data.custodial_account_id ?? "unknown"), payee_confirmed: flag(i, "payee_confirmed") });
      const put = rt.store.put("outstanding_checks", str(i, "check_number"), { ...(rec?.data ?? {}), check_number: str(i, "check_number"), status: "voided", voided_on: ctx.now.slice(0, 10), void_reason: str(i, "reason"), positive_pay_status: "void_sent", next: w.next ?? str(i, "reason") }, ctx.actor, ctx.now);
      const agg = { kind: "disbursement", id: str(i, "check_number") };
      ctx.events.append({ type: "positive_pay.void_sent", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { check_number: str(i, "check_number"), reason: str(i, "reason") } });
      // 6.4 timer table: SM_STALE_CHECK_180 is satisfied by `disbursement.cleared` or `disbursement.voided`.
      ctx.events.append({ type: "disbursement.voided", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { check_number: str(i, "check_number"), reason: str(i, "reason"), restore_to: w.restore_entry ? (str(i, "originating_balance") || "refund_payable") : null, next: w.next } });
      ctx.events.append({ type: "disbursement.closed", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, payload: { check_number: str(i, "check_number"), status: "voided", reason: str(i, "reason") } });
      // 6.4-T4: funds restored to the originating balance on the ledger and the 6.5 unclaimed-property row opened (ops-6-4 restoreVoidedCheckFunds)
      const restored = w.stale || w.next ? restoreVoidedCheckFunds({ events: ctx.events, ledger: ctx.ledger, actor: ctx.actor, now: ctx.now, store: rt.store }, { check_number: str(i, "check_number"), amount_cents: cents(i.amount_cents ?? rec?.data.amount_cents), custodial_account_id: str(i, "custodial_account_id") || String(rec?.data.custodial_account_id ?? "unknown"), loan_id: str(i, "loan_id") || (typeof rec?.data.loan_id === "string" ? rec.data.loan_id : null), originating_balance: (str(i, "originating_balance") || "refund_payable") as "refund_payable" | "escrow" | "loss_draft_liability", issued_on: issuedOn, next: w.next, suspense_item: w.suspense_item }) : null;
      return { ...put.data, restore_entry: w.restore_entry, suspense_item: w.suspense_item, next: w.next, ledger_entry_id: restored?.restore_entry?.id ?? null, suspense_item_id: restored?.suspense_item_id ?? null }; }),
    guardrails: [never("VOID_REASON", "6.4 rule 3: voids go through positive pay only for stale/reissue/escheat/paid-not-issued items", (i) => i.op === "void" && !VOID_REASONS.has(str(i, "reason")), "a void needs one of: stale, reissue, escheat, paid_not_issued, returned_refund")] },
  { name: "ledger.post_advance", kind: "write", handler: compute((i, ctx) => { const set = ledgerPost()(i, ctx);
      const lines = (entrySet(i)?.lines ?? []); const amount = lines.filter((l) => l.account.scope === "custodial").reduce((s, l) => s + l.amountCents, 0n);
      // 6.4 timer table: SM_TI_ESCROW_ADVANCE_FUND_1BD is satisfied by `custodial.advance.funded`.
      ctx.events.append({ type: "custodial.advance.funded", loanId: ctx.loanId, ...(i.aggregate ? { aggregate: i.aggregate as { kind: string; id: string } } : {}), actor: ctx.actor, payload: { amount_cents: amount, loans: Array.isArray(i.loans) ? i.loans : [], reconciliation_item_id: str(i, "reconciliation_item_id") || null } });
      if (str(i, "reconciliation_item_id")) ctx.events.append({ type: "reconciliation_item.resolved", loanId: ctx.loanId, actor: ctx.actor, payload: { item_id: str(i, "reconciliation_item_id"), status: "funded" } });
      return set; }), moneyFields: ["entry_set"],
    guardrails: [never("CORPORATE_TO_TI_ONLY", "6.4 agent design: `ledger.post_advance` (corporate → T&I only); the agent cannot move funds between borrowers' escrow balances", (i) => advanceDirectionViolation(entrySet(i)) !== undefined, "an advance is a corporate → T&I transfer and nothing else"),
      needsRole("ADVANCE_TIER_25K", "6.4 escalations: funding tiers as 6.3 — above $25,000 needs the officer (and the partner is notified)", (i) => (entrySet(i)?.lines ?? []).filter((l) => l.account.scope === "custodial").reduce((s, l) => s + l.amountCents, 0n) > 2_500_000n, ["officer"], "advances above $25,000 need an officer")] },
  { name: "form496a.generate", kind: "write", handler: generateForm("496a") },
]);
/** 6.4's tools register on the bus when spec/registry/agents.json names them for 6.4 (today the extractor left the row empty). */
const registry64 = new Set(loadAgentsFile().processes.find((p) => p.process === "6.4")?.tools ?? []);
export const SECTION_06_4_TOOLS: readonly ToolDef[] = p64;

// ---- 6.5 suspense ----------------------------------------------------------
const MATCHED_STATUSES = new Set(["matched_pending", "applied"]);
/** Every status change on the register is an event the 6.5 timers are armed by / satisfied with. */
function emitSuspenseTransition(ctx: Parameters<ReturnType<typeof compute>>[1], id: string, prev: Record<string, unknown> | undefined, next: Record<string, unknown>): void {
  const loanId = (next.loan_id as string | undefined) ?? undefined;
  const base = { ...(loanId ? { loanId } : {}), aggregate: { kind: "suspense_item", id }, actor: ctx.actor };
  const status = String(next.status ?? "open");
  if (!prev) ctx.events.append({ type: "suspense.item.created", ...base, payload: { id, status, reason_code: next.reason_code ?? null, source: next.source ?? null, amount_cents: next.amount_cents ?? null, received_on: next.received_on ?? null, loan_id: loanId ?? null } });
  if (prev && String(prev.status ?? "open") === status) return;
  if (prev || status !== "open") ctx.events.append({ type: "suspense.item.status_changed", ...base, payload: { id, status, from: prev ? String(prev.status ?? "open") : null, loan_id: loanId ?? null, credited_as_of: next.credited_as_of ?? null } });
  if (MATCHED_STATUSES.has(status) && loanId) ctx.events.append({ type: "suspense.item.matched", ...base, payload: { id, status, loan_id: loanId } });
  if (isSuspenseTerminal(status)) ctx.events.append({ type: "suspense.item.closed", ...base, payload: { id, status, loan_id: loanId ?? null, resolved_on: ctx.now.slice(0, 10) } });
}
const suspenseReadWrite = compute((i, ctx, rt) => {
  if (i.op !== "write") return read("suspense_items")(i, ctx, rt);
  const id = typeof i.id === "string" ? i.id : `suspense_items-${rt.store.list("suspense_items").length + 1}`;
  const prev = rt.store.get("suspense_items", id);
  // money field on the register: the bus checks `changes` only, so a rewrite of `amount_cents` through `data` is held to the same officer-only rule
  if (prev && "amount_cents" in data(i) && cents(data(i).amount_cents) !== cents(prev.data.amount_cents) && !hasRole(ctx.actor, ["officer"])) refuse65(ctx, "suspense.read/write", "MONEY_FIELD", "1.1 guardrail: money fields are never agent-corrected (6.5 actors: `officer` for write-offs and unusual returns)", `amount_cents ${String(prev.data.amount_cents)} → ${String(data(i).amount_cents)} on ${id} requires an officer waiver`, id);
  const rec = rt.store.put("suspense_items", id, { ...data(i), ...((i.changes as Record<string, unknown> | undefined) ?? {}) }, ctx.actor, ctx.now);
  ctx.events.append({ type: "suspense.item.written", ...(rec.data.loan_id ? { loanId: String(rec.data.loan_id) } : {}), aggregate: { kind: "suspense_item", id }, actor: ctx.actor, payload: { id, version: rec.version, fields: Object.keys(data(i)), status: rec.data.status ?? null } });
  emitSuspenseTransition(ctx, id, prev?.data, rec.data);
  if (rec.data.status === "written_off") rt.store.put("suspense_actions", `${id}-written_off-${rec.version}`, { suspense_item_id: id, action: "written_off", payload: { amount_cents: rec.data.amount_cents ?? null, reason: str(i, "reason") || null }, actor: `${ctx.actor.kind}:${ctx.actor.id}`, at: ctx.now }, ctx.actor, ctx.now);
  return rec.data;
});
/** A handler-side refusal (the bus's guardrails cannot see the entity store): the same `command.refused` row the bus writes, then the typed error. */
const refuse65 = (ctx: Parameters<ReturnType<typeof compute>>[1], command: string, code: string, citation: string, reason: string, subjectId?: string): never => {
  ctx.events.append({ type: "command.refused", ...(ctx.loanId ? { loanId: ctx.loanId } : {}), actor: ctx.actor, payload: { command, code, citation, reason, subject_id: subjectId ?? null } });
  throw new CommandRefused(command, code, citation, reason);
};
/** 6.5 state machine: an overpayment / post-payoff / duplicate receipt leaving T&I is a refund to the borrower (`refunded`, SM_OVERPAYMENT_REFUND_10BD); every other return rail outcome is `returned`. */
const REFUND_REASONS = new Set(["overpayment", "post_payoff_receipt", "duplicate_payment"]);
const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/**
 * 6.5 guardrail "no return of funds to a payer that is not the verified originator/remitter": beyond the caller's assertion, the
 * destination is compared with what the register recorded for the item — the originating account's last4 (`payer_account_last4`
 * / `originating_account_last4`) for an ACH credit, the remitter's `payer_name` (from the image) for a refund check.
 */
const assertReturnDestination = (ctx: Parameters<ReturnType<typeof compute>>[1], rt: Parameters<ReturnType<typeof compute>>[2], i: ToolInput, rail: "ach_credit" | "check"): void => {
  const itemId = str(i, "suspense_item_id"); if (!itemId) return;
  const item = rt.store.get("suspense_items", itemId)?.data; if (!item) return;
  if (rail === "ach_credit") {
    const recorded = String(item.payer_account_last4 ?? item.originating_account_last4 ?? "");
    if (recorded && recorded !== str(i, "destination_last4")) refuse65(ctx, "nacha.originate_credit", "RETURN_TO_ORIGINATOR_ONLY", "6.5 guardrail: no return of funds to a payer that is not the verified originator/remitter", `destination …${str(i, "destination_last4")} is not the item's originating account …${recorded}`, itemId);
  } else {
    const recorded = String(item.payer_name ?? "");
    if (recorded && !normName(str(i, "payee")).includes(normName(recorded))) refuse65(ctx, "check.issue", "REMITTER_ONLY", "6.5 guardrail: no return of funds to a payer that is not the verified originator/remitter", `payee "${str(i, "payee")}" is not the item's remitter "${recorded}"`, itemId);
  }
};
/** A return rail run against a register item moves it to `returned` / `refunded` (terminal) and records the `suspense_actions` row; returns the outcome. */
const returnItem = (ctx: Parameters<ReturnType<typeof compute>>[1], rt: Parameters<ReturnType<typeof compute>>[2], i: ToolInput, rail: "ach_credit" | "check", payload: Record<string, unknown>): "returned" | "refunded" | null => {
  const itemId = str(i, "suspense_item_id"); if (!itemId) return null;
  const prev = rt.store.get("suspense_items", itemId);
  const status = REFUND_REASONS.has(String(prev?.data.reason_code ?? "")) ? "refunded" : "returned";
  const rec = rt.store.put("suspense_items", itemId, { ...(prev?.data ?? {}), status, resolved_on: ctx.now.slice(0, 10), return_rail: rail }, ctx.actor, ctx.now);
  rt.store.put("suspense_actions", `${itemId}-${status === "refunded" ? "refund_issued" : "return_initiated"}-${rec.version}`, { suspense_item_id: itemId, action: status === "refunded" ? "refund_issued" : "return_initiated", payload: { rail, ...payload }, actor: `${ctx.actor.kind}:${ctx.actor.id}`, at: ctx.now }, ctx.actor, ctx.now);
  emitSuspenseTransition(ctx, itemId, prev?.data ?? { status: "open" }, rec.data);
  return status;
};
const p65 = defineTools("6.5", "custodial-recon", [
  { name: "suspense.read/write", kind: "write", moneyFields: ["amount_cents"], handler: suspenseReadWrite,
    guardrails: [guard("NO_WRITE_OFF_OVER_500", "6.5 guardrail: no write-off above $5.00; `written_off` only by `officer` (state machine) — above the limit the officer overrides with a reason (6.5-T10)", (i, ctx) => { if (i.op !== "write" || data(i).status !== "written_off") return undefined; const r = suspenseWriteOff({ amount_cents: cents(data(i).amount_cents), actor_is_officer: hasRole(ctx.actor, ["officer"]), override_reason: str(i, "reason") || str(data(i), "write_off_reason") }); return r.allowed ? undefined : r.refusal ?? "write-off refused"; })] },
  { name: "payments.history", kind: "read", handler: history("payments") },
  { name: "borrowers.search", kind: "read", handler: compute((i) => { const r = i.receipt as Receipt | undefined; if (!r) throw new RangeError("receipt is required"); return identify(r, rows<CandidateLoan>(i, "candidates")); }) },
  { name: "lockbox.image_ocr", kind: "read", handler: compute((i, _c, rt) => { need(i, "image_id"); const img = rt.store.get("lockbox_images", str(i, "image_id")); return img ? { image_id: img.id, memo: img.data.memo ?? null, payer_name: img.data.payer_name ?? null, scanline_loan_number: img.data.scanline_loan_number ?? null, micr_last4: img.data.micr_last4 ?? null } : { image_id: str(i, "image_id"), unavailable: true, fallback: "data fields only; no auto-apply below threshold" }; }) },
  { name: "ledger.apply_via_cashiering", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "amount_cents");
      const itemId = str(i, "suspense_item_id");
      // 6.5 timer table: REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD is armed by `suspense.accumulation.sufficient` and satisfied by `payment.applied{credited_as_of=accumulation}` (2.1 posts it); FNMA_C1102_PARTIAL_BALANCE_30 is satisfied by the accumulation.
      if (flag(i, "accumulation_sufficient") || (i.held_cents !== undefined && i.periodic_payment_cents !== undefined && cents(i.held_cents) >= cents(i.periodic_payment_cents))) ctx.events.append({ type: "suspense.accumulation.sufficient", loanId: str(i, "loan_id"), ...(itemId ? { aggregate: { kind: "suspense_item", id: itemId } } : {}), actor: ctx.actor, payload: { suspense_item_id: itemId || null, accumulated_on: str(i, "credited_as_of") || ctx.now.slice(0, 10), held_cents: cents(i.held_cents), periodic_payment_cents: cents(i.periodic_payment_cents) } });
      const e = ctx.events.append({ type: "cashiering.apply.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), credited_as_of: str(i, "credited_as_of") || null, suspense_item_id: itemId || null, command: "2.1 payment.apply", confidence: typeof i.confidence === "number" ? i.confidence : null } });
      if (itemId) { const prev = rt.store.get("suspense_items", itemId); const rec = rt.store.put("suspense_items", itemId, { ...(prev?.data ?? {}), loan_id: str(i, "loan_id"), status: "applied", credited_as_of: str(i, "credited_as_of") || ctx.now.slice(0, 10), resolved_on: ctx.now.slice(0, 10) }, ctx.actor, ctx.now); rt.store.put("suspense_actions", `${itemId}-applied-${rec.version}`, { suspense_item_id: itemId, action: "applied", payload: { loan_id: str(i, "loan_id"), amount_cents: cents(i.amount_cents), credited_as_of: rec.data.credited_as_of }, actor: `${ctx.actor.kind}:${ctx.actor.id}`, at: ctx.now }, ctx.actor, ctx.now); emitSuspenseTransition(ctx, itemId, prev?.data ?? { status: "open" }, rec.data); }
      return e; }),
    guardrails: [never("APPLY_CONFIDENCE_097", "6.5 guardrail: no application below 0.97 without borrower confirmation", (i) => !(typeof i.confidence === "number" && i.confidence >= 0.97) && !flag(i, "borrower_confirmed"), "identification confidence below 0.97 (or not stated) needs borrower confirmation"),
      never("ACCUMULATION_RULE", "6.5 human path: humans cannot bypass Reg Z accumulation application (enforced in the ledger command)", (i) => flag(i, "accumulation_rule_bypassed"), "the accumulation rule is enforced in the ledger command")] },
  { name: "nacha.originate_credit", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => { need(i, "amount_cents", "destination_last4"); assertReturnDestination(ctx, rt, i, "ach_credit"); ctx.events.append({ type: "suspense.return.initiated", loanId: ctx.loanId, actor: ctx.actor, payload: { rail: "ach_credit", amount_cents: cents(i.amount_cents), destination_last4: str(i, "destination_last4"), suspense_item_id: str(i, "suspense_item_id") || null, notice: str(i, "notice") || null } }); const status = returnItem(ctx, rt, i, "ach_credit", { amount_cents: cents(i.amount_cents), destination_last4: str(i, "destination_last4") }); return { rail: "ach_credit", amount_cents: cents(i.amount_cents), suspense_item_status: status }; }),
    guardrails: [never("RETURN_TO_ORIGINATOR_ONLY", "6.5 guardrail: no return of funds to a payer that is not the verified originator/remitter", (i) => !flag(i, "destination_is_verified_originator"), "funds return only to the verified originating account"),
      needsRole("NON_BORROWER_RETURN_10K", "6.5 guardrail: any return > $10,000 to a non-borrower → officer", (i) => cents(i.amount_cents) > 1_000_000n && !flag(i, "destination_is_borrower"), ["officer"], "returns above $10,000 to a non-borrower need an officer")] },
  { name: "check.issue", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => { need(i, "amount_cents", "payee"); assertReturnDestination(ctx, rt, i, "check"); ctx.events.append({ type: "suspense.return.initiated", loanId: ctx.loanId, actor: ctx.actor, payload: { rail: "check", amount_cents: cents(i.amount_cents), payee: str(i, "payee"), suspense_item_id: str(i, "suspense_item_id") || null, notice: str(i, "notice") || null } }); const status = returnItem(ctx, rt, i, "check", { amount_cents: cents(i.amount_cents), payee: str(i, "payee") }); return { rail: "check", amount_cents: cents(i.amount_cents), payee: str(i, "payee"), suspense_item_status: status }; }),
    guardrails: [never("REMITTER_ONLY", "6.5 guardrail: no return of funds to a payer that is not the verified originator/remitter", (i) => !flag(i, "payee_is_verified_remitter"), "refund checks go to the verified remitter at the address on the image"),
      needsRole("NON_BORROWER_RETURN_10K", "6.5 guardrail: any return > $10,000 to a non-borrower → officer", (i) => cents(i.amount_cents) > 1_000_000n && !flag(i, "destination_is_borrower"), ["officer"], "returns above $10,000 to a non-borrower need an officer")] },
  { name: "contact.request", kind: "act", handler: escalate("human_agent"), decision: (i) => ({ action: "contact.request", rationale: str(i, "reason") || "hand-off to borrower-comms" }),
    guardrails: [never("TCPA_CONSENT_QUIET_HOURS", "6.5 guardrail: contact attempts respect consents (TCPA), quiet hours and AI disclosure", (i) => i.consent !== true || flag(i, "quiet_hours") || i.automation_disclosed !== true, "no contact without consent on file (consent=true), outside quiet hours, and with automation disclosed (automation_disclosed=true) — omitting the facts is not consent")] },
  // `unclaimed_property.compute` (compute/open/presume_abandoned/officer_task/due_diligence_notice/report): ./section6-5.ts (TOOLS_6_5)
  { name: "naupa.generate", kind: "write", handler: compute((i, ctx, rt) => { need(i, "state", "cycle"); const items = rows<{ id: string; amount_cents: bigint }>(i, "items"); const rec = rt.store.put("naupa_files", `${str(i, "state")}-${str(i, "cycle")}`, { state: str(i, "state"), cycle: str(i, "cycle"), item_count: items.length, total_cents: items.reduce((a, x) => a + x.amount_cents, 0n), officer_verification: str(i, "officer_verification_id") || null }, ctx.actor, ctx.now); return { id: rec.id, ...rec.data }; }),
    guardrails: [humanWhen("OFFICER_VERIFICATION", "6.5 rule 7: the NAUPA II file is generated per state with the officer's verification", (i) => !i.officer_verification_id, "the officer verifies the file before filing")] },
  escalationCreate,
  { name: "timer.*", kind: "act", handler: timerOps65 },   // tick_weekly_register / review_register / cycle_sweep, then list/open/arm/cancel (./section6-5.ts)
]);

export const SECTION_06_TOOLS: readonly ToolDef[] = [...p62, ...p63, ...p64.filter((t) => registry64.has(t.name)), ...p65];   // 6.1: ./section6-1.ts
