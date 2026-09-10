/**
 * §6 tools — custodial account management (6.1, 6.2, 6.3, 6.5; 6.4 names no
 * tools). Tool strings verbatim from the Agents paragraphs; guardrails encode
 * the "cannot"/"never" sentences and the allowed-transfer matrix. Agent:
 * `custodial-recon` throughout.
 */
import { defineTools, read, write, readWrite, history, escalate, ledgerPost, timerOps, compute, never, needsRole, humanWhen, cents, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { evaluateDepositoryEligibility, accountPlan, titleString, fdicUninsuredExposure, type Depository, type AccountUse } from "../../domain/custodial/accounts.ts";
import { draftVariance, form496SS, form496AA, reconcile, type SectionI } from "../../domain/custodial/reconciliation.ts";
import { identify, escheat, writeOffAllowed, type Receipt, type CandidateLoan } from "../../domain/custodial/suspense.ts";
import { crsAaRequest } from "../../domain/investor/remittance.ts";
import { ingestStatement, unidentifiedDebit, reviewerRun, type Section3Item } from "../../domain/custodial/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const ALLOWLISTED_CHANNELS = new Set(["cbam", "depository", "partner"]);
const TI_ALLOWED_DESTINATIONS = /^(custodial_ti_|corporate_interest_fee$|refund_destination_verified$|approved_disbursement_payee$)/;
const RECLASS_ACCOUNTS = /(custodial_.*corporate_reimbursement|corporate_reimbursement|suspense|shortage_surplus|in_transit|fnma_shortage_surplus|interest_due_corporate)/;

const documentsWrite: Omit<ToolDef, "process" | "agent"> = { name: "documents.write", kind: "write", handler: write("documents", "document.written") };
const escalationCreate: Omit<ToolDef, "process" | "agent"> = { name: "escalation.create", kind: "act", handler: escalate("officer") };
const timers: Omit<ToolDef, "process" | "agent"> = { name: "timer.*", kind: "act", handler: timerOps() };

// ---- 6.1 Form 1013 ---------------------------------------------------------
const p61 = defineTools("6.1", "custodial-recon", [
  { name: "depository.evaluate", kind: "read", handler: compute((i) => { const d = i.depository as Depository | undefined; if (!d) throw new RangeError("depository is required"); return evaluateDepositoryEligibility(d, (str(i, "account_use") || "S/S") as AccountUse); }) },
  { name: "fdic.lookup", kind: "read", handler: compute((i, _c, rt) => { need(i, "cert"); const r = rt.store.get("depositories", str(i, "cert")); if (!r) return { found: false, insured: null, well_capitalized: null, as_of: null, stale: true };
      const ageDays = (Date.parse(str(i, "now") || new Date().toISOString()) - Date.parse(String(r.data.fdic_as_of ?? ""))) / 86_400_000;
      return { found: true, insured: r.data.insured ?? null, well_capitalized: r.data.well_capitalized ?? null, as_of: r.data.fdic_as_of ?? null, stale: !(ageDays <= 35), uninsured_exposure_cents: fdicUninsuredExposure(cents(i.balance_cents), num(i, "ownership_categories") || 1) }; }) },
  { name: "ratings.read", kind: "read", handler: read("depository_ratings") },
  { name: "custodial.plan_accounts", kind: "read", handler: compute((i) => { const plan = accountPlan(rows(i, "portfolio")); return { plan, titles: { pi: titleString(str(i, "servicer_name") || "Supermortgage", "pi"), ti: titleString(str(i, "servicer_name") || "Supermortgage", "ti") } }; }) },
  { name: "cbam.prepare_package", kind: "write", handler: compute((i, ctx, rt) => { need(i, "form_kind"); const plan = rows(i, "accounts"); const pkg = { form_kind: str(i, "form_kind"), accounts: plan, depository: i.depository ?? null, prepared_at: ctx.now, channel: str(i, "channel") || "cbam", portal_task_role: "fnma_portal_operator", signature_role: "officer" };
      const rec = rt.store.put("cbam_packages", str(i, "id") || `cbam-${ctx.now}`, pkg, ctx.actor, ctx.now); return { id: rec.id, ...pkg }; }),
    guardrails: [never("ACCOUNT_NUMBER_CHANNEL", "6.1 guardrail: the agent can never transmit an account number outside the allowlisted CBAM/depository/partner channels", (i) => typeof i.channel === "string" && !ALLOWLISTED_CHANNELS.has(str(i, "channel")), "account numbers travel only over CBAM, the depository or the partner channel")] },
  documentsWrite,
  escalationCreate,
  { name: "timer.start/satisfy", kind: "act", handler: compute((i, ctx) => { const op = str(i, "op") || "list"; if (op === "satisfy") { need(i, "event_type"); return ctx.events.append({ type: str(i, "event_type"), loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: (i.payload as Record<string, unknown> | undefined) ?? {} }); } return timerOps()({ ...i, op: op === "start" ? "arm" : op }, ctx); }),
    guardrails: [never("IN_EFFECT_NEEDS_HASH", "6.1 guardrail: cannot mark a form `in_effect` without the executed document hash", (i) => str(i, "event_type") === "custodial.form.in_effect" && !((i.payload as Record<string, unknown> | undefined)?.executed_document_hash), "custodial.form.in_effect requires executed_document_hash")] },
  { name: "email.send", kind: "act", handler: compute((i, ctx) => { need(i, "to", "subject"); ctx.events.append({ type: "email.sent", loanId: ctx.loanId, actor: ctx.actor, payload: { to: str(i, "to"), subject: str(i, "subject") } }); return { sent: true, to: str(i, "to") }; }),
    guardrails: [never("ALLOWLISTED_RECIPIENTS", "6.1 agent design: `email.send` to allowlisted recipients only", (i) => typeof i.to === "string" && !/@(fanniemae\.com|.*depository.*|.*partner.*)$/i.test(str(i, "to")) && !flag(i, "recipient_allowlisted"), "recipient is not on the allowlist"),
      never("NO_ACCOUNT_NUMBER_IN_EMAIL", "6.1 guardrail: account numbers never leave the allowlisted channels", (i) => /\b\d{9,17}\b/.test(str(i, "body")) && !flag(i, "recipient_allowlisted"), "the body carries an account-number-shaped string")] },
]);

// ---- 6.2 Form 1014 ---------------------------------------------------------
const p62 = defineTools("6.2", "custodial-recon", [
  { name: "ledger.post", kind: "write", handler: ledgerPost(), moneyFields: ["entry_set"],
    guardrails: [never("TI_ALLOWED_TRANSFER_MATRIX", "6.2 guardrail: T&I funds move only to custodial_ti_*, a borrower's verified refund destination, a payee on an approved disbursement, or the corporate interest/fee account", (i) => typeof i.ti_destination === "string" && !TI_ALLOWED_DESTINATIONS.test(str(i, "ti_destination")), "destination is outside the allowed-transfer matrix"),
      needsRole("CORPORATE_SWEEP_10K", "6.2 escalations: any sweep to corporate above $10,000 per credit → officer", (i) => str(i, "ti_destination") === "corporate_interest_fee" && cents(i.amount_cents) > 1_000_000n, ["officer"], "sweeps above $10,000 per credit need an officer"),
      needsRole("CORPORATE_FUNDS_SHORTFALL", "6.2 escalations: interest disposition when to_borrowers > I − E (corporate must fund) → officer", (i) => flag(i, "corporate_funds_shortfall"), ["officer"], "corporate funding of the statutory-interest shortfall is an officer decision")] },
  { name: "escrow.read_balances", kind: "read", handler: compute((i, _c, rt) => rt.store.list("escrow_accounts", (d) => !i.loan_id || d.loan_id === i.loan_id).map((r) => ({ id: r.id, loan_id: r.data.loan_id, balance_cents: r.data.balance_cents ?? 0n }))) },
  { name: "jurisdiction.read", kind: "read", handler: compute((i, _c, rt) => { need(i, "state"); return rt.store.get("jurisdiction_rules", str(i, "state"))?.data ?? null; }) },
]);

// ---- 6.3 Form 496 ----------------------------------------------------------
const p63 = defineTools("6.3", "custodial-recon", [
  { name: "bank.read_statement", kind: "write", handler: compute((i) => ingestStatement({ file_id: str(i, "file_id") || "unknown", credit_lines: rows(i, "credit_lines"), summary_credits: cents(i.summary_credits), debit_lines: rows(i, "debit_lines"), summary_debits: cents(i.summary_debits) })) },
  { name: "ledger.read", kind: "read", handler: read("ledger_accounts") },
  { name: "ledger.post_reclass", kind: "write", handler: ledgerPost(), moneyFields: ["entry_set"],
    guardrails: [never("RECLASS_SCOPE", "6.3 agent design: `ledger.post_reclass` is restricted to custodial ↔ corporate reimbursement, suspense, shortage/surplus and in-transit accounts", (i) => { const s = i.entry_set as { lines?: { account?: { account?: string } }[] } | undefined; return !!s?.lines?.length && !s.lines.every((l) => RECLASS_ACCOUNTS.test(String(l.account?.account ?? ""))); }, "a reclass may touch only reimbursement, suspense, shortage/surplus and in-transit accounts"),
      never("NO_PLUG", "6.3 agent design: never posts a balancing plug", (i) => flag(i, "plug") || str(i, "root_cause") === "plug", "unexplained differences stay open with a research task"),
      never("EVIDENCE_AND_CONFIDENCE", "6.3 agent design: posts only when confidence ≥ 0.95 and both sides carry documentary evidence", (i) => (typeof i.confidence === "number" && i.confidence < 0.95) || (Array.isArray(i.evidence_refs) && (i.evidence_refs as unknown[]).length < 2), "auto-post needs confidence ≥ 0.95 and evidence on both sides")] },
  { name: "fnma.read_cash_position", kind: "read", handler: compute((i, _c, rt) => rt.store.list("fnma_cash_position", (d) => !i.period || d.period === i.period).map((r) => ({ id: r.id, ...r.data }))) },
  { name: "fnma.read_draft_notifications", kind: "read", handler: compute((i, _c, rt) => { const notes = rt.store.list("draft_notifications", (d) => !i.period || d.period === i.period).map((r) => ({ id: r.id, ...r.data }));
      if (i.expected_cents !== undefined && i.bank_debit_cents !== undefined) return { notifications: notes, variance: draftVariance(cents(i.expected_cents), cents(i.bank_debit_cents), Array.isArray(i.adjustments) ? (i.adjustments as { loan: string; amount_cents: bigint; reason: string }[]) : []) };
      return { notifications: notes }; }) },
  { name: "crs.prepare_batch", kind: "write", handler: compute((i) => { need(i, "today"); const r = crsAaRequest(cents(i.amount_cents), date(i, "today"), flag(i, "last_work_day_of_month")); return { ...r, reason: str(i, "reason") || "shortage_remit_1bd", portal_task_role: "fnma_portal_operator" }; }) },
  { name: "form496.generate", kind: "write", handler: compute((i, ctx, rt) => { const s = i.section_i as SectionI | undefined; if (!s) throw new RangeError("section_i is required");
      const kind = str(i, "kind") || "ss"; const L12 = kind === "aa" ? form496AA(i.composition as Parameters<typeof form496AA>[0]).L12 : form496SS(i.composition as Parameters<typeof form496SS>[0]).L12;
      const r = reconcile(s, cents(i.cashbook_cents), L12); if (!r.balanced) throw new RangeError(`form not generated: difference ${r.difference_cents} cents (identity L12 = cashbook = adjusted depository must hold)`);
      const review = reviewerRun(rows<Section3Item>(i, "section_iii"), { difference_cents: r.difference_cents, preparer_run_id: str(i, "preparer_run_id") || ctx.actor.id, posting_run_ids: Array.isArray(i.posting_run_ids) ? (i.posting_run_ids as string[]) : [] });
      const rec = rt.store.put("custodial_reconciliations", str(i, "id") || `f496-${str(i, "period")}`, { kind: "monthly_form_496", period: str(i, "period"), L12, ...r, review }, ctx.actor, ctx.now); return { id: rec.id, L12, ...r, review }; }) },
  documentsWrite,
  escalationCreate,
  timers,
  { name: "partner.notify", kind: "act", handler: compute((i, ctx) => { need(i, "reason"); ctx.events.append({ type: "partner.notified", loanId: ctx.loanId, actor: ctx.actor, payload: { reason: str(i, "reason"), amount_cents: cents(i.amount_cents) } }); return { notified: true, reason: str(i, "reason") }; }),
    guardrails: [never("PARTNER_NOTICE_SCOPE", "6.3 escalations: partner treasury is notified for > $25,000 shortages, breaches and unauthorized debits", (i) => !["shortage_over_25k", "breach", "unauthorized_debit", "nsf_draft"].includes(str(i, "reason")) && !flag(i, "officer_directed"), "partner notices are for > $25,000 shortages, breaches and unauthorized debits")] },
]);

// ---- 6.5 suspense ----------------------------------------------------------
const p65 = defineTools("6.5", "custodial-recon", [
  { name: "suspense.read/write", kind: "write", moneyFields: ["amount_cents"], handler: readWrite("suspense_items", "suspense.item.written"),
    guardrails: [never("NO_WRITE_OFF_OVER_500", "6.5 guardrail: no write-off above $5.00", (i) => i.op === "write" && data(i).status === "written_off" && !writeOffAllowed(cents(data(i).amount_cents), false), "write-offs above $5.00 are officer decisions")] },
  { name: "payments.history", kind: "read", handler: history("payments") },
  { name: "borrowers.search", kind: "read", handler: compute((i) => { const r = i.receipt as Receipt | undefined; if (!r) throw new RangeError("receipt is required"); return identify(r, rows<CandidateLoan>(i, "candidates")); }) },
  { name: "lockbox.image_ocr", kind: "read", handler: compute((i, _c, rt) => { need(i, "image_id"); const img = rt.store.get("lockbox_images", str(i, "image_id")); return img ? { image_id: img.id, memo: img.data.memo ?? null, payer_name: img.data.payer_name ?? null, scanline_loan_number: img.data.scanline_loan_number ?? null, micr_last4: img.data.micr_last4 ?? null } : { image_id: str(i, "image_id"), unavailable: true, fallback: "data fields only; no auto-apply below threshold" }; }) },
  { name: "ledger.apply_via_cashiering", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "amount_cents"); return ctx.events.append({ type: "cashiering.apply.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), credited_as_of: str(i, "credited_as_of") || null, suspense_item_id: str(i, "suspense_item_id") || null, command: "2.1 payment.apply" } }); }),
    guardrails: [never("APPLY_CONFIDENCE_097", "6.5 guardrail: no application below 0.97 without borrower confirmation", (i) => typeof i.confidence === "number" && i.confidence < 0.97 && !flag(i, "borrower_confirmed"), "identification confidence below 0.97 needs borrower confirmation")] },
  { name: "nacha.originate_credit", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { need(i, "amount_cents", "destination_last4"); ctx.events.append({ type: "suspense.return.initiated", loanId: ctx.loanId, actor: ctx.actor, payload: { rail: "ach_credit", amount_cents: cents(i.amount_cents), destination_last4: str(i, "destination_last4") } }); return { rail: "ach_credit", amount_cents: cents(i.amount_cents) }; }),
    guardrails: [never("RETURN_TO_ORIGINATOR_ONLY", "6.5 guardrail: no return of funds to a payer that is not the verified originator/remitter", (i) => !flag(i, "destination_is_verified_originator"), "funds return only to the verified originating account"),
      needsRole("NON_BORROWER_RETURN_10K", "6.5 guardrail: any return > $10,000 to a non-borrower → officer", (i) => cents(i.amount_cents) > 1_000_000n && !flag(i, "destination_is_borrower"), ["officer"], "returns above $10,000 to a non-borrower need an officer")] },
  { name: "check.issue", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { need(i, "amount_cents", "payee"); ctx.events.append({ type: "suspense.return.initiated", loanId: ctx.loanId, actor: ctx.actor, payload: { rail: "check", amount_cents: cents(i.amount_cents), payee: str(i, "payee") } }); return { rail: "check", amount_cents: cents(i.amount_cents), payee: str(i, "payee") }; }),
    guardrails: [never("REMITTER_ONLY", "6.5 guardrail: no return of funds to a payer that is not the verified originator/remitter", (i) => !flag(i, "payee_is_verified_remitter"), "refund checks go to the verified remitter at the address on the image"),
      needsRole("NON_BORROWER_RETURN_10K", "6.5 guardrail: any return > $10,000 to a non-borrower → officer", (i) => cents(i.amount_cents) > 1_000_000n && !flag(i, "destination_is_borrower"), ["officer"], "returns above $10,000 to a non-borrower need an officer")] },
  { name: "contact.request", kind: "act", handler: escalate("human_agent"), decision: (i) => ({ action: "contact.request", rationale: str(i, "reason") || "hand-off to borrower-comms" }),
    guardrails: [never("TCPA_CONSENT_QUIET_HOURS", "6.5 guardrail: contact attempts respect consents (TCPA), quiet hours and AI disclosure", (i) => i.consent === false || flag(i, "quiet_hours") || i.automation_disclosed === false, "no contact without consent, outside quiet hours, and with automation disclosed")] },
  { name: "unclaimed_property.compute", kind: "read", handler: compute((i) => escheat(date(i, "dormancy_start_on"), str(i, "state") || "DEFAULT")) },
  { name: "naupa.generate", kind: "write", handler: compute((i, ctx, rt) => { need(i, "state", "cycle"); const items = rows<{ id: string; amount_cents: bigint }>(i, "items"); const rec = rt.store.put("naupa_files", `${str(i, "state")}-${str(i, "cycle")}`, { state: str(i, "state"), cycle: str(i, "cycle"), item_count: items.length, total_cents: items.reduce((a, x) => a + x.amount_cents, 0n), officer_verification: str(i, "officer_verification_id") || null }, ctx.actor, ctx.now); return { id: rec.id, ...rec.data }; }),
    guardrails: [humanWhen("OFFICER_VERIFICATION", "6.5 rule 7: the NAUPA II file is generated per state with the officer's verification", (i) => !i.officer_verification_id, "the officer verifies the file before filing")] },
  escalationCreate,
  timers,
]);

export const SECTION_06_TOOLS: readonly ToolDef[] = [...p61, ...p62, ...p63, ...p65];
