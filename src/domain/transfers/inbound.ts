/**
 * Transfer-in case mechanics the 1.2–1.7 acceptance tests exercise beyond the
 * date arithmetic in batch.ts/respa.ts/custody-mers.ts: the batch state
 * machine and its evidence gates, portal-task SLAs, consent parsing, loan-list
 * versions and the CD25 attestation, notice-run release and recipients,
 * eNote servicing-agent verification and the payoff block, recert forecasts,
 * MERS acknowledgement ingestion, loan-level reconciliation, Escrow Setup
 * acknowledgements, the CO-* carry-over checks, the denial review gate and
 * the rule-set re-issue of (k) timers.
 */
import { addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { recertDeadline } from "./custody-mers.ts";
import type { Cents } from "../../kernel/money/cents.ts";

// ---- 1.2 batch state machine ------------------------------------------------
export type BatchStatus = "proposed" | "package_ready" | "submitted" | "info_requested" | "approved" | "loan_list_frozen" | "pre_boarding" | "notice_window" | "cutover" | "post_transfer" | "closed" | "denied" | "withdrawn" | "on_hold";
export interface BatchEvidence {
  readonly first_batch_for_partner?: boolean;
  readonly form101_document_id?: string | null;
  readonly form629_document_id?: string | null;
  readonly loan_list_version?: number;
  readonly custodian_matrix_document_id?: string | null;
  readonly dq_precheck_passed?: boolean;
  readonly portal_completion_record_id?: string | null;   // fnma_portal_operator completion
  readonly consent_document_hash?: string | null;
  readonly consent_conditions?: readonly string[];
  readonly officer_confirmed_conditions?: boolean;
  readonly officer_attestation_document_id?: string | null;
}
const NEXT: Partial<Record<BatchStatus, readonly BatchStatus[]>> = {
  proposed: ["package_ready", "withdrawn"], package_ready: ["submitted", "withdrawn"], submitted: ["info_requested", "approved", "denied", "on_hold"], info_requested: ["submitted", "denied"],
  approved: ["loan_list_frozen", "withdrawn"], loan_list_frozen: ["pre_boarding"], pre_boarding: ["notice_window"], notice_window: ["cutover"], cutover: ["post_transfer"], post_transfer: ["closed"], on_hold: ["submitted", "withdrawn"],
};
/** Why a transition is refused, or null when its evidence gate is met (1.2 state machine). */
export function batchTransitionBlock(from: BatchStatus, to: BatchStatus, ev: BatchEvidence): string | null {
  if (!(NEXT[from] ?? []).includes(to)) return `no transition ${from} → ${to}`;
  switch (to) {
    case "package_ready":
      if (ev.first_batch_for_partner && !ev.form101_document_id) return "FNMA_A2_1_07_FORM101_INCEPTION: no Form 101 evidence for the partner's first batch";
      if (!ev.form629_document_id) return "Form 629 not attached";
      if (!ev.loan_list_version) return "loan list missing";
      if (!ev.custodian_matrix_document_id) return "Custodian Matrix not attached";
      if (ev.dq_precheck_passed !== true) return "DQ pre-check on the loan list has not passed";
      return null;
    case "submitted": return ev.portal_completion_record_id ? null : "submitted requires a fnma_portal_operator completion record";
    case "approved":
      if (!ev.consent_document_hash) return "approved requires the consent document hash";
      if ((ev.consent_conditions?.length ?? 0) > 0 && ev.officer_confirmed_conditions !== true) return "consent carries conditions: an officer must confirm the parsed D-Code and conditions";
      return null;
    case "loan_list_frozen": return ev.officer_attestation_document_id ? null : "loan_list_frozen requires the partner officer's attestation evidence";
    default: return null;
  }
}

/** Portal task SLA (1.2-T5): +2 servicer business days from assignment; past that an officer escalation is due and the batch report shows the breach. */
export function portalTaskStatus(assignedOn: PlainDate, today: PlainDate): { due: PlainDate; breached: boolean; escalation: "officer" | null } {
  const due = addBusinessDays(assignedOn, 2, servicer);
  const breached = today > due;
  return { due, breached, escalation: breached ? "officer" : null };
}

/** Consent notice parsing (1.2-T6): outcome, D-Code, effective date and any conditions; conditions block `approved` until an officer confirms. */
export function parseConsentNotice(text: string): { outcome: "approved" | "denied" | "unclear"; d_code: string | null; effective_date: string | null; conditions: string[]; officer_confirmation_required: boolean } {
  const denied = /\b(den(y|ied)|not approved|reject(ed)?)\b/i.test(text);
  const approved = /\b(approv(e[sd]?|al)|consent(s|ed)?)\b/i.test(text);
  const dCode = /\bD-?Code[:\s]+([A-Z]\d{1,3}|[A-Z]{1,2})\b/i.exec(text)?.[1] ?? null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  const conditions = [...text.matchAll(/(?:condition(?:ed)?(?: on|s?:)|provided that|subject to)\s+([^.;\n]+)/gi)].map((m) => m[1]!.trim());
  return { outcome: denied ? "denied" : approved ? "approved" : "unclear", d_code: dCode, effective_date: date, conditions, officer_confirmation_required: conditions.length > 0 };
}

// ---- 1.2 loan-list versions and the CD25 attestation ---------------------------
export interface LoanListVersion { readonly version: number; readonly loans: readonly string[]; readonly attested: boolean; readonly attested_by?: string; readonly reason?: string; readonly created_on: PlainDate; }
export interface LoanListLoan { readonly fnma_loan_number: string; status: "listed" | "withdrawn"; withdrawn_reason?: string; withdrawn_on?: PlainDate; }
/** 1.2-T7: a payoff/repurchase/foreclosure after approval withdraws the loan and creates a new (unattested) list version. */
export function withdrawFromList(versions: readonly LoanListVersion[], loans: LoanListLoan[], fnmaLoanNumber: string, reason: "paid_off" | "repurchased" | "foreclosed", on: PlainDate): LoanListVersion {
  const loan = loans.find((l) => l.fnma_loan_number === fnmaLoanNumber);
  if (!loan) throw new RangeError(`${fnmaLoanNumber} is not on the Form 629 list`);
  loan.status = "withdrawn"; loan.withdrawn_reason = reason; loan.withdrawn_on = on;
  const last = versions[versions.length - 1];
  return { version: (last?.version ?? 0) + 1, loans: loans.filter((l) => l.status === "listed").map((l) => l.fnma_loan_number), attested: false, reason: `${fnmaLoanNumber} ${reason} ${on}`, created_on: on };
}
/** FNMA_QX_LOAN_LIST_FREEZE_CD25 is satisfied only by an attested version (`transfer.loan_list.attested`). */
export function attestationSatisfies(v: LoanListVersion): boolean { return v.attested === true && !!v.attested_by; }
export function attestList(v: LoanListVersion, officer: Actor): LoanListVersion {
  if (officer.kind !== "human" || officer.role !== "officer") throw new RangeError("loan-list attestation is an officer act");
  return { ...v, attested: true, attested_by: officer.id };
}

// ---- 1.3 notice runs ------------------------------------------------------------
export type NoticeRunStatus = "planned" | "rendered" | "qc_passed" | "released_to_vendor" | "mailed" | "complete";
/** Release gate (1.3-T4): every rendered notice must pass the required-content checklist and address validation. */
export function releaseGate(run: { status: NoticeRunStatus; notices: readonly { id: string; checklist_missing: readonly string[]; address_valid: boolean }[]; transferor_authorization_on_file: boolean; kind: "goodbye" | "hello" | "combined" | "corrective" }): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (run.status !== "qc_passed" && run.status !== "rendered") reasons.push(`run is ${run.status}`);
  for (const n of run.notices) { if (n.checklist_missing.length) reasons.push(`${n.id}: missing ${n.checklist_missing.join(", ")}`); if (!n.address_valid) reasons.push(`${n.id}: address not validated`); }
  if ((run.kind === "goodbye" || run.kind === "combined") && !run.transferor_authorization_on_file) reasons.push("goodbye run needs the transferor's written authorization on file");
  return { ok: reasons.length === 0, reasons };
}
export interface NoticeParty { readonly party_id: string; readonly role: "borrower" | "successor_in_interest" | "bk_counsel"; readonly address: string; readonly acp_enrolled?: boolean; readonly acp_substitute_address?: string | null; readonly sii_confirmed?: boolean; }
/** Recipients (1.3 rule 6 / T9): each borrower at their own address, confirmed successors, ACP participants at the substitute address only, counsel where known. */
export function noticeRecipients(parties: readonly NoticeParty[]): { party_id: string; address: string; via: "own_address" | "acp_substitute" | "counsel_copy" }[] {
  const out: { party_id: string; address: string; via: "own_address" | "acp_substitute" | "counsel_copy" }[] = [];
  for (const p of parties) {
    if (p.role === "successor_in_interest" && !p.sii_confirmed) continue;
    if (p.role === "bk_counsel") { out.push({ party_id: p.party_id, address: p.address, via: "counsel_copy" }); continue; }
    if (p.acp_enrolled) { if (!p.acp_substitute_address) throw new RangeError(`${p.party_id} is ACP-enrolled with no substitute address`); out.push({ party_id: p.party_id, address: p.acp_substitute_address, via: "acp_substitute" }); }
    else out.push({ party_id: p.party_id, address: p.address, via: "own_address" });
  }
  return out;
}
/** Returned mail (1.3-T8): a skip-trace order within 5 servicer business days; the original proof of mailing stays linked (comment 33(b)(3)-1). */
export function returnedMail(notice: { id: string; proof_of_mailing_id: string }, returnedOn: PlainDate): { notice_id: string; skip_trace_due: PlainDate; original_proof_of_mailing_id: string; still_satisfies_1024_33: true } {
  return { notice_id: notice.id, skip_trace_due: addBusinessDays(returnedOn, 5, servicer), original_proof_of_mailing_id: notice.proof_of_mailing_id, still_satisfies_1024_33: true };
}
/** Master-servicer-only change (1.3-T10, §1024.33(b)(2)(i)(C)): no notices, provided nothing the borrower sees changes, and an officer approval record documents the exclusion. */
export function masterServicerOnlyExclusion(unchanged: { payee: boolean; address: boolean; account: boolean; amount: boolean }, officer: Actor | null): { notices_required: boolean; exclusion_record: { basis: string; approved_by: string } | null; block: string | null } {
  const all = unchanged.payee && unchanged.address && unchanged.account && unchanged.amount;
  if (!all) return { notices_required: true, exclusion_record: null, block: null };
  if (!officer || officer.kind !== "human" || officer.role !== "officer") return { notices_required: false, exclusion_record: null, block: "suppression needs an officer sign-off verifying no payee/address/account/amount change" };
  return { notices_required: false, exclusion_record: { basis: "§1024.33(b)(2)(i)(C): master servicer change, subservicer retained, nothing borrower-facing changes", approved_by: officer.id }, block: null };
}

// ---- 1.4 eNotes and recert forecasts --------------------------------------------
export const SUPERMORTGAGE_ORG_ID = "1009999";
/** eRegistry check (1.4 rule 5): Controller = Fannie Mae, Location = Fannie Mae eVault, Servicing Agent = Supermortgage (or partner with Supermortgage as delegatee). */
export function enoteVerification(reg: { controller: string; location: string; servicing_agent: string; delegatee?: string | null }, partnerOrgId?: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (reg.controller !== "FNMA") problems.push(`controller ${reg.controller} ≠ FNMA`);
  if (!/fnma|fannie/i.test(reg.location)) problems.push(`location ${reg.location} is not Fannie Mae's eVault`);
  const agentOk = reg.servicing_agent === SUPERMORTGAGE_ORG_ID || (partnerOrgId !== undefined && reg.servicing_agent === partnerOrgId && reg.delegatee === SUPERMORTGAGE_ORG_ID);
  if (!agentOk) problems.push("enote_servicing_agent_mismatch");
  return { ok: problems.length === 0, problems };
}
/** Payoff/modification command gate on eNotes (1.4-T6): blocked with reason `enote_servicing_agent_mismatch` while FNMA_F1_11_ENOTE_SERVICING_AGENT_T0 is breached. */
export function enotePayoffGate(loan: { enote: boolean; servicing_agent_verified: boolean }): { ok: true } | { ok: false; reason: "enote_servicing_agent_mismatch" } {
  return !loan.enote || loan.servicing_agent_verified ? { ok: true } : { ok: false, reason: "enote_servicing_agent_mismatch" };
}
/** Recert risk forecast (1.4-T7): at-risk when the projected unrecertified count at the forecast date is > 0; the extension draft is due 16 days before the request deadline so an officer task can open. */
export function recertForecast(f: { ted: PlainDate; code: "D" | "C" | "I" | "none"; total: number; unrecertified_at_forecast: number; forecast_date: PlainDate }): { deadline: PlainDate; extension_request_by: PlainDate; at_risk: boolean; extension_draft_due: PlainDate | null; officer_task: "recert_extension" | null; pct_unrecertified: number } {
  const d = recertDeadline(f.ted, f.code);
  const atRisk = f.unrecertified_at_forecast > 0 && f.forecast_date < d.deadline;
  return { ...d, at_risk: atRisk, extension_draft_due: atRisk ? addDays(d.extension_request_by, -16) : null, officer_task: atRisk ? "recert_extension" : null, pct_unrecertified: Math.round((10_000 * f.unrecertified_at_forecast) / f.total) / 100 };
}

// ---- 1.5 MERS ------------------------------------------------------------------
export const MERS_REGISTRATION_FEE_CENTS: Cents = 2_495n;   // $24.95 MOM/Non-MOM registration (research/00b N1)
/** TOS expectations (1.5-T2): pending notices from the seller and a 7-day confirmation timer per MIN. */
export function tosExpectations(batch: { type: string; mins: readonly string[]; pending_received_on?: PlainDate }): { tos_expected: boolean; confirmations: { min: string; confirm_by: PlainDate | null }[] } {
  if (batch.type !== "servicing_sale_with_sub") return { tos_expected: false, confirmations: [] };
  return { tos_expected: true, confirmations: batch.mins.map((min) => ({ min, confirm_by: batch.pending_received_on ? addDays(batch.pending_received_on, 7) : null })) };
}
/** Acknowledgement ingestion (1.5-T4): every rejected MIN opens a boarding exception; the batch report carries the accepted percentage. */
export function ingestMersAcknowledgement(results: readonly { min: string; accepted: boolean; reason?: string }[]): { accepted: number; rejected: number; accepted_pct: number; exceptions: { min: string; kind: "mers_rejected"; reason: string }[] } {
  const rejected = results.filter((r) => !r.accepted);
  return { accepted: results.length - rejected.length, rejected: rejected.length, accepted_pct: Math.round((10_000 * (results.length - rejected.length)) / Math.max(1, results.length)) / 100, exceptions: rejected.map((r) => ({ min: r.min, kind: "mers_rejected", reason: r.reason ?? "rejected" })) };
}
/** Registration fee accrual (1.5 rule 5): to the partner's MERS invoice, never to the borrower. */
export function registrationFeeAccrual(min: string, partnerId: string): { min: string; amount_cents: Cents; bill_to: string; borrower_charge: false } {
  return { min, amount_cents: MERS_REGISTRATION_FEE_CENTS, bill_to: `partner:${partnerId}:mers_invoice`, borrower_charge: false };
}

// ---- 1.6 reconciliation gates -----------------------------------------------------
/** Loan-level reconciliation (1.6-T3): tape money fields must equal the trial balance to the cent before the loan may board. */
export function loanLevelRecon(tape: Record<string, Cents>, trialBalance: Record<string, Cents>): { status: "reconciled" | "variance"; variances: { field: string; tape: Cents; trial_balance: Cents }[]; gate: "SM_RECON_LOAN_LEVEL_T0" } {
  const variances = Object.keys(tape).filter((k) => trialBalance[k] !== undefined && trialBalance[k] !== tape[k]).map((k) => ({ field: k, tape: tape[k]!, trial_balance: trialBalance[k]! }));
  return { status: variances.length ? "variance" : "reconciled", variances, gate: "SM_RECON_LOAN_LEVEL_T0" };
}
export const ESCROW_SETUP_CATEGORIES = ["tax", "hazard", "flood", "mi", "other"] as const;
/** Escrow Setup events (1.6-T9, LL-2026-05): one per escrow category on the boarded loan; `active` waits for every ack. */
export function escrowSetupEvents(loan: { loan_id: string; escrowed: boolean; boarded_on: PlainDate; categories: readonly string[] }): { type: "EscrowSetup"; category: string; loan_id: string }[] {
  if (!loan.escrowed || loan.boarded_on < "2026-12-01") return [];
  return loan.categories.filter((c) => (ESCROW_SETUP_CATEGORIES as readonly string[]).includes(c)).map((category) => ({ type: "EscrowSetup" as const, category, loan_id: loan.loan_id }));
}
export function activeGate(expected: readonly { category: string }[], acked: readonly string[]): { ok: boolean; missing: string[] } {
  const missing = expected.map((e) => e.category).filter((c) => !acked.includes(c));
  return { ok: missing.length === 0, missing };
}

// ---- 1.7 carry-over checks, denial review, rule-set re-issue ---------------------------
export interface TransferorLossmitFile { readonly application_received_on?: PlainDate | null; readonly documents?: readonly { name: string; received_on: PlainDate }[]; readonly ack_sent_on?: PlainDate | null; readonly determination?: { kind: "offer" | "denial"; sent_on: PlainDate; appeal_window_end?: PlainDate } | null; readonly trial?: { schedule: readonly { due_on: PlainDate; amount_cents: Cents }[] } | null; readonly forbearance_months?: number; }
export const CARRYOVER_CHECKS = [
  { code: "CO-01", title: "loss-mit file present" }, { code: "CO-02", title: "application received date present" }, { code: "CO-03", title: "document receipt dates present" },
  { code: "CO-04", title: "acknowledgment status known" }, { code: "CO-05", title: "determination and appeal window known" }, { code: "CO-06", title: "trial schedule complete" }, { code: "CO-07", title: "forbearance months ≤ 12 cumulative" },
] as const;
export function runCarryoverChecks(file: TransferorLossmitFile | null, boardedOn: PlainDate): { status: "file_verified" | "file_deficient"; failed: string[]; transferor_request_due: PlainDate | null; borrower_request_allowed: false; ask_order: "ask_transferor" } {
  const failed: string[] = [];
  if (!file) failed.push("CO-01");
  else {
    if (!file.application_received_on) failed.push("CO-02");
    if ((file.documents ?? []).some((d) => !d.received_on)) failed.push("CO-03");
    if (file.ack_sent_on === undefined) failed.push("CO-04");
    if (file.determination && !file.determination.appeal_window_end && file.determination.kind === "denial") failed.push("CO-05");
    if (file.trial && file.trial.schedule.some((m) => !m.due_on || m.amount_cents <= 0n)) failed.push("CO-06");
    if ((file.forbearance_months ?? 0) > 12) failed.push("CO-07");
  }
  return { status: failed.length ? "file_deficient" : "file_verified", failed, transferor_request_due: failed.length ? addBusinessDays(boardedOn, 2, servicer) : null, borrower_request_allowed: false, ask_order: "ask_transferor" };
}
/** After the transferor fails to respond by the request deadline, the borrower may be asked (comment 41(k)(1)(i)-1). */
export function borrowerRequestAllowed(transferorRequestDue: PlainDate, transferorResponded: boolean, today: PlainDate): boolean { return !transferorResponded && today > transferorRequestDue; }
/** Denial review gate (1.7-T9): an AI-proposed denial cannot go out without a `lossmit_reviewer` approval record. */
export function denialSendGate(determination: { kind: "offer" | "denial"; proposed_by: Actor }, approval: { by: Actor; decision_id: string } | null): { ok: boolean; block: string | null } {
  if (determination.kind !== "denial" || determination.proposed_by.kind !== "agent") return { ok: true, block: null };
  if (approval && approval.by.kind === "human" && approval.by.role === "lossmit_reviewer") return { ok: true, block: null };
  return { ok: false, block: "denial proposed by the AI needs a lossmit_reviewer approval record before the determination notice is sent" };
}
/** Rule-set switch (1.7-T10): inherited cases keep `deemed_received_at`; their open (k) timers are cancelled with reason `rule_set_change` and re-issued under the new definitions. */
export function reissueTimersForRuleSet(engine: TimerEngine, registry: TimerRegistry, events: EventStore, loanId: string, boarded: DomainEvent, newRuleSet: string, actor: Actor): { cancelled: string[]; reissued: string[]; deemed_received_at: unknown } {
  const open = engine.forSubject("loan", loanId).filter((t) => (t.status === "armed" || t.status === "breached") && /^REGX_1024_41/.test(t.code));
  const cancelled: string[] = [], reissued: string[] = [];
  for (const t of open) { engine.cancel(t.id, "rule_set_change", actor); cancelled.push(t.code); }
  const trigger = events.append({ type: "lossmit.rule_set.changed", loanId, actor, causationId: boarded.id, payload: { ...boarded.payload, rule_set: newRuleSet, deemed_received_at: (boarded.payload as { deemed_received_at?: unknown }).deemed_received_at ?? null } });
  for (const code of cancelled) { const def = registry.get(code); if (def) { engine.arm(def, trigger); reissued.push(code); } }
  return { cancelled, reissued, deemed_received_at: (boarded.payload as { deemed_received_at?: unknown }).deemed_received_at ?? null };
}
