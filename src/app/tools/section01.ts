/**
 * §1 tools — boarding and transfer-in (1.1–1.7). Each entry is the tool string
 * from the process's "Agents" paragraph; guardrails encode that paragraph.
 * Tools emit the events the §1 timers arm and satisfy on (transfer.batch.*,
 * transfer.form629.*, notice.mailed, custody.*, mers.txn.*, recon.*,
 * lossmit.carryover.* / transferor_request.sent) through the domain emitters
 * in src/domain/transfers/inbound.ts, so the bus is the process's own emitter.
 */
import { defineTools, write, escalate, decision, noticeOps, ledgerPost, compute, guard, needsRole, never, gate, port, service, cents, abs, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { BoardingService } from "../../domain/boarding/service.ts";
import { isValidMin } from "../../domain/boarding/min.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { form629Clocks, transferDateGate, portalTaskEscalation, type TransferType } from "../../domain/transfers/batch.ts";
import { openForm629PortalTask } from "../../domain/transfers/ops-1-2.ts";
import { openForm2009Release, ingestCustodyFeedItem, resolutionNeedsSigningOfficer, type CustodyFeedItem } from "../../domain/transfers/ops-1-4.ts";
import { noticeDates, runScheduledOn, respaEffectiveDate, contentCheck, skipTraceDue } from "../../domain/transfers/respa.ts";
import { recordTosPendingNotices, recordTosConfirmations, mreReceived, reconcileExtract, lockoutWarningReceived, violationRemediated, lockoutRemediated, submitAnnualReport, mersBatchFees, submitAuthorization, type PendingTransferNotice, type ReconRow } from "../../domain/transfers/ops-1-5.ts";
import { violationNoticeReceived, SUPERMORTGAGE_ORG_ID } from "../../domain/transfers/inbound.ts";
import { recertDeadline, custodyClocks, custodyOk, mersTransaction, mersIntegrity, mersClocks, violationResponseDue } from "../../domain/transfers/custody-mers.ts";
import { expectedWires, wireVariance, classifyVariance, absorbNeedsOfficer, isBorrowerAffecting, fnmaPositionLagDeadline, type VarianceFacts } from "../../domain/transfers/reconciliation.ts";
import { TransferBatchService, proposeBatch, parseConsentNotice as parseConsent, loanListFreezeOn, planNoticeRun as planRun, releaseGate, forecastRecertRisk as forecastRisk, ingestCustodianFeedItem, planMersTransactions as planMers, recordMersAcknowledgement, verifyPostTransferSnapshots, mreMismatchFinding, raiseVariance as raiseVarianceEvent, resolveVariance, verifyCarryover, requestFromTransferor as sendTransferorRequest, honorTransferorOfferCase, type BatchProposal, type CustodianFeedItem, type MersTxnRow, type TransferorLossmitFile, type InheritedOffer } from "../../domain/transfers/inbound.ts";

/** 1.1 guardrail: money fields (UPB, escrow, suspense, advances, fees, P&I, rate) are never agent-corrected — the canonical StagedLoan/loan_terms names (domain/boarding/types.ts) plus their generic aliases. */
export const MONEY_FIELDS = [
  "upb_cents", "scheduled_upb_cents", "original_upb_cents",                       // UPB
  "escrow_balance_cents", "escrow_payment_cents", "escrow_lines",                // escrow
  "unapplied_cents", "suspense_cents",                                           // suspense
  "corporate_advances_cents", "advances_cents", "escrow_advances_cents",        // advances
  "fees_advances_cents", "late_charges_due_cents", "fees_cents", "late_charge_pct",   // fees
  "pi_cents",                                                                    // P&I
  "note_rate_pct", "rate_pct",                                                   // rate
  "deferred_principal_cents", "forborne_principal_cents",                        // non-interest-bearing UPB (HF-016)
] as const;
const touchesMoney = (i: ToolInput): string[] => Object.keys(i.changes ?? {}).filter((f) => (MONEY_FIELDS as readonly string[]).includes(f));
const boardingSvc = (rt: Parameters<typeof service>[0]) => service<BoardingService>(rt, "boarding");
const transferSvc = (rt: Parameters<typeof service>[0]): TransferBatchService | null => (rt.services.transfer as TransferBatchService | undefined) ?? null;
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const proposalOf = (i: ToolInput): BatchProposal => ({ batch_id: str(i, "batch_id"), type: str(i, "transfer_type") as TransferType, transfer_date: D(str(i, "transfer_date")), sale_date: optDate(i, "sale_date"),
  ...(i.first_batch_for_partner !== undefined ? { first_batch_for_partner: flag(i, "first_batch_for_partner") } : {}), ...(typeof i.notice_mode === "string" ? { notice_mode: i.notice_mode as "separate" | "combined" } : {}),
  ...(typeof i.loan_count === "number" ? { loan_count: i.loan_count } : {}), ...(typeof i.emortgage_count === "number" ? { emortgage_count: i.emortgage_count } : {}), ...(typeof i.code_type === "string" ? { code_type: i.code_type as "D" | "I" | "C" | "none" } : {}) });

const p11: ToolDef[] = defineTools("1.1", "boarding", [
  { name: "readTape", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).ingestTape(str(i, "batch_id"), (i.kind as "preliminary" | "final") ?? "preliminary", str(i, "bytes"), num(i, "row_count"))) },
  { name: "mapField", kind: "write", handler: write("tape_field_map", "boarding.field_mapped") },
  { name: "runValidation", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).validate(str(i, "batch_id"))) },
  { name: "queryFnmaPosition", kind: "read", handler: compute((i, _c, rt) => port(rt, "lsdu").trialBalance([str(i, "fnma_loan_number")])) },
  { name: "queryMers", kind: "read", handler: compute((i, _c, rt) => port(rt, "mers").queryMin(str(i, "min"))) },
  { name: "proposeCorrection", kind: "write", moneyFields: [...MONEY_FIELDS], handler: write("boarding_corrections", "boarding.correction.proposed") },
  // The correction is applied by the boarding service (BoardingService.applyCorrection: row replaced, decision record, `boarding.correction.applied`, the loan re-validated so an exception it cures emits `loan.boarding_exception.resolved`).
  { name: "applyCorrection", kind: "write", handler: compute((i, ctx, rt) => { const r = boardingSvc(rt).applyCorrection(str(i, "batch_loan_id") || str(i, "id"), { ...data(i), ...((i.changes as Record<string, unknown> | undefined) ?? {}) } as Parameters<BoardingService["applyCorrection"]>[1], ctx.actor,
        { provenance: i.provenance === "transferor" ? "transferor" : "agent", evidence_document_ids: Array.isArray(i.evidence_document_ids) ? (i.evidence_document_ids as string[]) : [], ...(typeof i.rationale === "string" ? { rationale: i.rationale } : typeof i.reason === "string" ? { rationale: i.reason } : {}), ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}), ...(typeof i.rule_code === "string" ? { rule_code: i.rule_code } : {}) });
      if (!r.ok) throw new RangeError(`${r.code}: ${r.reason}`); return r; }),
    // A money change is the transferor's correction or nothing: `provenance=transferor` is only credible with the correction file / letter behind it (evidence_document_ids); an officer resolves a money discrepancy by waiver (proposeWaiver), not by keying a value.
    guardrails: [guard("MONEY_FIELD_PROVENANCE", "1.1 guardrails: money fields (UPB, escrow, suspense, advances, fees, P&I, rate) are never agent-corrected — only transferor-corrected or officer-waived", (i) => { const m = [...new Set([...touchesMoney(i), ...Object.keys(data(i)).filter((f) => (MONEY_FIELDS as readonly string[]).includes(f))])]; if (!m.length) return undefined;
        const evidence = Array.isArray(i.evidence_document_ids) && (i.evidence_document_ids as unknown[]).length > 0; return i.provenance === "transferor" && evidence ? undefined : `${m.join(", ")} need provenance=transferor with the transferor's correction file / letter as evidence_document_ids (an officer waives the failure instead: proposeWaiver)`; })] },
  // The agent's own exception goes through the service so a hard one is the `loan.boarding_exception.raised{severity=hard}` SM_BOARD_EXCEPTION_SLA_2 arms on (anchored on `raised_at`).
  { name: "raiseException", kind: "write", handler: compute((i, ctx, rt) => boardingSvc(rt).raiseException(str(i, "batch_loan_id") || str(i, "id"), { rule_code: str(i, "rule_code"), severity: ((i.severity as string | undefined) ?? "hard") as "hard" | "warning" | "info", money_field: flag(i, "money_field"),
        ...(typeof i.message === "string" ? { message: i.message } : typeof i.reason === "string" ? { message: i.reason } : {}), ...(i.expected !== undefined ? { expected: i.expected } : {}), ...(i.actual !== undefined ? { actual: i.actual } : {}), ...(Array.isArray(i.evidence_document_ids) ? { evidence_document_ids: i.evidence_document_ids as string[] } : {}) }, ctx.actor)) },
  { name: "boardLoan", kind: "act", handler: compute((i, _c, rt) => { const svc = boardingSvc(rt); const r = svc.board(str(i, "batch_id"), { finalTapeReconciled: flag(i, "final_tape_reconciled") });
      // 1.1 state machine "cutover (transfer date)": once the batch has boarded, the cutover event arms the post-transfer clocks of 1.3–1.6.
      const cutover = flag(i, "complete_cutover") ? svc.completeCutover(str(i, "batch_id"), { ...(typeof i.code_type === "string" ? { code_type: i.code_type as "D" | "I" | "C" | "none" } : {}), ...(typeof i.notice_mode === "string" ? { notice_mode: i.notice_mode as "separate" | "combined" } : {}), ...(i.respa_effective_date ? { respa_effective_date: D(str(i, "respa_effective_date")) } : {}) }) : null;
      return { ...r, cutover_event_id: cutover?.id ?? null }; }),
    guardrails: [never("OPEN_HARD_FAILURE", "1.1 guardrails: the agent may not board a loan with an open hard failure", (i) => num(i, "open_hard_failures") > 0, "open hard failure(s) on the loan"),
      needsRole("HARD_FAIL_RATE_T7", "1.1 escalations: batches with > 2% hard-fail rate at T-7 go to the officer", (i) => num(i, "hard_fail_rate") > 0.02, ["officer"], "hard-fail rate above 2% at T-7")] },
  { name: "sendTransferorQuery", kind: "act", handler: compute((i, _c, rt) => boardingSvc(rt).transferorQuery(str(i, "batch_loan_id"))) },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p12: ToolDef[] = defineTools("1.2", "transfer", [
  // `proposeBatch` lives here: the package builder is where the transfer agent creates the batch from the partner's instruction (1.2 inputs); the transfer-date gate refuses before anything is written (1.2-T2).
  { name: "buildForm629", kind: "act", handler: compute((i, ctx, rt) => { const type = i.transfer_type as TransferType; const T = D(str(i, "transfer_date")); const clocks = form629Clocks(type, T, optDate(i, "sale_date"));
      let proposed: string | null = null;
      if (str(i, "batch_id")) { const p = proposalOf(i); const svc = transferSvc(rt); proposed = (svc ? svc.propose(p, ctx.actor).history[0]!.at : proposeBatch(ctx.events, p, ctx.actor).id); }
      return { transfer_type: type, ...clocks, transfer_date_gate: transferDateGate(T), proposed_event: proposed, loan_list_freeze_on: loanListFreezeOn(T) }; }),
    guardrails: [guard("FNMA_A2_7_03_TRANSFER_DATE_GATE", "1.2 timer table: `transfer_date` must equal the first `business_days_fannie_et` of the month (A2-7-03); asserted in `proposeBatch`", (i) => { const t = str(i, "transfer_date"); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined; const g = transferDateGate(D(t)); return g.ok ? undefined : `proposed transfer date ${t} is not the first Fannie Mae business day of the month (${g.expected})`; })] },
  { name: "buildCustodianMatrix", kind: "act", handler: compute((i) => { const loans = (i.loans as readonly { custodian: string; fnma_loan_number: string; enote?: boolean }[]) ?? []; const m: Record<string, { count: number; enotes: number; loans: string[] }> = {}; for (const l of loans) { const row = (m[l.custodian] ??= { count: 0, enotes: 0, loans: [] }); row.count++; if (l.enote) row.enotes++; row.loans.push(l.fnma_loan_number); } return m; }) },
  { name: "validateLoanList", kind: "act", handler: compute((i) => { const rows = (i.loans as readonly Record<string, unknown>[]) ?? []; const errors = rows.flatMap((r, n) => [!/^\d{10}$/.test(String(r.fnma_loan_number ?? "")) ? `row ${n + 1}: fnma_loan_number must be 10 digits` : null, r.upb_cents === undefined ? `row ${n + 1}: upb_cents missing` : null, r.min !== undefined && !isValidMin(String(r.min)) ? `row ${n + 1}: MIN check digit invalid` : null].filter((x): x is string => !!x)); return { rows: rows.length, valid: errors.length === 0, errors }; }) },
  // The Form 629 portal task: `escalation.created{kind=human_portal_task, task=form629}` arms SM_PORTAL_TASK_FORM629_SLA_2; the operator's completion record moves the batch to `submitted` (TransferBatchService).
  { name: "createPortalTask", kind: "act", handler: compute((i, ctx, rt) => { const task = str(i, "task") || "form629";
      // Other portal-only steps for the `fnma_portal_operator` (Fannie Mae Connect downloads) are plain work items; the Form 629 submission is the SLA-watched task ops-1-2.ts files.
      if (task !== "form629") return rt.escalations.open({ kind: "human_portal_task", ...(typeof i.batch_id === "string" ? { batchId: i.batch_id } : {}), payload: { task, batch_id: (i.batch_id as string | undefined) ?? null, package_document_id: (i.package_document_id as string | undefined) ?? null, reason: i.reason ?? null, ...((i.payload as Record<string, unknown> | undefined) ?? {}) } }, ctx.actor);
      const svc = transferSvc(rt); const batch = svc && svc.all().some((b) => b.id === str(i, "batch_id")) ? svc.get(str(i, "batch_id")) : null;
      return openForm629PortalTask({ events: ctx.events, clock: { now: () => ctx.now }, escalations: rt.escalations, batch }, { batch_id: str(i, "batch_id"), package_document_id: str(i, "package_document_id"),
        custodian_matrix_document_id: (i.custodian_matrix_document_id as string | undefined) ?? null, loan_list_version: typeof i.loan_list_version === "number" ? i.loan_list_version : null, loan_list_document_id: (i.loan_list_document_id as string | undefined) ?? null, form629_template_version: (i.form629_template_version as string | undefined) ?? null,
        transfer_type: (i.transfer_type as TransferType | undefined) ?? batch?.proposal.type ?? null, transfer_date: i.transfer_date ? D(str(i, "transfer_date")) : batch?.proposal.transfer_date ?? null, sale_date: optDate(i, "sale_date") ?? batch?.proposal.sale_date ?? null,
        transferor_servicer_number: (i.transferor_servicer_number as string | undefined) ?? null, transferee_servicer_number: (i.transferee_servicer_number as string | undefined) ?? null, purchase_price_bps: (i.purchase_price_bps as string | undefined) ?? null, contact_emails: Array.isArray(i.contact_emails) ? (i.contact_emails as string[]) : [],
        assigned_on: optDate(i, "assigned_on"), ...(i.operator_role === "partner_user" ? { operator_role: "partner_user" as const } : {}), reason: (i.reason as string | undefined) ?? null }, ctx.actor); }),
    decision: (i) => ({ action: "portal_task.create", rationale: str(i, "reason") || "Fannie Mae portal task (B2B unavailable or portal-only step)", ...(i.batch_id ? { subject: { kind: "batch", id: str(i, "batch_id") } } : {}) }) },
  // 1.2-T6: the parsed D-Code and conditions are confirmed by an officer before `approved`; the officer's confirmation (`confirm=true`) records the approval and emits `transfer.batch.approved`.
  { name: "parseConsentNotice", kind: "act", handler: compute((i, ctx, rt) => { const parsed = parseConsent(str(i, "text"));
      if (!flag(i, "confirm") || !str(i, "batch_id")) return parsed;
      const svc = transferSvc(rt); if (!svc) throw new RangeError("confirming an approval needs the transfer batch service (services.transfer)");
      svc.recordApproval(str(i, "batch_id"), { d_code: (i.d_code as string | undefined) ?? parsed.d_code, fnma_consent_document_id: str(i, "consent_document_id"), consent_document_hash: str(i, "consent_document_hash"), conditions: parsed.conditions, ...(i.respa_effective_date ? { respa_effective_date: D(str(i, "respa_effective_date")) } : {}) }, true);
      const b = svc.transition(str(i, "batch_id"), "approved", {}, ctx.actor);
      return { ...parsed, batch_status: b.status }; }),
    guardrails: [needsRole("APPROVAL_CONFIRMATION_IS_OFFICER", "1.2 state machine / 1.2-T6: `approved` is blocked until an `officer` confirms the parsed D-Code and conditions", (i) => flag(i, "confirm"), ["officer"], "confirming the consent (D-Code and conditions) is an officer act")] },
  { name: "computeDeadlines", kind: "act", handler: compute((i) => { const T = D(str(i, "transfer_date")); return { form_629: form629Clocks(i.transfer_type as TransferType, T, optDate(i, "sale_date")), loan_list_freeze_on: loanListFreezeOn(T), mers: mersClocks(T), custody: custodyClocks(T), respa: noticeDates(respaEffectiveDate(T, i.installments_due_on_1st !== false)), fnma_position_deadline: fnmaPositionLagDeadline(T), portal_task_escalation: i.assigned_on ? portalTaskEscalation(D(str(i, "assigned_on"))) : null }; }) },
  { name: "writeDecision", kind: "act", handler: decision() },
  { name: "notifyPartner", kind: "write", handler: write("partner_notifications", "transfer.partner.notified") },
]);

const p13: ToolDef[] = defineTools("1.3", "transfer", [
  { name: "planNoticeRun", kind: "act", handler: compute((i, ctx) => { const eff = i.respa_effective_date ? D(str(i, "respa_effective_date")) : respaEffectiveDate(D(str(i, "transfer_date")), i.installments_due_on_1st !== false); const d = noticeDates(eff);
      const dates = { effective_date: eff, ...d, goodbye_run_on: runScheduledOn(d.goodbye_due), hello_run_on: runScheduledOn(d.hello_due) };
      if (!str(i, "batch_id") || !Array.isArray(i.loan_ids)) return dates;
      const run = planRun({ batch_id: str(i, "batch_id"), respa_effective_date: eff, loan_ids: (i.loan_ids as string[]).map(String) }, ((i.kind as string | undefined) ?? "goodbye") as "goodbye" | "hello" | "combined" | "corrective");
      ctx.events.append({ type: "transfer_notice_run.planned", aggregate: { kind: "transfer_batch", id: run.batch_id }, actor: ctx.actor, payload: { run_id: run.run_id, batch_id: run.batch_id, kind: run.kind, template: run.template, due_at: run.due_at, loan_count: run.loans.length } });
      return { ...dates, run: { run_id: run.run_id, kind: run.kind, template: run.template, due_at: run.due_at, scheduled_on: runScheduledOn(run.due_at), loans: run.loans } }; }) },
  { name: "renderNotice", kind: "act", handler: noticeOps("render") },
  { name: "runContentChecklist", kind: "act", handler: compute((i) => contentCheck((i.present as readonly string[]) ?? [])) },
  { name: "validateAddress", kind: "act", handler: compute((i) => { const a = data(i); const errors = [!a.line1 ? "line1 missing" : null, !a.city ? "city missing" : null, !/^[A-Z]{2}$/.test(String(a.state ?? "")) ? "state must be 2 letters" : null, !/^\d{5}(-\d{4})?$/.test(String(a.zip ?? "")) ? "zip must be 5 or 9 digits" : null].filter((x): x is string => !!x); return { deliverable: errors.length === 0, errors, standardized: errors.length ? null : { line1: String(a.line1).toUpperCase(), line2: a.line2 ? String(a.line2).toUpperCase() : null, city: String(a.city).toUpperCase(), state: a.state, zip: a.zip } }; }) },
  // 1.3 state machine: release needs a passing content checklist and address validation, the transferor's written authorization for the goodbye/combined run, and SM_TOLLFREE_LIVE_GATE (toll-free number and IVR/AI disclosure live).
  { name: "releaseToVendor", kind: "act", handler: compute((i, ctx, rt) => port(rt, "printMail").submit(i.job as Parameters<ReturnType<typeof port<"printMail">>["submit"]>[0], ctx.now)),
    guardrails: [never("CHECKLIST_FIRST", "1.3: no release without a passing content checklist", (i) => i.checklist_passed !== true && !(i.run && releaseGate(i.run as Parameters<typeof releaseGate>[0]).ok), "content checklist has not passed for this run"),
      guard("RUN_RELEASE_GATE", "1.3 state machine: `released_to_vendor` needs every notice past the checklist and address validation", (i) => { if (!i.run) return undefined; const g = releaseGate(i.run as Parameters<typeof releaseGate>[0]); return g.ok ? undefined : g.reasons.join("; "); }),
      never("TRANSFEROR_AUTHORIZATION", "1.3 state machine: release to vendor for the goodbye run requires the transferor's written authorization on file", (i) => { const kind = str(i, "kind") || (i.run as { kind?: string } | undefined)?.kind; return (kind === "goodbye" || kind === "combined") && i.transferor_authorization_on_file !== true && (i.run as { transferor_authorization_on_file?: boolean } | undefined)?.transferor_authorization_on_file !== true; }, "goodbye/combined run needs the transferor's written authorization on file"),
      gate("1.3.tollFreeAndIvrDisclosureLive", "SM_TOLLFREE_LIVE_GATE: toll-free number and IVR/AI disclosure verified live, else the goodbye run cannot be released")] },
  { name: "ingestMailReturns", kind: "act", handler: compute(async (i, ctx, rt) => { const rs = await port(rt, "printMail").returns(str(i, "since") || ctx.now);
      return rs.map((r) => { const returnedOn = D(r.returnedAt.slice(0, 10)); ctx.events.append({ type: "mail.returned", aggregate: { kind: "notice", id: r.noticeId }, actor: { kind: "external", id: "print-mail" }, payload: { notice_id: r.noticeId, job_id: r.jobId, template: str(i, "template") || null, returned_at: returnedOn, reason: r.reason } }); return { ...r, skip_trace_due: skipTraceDue(returnedOn) }; }); }) },
  { name: "orderSkipTrace", kind: "write", handler: write("skip_trace_orders", "notice.skip_trace.ordered") },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const p14: ToolDef[] = defineTools("1.4", "security-records", [
  { name: "buildTrialBalance", kind: "act", handler: compute((i) => { const rows = (i.loans as readonly { fnma_loan_number: string; note_date: string; original_upb_cents: bigint | string }[]) ?? []; return { rows: rows.map((r) => ({ fnmaLoanNumber: r.fnma_loan_number, noteDate: r.note_date, originalUpbCents: cents(r.original_upb_cents) })), total_original_upb_cents: rows.reduce((s, r) => s + cents(r.original_upb_cents), 0n) }; }) },
  // The custodian's receipt is the acknowledgment FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30 waits for (`custody.trial_balance.sent`).
  // `kind=form_2009_request` (1.4 integrations: outbound "Form 2009 requests"; 13.3/16.3 later in life) opens the release on the loan — `custody.release.opened{reason=non_liquidation}` arms FNMA_RDC_FORM2009_90.
  { name: "sendToCustodian", kind: "act", handler: compute(async (i, ctx, rt) => { if (str(i, "kind") === "form_2009_request") { const rel = openForm2009Release(ctx.events, { loan_id: str(i, "loan_id") || ctx.loanId || "", form_2009_id: str(i, "form_2009_id"), release_reason: str(i, "release_reason"), released_on: D(str(i, "released_on") || ctx.now.slice(0, 10)), released_to: str(i, "released_to") }, ctx.actor); return { form_2009_id: str(i, "form_2009_id"), reason: rel.reason, expected_return_at: rel.expected_return_at, note_location: rel.note_location, event_id: rel.event.id }; }
      const r = await port(rt, "custodian").sendTrialBalance(str(i, "batch_id"), (i.rows as Parameters<ReturnType<typeof port<"custodian">>["sendTrialBalance"]>[1] | undefined) ?? [], ctx.now);
      const ack = ingestCustodianFeedItem(ctx.events, str(i, "batch_id"), { kind: "trial_balance_ack", receipt_id: r.receiptId, acked_on: D(ctx.now.slice(0, 10)) }); return { ...r, ack_event_id: ack.id }; }) },
  // Inbound custodian feed: holdings plus every acknowledgment/manifest/exception list as its `custody.*` event (shipment received, exceptions notified, Start/Complete acks, extension requested).
  { name: "ingestCustodianFeed", kind: "act", handler: compute(async (i, ctx, rt) => { const holdings = Array.isArray(i.fnma_loan_numbers) ? await port(rt, "custodian").holdings((i.fnma_loan_numbers as readonly string[])) : [];
      const items = (Array.isArray(i.items) ? (i.items as CustodyFeedItem[]) : []).map((it) => ingestCustodyFeedItem(ctx.events, str(i, "batch_id"), it, ctx.timers)); return { holdings, events: items.map((e) => ({ id: e.id, type: e.type })) }; }) },
  { name: "matchHoldings", kind: "act", handler: compute((i) => { const tb = new Set((i.trial_balance as readonly string[]) ?? []); const held = new Set(((i.holdings as readonly { fnmaLoanNumber: string }[]) ?? []).map((h) => h.fnmaLoanNumber)); return { matched: [...tb].filter((x) => held.has(x)), missing_at_custodian: [...tb].filter((x) => !held.has(x)), unexpected_at_custodian: [...held].filter((x) => !tb.has(x)) }; }) },
  { name: "openException", kind: "write", handler: write("custody_exceptions", "custody.exception.opened"),
    guardrails: [needsRole("ASSIGNMENT_RESOLUTION_IS_SIGNING_OFFICER", "1.4 state machine: `exception` resolution involving an assignment requires `signing_officer`", (i) => !!data(i).resolved_at && resolutionNeedsSigningOfficer(String(data(i).kind)), ["signing_officer"], "resolving an assignment/endorsement/allonge exception is a signing_officer act")] },
  { name: "draftTransferorQuery", kind: "write", handler: write("transferor_queries", "transferor_query.drafted") },
  { name: "verifyERegistry", kind: "act", handler: compute(async (i, _c, rt) => { const snap = await port(rt, "mers").queryMin(str(i, "min")); const ok = custodyOk({ custodian: (i.custodian as string) ?? null, certification_status: (i.certification_status as string) ?? null, enote_controller: (snap as { controller?: string } | null)?.controller ?? null }); return { snapshot: snap, custody_ok: ok }; }) },
  // 1.4 agent design: "forecasts recert completion (loans certified per week vs remaining) and drafts extension requests 30 days ahead of the 15-day cutoff" (1.4-T7).
  { name: "forecastRecertRisk", kind: "act", handler: compute((i, ctx, rt) => { const ted = D(str(i, "transfer_effective_date") || str(i, "ted")); const code = ((i.code as string | undefined) ?? "none") as "D" | "C" | "I" | "none";
      if (i.total === undefined) return { ...recertDeadline(ted, code), at_risk: null, officer_task: null };
      return forecastRisk(ctx.events, rt.escalations, str(i, "batch_id"), { ted, code, total: num(i, "total"), unrecertified_at_forecast: num(i, "unrecertified"), forecast_date: D(str(i, "forecast_date") || ctx.now.slice(0, 10)) }, ctx.actor); }) },
  // The draft is the agent's; `custody.extension.requested` (FNMA_DTJA_RECERT_EXTENSION_15 satisfaction) is the custodian's / officer's send (decision 3).
  { name: "draftExtensionRequest", kind: "write", handler: compute((i, ctx, rt) => { const rec = write("recert_extension_requests", "custody.recert.extension_drafted")(i, ctx, rt);
      if (str(i, "status") === "sent") ingestCustodianFeedItem(ctx.events, str(i, "batch_id"), { kind: "extension_requested", requested_on: D(str(i, "sent_on") || ctx.now.slice(0, 10)), until: D(str(i, "extension_until")) }); return rec; }),
    guardrails: [needsRole("EXTENSION_SEND_IS_OFFICER", "1.4 escalations: `officer` (partner) for extension requests — the agent drafts, the officer/custodian sends", (i) => str(i, "status") === "sent", ["officer"], "sending the extension request is an officer act")] },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

const req = (i: ToolInput, k: string): string => { const v = str(i, k); if (!v) throw new RangeError(`${k} is required`); return v; };
const p15: ToolDef[] = defineTools("1.5", "transfer", [
  { name: "planMersTransactions", kind: "act", handler: compute((i) => { const type = i.transfer_type as TransferType; const T = D(str(i, "transfer_date")); const mins = Array.isArray(i.mins) ? (i.mins as { min: string; loan_id?: string }[]) : [];
      return { transaction: mersTransaction(type), clocks: mersClocks(T), ...(mins.length ? planMers({ type, transfer_date: T, mins, partner_org_id: str(i, "partner_org_id") }) : {}) }; }) },
  { name: "validateMin", kind: "act", handler: compute((i) => ({ min: str(i, "min"), valid: isValidMin(str(i, "min")) })) },
  { name: "buildMersBatch", kind: "act", handler: compute((i) => { const txns = (i.transactions as readonly Record<string, unknown>[]) ?? []; const bad = txns.filter((t) => !isValidMin(String(t.min ?? ""))); if (bad.length) throw new RangeError(`${bad.length} transaction(s) carry an invalid MIN`); return { batch: txns, count: txns.length }; }) },
  // Decision 1: Supermortgage submits under its Org ID only what it is authorized to perform — partner-Org-ID rows (buyer-side TOS confirmations) go through with the partner's written authorization, else to `createPartnerTask`. Fees ride the batch (1.5 rule 5: transfers free, registrations $24.95 to the partner's MERS invoice). op=annual_report submits the officer-signed Annual Report for both Org IDs → `mers.annual_report.submitted{both_org_ids=true}` (MERS_ANNUAL_REPORT_1231).
  { name: "submitMersBatch", kind: "act", handler: compute(async (i, ctx, rt) => {
      if (str(i, "op") === "annual_report") {
        const s = { year: num(i, "year"), org_ids: Array.isArray(i.org_ids) ? (i.org_ids as unknown[]).map(String) : [], submitted_on: D(str(i, "submitted_on") || ctx.now.slice(0, 10)), package_document_id: str(i, "package_document_id"), officer_signature_document_id: str(i, "officer_signature_document_id") || null, active_mins: num(i, "active_mins"), third_party_review_document_id: str(i, "third_party_review_document_id") || null };
        const r = submitAnnualReport(ctx.events, s, ctx.actor);
        rt.store.put("mers_annual_reports", String(s.year), { ...s, due_on: r.due_on, on_time: r.on_time, event_id: r.event.id }, ctx.actor, ctx.now);
        return { year: s.year, due_on: r.due_on, on_time: r.on_time, third_party_review_required: r.third_party_review_required, event_id: r.event.id };
      }
      const txns = Array.isArray(i.transactions) ? (i.transactions as { min: string; txn_type?: string; type?: string; submitted_by_org_id?: string; orgId?: string }[]) : [];
      const auth = submitAuthorization(txns, str(i, "partner_authorization_document_id") || null);
      const submitted = await port(rt, "mers").submitBatch(auth.authorized as unknown as Parameters<ReturnType<typeof port<"mers">>["submitBatch"]>[0], ctx.now);
      return { ...submitted, submitted_count: auth.authorized.length, needs_partner_task: auth.needs_partner_task.map((t) => t.min), fees: txns.length ? mersBatchFees(txns.map((t) => ({ min: t.min, txn_type: t.txn_type ?? t.type ?? "min_update_other" })), str(i, "partner_id") || str(i, "partner_org_id") || "partner") : null }; }),
    guardrails: [never("PARTNER_ORG_ID_NEEDS_AUTHORIZATION", "1.5 agent design: `submitMersBatch` (under Supermortgage's Org ID for transactions it is authorized to perform; otherwise `createPartnerTask`) — decision 1: the partner submits under its Org ID by default", (i) => str(i, "op") !== "annual_report" && !str(i, "partner_authorization_document_id") && submitAuthorization(Array.isArray(i.transactions) ? (i.transactions as { min: string; submitted_by_org_id?: string; orgId?: string }[]) : []).needs_partner_task.length > 0, "route the partner-Org-ID transactions to createPartnerTask, or attach the partner's written authorization (partner_authorization_document_id)")] },
  { name: "createPartnerTask", kind: "act", handler: escalate("human_portal_task") },
  // MERS inbound (1.5 inputs), by `op`: ack (default) — the acknowledgment file: `mers.txn.accepted{txn_type, min}` per MIN, rejects to 1.1 exceptions, the batch-level `all_mins=true` that satisfies MERS_PROC_SUBSERVICER_MIN_UPDATE_T0 / MERS_PROC_REGISTER_UNREGISTERED_7;
  // tos_pending — the seller's TOS pending notices (inline `notices` or the port's pendingTransfers) → `mers.tos.pending_received` (MERS_PROC_TOS_INITIATE_T0 satisfied, MERS_PROC_TOS_CONFIRM_7 armed per MIN); tos_confirm — the buyer-side confirmation acknowledgment → `mers.txn.confirmed{txn_type=tos_confirm}`;
  // mre — the Member Reconciliation Extract → `mers.mre.received` (MERS_QA_MRE_RECON_MONTHLY); violation_notice / lockout_warning — MERSCORP's Rule 7 correspondence → `mers.violation_notice.received` / `mers.lockout_warning.received` + the `officer` task (sev 1).
  { name: "ingestMersAck", kind: "write", handler: compute(async (i, ctx, rt) => { const rows = Array.isArray(i.transactions) ? (i.transactions as MersTxnRow[]) : []; const results = Array.isArray(i.results) ? (i.results as { min: string; accepted: boolean; reason?: string }[]) : [];
      const batchId = str(i, "batch_id"); const on = (k: string): PlainDate => D(str(i, k) || ctx.now.slice(0, 10)); const org = str(i, "org_id") || SUPERMORTGAGE_ORG_ID;
      switch (str(i, "op") || "ack") {
        case "tos_pending": { const notices = Array.isArray(i.notices) ? (i.notices as PendingTransferNotice[]) : await port(rt, "mers").pendingTransfers(str(i, "partner_org_id") || org);
          const r = recordTosPendingNotices(ctx.events, batchId, rows, notices, { seller_org_id: str(i, "seller_org_id") || null, previously_received: Array.isArray(i.previously_received) ? (i.previously_received as unknown[]).map(String) : [] });
          rt.store.put("mers_tos_pending", str(i, "id") || `tos-pending-${batchId}-${ctx.now}`, { batch_id: batchId, expected: r.expected, received: r.received, missing: r.missing, ignored: r.ignored, confirm_by: r.confirm_by, all_mins: r.all_mins }, ctx.actor, ctx.now);
          return { expected: r.expected, received: r.received, missing: r.missing, ignored: r.ignored, confirm_by: r.confirm_by, all_mins: r.all_mins }; }
        case "tos_confirm": { const r = recordTosConfirmations(ctx.events, batchId, rows, results, on("confirmed_on"));
          rt.store.put("mers_acks", str(i, "id") || `tos-confirm-${batchId}-${ctx.now}`, { batch_id: batchId, txn_type: "tos_confirm", confirmed: r.confirmed, rejected: r.rejected, confirmed_pct: r.confirmed_pct, all_mins: r.all_mins, exceptions: r.exceptions }, ctx.actor, ctx.now);
          return { confirmed: r.confirmed, rejected: r.rejected, confirmed_pct: r.confirmed_pct, all_mins: r.all_mins, exceptions: r.exceptions }; }
        case "mre": { const extract = Array.isArray(i.rows) ? (i.rows as { min: string }[]) : await port(rt, "mers").memberReconciliationExtract(org, str(i, "as_of") || ctx.now.slice(0, 10));
          const r = mreReceived(ctx.events, { org_id: org, as_of: on("as_of"), received_on: on("received_on"), rows: extract, document_id: str(i, "document_id") || null });
          rt.store.put("mers_mre_receipts", str(i, "id") || `mre-${org}-${on("received_on")}`, { org_id: org, as_of: on("as_of"), received_on: on("received_on"), mins: r.mins, cadence: r.cadence, recon_due: r.recon_due, event_id: r.event.id }, ctx.actor, ctx.now);
          return { org_id: org, mins: r.mins, cadence: r.cadence, recon_due: r.recon_due, event_id: r.event.id }; }
        case "violation_notice": { const r = violationNoticeReceived(ctx.events, rt.escalations, { notice_on: D(req(i, "notice_on")), org_id: org, description: req(i, "description"), ...(str(i, "min") ? { min: str(i, "min") } : {}) });
          rt.store.put("mers_qa_findings", `violation:${org}:${str(i, "notice_on")}`, { ...r.finding, org_id: org, description: str(i, "description"), min: str(i, "min") || null, officer_task_id: r.officer_task_id }, ctx.actor, ctx.now);
          return { response_due: r.response_due, officer_task_id: r.officer_task_id, finding: r.finding }; }
        case "lockout_warning": { const r = lockoutWarningReceived(ctx.events, rt.escalations, { notice_on: D(req(i, "notice_on")), org_id: org, description: req(i, "description"), penalties_cents: i.penalties_cents === undefined || i.penalties_cents === null ? null : cents(i.penalties_cents), violation_notice_date: str(i, "violation_notice_date") ? D(str(i, "violation_notice_date")) : null });
          rt.store.put("mers_qa_findings", `lockout:${org}:${str(i, "notice_on")}`, { ...r.finding, org_id: org, description: str(i, "description"), officer_task_id: r.officer_task_id }, ctx.actor, ctx.now);
          return { remediate_by: r.remediate_by, officer_task_id: r.officer_task_id, finding: r.finding }; }
        case "ack": { const r = recordMersAcknowledgement(ctx.events, batchId, rows, results, on("acked_on"));
          rt.store.put("mers_acks", str(i, "id") || `ack-${batchId}-${ctx.now}`, { batch_id: batchId, accepted: r.accepted, rejected: r.rejected, accepted_pct: r.accepted_pct, all_mins: r.all_mins, exceptions: r.exceptions }, ctx.actor, ctx.now);
          return { accepted: r.accepted, rejected: r.rejected, accepted_pct: r.accepted_pct, all_mins: r.all_mins, exceptions: r.exceptions }; }
        default: throw new RangeError(`ingestMersAck op ${str(i, "op")} is not one of ack/tos_pending/tos_confirm/mre/violation_notice/lockout_warning`);
      } }) },
  // Post-transfer snapshots: with the expected MINs and partner Org ID, 100% verified emits `mers.snapshot.verified{all_mins=true}` (SM_MERS_POST_TRANSFER_VERIFY_3).
  { name: "snapshotMins", kind: "act", handler: compute(async (i, ctx, rt) => { const snaps = await port(rt, "mers").memberReconciliationExtract(str(i, "org_id"), str(i, "as_of") || ctx.now.slice(0, 10));
      if (!Array.isArray(i.expected_mins) || !str(i, "partner_org_id")) return snaps;
      const v = verifyPostTransferSnapshots(ctx.events, str(i, "batch_id"), snaps.map((s) => ({ min: s.min, status: s.status, servicer_org_id: s.servicerOrgId, subservicer_org_id: s.subservicerOrgId, investor_org_id: s.investorOrgId })), { partner_org_id: str(i, "partner_org_id"), mins: (i.expected_mins as string[]).map(String) }, D(str(i, "as_of") || ctx.now.slice(0, 10)));
      return { snapshots: snaps, verification: v }; }) },
  // 1.5 rule 3 / MERS_QA_MRE_RECON_MONTHLY: one MIN (`min`, `system_of_record`, `snapshot`, `changing`) or a whole extract (`rows`) — a mismatch other than the field being changed blocks that MIN's update and opens `mers_qa_findings{mre_mismatch}`; the run appends `mers.recon.completed{org_id, received_on}` on the Org ID the MRE was received for (ops-1-5.ts reconcileExtract).
  { name: "reconcileMre", kind: "act", handler: compute((i, ctx, rt) => {
      if (!Array.isArray(i.rows) && !str(i, "min")) throw new RangeError("reconcileMre needs `min` (with system_of_record/snapshot) or the extract `rows`");
      const rows: ReconRow[] = Array.isArray(i.rows) ? (i.rows as ReconRow[]) : [{ min: str(i, "min"), system_of_record: (i.system_of_record as Record<string, string>) ?? {}, snapshot: (i.snapshot as Record<string, string>) ?? {}, changing: (i.changing as readonly string[]) ?? [] }];
      const r = reconcileExtract(ctx.events, { org_id: str(i, "org_id") || SUPERMORTGAGE_ORG_ID, received_on: D(str(i, "received_on") || ctx.now.slice(0, 10)), rows }, ctx.actor);
      for (const f of r.findings) rt.store.put("mers_qa_findings", `mre:${f.min}:${ctx.now}`, { ...f, org_id: r.org_id }, ctx.actor, ctx.now);
      const single = Array.isArray(i.rows) ? null : rows[0]!;
      return { org_id: r.org_id, received_on: r.received_on, mins: r.mins, clean: r.clean, blocked: r.blocked, findings: r.findings, event_id: r.event.id,
        ...(single ? { discrepancies: mersIntegrity(single.system_of_record, single.snapshot, single.changing ?? []), finding: r.findings[0] ?? null } : {}) }; }) },
  // Rule 7, by `op`: draft (default) — the response package due +30 CD from the notice; remediated / lockout_remediated — the `officer` records the filed response / the remediation with penalties paid → `mers.violation.remediated` / `mers.lockout.remediated{penalties_paid=true}` (MERS_RULE7_VIOLATION_RESPONSE_30 / MERS_RULE7_LOCKOUT_WARNING_30 satisfied; ops-1-5.ts).
  { name: "draftViolationResponse", kind: "write", handler: compute((i, ctx, rt) => { const org = str(i, "org_id") || SUPERMORTGAGE_ORG_ID; const notice = D(req(i, "notice_on")); const remediatedOn = D(str(i, "remediated_on") || ctx.now.slice(0, 10));
      switch (str(i, "op") || "draft") {
        case "remediated": { const r = violationRemediated(ctx.events, { org_id: org, notice_date: notice, remediated_on: remediatedOn, response_document_id: str(i, "response_document_id"), summary: str(i, "summary") || null }, ctx.actor);
          rt.store.put("mers_qa_findings", `violation:${org}:${notice}`, { kind: "violation_notice", org_id: org, raised_at: notice, resolved_at: remediatedOn, response_document_id: str(i, "response_document_id"), on_time: r.on_time }, ctx.actor, ctx.now);
          return { response_due: r.response_due, on_time: r.on_time, event_id: r.event.id }; }
        case "lockout_remediated": { const r = lockoutRemediated(ctx.events, { org_id: org, notice_date: notice, remediated_on: remediatedOn, penalties_paid: flag(i, "penalties_paid"), penalties_paid_cents: i.penalties_paid_cents === undefined || i.penalties_paid_cents === null ? null : cents(i.penalties_paid_cents), evidence_document_id: str(i, "evidence_document_id") }, ctx.actor);
          rt.store.put("mers_qa_findings", `lockout:${org}:${notice}`, { kind: "violation_notice", stage: "lockout_warning", org_id: org, raised_at: notice, resolved_at: remediatedOn, penalties_paid: true, evidence_document_id: str(i, "evidence_document_id"), on_time: r.on_time }, ctx.actor, ctx.now);
          return { remediate_by: r.remediate_by, on_time: r.on_time, event_id: r.event.id }; }
        case "draft": { const due = violationResponseDue(notice); rt.store.put("mers_violation_responses", str(i, "id") || `mvr-${ctx.now}`, { ...data(i), org_id: org, notice_on: notice, response_due: due }, ctx.actor, ctx.now); return { response_due: due }; }
        default: throw new RangeError(`draftViolationResponse op ${str(i, "op")} is not one of draft/remediated/lockout_remediated`);
      } }),
    guardrails: [needsRole("RULE7_REMEDIATION_IS_OFFICER", "1.5 agent design: escalations — `officer` (partner) for violation responses; Rule 7 §1(b)/(e): the response, the remediation and the penalties are the Member's act", (i) => str(i, "op") === "remediated" || str(i, "op") === "lockout_remediated", ["officer"], "the agent drafts the response; the officer records the filed response and the remediation")] },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

/** 1.6 tools are process-owned: src/app/tools/section1-6.ts (TOOLS_1_6, spread by ./index.ts alongside SECTION_01_TOOLS) — the empty slot keeps this file's shape. */
const p16: ToolDef[] = [];

/** 1.7 tools are process-owned: src/app/tools/section1-7.ts (TOOLS_1_7, spread by ./index.ts alongside SECTION_01_TOOLS) — the empty slot keeps this file's shape. */
const p17: ToolDef[] = [];

export const SECTION_01_TOOLS: readonly ToolDef[] = [...p11, ...p12, ...p13, ...p14, ...p15, ...p16, ...p17];
