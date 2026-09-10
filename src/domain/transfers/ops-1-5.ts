/**
 * §1.5 operating rules over the MERS calculators in custody-mers.ts and the plan/acknowledgment mechanics in
 * inbound.ts: the inbound MERS records the `transfer` agent ingests (pending-transfer notices for a TOS, the
 * buyer-side TOS confirmation acknowledgment, the Member Reconciliation Extract, MERSCORP's Rule 7
 * correspondence) and the events each appends once the record is validated, the QA reconciliation run over an
 * extract, the Rule 7 remediations the `officer` records, the Annual Report submission for both Org IDs, the fee
 * schedule (transfers free, registrations $24.95 to the partner's MERS invoice, never the borrower) and the
 * submit-authorization split of decision 1. An event is the platform's statement that a record was received and
 * checked, so every function validates before it appends; nothing here contacts a borrower or posts to the ledger.
 *
 * Events (timer subject in brackets — src/kernel/timers/engine.ts arms on `loanId`, else the aggregate):
 *   mers.tos.pending_received{batch_id, min, txn_type=tos_initiate, notice_date, confirm_by}   [mers_txn per MIN / loan; transfer_batch once every planned MIN is noticed — satisfies MERS_PROC_TOS_INITIATE_T0, arms MERS_PROC_TOS_CONFIRM_7]
 *   mers.txn.confirmed{batch_id, min, txn_type=tos_confirm, confirmed_at}                      [same subjects — satisfies MERS_PROC_TOS_CONFIRM_7]
 *   mers.mre.received{org_id, as_of, received_on, mins}                                        [mers_org — arms MERS_QA_MRE_RECON_MONTHLY]
 *   mers.recon.completed{org_id, received_on, mins, mismatches, blocked_mins}                  [mers_org — satisfies it and re-arms the next cycle]
 *   mers.lockout_warning.received{org_id, notice_date, remediate_by}                           [mers_org — arms MERS_RULE7_LOCKOUT_WARNING_30]
 *   mers.violation.remediated{org_id, notice_date, remediated_on, on_time}                     [mers_org — satisfies MERS_RULE7_VIOLATION_RESPONSE_30]
 *   mers.lockout.remediated{org_id, notice_date, penalties_paid=true}                          [mers_org — satisfies MERS_RULE7_LOCKOUT_WARNING_30]
 *   mers.annual_report.submitted{year, period_end, org_ids, both_org_ids=true}                 [mers_annual_report — satisfies MERS_ANNUAL_REPORT_1231]
 */
import { type PlainDate, addDays, addMonths, plainDate, ymd } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { isValidMin } from "../boarding/min.ts";
import { violationResponseDue } from "./custody-mers.ts";
import { type EscalationOpener, type MersTxnRow, SUPERMORTGAGE_ORG_ID, MERS_REGISTRATION_FEE_CENTS, mreMismatchFinding } from "./inbound.ts";

const MERS: Actor = { kind: "external", id: "mers" };
const MERSCORP: Actor = { kind: "external", id: "merscorp" };
const AGENT: Actor = { kind: "agent", id: "transfer" };
const batchAgg = (id: string) => ({ kind: "transfer_batch", id });
const txnAgg = (batchId: string, min: string) => ({ kind: "mers_txn", id: `${batchId}:${min}` });
const orgAgg = (id: string) => ({ kind: "mers_org", id });
const ORG_ID = /^\d{7}$/;
const requireOrgId = (orgId: string, what = "org_id"): string => { if (!ORG_ID.test(orgId)) throw new RangeError(`${what} ${JSON.stringify(orgId)} is not a 7-digit MERS Org ID`); return orgId; };
const pct = (n: number, of: number): number => (of ? Math.round((10_000 * n) / of) / 100 : 0);

// ============================================================ clocks and constants (1.5 timer table)
/** TOS confirmation window: +7 calendar days from the pending notice — **[UNVERIFIED]** (Procedures Manual TOS section; open question 2). */
export const TOS_CONFIRM_WINDOW_DAYS = 7;
export const tosConfirmBy = (noticeDate: PlainDate): PlainDate => addDays(noticeDate, TOS_CONFIRM_WINDOW_DAYS);
/** Rule 7 §1(e): the 30-day Lockout Warning Period that follows an unremediated Violation. */
export const RULE7_LOCKOUT_WARNING_DAYS = 30;
export const lockoutRemediateBy = (noticeDate: PlainDate): PlainDate => addDays(noticeDate, RULE7_LOCKOUT_WARNING_DAYS);
/** Annual Report: due Dec. 31 each year; independent third-party review at ≥ 1,000 active MINs (research/00b N1 **[PARTIALLY VERIFIED]**). */
export const ANNUAL_REPORT_THIRD_PARTY_REVIEW_MINS = 1000;
export const annualReportDue = (year: number): PlainDate => ymd(year, 12, 31);
/** MRE reconciliation cadence: monthly at ≥ 1,000 MINs, quarterly below **[PARTIALLY VERIFIED]** — the registry row's timer stays monthly. */
export const MRE_MONTHLY_MINS = 1000;
export const mreReconCadence = (mins: number): "monthly" | "quarterly" => (mins >= MRE_MONTHLY_MINS ? "monthly" : "quarterly");

// ============================================================ TOS (servicing_sale_with_sub): pending notices and confirmations
/** A MERS pending-transfer notice (MersPort.pendingTransfers row): the transferor initiated a TOS/TOB naming the partner as buyer. */
export interface PendingTransferNotice { readonly min: string; readonly fromOrgId: string; readonly type: "tos" | "tob"; readonly noticedAt: string; }
/** The notice's civil date: an ISO date as given, a timestamp on its Eastern-time date (MERS batch windows are ET). */
export function noticeDateOf(noticedAt: string): PlainDate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(noticedAt)) return plainDate(noticedAt);
  const ms = Date.parse(noticedAt); if (Number.isNaN(ms)) throw new RangeError(`noticedAt ${JSON.stringify(noticedAt)} is not a date or timestamp`);
  return wallClock(ms, "America/New_York").date;
}
export interface TosPendingResult { readonly expected: number; readonly received: number; readonly missing: string[]; readonly ignored: { min: string; reason: string }[]; readonly confirm_by: PlainDate | null; readonly all_mins: boolean; readonly batch_event: DomainEvent | null; readonly events: DomainEvent[]; }
/**
 * 1.5-T2 / MERS_PROC_TOS_INITIATE_T0: the seller initiates the TOS and MERS notices the buyer; each validated notice for a
 * planned MIN appends `mers.tos.pending_received` on the MIN (arming the 7-day confirmation clock per MIN, anchored on
 * `notice_date`), and once every planned MIN is noticed the batch-level event satisfies the T0 transferor duty. TOB
 * notices are ignored (the investor remains Fannie Mae), as are MINs outside the plan, invalid MINs and notices from an
 * Org ID other than the transferor's.
 */
export function recordTosPendingNotices(events: EventStore, batchId: string, plan: readonly MersTxnRow[], notices: readonly PendingTransferNotice[], opts: { seller_org_id?: string | null; previously_received?: readonly string[] } = {}, actor: Actor = MERS): TosPendingResult {
  const rows = plan.filter((r) => r.txn_type === "tos_confirm");
  if (!rows.length) throw new RangeError("no TOS is expected: only a servicing_sale_with_sub plan carries tos_confirm rows (1.5 rule 1)");
  if (!notices.length) throw new RangeError("no pending-transfer notices to record");
  const byMin = new Map(rows.map((r) => [r.min, r] as const));
  const seen = new Set((opts.previously_received ?? []).filter((m) => byMin.has(m)));
  const ignored: { min: string; reason: string }[] = []; const out: DomainEvent[] = []; let latest: PlainDate | null = null;
  for (const n of notices) {
    const reason = n.type !== "tos" ? "tob_not_applicable: the investor remains Fannie Mae, Supermortgage never confirms a TOB (1.5 rule 1)"
      : !isValidMin(n.min) ? "invalid MIN (HF-008)"
      : !byMin.has(n.min) ? "MIN is not in the batch plan"
      : opts.seller_org_id && n.fromOrgId !== opts.seller_org_id ? `initiated by ${n.fromOrgId}, not the transferor ${opts.seller_org_id}`
      : seen.has(n.min) ? "duplicate notice for a MIN already noticed" : null;
    if (reason) { ignored.push({ min: n.min, reason }); continue; }
    seen.add(n.min);
    const row = byMin.get(n.min)!; const notice_date = noticeDateOf(n.noticedAt); const confirm_by = tosConfirmBy(notice_date);
    if (!latest || notice_date > latest) latest = notice_date;
    out.push(events.append({ type: "mers.tos.pending_received", ...(row.loan_id ? { loanId: row.loan_id } : {}), aggregate: txnAgg(batchId, n.min), actor,
      payload: { batch_id: batchId, min: n.min, txn_type: "tos_initiate", from_org_id: n.fromOrgId, notice_date, confirm_by, effective_date: row.effective_date, all_mins: false } }));
  }
  const missing = rows.map((r) => r.min).filter((m) => !seen.has(m));
  const all = missing.length === 0 && latest !== null;
  const batch_event = all ? events.append({ type: "mers.tos.pending_received", aggregate: batchAgg(batchId), actor,
    payload: { batch_id: batchId, txn_type: "tos_initiate", all_mins: true, initiated_by: "transferor", notice_date: latest, confirm_by: tosConfirmBy(latest!), expected: rows.length, received: seen.size } }) : null;
  return { expected: rows.length, received: seen.size, missing, ignored, confirm_by: latest ? tosConfirmBy(latest) : null, all_mins: all, batch_event, events: out };
}
export interface TosConfirmResult { readonly confirmed: number; readonly rejected: number; readonly confirmed_pct: number; readonly exceptions: { min: string; kind: "mers_rejected"; reason: string }[]; readonly all_mins: boolean; readonly batch_event: DomainEvent | null; }
/**
 * MERS_PROC_TOS_CONFIRM_7: the buyer's confirmation (the partner under its Org ID, or Supermortgage under written
 * authorization) is acknowledged by MERS; an accepted confirmation is the `mers_transactions.status=confirmed` row and
 * appends `mers.txn.confirmed{txn_type=tos_confirm}` on the MIN, a rejected one `mers.txn.rejected` (→ 1.1 exception);
 * once every planned MIN is confirmed the batch-level event closes the batch's clock.
 */
export function recordTosConfirmations(events: EventStore, batchId: string, plan: readonly MersTxnRow[], results: readonly { min: string; accepted: boolean; reason?: string }[], confirmedOn: PlainDate, actor: Actor = MERS): TosConfirmResult {
  const rows = plan.filter((r) => r.txn_type === "tos_confirm");
  if (!rows.length) throw new RangeError("no TOS to confirm: only a servicing_sale_with_sub plan carries tos_confirm rows (1.5 rule 1)");
  if (!results.length) throw new RangeError("no confirmation results in the acknowledgment");
  const byMin = new Map(rows.map((r) => [r.min, r] as const));
  const exceptions: TosConfirmResult["exceptions"] = []; const confirmedMins = new Set<string>();
  for (const r of results) {
    const row = byMin.get(r.min);
    if (!row) { exceptions.push({ min: r.min, kind: "mers_rejected", reason: "MIN is not in the batch plan" }); continue; }
    const base = { batch_id: batchId, min: r.min, txn_type: "tos_confirm", effective_date: row.effective_date, all_mins: false };
    if (r.accepted) { confirmedMins.add(r.min); events.append({ type: "mers.txn.confirmed", ...(row.loan_id ? { loanId: row.loan_id } : {}), aggregate: txnAgg(batchId, r.min), actor, payload: { ...base, confirmed_at: confirmedOn } }); }
    else { const reason = r.reason ?? "rejected"; exceptions.push({ min: r.min, kind: "mers_rejected", reason }); events.append({ type: "mers.txn.rejected", ...(row.loan_id ? { loanId: row.loan_id } : {}), aggregate: txnAgg(batchId, r.min), actor, payload: { ...base, acked_at: confirmedOn, reason } }); }
  }
  const all = rows.every((r) => confirmedMins.has(r.min));
  const batch_event = all ? events.append({ type: "mers.txn.confirmed", aggregate: batchAgg(batchId), actor, payload: { batch_id: batchId, txn_type: "tos_confirm", all_mins: true, confirmed: confirmedMins.size, rejected: exceptions.length, confirmed_at: confirmedOn } }) : null;
  return { confirmed: confirmedMins.size, rejected: exceptions.length, confirmed_pct: pct(confirmedMins.size, results.length), exceptions, all_mins: all, batch_event };
}

// ============================================================ QA: Member Reconciliation Extract (MERS_QA_MRE_RECON_MONTHLY)
export interface MreExtract { readonly org_id: string; readonly as_of: PlainDate; readonly received_on: PlainDate; readonly rows: readonly { readonly min: string }[]; readonly document_id?: string | null; }
/** The MRE arrives (batch interface or MERS OnLine download): a non-empty extract of valid MINs for a Member Org ID appends `mers.mre.received`, which arms the reconciliation clock anchored on `received_on`. */
export function mreReceived(events: EventStore, x: MreExtract, actor: Actor = MERS): { event: DomainEvent; mins: number; cadence: "monthly" | "quarterly"; recon_due: PlainDate } {
  requireOrgId(x.org_id);
  if (!x.rows.length) throw new RangeError("an empty Member Reconciliation Extract is not a receipt");
  const bad = x.rows.filter((r) => !isValidMin(r.min)); if (bad.length) throw new RangeError(`${bad.length} MRE row(s) carry an invalid MIN (HF-008): ${bad.slice(0, 3).map((r) => r.min).join(", ")}`);
  const cadence = mreReconCadence(x.rows.length); const recon_due = addMonths(x.received_on, cadence === "monthly" ? 1 : 3);
  const event = events.append({ type: "mers.mre.received", aggregate: orgAgg(x.org_id), actor, payload: { org_id: x.org_id, as_of: x.as_of, received_on: x.received_on, mins: x.rows.length, cadence, recon_due, document_id: x.document_id ?? null } });
  return { event, mins: x.rows.length, cadence, recon_due };
}
export interface ReconRow { readonly min: string; readonly loan_id?: string | null; readonly system_of_record: Record<string, string>; readonly snapshot: Record<string, string>; readonly changing?: readonly string[]; }
export interface MreMismatchFindingRow { readonly kind: "mre_mismatch"; readonly min: string; readonly fields: string[]; readonly raised_at: PlainDate; readonly due_at: PlainDate; readonly resolved_at: null; }
export interface ReconResult { readonly org_id: string; readonly received_on: PlainDate; readonly mins: number; readonly clean: number; readonly blocked: string[]; readonly findings: MreMismatchFindingRow[]; readonly event: DomainEvent; }
/**
 * 1.5 rule 3 / 1.5-T3 over a whole extract: every MIN's system-of-record values are compared to its MERS snapshot; a
 * mismatch other than the field being changed opens `mers_qa_findings{mre_mismatch}` and blocks that MIN's update
 * until reconciled. The run appends one `mers.recon.completed` for the Org ID (the row's satisfaction; `received_on`
 * carries the extract's receipt so the recurring clock re-arms a month from it).
 */
export function reconcileExtract(events: EventStore, run: { org_id: string; received_on: PlainDate; rows: readonly ReconRow[] }, actor: Actor = AGENT): ReconResult {
  requireOrgId(run.org_id);
  if (!run.rows.length) throw new RangeError("nothing to reconcile: the run needs at least one MIN");
  const findings: MreMismatchFindingRow[] = []; const blocked: string[] = [];
  for (const r of run.rows) { const f = mreMismatchFinding(r.system_of_record, r.snapshot, r.changing ?? [], r.min, run.received_on); if (f.finding) { findings.push(f.finding); blocked.push(r.min); } }
  const event = events.append({ type: "mers.recon.completed", aggregate: orgAgg(run.org_id), actor,
    payload: { org_id: run.org_id, received_on: run.received_on, mins: run.rows.length, mismatches: findings.length, blocked_mins: [...blocked], findings: findings.map((f) => ({ min: f.min, fields: [...f.fields], due_at: f.due_at })) } });
  return { org_id: run.org_id, received_on: run.received_on, mins: run.rows.length, clean: run.rows.length - blocked.length, blocked, findings, event };
}

// ============================================================ Rule 7: lockout warning and remediations
/** Rule 7 §1(e): after the 30-day response period MERSCORP issues a Lockout Warning; a further 30 days to remediate and pay the penalties assessed. The notice arms MERS_RULE7_LOCKOUT_WARNING_30 and opens the `officer` task at once (sev 1). */
export function lockoutWarningReceived(events: EventStore, esc: EscalationOpener, notice: { notice_on: PlainDate; org_id: string; description: string; penalties_cents?: Cents | null; violation_notice_date?: PlainDate | null }, actor: Actor = MERSCORP): { remediate_by: PlainDate; officer_task_id: string; finding: { kind: "violation_notice"; stage: "lockout_warning"; raised_at: PlainDate; due_at: PlainDate; resolved_at: null }; event: DomainEvent } {
  requireOrgId(notice.org_id);
  if (!notice.description.trim()) throw new RangeError("a Lockout Warning names the Violation it warns about (description)");
  if (notice.violation_notice_date && notice.violation_notice_date > notice.notice_on) throw new RangeError("the Violation notice cannot postdate the Lockout Warning");
  const remediate_by = lockoutRemediateBy(notice.notice_on);
  const event = events.append({ type: "mers.lockout_warning.received", aggregate: orgAgg(notice.org_id), actor,
    payload: { notice_date: notice.notice_on, org_id: notice.org_id, description: notice.description, penalties_cents: notice.penalties_cents ?? null, violation_notice_date: notice.violation_notice_date ?? null, remediate_by } });
  const task = esc.open({ kind: "officer", severity: "sev-1", payload: { task: "mers_rule7_lockout_remediation", notice_date: notice.notice_on, remediate_by, description: notice.description, penalties_cents: notice.penalties_cents ?? null } }, AGENT);
  return { remediate_by, officer_task_id: task.id, finding: { kind: "violation_notice", stage: "lockout_warning", raised_at: notice.notice_on, due_at: remediate_by, resolved_at: null }, event };
}
/** Rule 7 §1(b): the response filed and the Violation remediated within the 30 days — an `officer` act (1.5 escalations) evidenced by the response document; appends `mers.violation.remediated` on the Org ID, closing MERS_RULE7_VIOLATION_RESPONSE_30 and resolving the `violation_notice` finding. */
export function violationRemediated(events: EventStore, r: { org_id: string; notice_date: PlainDate; remediated_on: PlainDate; response_document_id: string; summary?: string | null }, actor: Actor): { response_due: PlainDate; on_time: boolean; finding_resolution: { kind: "violation_notice"; raised_at: PlainDate; resolved_at: PlainDate }; event: DomainEvent } {
  requireOrgId(r.org_id);
  if (!r.response_document_id) throw new RangeError("the remediation is evidenced by the response filed with MERSCORP (response_document_id)");
  if (r.remediated_on < r.notice_date) throw new RangeError(`remediated_on ${r.remediated_on} precedes the Violation notice of ${r.notice_date}`);
  const response_due = violationResponseDue(r.notice_date); const on_time = r.remediated_on <= response_due;
  const event = events.append({ type: "mers.violation.remediated", aggregate: orgAgg(r.org_id), actor,
    payload: { org_id: r.org_id, notice_date: r.notice_date, remediated_on: r.remediated_on, response_due, on_time, response_document_id: r.response_document_id, summary: r.summary ?? null } });
  return { response_due, on_time, finding_resolution: { kind: "violation_notice", raised_at: r.notice_date, resolved_at: r.remediated_on }, event };
}
/** Rule 7 §1(e): a Lockout Warning is lifted only by remediation *and* payment of the penalties assessed — `mers.lockout.remediated{penalties_paid=true}`; a remediation without the payment is refused rather than recorded as satisfaction. */
export function lockoutRemediated(events: EventStore, r: { org_id: string; notice_date: PlainDate; remediated_on: PlainDate; penalties_paid: boolean; penalties_paid_cents?: Cents | null; evidence_document_id: string }, actor: Actor): { remediate_by: PlainDate; on_time: boolean; event: DomainEvent } {
  requireOrgId(r.org_id);
  if (!r.evidence_document_id) throw new RangeError("the lockout remediation is evidenced by MERSCORP's confirmation (evidence_document_id)");
  if (!r.penalties_paid) throw new RangeError("Rule 7 §1(e): a Lockout Warning is lifted only by remediation and payment of the penalties assessed — record the payment first");
  if (r.remediated_on < r.notice_date) throw new RangeError(`remediated_on ${r.remediated_on} precedes the Lockout Warning of ${r.notice_date}`);
  const remediate_by = lockoutRemediateBy(r.notice_date); const on_time = r.remediated_on <= remediate_by;
  const event = events.append({ type: "mers.lockout.remediated", aggregate: orgAgg(r.org_id), actor,
    payload: { org_id: r.org_id, notice_date: r.notice_date, remediated_on: r.remediated_on, remediate_by, on_time, penalties_paid: true, penalties_paid_cents: r.penalties_paid_cents ?? null, evidence_document_id: r.evidence_document_id } });
  return { remediate_by, on_time, event };
}

// ============================================================ Annual Report (MERS_ANNUAL_REPORT_1231)
export interface AnnualReportSubmission { readonly year: number; readonly org_ids: readonly string[]; readonly submitted_on: PlainDate; readonly package_document_id: string; readonly officer_signature_document_id: string | null; readonly active_mins: number; readonly third_party_review_document_id?: string | null; }
/** What stops an Annual Report submission: both Org IDs (the partner's and Supermortgage's), the `officer` signature (1.5 escalations), the package, and the independent third-party review at ≥ 1,000 active MINs. */
export function annualReportChecks(s: AnnualReportSubmission): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(s.year) || s.year < 2000 || s.year > 2100) problems.push(`year ${String(s.year)} is not a reporting year`);
  const ids = [...new Set(s.org_ids)];
  if (ids.length !== 2 || ids.some((id) => !ORG_ID.test(id))) problems.push("the Annual Report covers both Org IDs — the partner's and Supermortgage's 7-digit MERS Org IDs");
  else if (!ids.includes(SUPERMORTGAGE_ORG_ID)) problems.push(`Supermortgage's Org ID ${SUPERMORTGAGE_ORG_ID} is one of the two Org IDs reported`);
  if (!s.package_document_id) problems.push("the Annual Report package (package_document_id) is required");
  if (!s.officer_signature_document_id) problems.push("the Annual Report is signed by the `officer` before submission (officer_signature_document_id)");
  if (!Number.isInteger(s.active_mins) || s.active_mins < 0) problems.push("active_mins is the count of active MINs at year end");
  else if (s.active_mins >= ANNUAL_REPORT_THIRD_PARTY_REVIEW_MINS && !s.third_party_review_document_id) problems.push(`an independent third-party review is required at ≥ ${ANNUAL_REPORT_THIRD_PARTY_REVIEW_MINS} active MINs (third_party_review_document_id)`);
  return problems;
}
/** The signed Annual Report for both Org IDs is submitted to MERSCORP: `mers.annual_report.submitted{both_org_ids=true, period_end}` (due Dec. 31 of `year`; `period_end` anchors the next cycle's re-arm). */
export function submitAnnualReport(events: EventStore, s: AnnualReportSubmission, actor: Actor): { due_on: PlainDate; on_time: boolean; third_party_review_required: boolean; event: DomainEvent } {
  const problems = annualReportChecks(s); if (problems.length) throw new RangeError(problems.join("; "));
  const due_on = annualReportDue(s.year); const on_time = s.submitted_on <= due_on; const ids = [...new Set(s.org_ids)];
  const event = events.append({ type: "mers.annual_report.submitted", aggregate: { kind: "mers_annual_report", id: String(s.year) }, actor,
    payload: { year: s.year, period_end: due_on, org_ids: ids, both_org_ids: true, submitted_on: s.submitted_on, due_on, on_time, active_mins: s.active_mins, third_party_review: !!s.third_party_review_document_id, package_document_id: s.package_document_id, officer_signature_document_id: s.officer_signature_document_id } });
  return { due_on, on_time, third_party_review_required: s.active_mins >= ANNUAL_REPORT_THIRD_PARTY_REVIEW_MINS, event };
}

// ============================================================ fees (1.5 rule 5) and submit authorization (decision 1)
export interface MersFeeLine { readonly min: string; readonly txn_type: string; readonly amount_cents: Cents; }
/** MERS transfers (MIN Updates, TOS/TOB) are free; each registration is $24.95 MOM/Non-MOM — accrued to the partner's MERS invoice, never charged to the borrower. */
export function mersBatchFees(rows: readonly { min: string; txn_type: string }[], partnerId: string): { registrations: number; transfers: number; total_cents: Cents; bill_to: string; borrower_charge: false; lines: MersFeeLine[] } {
  if (!rows.length) throw new RangeError("no MERS transactions to price");
  if (!partnerId) throw new RangeError("the partner whose MERS invoice accrues the fees is required");
  const lines = rows.map((r): MersFeeLine => ({ min: r.min, txn_type: r.txn_type, amount_cents: r.txn_type === "registration" ? MERS_REGISTRATION_FEE_CENTS : 0n }));
  const registrations = lines.filter((l) => l.amount_cents > 0n).length;
  return { registrations, transfers: lines.length - registrations, total_cents: lines.reduce((s, l) => s + l.amount_cents, 0n), bill_to: `partner:${partnerId}:mers_invoice`, borrower_charge: false, lines };
}
/** Decision 1: Supermortgage submits under its own Org ID only what it is authorized to perform; rows the partner submits under its Org ID (buyer-side TOS confirmations) go through with the partner's written authorization, else to `createPartnerTask`. */
export function submitAuthorization(rows: readonly { min: string; txn_type?: string; submitted_by_org_id?: string; orgId?: string }[], partnerAuthorizationDocumentId?: string | null): { authorized: typeof rows; needs_partner_task: typeof rows; partner_org_rows: number } {
  const isOwn = (r: (typeof rows)[number]) => (r.submitted_by_org_id ?? r.orgId ?? SUPERMORTGAGE_ORG_ID) === SUPERMORTGAGE_ORG_ID;
  const partner = rows.filter((r) => !isOwn(r));
  return partnerAuthorizationDocumentId ? { authorized: rows, needs_partner_task: [], partner_org_rows: partner.length } : { authorized: rows.filter(isOwn), needs_partner_task: partner, partner_org_rows: partner.length };
}
