/**
 * §8.1 process-owned operations over the cycle mechanics in ./ops.ts (CreditCycleRunner) and the generator in
 * ./metro2.ts — the code paths that append the 8.1 events the registry rows arm on and are satisfied by where the
 * section file has none:
 *
 *   credit.policy.reviewed{reviewed_on, next_review_due, signed_by, signed_by_role, policy_version, program_document_id}
 *     — `recordPolicyReview`: the annual Reg V §1022.42(c) review sign-off (SM_METRO2_ANNUAL_POLICY_REVIEW_365 trigger
 *       and satisfier); refused for any signer but an `officer` (human touchpoints: "`officer` signs the annual Reg V
 *       policy review"); nothing is written on refusal.
 *   notice.sent{template=NTC_FCRA_1681S2A7_B2} — `mailB2Notices`: the §1681s-2(a)(7) post-furnishing notice through
 *       the Notice Registry (NoticeService emits the event; the B-2 checklist's `within-30` rule holds a late notice)
 *       for every loan the cycle furnished negative information on without B-1 evidence
 *       (FCRA_1681S2A7_NEG_INFO_NOTICE_30 satisfier); `b2Plan` lists them with the 30-day mail-by date.
 *
 * Plus the read models the cycle needs from the loan's event log: the FDCPA §1006.30(a) gate state
 * (`fdcpaGateState`: `loan.boarded{fdcpa_debt_collector_flag}` + 11.4's `fdcpa.*` / `contact.live.established`
 * events → the `CycleRecordInput.fdcpa` shape), B-1 evidence (`b1EvidenceOnFile`) and the terminal-status
 * "reported once, then `final_reported`" rule (`finalReportedAfter`, `nextCycleCandidates`).
 *
 * 8.1 names no bus tools in spec/registry/agents.json (`tools: []`), so — like CreditCycleRunner — these are domain
 * operations over an `EventStore`; the role gate is the one the bus applies (a human actor with role `officer`).
 * bigint cents; PlainDate; every input validated (RangeError) before anything is appended.
 */
import { addMonths, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { NoticeService, Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import { negativeInfoNoticeDue } from "./metro2.ts";
import { requireOfficer, type CycleBuild, type CycleRecordInput } from "./ops.ts";
import type { FdcpaGateInput } from "./suppression.ts";
import type { Metro2Snapshot } from "./types.ts";

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ---------------------------------------------------------------------------
// Annual Reg V §1022.42(c) policy review (SM_METRO2_ANNUAL_POLICY_REVIEW_365)
// ---------------------------------------------------------------------------
/** Reg V §1022.42(c): the written policies and procedures are reviewed "periodically" — policy: every 12 months (the registry row's offset). */
export const POLICY_REVIEW_MONTHS = 12;
/** The review is a program-level record, not a loan's: the timer's subject is the Reg V program itself. */
export const POLICY_REVIEW_SUBJECT = { kind: "credit_policy", id: "reg_v_1022_42" } as const;
export const POLICY_REVIEW_CITATION = "12 CFR 1022.42(c); 12 CFR 1022 Appendix E III(l)";

export interface PolicyReviewInput {
  readonly reviewed_on: PlainDate;
  /** The signer — must be a human `officer` (8.1 human touchpoints); the agent may prepare the review, never sign it. */
  readonly signer: Actor;
  /** Version label of the Appendix E program document as reviewed (e.g. `fcra.regv.2026-09`). */
  readonly policy_version: string;
  /** The signed review / program document in `documents`. */
  readonly program_document_id: string;
  /** Appendix E III(l) items evaluated (dispute rates, reject rates, correction root causes, CRA practices …). */
  readonly scope?: readonly string[];
  readonly findings?: readonly string[];
}
export interface PolicyReviewRecord {
  readonly reviewed_on: PlainDate;
  readonly next_review_due: PlainDate;
  readonly signed_by: string;
  readonly signed_by_role: "officer";
  readonly policy_version: string;
  readonly program_document_id: string;
  readonly scope: readonly string[];
  readonly findings: readonly string[];
  readonly event_id: string;
}
/** When the next review falls due: 12 months after the last one (the registry row's `12 months` from "last review"). */
export function nextPolicyReviewDue(reviewedOn: PlainDate): PlainDate { return addMonths(reviewedOn, POLICY_REVIEW_MONTHS); }

/**
 * Record the annual policy review sign-off: validates the record, refuses any signer but an `officer`
 * (CreditReportingRefused OFFICER_REQUIRED — nothing written), then appends `credit.policy.reviewed`, the event that
 * satisfies the running SM_METRO2_ANNUAL_POLICY_REVIEW_365 instance and (recurring row) arms the next one.
 */
export function recordPolicyReview(events: EventStore, f: PolicyReviewInput): PolicyReviewRecord {
  if (!isDate(f.reviewed_on)) throw new RangeError("reviewed_on is required (PlainDate)");
  if (!f.signer) throw new RangeError("signer is required");
  if (!f.policy_version) throw new RangeError("policy_version is required");
  if (!f.program_document_id) throw new RangeError("program_document_id is required");
  requireOfficer(f.signer, "the annual Reg V §1022.42(c) policy review sign-off");
  const next = nextPolicyReviewDue(f.reviewed_on);
  const scope = [...(f.scope ?? [])], findings = [...(f.findings ?? [])];
  const e = events.append({
    type: "credit.policy.reviewed", aggregate: POLICY_REVIEW_SUBJECT, actor: f.signer,
    payload: { reviewed_on: f.reviewed_on, next_review_due: next, signed_by: f.signer.id, signed_by_role: "officer", policy_version: f.policy_version, program_document_id: f.program_document_id, scope, findings, citation: POLICY_REVIEW_CITATION },
  });
  return { reviewed_on: f.reviewed_on, next_review_due: next, signed_by: f.signer.id, signed_by_role: "officer", policy_version: f.policy_version, program_document_id: f.program_document_id, scope, findings, event_id: e.id };
}
/** The last recorded review (by `reviewed_on`) and whether the 12-month clock has run out on `today`. */
export function policyReviewStatus(events: EventStore, today: PlainDate): { last_reviewed_on: PlainDate | null; next_review_due: PlainDate | null; overdue: boolean } {
  const reviews = events.ofType("credit.policy.reviewed").map((e) => e.payload.reviewed_on).filter(isDate).sort();
  const last = reviews.length ? reviews[reviews.length - 1]! : null;
  const next = last ? nextPolicyReviewDue(last) : null;
  return { last_reviewed_on: last, next_review_due: next, overdue: next !== null && today > next };
}

// ---------------------------------------------------------------------------
// FDCPA §1006.30(a) pre-furnishing gate from the loan's events (FDCPA_1006_30A_PRE_FURNISH_GATE)
// ---------------------------------------------------------------------------
export interface FdcpaGateState {
  /** `loan.boarded{fdcpa_debt_collector_flag=true}` (1.1) or `fdcpa.status.determined{debt_collector=true}` (11.4). */
  readonly boarded_in_default: boolean;
  readonly gate: FdcpaGateInput;
  /** 11.4's `fdcpa.furnishing_gate.opened.furnishing_gate_open_at` when the gate event has been recorded. */
  readonly opened_on: PlainDate | null;
}
const earliest = (ds: readonly (PlainDate | null)[]): PlainDate | null => ds.filter((d): d is PlainDate => d !== null).sort()[0] ?? null;
const dateField = (e: DomainEvent, ...keys: string[]): PlainDate | null => {
  for (const k of keys) { const v = e.payload[k]; if (isDate(v)) return v; if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10) as PlainDate; }
  return null;
};
/**
 * Read the §1006.30(a) gate for one loan from its event log — the 8.3 rule 8 inputs: live contact
 * (`contact.live.established`), the validation notice mailed (`fdcpa.validation_notice.sent`), undeliverability
 * (`fdcpa.validation_notice.undeliverable`) and 11.4's authoritative `fdcpa.furnishing_gate.opened`. A loan not
 * boarded in default has no gate (`boarded_in_default=false` → always included).
 */
export function fdcpaGateState(loanEvents: readonly DomainEvent[]): FdcpaGateState {
  const boardedInDefault = loanEvents.some((e) => (e.type === "loan.boarded" && e.payload.fdcpa_debt_collector_flag === true) || (e.type === "fdcpa.status.determined" && e.payload.debt_collector === true));
  const opened = earliest(loanEvents.filter((e) => e.type === "fdcpa.furnishing_gate.opened").map((e) => dateField(e, "furnishing_gate_open_at", "on")));
  const live = earliest(loanEvents.filter((e) => e.type === "contact.live.established").map((e) => dateField(e, "on", "occurred_on")));
  const sent = earliest(loanEvents.filter((e) => e.type === "fdcpa.validation_notice.sent").map((e) => dateField(e, "sent_on", "on")));
  const undeliverable = earliest(loanEvents.filter((e) => e.type === "fdcpa.validation_notice.undeliverable").map((e) => dateField(e, "on")));
  return { boarded_in_default: boardedInDefault, gate: { live_contact_on: earliest([live, opened]), validation_notice_sent_on: sent, undeliverable_on: undeliverable }, opened_on: opened };
}
/** The `CycleRecordInput.fdcpa` shape for `buildCycle` (omitted, never furnished, while the gate is closed — rule 9 / T17). */
export function fdcpaCycleInput(loanEvents: readonly DomainEvent[]): NonNullable<CycleRecordInput["fdcpa"]> {
  const s = fdcpaGateState(loanEvents);
  return { boarded_in_default: s.boarded_in_default, gate: s.gate };
}

// ---------------------------------------------------------------------------
// §1681s-2(a)(7) negative-information notices (FCRA_1681S2A7_NEG_INFO_NOTICE_30)
// ---------------------------------------------------------------------------
export const B1_TEMPLATE = "NTC_FCRA_1681S2A7_B1";
export const B2_TEMPLATE = "NTC_FCRA_1681S2A7_B2";
/**
 * B-1 evidence: a `notice.sent` for the B-1 template itself or for a carrier document (the RESPA hello notice 1.3 /
 * first periodic statement 7.1) whose `carries` lists it — "one notice per account suffices for subsequent negative
 * information" (§1681s-2(a)(7)(A)(i)).
 */
export function b1EvidenceOnFile(loanEvents: readonly DomainEvent[]): boolean {
  return loanEvents.some((e) => e.type === "notice.sent" && (e.payload.template === B1_TEMPLATE || (Array.isArray(e.payload.carries) && (e.payload.carries as unknown[]).includes(B1_TEMPLATE))));
}
export interface B2Plan { readonly loan_id: string; readonly first_furnished_on: PlainDate; readonly mail_by: PlainDate; readonly account_status: string; }
/** Loans the cycle furnished negative information on without B-1 evidence: B-2 mailed ≤30 days after the furnishing (§1681s-2(a)(7)(B)(i)). */
export function b2Plan(b: CycleBuild, transmittedAt: string): B2Plan[] {
  if (!/^\d{4}-\d{2}-\d{2}/.test(transmittedAt)) throw new RangeError("transmittedAt is required (ISO instant or date)");
  const on = transmittedAt.slice(0, 10) as PlainDate;
  return b.included.filter((s) => b.negative_information.has(s.loan_id) && !b.b1_on_file.has(s.loan_id))
    .map((s) => ({ loan_id: s.loan_id, first_furnished_on: on, mail_by: negativeInfoNoticeDue(on, false)!, account_status: s.account_status }));
}
export interface B2Mailing { readonly loan_id: string; readonly notice_id: string; readonly status: Notice["status"]; readonly mail_by: PlainDate; readonly sent_on: PlainDate; readonly days_after_furnishing: number; }
/**
 * Render and send the Model B-2 notice for every planned loan through the Notice Registry (first-class mail unless
 * `esign` consent for class `fcra_notices` exists — the template's channel policy decides). The B-2 checklist holds a
 * notice mailed after day 30 (`within-30`, data_range ≤ 30) and NoticeService refuses to send a held notice, so a late
 * B-2 never goes out silently; the `notice.sent{template=NTC_FCRA_1681S2A7_B2}` the service emits satisfies the timer.
 */
export async function mailB2Notices(notices: NoticeService, plan: readonly B2Plan[], f: { readonly sent_on: PlainDate; readonly recipients: (loanId: string) => readonly Recipient[]; readonly account_last4: (loanId: string) => string; readonly servicer_phone: string; readonly servicer_address: string }): Promise<B2Mailing[]> {
  if (!isDate(f.sent_on)) throw new RangeError("sent_on is required (PlainDate)");
  if (!f.servicer_phone || !f.servicer_address) throw new RangeError("servicer_phone and servicer_address are required");
  const out: B2Mailing[] = [];
  for (const p of plan) {
    const days = daysBetween(p.first_furnished_on, f.sent_on);
    const n = notices.render({ templateCode: B2_TEMPLATE, loanId: p.loan_id, recipients: f.recipients(p.loan_id), payload: { account_last4: f.account_last4(p.loan_id), first_furnished_on: p.first_furnished_on, days_after_furnishing: days, servicer_phone: f.servicer_phone, servicer_address: f.servicer_address }, asOf: f.sent_on });
    const sent = n.status === "held" ? n : await notices.send(n.id);
    out.push({ loan_id: p.loan_id, notice_id: sent.id, status: sent.status, mail_by: p.mail_by, sent_on: f.sent_on, days_after_furnishing: days });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terminal statuses: reported once, then `final_reported` (rule 14 / T8)
// ---------------------------------------------------------------------------
/** Loans the transmitted cycle reported with a terminal status (94/89/13/65/97/05): `loans.credit_reporting_status = final_reported` afterwards. */
export function finalReportedAfter(b: CycleBuild): Set<string> {
  return new Set(b.included.filter((s) => s.final_reported).map((s) => s.loan_id));
}
/**
 * Next cycle's candidates: a `final_reported` loan is reported again only when a correction requires it
 * (rule 14: "thereafter only if a correction requires it").
 */
export function nextCycleCandidates(snapshots: readonly Metro2Snapshot[], finalReported: ReadonlySet<string>, correctionRequired: ReadonlySet<string> = new Set()): { included: Metro2Snapshot[]; skipped: { loan_id: string; reason: "final_reported" }[] } {
  const included: Metro2Snapshot[] = []; const skipped: { loan_id: string; reason: "final_reported" }[] = [];
  for (const s of snapshots) { if (finalReported.has(s.loan_id) && !correctionRequired.has(s.loan_id)) skipped.push({ loan_id: s.loan_id, reason: "final_reported" }); else included.push(s); }
  return { included, skipped };
}
