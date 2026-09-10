/**
 * §15.2 Expense reimbursement submission — rule functions on top of ./claims.ts:
 * the nightly candidate sweep (rule 1), itemization/quantity bundles (rule 5, worked example rule 9),
 * milestone billing (E-5-05; 15.2-T5), claim assembly into the decision record (Agents paragraph),
 * the bulk package with the NPI screen (15.2-T13), the channel fallback (15.2-T11), PSA/ACH outcomes
 * (15.2-T6/T8), the deferral claim (15.2-T12), recovered-advance repayment batches (rule 8; 15.2-T9)
 * and the denial-briefing / write-off thresholds (guardrails; open question 4).
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { validateLine, finalDueAt, claimTotals, psaClocks, achExpected, attachmentContainsSsn, type ClaimLine, type ClaimContext, type LineValidation } from "./claims.ts";

// ---- rule 1 / schedules: nightly claim-candidate sweep -------------------------------------------------
export type AdvanceKind = "escrow_tax" | "escrow_hazard" | "escrow_flood" | "hoa" | "mi_premium" | "inspection" | "preservation" | "registration" | "utilities" | "attorney_fee_fcl" | "attorney_fee_bk" | "legal_cost" | "recording" | "valuation" | "mediation" | "technology_fee" | "einvoice_fee" | "workout_expense" | "delinquency_pi" | "other";
export interface AdvanceRow {
  readonly id: string; readonly loan_id: string; readonly kind: AdvanceKind; readonly amount_cents: Cents;
  readonly paid_at: PlainDate | null; readonly invoice_document_id: string | null; readonly allowable_code: string | null;
  readonly borrower_recoverable: boolean;
  /** Collected from the borrower at reinstatement/payoff/workout → `advance_recoveries`, no claim. */
  readonly collected_from_borrower?: boolean;
  /** Recoverable but left out of the reinstatement/payoff figure by our error (E-5-05). */
  readonly omitted_from_payoff_figure?: boolean;
  readonly claim_line_id?: string | null;
}
export type SweepSkipReason = "not_paid" | "missing_invoice" | "already_claimed" | "collected_from_borrower" | "e505_not_included" | "pi_advances_not_claimable";
export interface SweepResult { readonly candidates: readonly AdvanceRow[]; readonly skipped: readonly { advance_id: string; reason: SweepSkipReason }[]; readonly by_loan: Readonly<Record<string, Cents>>; }

/** Rule 1 — a line is claimable iff paid (invoice retained), not yet claimed, not collected from the borrower and not omitted by our error. */
export function sweepClaimCandidates(advances: readonly AdvanceRow[]): SweepResult {
  const candidates: AdvanceRow[] = []; const skipped: { advance_id: string; reason: SweepSkipReason }[] = []; const byLoan: Record<string, Cents> = {};
  for (const a of advances) {
    const reason: SweepSkipReason | null =
      a.kind === "delinquency_pi" ? "pi_advances_not_claimable"
      : a.claim_line_id ? "already_claimed"
      : a.collected_from_borrower ? "collected_from_borrower"
      : a.borrower_recoverable && a.omitted_from_payoff_figure ? "e505_not_included"
      : a.paid_at === null ? "not_paid"
      : a.invoice_document_id === null ? "missing_invoice" : null;
    if (reason) { skipped.push({ advance_id: a.id, reason }); continue; }
    candidates.push(a); byLoan[a.loan_id] = (byLoan[a.loan_id] ?? 0n) + a.amount_cents;
  }
  return { candidates, skipped, by_loan: byLoan };
}

// ---- rule 5: itemization and quantity ------------------------------------------------------------------
export interface ItemizedInput { readonly label: string; readonly unit_cents: Cents; readonly quantity: number; }
export interface ItemizedLine extends ItemizedInput { readonly amount_cents: Cents; }
/** Rule 5 — unit price × quantity = amount (cents, no rounding); quantities are whole numbers. */
export function itemize(items: readonly ItemizedInput[]): { lines: readonly ItemizedLine[]; total_cents: Cents } {
  const lines = items.map((it) => {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new RangeError(`quantity for ${it.label} must be a positive whole number (Job Aid)`);
    return { ...it, amount_cents: it.unit_cents * BigInt(it.quantity) };
  });
  return { lines, total_cents: lines.reduce((s, l) => s + l.amount_cents, 0n) };
}

// ---- E-5-05 milestone billing (15.2-T5) ------------------------------------------------------------------
export const JUDICIAL_MILESTONES: Readonly<Record<string, number>> = { title_requested: 30, title_reviewed: 40, complaint_filed: 50, service_started: 60, service_complete: 70, judgment_prepared: 80, judgment_to_court: 90, bid_confirmed: 95, sale_held: 100 };
export const NON_JUDICIAL_MILESTONES: Readonly<Record<string, number>> = { title_requested: 30, title_reviewed: 65, notices_started: 75, first_legal: 85, sale_package: 95, sale_held: 100 };
export interface MilestoneInvoice { readonly milestone: string; readonly invoice_cents: Cents; }
export interface MilestoneBill { readonly milestone: string; readonly cumulative_pct: number; readonly earned_cents: Cents; readonly fee_line_cents: Cents; readonly over_cents: Cents; }
/** E-5-05 — fees are earned at established milestones (cumulative % of the exhibit) and never prorated between milestones. */
export function milestoneBilling(exhibitCents: Cents, track: "judicial" | "non_judicial", invoices: readonly MilestoneInvoice[]): { bills: readonly MilestoneBill[]; total_fee_cents: Cents } {
  const sched = track === "judicial" ? JUDICIAL_MILESTONES : NON_JUDICIAL_MILESTONES;
  let billedPct = 0; let total = 0n; const bills: MilestoneBill[] = [];
  for (const inv of invoices) {
    const pct = sched[inv.milestone];
    if (pct === undefined) throw new RangeError(`${inv.milestone} is not an E-5-05 ${track} milestone — fees are not prorated between milestones`);
    const cumulative = Decimal.fromBigInt(exhibitCents).mul(Decimal.fromInt(pct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
    const previously = Decimal.fromBigInt(exhibitCents).mul(Decimal.fromInt(billedPct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
    const earned = cumulative - previously;
    const feeLine = inv.invoice_cents < earned ? inv.invoice_cents : earned;
    bills.push({ milestone: inv.milestone, cumulative_pct: pct, earned_cents: earned, fee_line_cents: feeLine, over_cents: inv.invoice_cents > earned ? inv.invoice_cents - earned : 0n });
    billedPct = Math.max(billedPct, pct); total += feeLine;
  }
  return { bills, total_fee_cents: total };
}

// ---- claim assembly → decision record -------------------------------------------------------------------
export type ClaimType = "571" | "fnma_mod" | "npl" | "hecm" | "recon" | "sol";
export type MilestoneKind = "workout_completed" | "shortsale_closed" | "deferral_completed" | "tps_completed" | "reinstatement" | "payoff" | "reo_disposition" | "mortgage_release" | "foreclosure_sale" | "govt_claim_proceeds";
export interface AssembleInput {
  readonly loan_id: string; readonly claim_type: ClaimType; readonly milestone_kind: MilestoneKind; readonly milestone_date: PlainDate;
  readonly mi_insured: boolean; readonly disposition_date: PlainDate | null;
  readonly lines: readonly (ClaimLine & { readonly advance_id: string; readonly evidence_ids?: readonly string[] })[];
  readonly credits: readonly { kind: "hazard_refund" | "flood_refund" | "mi_refund" | "borrower_collection" | "escrow_balance" | "rents" | "other"; amount_cents: Cents; received_at: PlainDate }[];
  readonly context: ClaimContext;
  /** E-4.4-02: a hazard refund is expected on this liquidation. */
  readonly hazard_refund_expected?: boolean;
  /** E-4.4-02: the carrier refused the refund; the comment goes on the final claim instead of a credit line. */
  readonly refund_refusal_comment?: string | null;
  readonly interim?: boolean;
}
export interface DecisionLine { readonly advance_id: string; readonly code: string; readonly amount: Cents; readonly cap: Cents | null; readonly validation: "pass" | "fail"; readonly indicator: "blank" | "non_recoverable" | "not_yet_recovered"; readonly evidence_ids: readonly string[]; readonly messages: readonly string[]; }
export interface ClaimDecision {
  readonly loan_id: string; readonly claim_type: ClaimType; readonly milestone: MilestoneKind; readonly milestone_date: PlainDate;
  readonly final_due_at: PlainDate | null; readonly policy_due_at: PlainDate; readonly internal_target_at: PlainDate;
  readonly lines: readonly DecisionLine[]; readonly credits: readonly AssembleInput["credits"][number][];
  readonly gross: Cents; readonly net: Cents; readonly status: "draft" | "validated"; readonly exceptions: readonly string[]; readonly interim: boolean;
  readonly e4402_comment: string | null;
}
const LIQUIDATION: ReadonlySet<MilestoneKind> = new Set(["reo_disposition", "tps_completed", "shortsale_closed", "mortgage_release", "foreclosure_sale"]);
const kindOf = (m: MilestoneKind): Parameters<typeof finalDueAt>[0]["kind"] => (m === "reo_disposition" || m === "foreclosure_sale" ? "reo" : m === "tps_completed" ? "tps" : m === "shortsale_closed" ? "short_sale" : m === "mortgage_release" ? "mortgage_release" : "workout");

/** Agents paragraph — the decision record `{claim, milestone, final_due_at, lines[], credits[], gross, net, exceptions[]}`; rule 1 sets the indicator; E-4.4-02 blocks a final claim without the refund credit or refusal comment. */
export function assembleClaim(i: AssembleInput): ClaimDecision {
  const due = finalDueAt({ event_date: i.milestone_date, mi_insured: i.mi_insured, disposition_date: i.disposition_date, kind: kindOf(i.milestone_kind) });
  const validations: LineValidation[] = i.lines.map((l) => validateLine(l, i.context));
  const lines: DecisionLine[] = i.lines.map((l, k) => { const v = validations[k]!; return { advance_id: l.advance_id, code: v.allowable_code, amount: v.amount_cents, cap: v.cap_cents, validation: v.ok ? "pass" : "fail", indicator: LIQUIDATION.has(i.milestone_kind) ? "blank" : "not_yet_recovered", evidence_ids: l.evidence_ids ?? [], messages: v.messages }; });
  const totals = claimTotals(validations, i.credits.map((c) => c.amount_cents));
  const exceptions = lines.filter((l) => l.validation === "fail").map((l) => `${l.advance_id}: ${l.messages.join(", ")}`);
  const hasHazardCredit = i.credits.some((c) => c.kind === "hazard_refund");
  const refusal = i.refund_refusal_comment ?? null;
  if (i.hazard_refund_expected && !i.interim && !hasHazardCredit && !refusal) exceptions.push("FNMA_E4402_REFUND_CREDIT_ON_FINAL: credit line missing and no refusal comment (E-4.4-02)");
  return { loan_id: i.loan_id, claim_type: i.claim_type, milestone: i.milestone_kind, milestone_date: i.milestone_date, final_due_at: due.final_due, policy_due_at: due.policy_due, internal_target_at: due.internal_target,
    lines, credits: [...i.credits], gross: totals.gross_cents, net: totals.net_cents, status: exceptions.length === 0 ? "validated" : "draft", exceptions, interim: i.interim ?? false, e4402_comment: !hasHazardCredit && refusal ? refusal : null };
}

// ---- bulk package + NPI screen (15.2-T13; Job Aid limits) ------------------------------------------------
export interface Attachment { readonly name: string; readonly line_index: number; readonly text: string; }
export interface BulkPackage {
  readonly ok: boolean; readonly blocked_by: readonly string[]; readonly findings: readonly { attachment: string; finding: "ssn_detected" }[];
  readonly xlsx_rows: readonly Record<string, unknown>[]; readonly json: { claim_number: string; line_count: number; attachment_names: readonly string[] }; readonly manifest: readonly string[];
}
const MAX_LINES = 100, MAX_ATTACHMENTS_PER_LINE = 5;
/** Job Aid — ZIP = .XLSX (Claims tab) + generated .JSON + attachments named per the manifest; ≤100 lines, ≤5 attachments per line; NPI must be removed (SSN screen blocks the package and logs the finding). */
export function buildBulkPackage(claim: ClaimDecision, claimNumber: string, attachments: readonly Attachment[]): BulkPackage {
  const blocked: string[] = []; const findings: { attachment: string; finding: "ssn_detected" }[] = [];
  if (claim.status !== "validated") blocked.push(`claim is ${claim.status}: ${claim.exceptions.join("; ")}`);
  if (claim.lines.length > MAX_LINES) blocked.push(`line count ${claim.lines.length} exceeds ${MAX_LINES} per claim`);
  const perLine = new Map<number, number>();
  for (const a of attachments) {
    perLine.set(a.line_index, (perLine.get(a.line_index) ?? 0) + 1);
    if (attachmentContainsSsn(a.text)) { findings.push({ attachment: a.name, finding: "ssn_detected" }); }
  }
  for (const [ix, n] of perLine) if (n > MAX_ATTACHMENTS_PER_LINE) blocked.push(`line ${ix} has ${n} attachments (max ${MAX_ATTACHMENTS_PER_LINE})`);
  if (findings.length) blocked.push(`redaction check failed: ${findings.map((f) => f.attachment).join(", ")} contain NPI`);
  const names = attachments.map((a) => a.name);
  const rows = claim.lines.map((l, k) => ({ claim_number: claimNumber, claim_type: claim.claim_type, line: k + 1, expense_code: l.code, amount_cents: l.amount, attachment_names: attachments.filter((a) => a.line_index === k).map((a) => a.name).join(";") }));
  return { ok: blocked.length === 0, blocked_by: blocked, findings, xlsx_rows: rows, json: { claim_number: claimNumber, line_count: claim.lines.length, attachment_names: names }, manifest: [`${claimNumber}.xlsx`, `${claimNumber}.json`, ...names] };
}

// ---- channel selection / API fallback (15.2-T11; Integrations "Failure") ---------------------------------
export interface ChannelInput { readonly api_credentialed: boolean; readonly api_status: number | null; readonly bulk_available?: boolean; readonly today: PlainDate; readonly final_due_at: PlainDate | null; readonly line_count: number; }
export interface ChannelDecision {
  readonly channel: "api" | "bulk_upload" | "single_entry"; readonly package_generated: boolean;
  readonly portal_task: { kind: "human_portal_task"; task: "p360.claims.bulk_upload" | "p360.claims.single_entry"; owner: "fnma_portal_operator"; opened_on: PlainDate; deadline_shown: PlainDate | null } | null;
  readonly fallback_by: PlainDate | null; readonly irt_late_filing_dispute: boolean; readonly screenshots_required: boolean; readonly reason: string;
}
/** 15.2-T11 — a 5xx from the Expense Claims API falls back to the bulk ZIP and a same-day portal task showing the deadline; on the deadline day with bulk down, single entry (≤3 lines) + screenshots + IRT dispute. */
export function submissionChannel(i: ChannelInput): ChannelDecision {
  const fallbackBy = i.final_due_at === null ? null : addDays(i.final_due_at, -5);
  const apiUp = i.api_credentialed && i.api_status !== null && i.api_status >= 200 && i.api_status < 300;
  if (apiUp) return { channel: "api", package_generated: false, portal_task: null, fallback_by: fallbackBy, irt_late_filing_dispute: false, screenshots_required: false, reason: "Expense Claims API accepted the payload" };
  const bulkUp = i.bulk_available ?? true;
  if (bulkUp) {
    return { channel: "bulk_upload", package_generated: true, portal_task: { kind: "human_portal_task", task: "p360.claims.bulk_upload", owner: "fnma_portal_operator", opened_on: i.today, deadline_shown: i.final_due_at }, fallback_by: fallbackBy, irt_late_filing_dispute: false, screenshots_required: false,
      reason: i.api_credentialed ? `API returned ${i.api_status ?? "no response"} on ${i.today} — bulk package generated` : "API not credentialed — bulk-upload launch channel" };
  }
  const deadlineDay = i.final_due_at !== null && i.today >= i.final_due_at;
  if (i.line_count <= 3 || deadlineDay) {
    return { channel: "single_entry", package_generated: false, portal_task: { kind: "human_portal_task", task: "p360.claims.single_entry", owner: "fnma_portal_operator", opened_on: i.today, deadline_shown: i.final_due_at }, fallback_by: fallbackBy, irt_late_filing_dispute: deadlineDay, screenshots_required: deadlineDay, reason: deadlineDay ? "P360 bulk path down on the deadline day — single-entry attempt with screenshots; IRT late-filing dispute" : "bulk path down; ≤3 lines entered singly" };
  }
  return { channel: "bulk_upload", package_generated: true, portal_task: { kind: "human_portal_task", task: "p360.claims.bulk_upload", owner: "fnma_portal_operator", opened_on: i.today, deadline_shown: i.final_due_at }, fallback_by: fallbackBy, irt_late_filing_dispute: false, screenshots_required: false, reason: "bulk path down; package staged for re-upload the same day (claim age not yet started)" };
}

// ---- PSA (15.2-T6) and ACH (15.2-T8) outcomes -------------------------------------------------------------
export function psaOutcome(enteredOn: PlainDate, respondedOn: PlainDate | null, today: PlainDate): { internal_due: PlainDate; response_due: PlainDate; status: "psa" | "submitted" | "denied"; severity: "sev1" | "sev2" | null; auto_denied: boolean } {
  const c = psaClocks(enteredOn);
  if (respondedOn !== null && respondedOn <= c.response_due) return { ...c, status: "submitted", severity: null, auto_denied: false };
  if (today > c.response_due) return { ...c, status: "denied", severity: "sev1", auto_denied: true };
  return { ...c, status: "psa", severity: today > c.internal_due ? "sev2" : null, auto_denied: false };
}
export const FNMA_REO_DISBURSEMENTS_MAILBOX = "FannieMae_REO_Disbursements@fanniemae.com";
export function achMatchOutcome(paidOn: PlainDate, matchedOn: PlainDate | null, today: PlainDate, cal: Calendar = fannieEt): { expected: PlainDate; escalate_after: PlainDate; status: "paid" | "awaiting_ach" | "unmatched"; escalation: { severity: "sev2"; package_to: string } | null } {
  const a = achExpected(paidOn, cal);
  if (matchedOn !== null) return { ...a, status: "paid", escalation: null };
  if (today > a.escalate_after) return { ...a, status: "unmatched", escalation: { severity: "sev2", package_to: FNMA_REO_DISBURSEMENTS_MAILBOX } };
  return { ...a, status: "awaiting_ach", escalation: null };
}

// ---- payment deferral / capitalized advances (15.2-T12) --------------------------------------------------
export const CAPITALIZED_ADVANCE_CLAIM_FROM: PlainDate = "2023-10-01" as PlainDate;
export function deferralExpenseClaim(i: { completed_on: PlainDate; closed_on: PlainDate; lines: readonly ItemizedInput[] }): { claim_type: ClaimType; due_at: PlainDate; capitalized_advance_rule: "claim_required_no_auto_generation" | "auto_generated"; total_cents: Cents; expense_type: string } {
  const it = itemize(i.lines);
  return { claim_type: "fnma_mod", due_at: addDays(i.completed_on, 60), capitalized_advance_rule: i.closed_on >= CAPITALIZED_ADVANCE_CLAIM_FROM ? "claim_required_no_auto_generation" : "auto_generated", total_cents: it.total_cents, expense_type: "General Services – Post Payoff PD Reimbursement" };
}

// ---- rule 8: recovered-advance repayment batch (15.2-T9) -------------------------------------------------
export interface ReimbursedAdvance { readonly advance_id: string; readonly reimbursed_cents: Cents; readonly reimbursed_on: PlainDate; }
export function recoveryRepaymentBatch(i: { completion_on: PlainDate; source: "borrower_reinstatement" | "payoff" | "repurchase"; collected_cents: Cents; reimbursed: readonly ReimbursedAdvance[] }): { crs_code: "353" | "352"; fnma_repay_due_at: PlainDate; recoveries: readonly { advance_id: string; amount_cents: Cents }[]; total_cents: Cents } {
  const fifo = [...i.reimbursed].sort((a, b) => (a.reimbursed_on < b.reimbursed_on ? -1 : a.reimbursed_on > b.reimbursed_on ? 1 : 0));
  let left = i.collected_cents; const recoveries: { advance_id: string; amount_cents: Cents }[] = [];
  for (const r of fifo) { if (left <= 0n) break; const take = r.reimbursed_cents < left ? r.reimbursed_cents : left; recoveries.push({ advance_id: r.advance_id, amount_cents: take }); left -= take; }
  return { crs_code: i.source === "borrower_reinstatement" ? "353" : "352", fnma_repay_due_at: addDays(i.completion_on, 60), recoveries, total_cents: recoveries.reduce((s, r) => s + r.amount_cents, 0n) };
}

// ---- guardrail thresholds ----------------------------------------------------------------------------------
export const OFFICER_DENIAL_BRIEFING_CENTS: Cents = 500_000n;
export const AGENT_WRITE_OFF_LINE_CAP_CENTS: Cents = 50_000n;
/** Agents paragraph — denials > $5,000 per loan (or a systematic pattern) → `officer` briefing. */
export function denialBriefing(denials: readonly { loan_id: string; amount_cents: Cents; reason: string }[]): { per_loan: Readonly<Record<string, Cents>>; officer_briefing: boolean; loans_over_threshold: readonly string[]; systematic_reason: string | null } {
  const perLoan: Record<string, Cents> = {}; const byReason: Record<string, number> = {};
  for (const d of denials) { perLoan[d.loan_id] = (perLoan[d.loan_id] ?? 0n) + d.amount_cents; byReason[d.reason] = (byReason[d.reason] ?? 0) + 1; }
  const over = Object.entries(perLoan).filter(([, c]) => c > OFFICER_DENIAL_BRIEFING_CENTS).map(([l]) => l);
  const systematic = Object.entries(byReason).find(([, n]) => n >= 3)?.[0] ?? null;
  return { per_loan: perLoan, officer_briefing: over.length > 0 || systematic !== null, loans_over_threshold: over, systematic_reason: systematic };
}
/** Open question 4 default — agent ≤ $500/line; `officer` above. */
export function writeOffAuthority(lineCents: Cents): "agent" | "officer" { return lineCents <= AGENT_WRITE_OFF_LINE_CAP_CENTS ? "agent" : "officer"; }

/** Rule 10 — curable denials go to IRT within 5 BD; the Fannie Mae response starts the 7-day reply clock. */
export function irtInquiryDue(deniedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(deniedOn, 5, cal); }
