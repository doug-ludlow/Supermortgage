/**
 * §1 tools — boarding and transfer-in (1.1–1.7). Each entry is the tool string
 * from the process's "Agents" paragraph; guardrails encode that paragraph.
 */
import { defineTools, write, escalate, decision, noticeOps, ledgerPost, compute, guard, needsRole, never, port, service, cents, abs, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { BoardingService } from "../../domain/boarding/service.ts";
import { isValidMin } from "../../domain/boarding/min.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { form629Clocks, transferDateGate, portalTaskEscalation } from "../../domain/transfers/batch.ts";
import { noticeDates, runScheduledOn, respaEffectiveDate, contentCheck, skipTraceDue } from "../../domain/transfers/respa.ts";
import { recertDeadline, custodyClocks, custodyOk, mersTransaction, mersIntegrity, mersClocks, violationResponseDue } from "../../domain/transfers/custody-mers.ts";
import { expectedWires, wireVariance } from "../../domain/transfers/reconciliation.ts";
import { deemedReceived, transfereeAckDue, transfereeEvaluationDue, transfereeAppealDue, honorTransferorOffer, forbearanceCarryover, documentRequestOrder, firstFilingGate } from "../../domain/transfers/lossmit-inflight.ts";

/** 1.1 guardrail: money fields are never agent-corrected. */
export const MONEY_FIELDS = ["upb_cents", "escrow_balance_cents", "suspense_cents", "advances_cents", "fees_cents", "pi_cents", "note_rate_pct", "rate_pct"] as const;
const touchesMoney = (i: ToolInput): string[] => Object.keys(i.changes ?? {}).filter((f) => (MONEY_FIELDS as readonly string[]).includes(f));
const boardingSvc = (rt: Parameters<typeof service>[0]) => service<BoardingService>(rt, "boarding");

const p11: ToolDef[] = defineTools("1.1", "boarding", [
  { name: "readTape", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).ingestTape(str(i, "batch_id"), (i.kind as "preliminary" | "final") ?? "preliminary", str(i, "bytes"), num(i, "row_count"))) },
  { name: "mapField", kind: "write", handler: write("tape_field_map", "boarding.field_mapped") },
  { name: "runValidation", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).validate(str(i, "batch_id"))) },
  { name: "queryFnmaPosition", kind: "read", handler: compute((i, _c, rt) => port(rt, "lsdu").trialBalance([str(i, "fnma_loan_number")])) },
  { name: "queryMers", kind: "read", handler: compute((i, _c, rt) => port(rt, "mers").queryMin(str(i, "min"))) },
  { name: "proposeCorrection", kind: "write", moneyFields: [...MONEY_FIELDS], handler: write("boarding_corrections", "boarding.correction.proposed") },
  { name: "applyCorrection", kind: "write", handler: write("boarding_corrections", "boarding.correction.applied"),
    guardrails: [guard("MONEY_FIELD_PROVENANCE", "1.1 guardrails: money fields are only transferor-corrected or officer-waived", (i, ctx) => { const m = touchesMoney(i); return m.length && i.provenance !== "transferor" && ctx.actor.role !== "officer" ? `${m.join(", ")} need provenance=transferor or an officer waiver` : undefined; })] },
  { name: "raiseException", kind: "write", handler: write("boarding_exceptions", "boarding.exception.raised") },
  { name: "boardLoan", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).board(str(i, "batch_id"), { finalTapeReconciled: flag(i, "final_tape_reconciled") })),
    guardrails: [never("OPEN_HARD_FAILURE", "1.1 guardrails: the agent may not board a loan with an open hard failure", (i) => num(i, "open_hard_failures") > 0, "open hard failure(s) on the loan"),
      needsRole("HARD_FAIL_RATE_T7", "1.1 escalations: batches with > 2% hard-fail rate at T-7 go to the officer", (i) => num(i, "hard_fail_rate") > 0.02, ["officer"], "hard-fail rate above 2% at T-7")] },
  { name: "sendTransferorQuery", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).transferorQuery(str(i, "batch_loan_id"))) },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p12: ToolDef[] = defineTools("1.2", "transfer", [
  { name: "buildForm629", kind: "act", handler: compute((i) => ({ transfer_type: str(i, "transfer_type"), ...form629Clocks(i.transfer_type as Parameters<typeof form629Clocks>[0], D(str(i, "transfer_date")), i.sale_date ? D(str(i, "sale_date")) : null), transfer_date_gate: transferDateGate(D(str(i, "transfer_date"))) })) },
  { name: "buildCustodianMatrix", kind: "act", handler: compute((i) => { const loans = (i.loans as readonly { custodian: string; fnma_loan_number: string; enote?: boolean }[]) ?? []; const m: Record<string, { count: number; enotes: number; loans: string[] }> = {}; for (const l of loans) { const row = (m[l.custodian] ??= { count: 0, enotes: 0, loans: [] }); row.count++; if (l.enote) row.enotes++; row.loans.push(l.fnma_loan_number); } return m; }) },
  { name: "validateLoanList", kind: "act", handler: compute((i) => { const rows = (i.loans as readonly Record<string, unknown>[]) ?? []; const errors = rows.flatMap((r, n) => [!/^\d{10}$/.test(String(r.fnma_loan_number ?? "")) ? `row ${n + 1}: fnma_loan_number must be 10 digits` : null, r.upb_cents === undefined ? `row ${n + 1}: upb_cents missing` : null, r.min !== undefined && !isValidMin(String(r.min)) ? `row ${n + 1}: MIN check digit invalid` : null].filter((x): x is string => !!x)); return { rows: rows.length, valid: errors.length === 0, errors }; }) },
  { name: "createPortalTask", kind: "act", handler: escalate("human_portal_task"), decision: (i) => ({ action: "portal_task.create", rationale: str(i, "reason") || "Fannie Mae portal task (B2B unavailable or portal-only step)", ...(i.batch_id ? { subject: { kind: "batch", id: str(i, "batch_id") } } : {}) }) },
  { name: "parseConsentNotice", kind: "act", handler: compute((i) => { const t = str(i, "text"); const denied = /den(y|ied)|not approved|reject/i.test(t); const date = /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1] ?? null; return { outcome: denied ? "denied" : /approv|consent/i.test(t) ? "approved" : "unclear", effective_date: date, conditions: [...t.matchAll(/condition[^.]*\./gi)].map((m) => m[0]) }; }) },
  { name: "computeDeadlines", kind: "act", handler: compute((i) => { const T = D(str(i, "transfer_date")); return { form_629: form629Clocks(i.transfer_type as Parameters<typeof form629Clocks>[0], T, i.sale_date ? D(str(i, "sale_date")) : null), mers: mersClocks(T), custody: custodyClocks(T), respa: noticeDates(respaEffectiveDate(T, i.installments_due_on_1st !== false)), portal_task_escalation: i.assigned_on ? portalTaskEscalation(D(str(i, "assigned_on"))) : null }; }) },
  { name: "writeDecision", kind: "act", handler: decision() },
  { name: "notifyPartner", kind: "write", handler: write("partner_notifications", "transfer.partner.notified") },
]);

const p13: ToolDef[] = defineTools("1.3", "transfer", [
  { name: "planNoticeRun", kind: "act", handler: compute((i) => { const eff = respaEffectiveDate(D(str(i, "transfer_date")), i.installments_due_on_1st !== false); const d = noticeDates(eff); return { effective_date: eff, ...d, goodbye_run_on: runScheduledOn(d.goodbye_due), hello_run_on: runScheduledOn(d.hello_due) }; }) },
  { name: "renderNotice", kind: "act", handler: noticeOps("render") },
  { name: "runContentChecklist", kind: "act", handler: compute((i) => contentCheck((i.present as readonly string[]) ?? [])) },
  { name: "validateAddress", kind: "act", handler: compute((i) => { const a = data(i); const errors = [!a.line1 ? "line1 missing" : null, !a.city ? "city missing" : null, !/^[A-Z]{2}$/.test(String(a.state ?? "")) ? "state must be 2 letters" : null, !/^\d{5}(-\d{4})?$/.test(String(a.zip ?? "")) ? "zip must be 5 or 9 digits" : null].filter((x): x is string => !!x); return { deliverable: errors.length === 0, errors, standardized: errors.length ? null : { line1: String(a.line1).toUpperCase(), line2: a.line2 ? String(a.line2).toUpperCase() : null, city: String(a.city).toUpperCase(), state: a.state, zip: a.zip } }; }) },
  { name: "releaseToVendor", kind: "act", handler: compute((i, ctx, rt) => port(rt, "printMail").submit(i.job as Parameters<ReturnType<typeof port<"printMail">>["submit"]>[0], ctx.now)),
    guardrails: [never("CHECKLIST_FIRST", "1.3: no release without a passing content checklist", (i) => i.checklist_passed !== true, "content checklist has not passed for this run")] },
  { name: "ingestMailReturns", kind: "act", handler: compute(async (i, ctx, rt) => { const rs = await port(rt, "printMail").returns(str(i, "since") || ctx.now); return rs.map((r) => ({ ...r, skip_trace_due: skipTraceDue(D(r.returnedAt.slice(0, 10))) })); }) },
  { name: "orderSkipTrace", kind: "write", handler: write("skip_trace_orders", "notice.skip_trace.ordered") },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p14: ToolDef[] = defineTools("1.4", "security-records", [
  { name: "buildTrialBalance", kind: "act", handler: compute((i) => { const rows = (i.loans as readonly { fnma_loan_number: string; note_date: string; original_upb_cents: bigint | string }[]) ?? []; return { rows: rows.map((r) => ({ fnmaLoanNumber: r.fnma_loan_number, noteDate: r.note_date, originalUpbCents: cents(r.original_upb_cents) })), total_original_upb_cents: rows.reduce((s, r) => s + cents(r.original_upb_cents), 0n) }; }) },
  { name: "sendToCustodian", kind: "act", handler: compute((i, ctx, rt) => port(rt, "custodian").sendTrialBalance(str(i, "batch_id"), (i.rows as Parameters<ReturnType<typeof port<"custodian">>["sendTrialBalance"]>[1] | undefined) ?? [], ctx.now)) },
  { name: "ingestCustodianFeed", kind: "act", handler: compute((i, _c, rt) => port(rt, "custodian").holdings((i.fnma_loan_numbers as readonly string[]) ?? [])) },
  { name: "matchHoldings", kind: "act", handler: compute((i) => { const tb = new Set((i.trial_balance as readonly string[]) ?? []); const held = new Set(((i.holdings as readonly { fnmaLoanNumber: string }[]) ?? []).map((h) => h.fnmaLoanNumber)); return { matched: [...tb].filter((x) => held.has(x)), missing_at_custodian: [...tb].filter((x) => !held.has(x)), unexpected_at_custodian: [...held].filter((x) => !tb.has(x)) }; }) },
  { name: "openException", kind: "write", handler: write("custody_exceptions", "custody.exception.opened") },
  { name: "draftTransferorQuery", kind: "write", handler: write("transferor_queries", "transferor_query.drafted") },
  { name: "verifyERegistry", kind: "act", handler: compute(async (i, _c, rt) => { const snap = await port(rt, "mers").queryMin(str(i, "min")); const ok = custodyOk({ custodian: (i.custodian as string) ?? null, certification_status: (i.certification_status as string) ?? null, enote_controller: (snap as { controller?: string } | null)?.controller ?? null }); return { snapshot: snap, custody_ok: ok }; }) },
  { name: "forecastRecertRisk", kind: "act", handler: compute((i) => { const d = recertDeadline(D(str(i, "transfer_effective_date")), (i.code as "D" | "C" | "I" | "none") ?? "none"); const today = str(i, "today"); return { ...d, at_risk: today ? today > d.extension_request_by : null }; }) },
  { name: "draftExtensionRequest", kind: "write", handler: write("recert_extension_requests", "custody.recert.extension_drafted") },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p15: ToolDef[] = defineTools("1.5", "transfer", [
  { name: "planMersTransactions", kind: "act", handler: compute((i) => ({ transaction: mersTransaction(i.transfer_type as Parameters<typeof mersTransaction>[0]), clocks: mersClocks(D(str(i, "transfer_date"))) })) },
  { name: "validateMin", kind: "act", handler: compute((i) => ({ min: str(i, "min"), valid: isValidMin(str(i, "min")) })) },
  { name: "buildMersBatch", kind: "act", handler: compute((i) => { const txns = (i.transactions as readonly Record<string, unknown>[]) ?? []; const bad = txns.filter((t) => !isValidMin(String(t.min ?? ""))); if (bad.length) throw new RangeError(`${bad.length} transaction(s) carry an invalid MIN`); return { batch: txns, count: txns.length }; }) },
  { name: "submitMersBatch", kind: "act", handler: compute((i, ctx, rt) => port(rt, "mers").submitBatch((i.transactions as Parameters<ReturnType<typeof port<"mers">>["submitBatch"]>[0] | undefined) ?? [], ctx.now)) },
  { name: "createPartnerTask", kind: "act", handler: escalate("human_portal_task") },
  { name: "ingestMersAck", kind: "write", handler: write("mers_acks", "mers.ack.ingested") },
  { name: "snapshotMins", kind: "act", handler: compute((i, ctx, rt) => port(rt, "mers").memberReconciliationExtract(str(i, "org_id"), str(i, "as_of") || ctx.now.slice(0, 10))) },
  { name: "reconcileMre", kind: "act", handler: compute((i) => { const diffs = mersIntegrity((i.system_of_record as Record<string, string>) ?? {}, (i.snapshot as Record<string, string>) ?? {}, (i.changing as readonly string[]) ?? []); return { discrepancies: diffs, clean: diffs.length === 0 }; }) },
  { name: "draftViolationResponse", kind: "write", handler: compute((i, ctx, rt) => { const due = violationResponseDue(D(str(i, "notice_on"))); rt.store.put("mers_violation_responses", str(i, "id") || `mvr-${ctx.now}`, { ...data(i), response_due: due }, ctx.actor, ctx.now); return { response_due: due }; }) },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p16: ToolDef[] = defineTools("1.6", "custodial-recon", [
  { name: "loadTapeBalances", kind: "write", handler: write("tape_balances", "recon.tape_balances.loaded") },
  { name: "loadTrialBalance", kind: "act", handler: compute((i, _c, rt) => port(rt, "lsdu").trialBalance((i.fnma_loan_numbers as readonly string[]) ?? [])) },
  { name: "loadBankFeed", kind: "act", handler: compute((i, ctx, rt) => port(rt, "custodialBank").priorDay(str(i, "account_number"), str(i, "as_of") || ctx.now.slice(0, 10))) },
  { name: "queryFnmaPosition", kind: "read", handler: compute((i, _c, rt) => port(rt, "lsdu").trialBalance([str(i, "fnma_loan_number")])) },
  { name: "matchWires", kind: "act", handler: compute((i) => { const exp = expectedWires((i.loans as Parameters<typeof expectedWires>[0] | undefined) ?? [], flag(i, "include_escrow_interest_month")); const today = D(str(i, "today")); return { expected: exp, ti: wireVariance(exp.ti_wire_cents, cents(i.ti_received_cents), "ti", today), pi: wireVariance(exp.pi_wire_cents, cents(i.pi_received_cents), "pi", today) }; }) },
  { name: "raiseVariance", kind: "write", handler: write("recon_variances", "recon.variance.raised") },
  { name: "classifyVariance", kind: "act", handler: compute((i) => wireVariance(cents(i.expected_cents), cents(i.received_cents), (i.category as "ti" | "pi") ?? "ti", D(str(i, "today")))) },
  { name: "draftTransferorQuery", kind: "write", handler: write("transferor_queries", "transferor_query.drafted") },
  { name: "postOpeningEntries", kind: "act", handler: ledgerPost(),
    guardrails: [guard("EVIDENCE_REQUIRED", "1.6 guardrails: a balance is adjusted only with transferor or bank evidence", (i) => (i.adjustment === true && !["transferor", "bank"].includes(str(i, "evidence")) ? "adjustment without transferor/bank evidence" : undefined)),
      guard("ABSORB_NEEDS_OFFICER", "1.6 guardrails: absorbing or writing off a variance needs officer approval (any borrower-affecting amount; ≥ $25/loan or ≥ $5,000/batch portfolio-level)", (i, ctx) => {
        if (i.absorb !== true) return undefined; const v = abs(cents(i.variance_cents));
        const needs = flag(i, "borrower_affecting") || (i.scope === "batch" ? v >= 500_000n : v >= 2_500n);
        return needs && ctx.actor.role !== "officer" ? `absorbing ${v} cents (${str(i, "scope") || "loan"} scope) requires an officer` : undefined; }),
      never("NO_BORROWER_CONTACT", "1.6 guardrails: no borrower contact from 1.6", (i) => flag(i, "borrower_contact"), "1.6 never contacts the borrower; escrow statements are Notice Registry outputs")] },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p17: ToolDef[] = defineTools("1.7", "lossmit-underwriter", [
  { name: "loadTransferorFile", kind: "write", handler: write("transferor_lossmit_files", "lossmit.transfer.file_loaded") },
  { name: "runCarryoverChecks", kind: "act", handler: compute((i) => ({ forbearance: forbearanceCarryover(num(i, "cumulative_forbearance_months") || 0, num(i, "requested_months") || 0), first_filing: firstFilingGate(i.reasonable_date ? D(str(i, "reasonable_date")) : null, D(str(i, "today"))), document_request_order: documentRequestOrder(flag(i, "transferor_failed")) })) },
  { name: "computeDeemedDates", kind: "act", handler: compute((i) => { const T = D(str(i, "transfer_date")); const atT = flag(i, "subject_at_transferor"); return { deemed_received: deemedReceived(D(str(i, "transferor_received_on")), atT, T), ack_due: transfereeAckDue(T, atT), evaluation_due: transfereeEvaluationDue(T), ...(i.appeal_received_on ? { appeal_due: transfereeAppealDue(T, D(str(i, "appeal_received_on"))) } : {}) }; }) },
  { name: "classifyCompleteness", kind: "act", handler: compute((i) => { const missing = ((i.required as readonly string[]) ?? []).filter((d) => !((i.received as readonly string[]) ?? []).includes(d)); return { status: missing.length ? "incomplete" : "complete", missing }; }) },
  { name: "requestFromTransferor", kind: "write", handler: write("transferor_document_requests", "lossmit.transfer.documents_requested") },
  { name: "evaluateOptions", kind: "act", handler: compute((i) => ({ transferor_offer: i.accepted_on && i.accept_by ? honorTransferorOffer(D(str(i, "accepted_on")), D(str(i, "accept_by"))) : "none", forbearance: forbearanceCarryover(num(i, "cumulative_forbearance_months") || 0, num(i, "requested_months") || 0) })) },
  { name: "draftNotice", kind: "act", handler: noticeOps("render") },
  { name: "setForeclosureHold", kind: "write", handler: write("foreclosure_holds", "foreclosure.hold.set") },
  { name: "honorTransferorOffer", kind: "act", handler: compute((i) => ({ decision: honorTransferorOffer(D(str(i, "accepted_on")), D(str(i, "accept_by"))) })) },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

export const SECTION_01_TOOLS: readonly ToolDef[] = [...p11, ...p12, ...p13, ...p14, ...p15, ...p16, ...p17];
