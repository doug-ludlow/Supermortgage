/**
 * §8 mechanics beyond metro2/disputes/suppression: the bureau ack/reject
 * loop, FDCPA-gated cycle inclusion, the four-bureau file set (8.1); oral
 * dispute intake, NoE-linked disputes and the AUD-vs-cycle rule (8.2); the
 * stale-suppression review against the docket (8.3). bigint cents; the
 * servicer calendar for the 5-BD resubmission and the 30-BD NoE clock.
 */
import { addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { handleUtterance } from "../servicing-requests/ops.ts";
import { fdcpaGateIncludes, fdcpaGateOpensOn, staleSuppressionReviewDue, type FdcpaGateInput, type BankruptcyState } from "./suppression.ts";
import { directDisputeClocks, cccOnReceipt, BUREAUS, type Bureau } from "./disputes.ts";
import { renderBase } from "./metro2.ts";
import type { Metro2Snapshot, Cii } from "./types.ts";

// ---------------------------------------------------------------------------
// 8.1
// ---------------------------------------------------------------------------
export interface AckReject { readonly line: number; readonly code: string; readonly message: string; readonly loan_id: string; readonly field?: string; }
export interface AckItem { readonly bureau: Bureau; readonly file_id: string; readonly line: number; readonly code: string; readonly loan_id: string; readonly classification: "data" | "configuration"; readonly status: "open" | "corrected" | "resolved"; readonly correction: { field: string; before: string | null; after: string | null; source: "loans" } | null; }
/** 8.1 rule 11–12 / T12: a bureau Metric Report's rejects become `metro2_ack_items`; data rejects are corrected from the loan record and resubmitted (or AUD'd) within 5 business days. */
export function ackRejectLoop(f: { bureau: Bureau; file_id: string; received_on: PlainDate; rejects: readonly AckReject[]; loans: Record<string, { min: string | null; fnma_loan_number: string }>; resubmitted_on?: PlainDate | null }): { items: AckItem[]; resubmit_by: PlainDate; via: "resubmission" | "aud"; resolved: boolean; unresolved: string[] } {
  const items: AckItem[] = f.rejects.map((r) => {
    const loan = f.loans[r.loan_id];
    if (/MIN/i.test(r.code) || r.field === "min") {
      const after = loan?.min ?? null;
      const ok = !!after && /^\d{18}$/.test(after);
      return { bureau: f.bureau, file_id: f.file_id, line: r.line, code: r.code, loan_id: r.loan_id, classification: "data", status: ok ? "corrected" : "open", correction: { field: "min", before: null, after: ok ? after : null, source: "loans" } };
    }
    if (/HEADER|TRAILER|PROGRAM|SUBSCRIBER/i.test(r.code)) return { bureau: f.bureau, file_id: f.file_id, line: r.line, code: r.code, loan_id: r.loan_id, classification: "configuration", status: "open", correction: null };
    return { bureau: f.bureau, file_id: f.file_id, line: r.line, code: r.code, loan_id: r.loan_id, classification: "data", status: "open", correction: null };
  });
  const by = addBusinessDays(f.received_on, 5, servicer);
  const resubmitted = !!f.resubmitted_on && f.resubmitted_on <= by;
  const final = items.map((i) => (i.status === "corrected" && resubmitted ? { ...i, status: "resolved" as const } : i));
  return { items: final, resubmit_by: by, via: items.every((i) => i.classification === "data") ? "aud" : "resubmission", resolved: final.every((i) => i.status === "resolved"), unresolved: final.filter((i) => i.status !== "resolved").map((i) => `${i.loan_id}:${i.code}`) };
}
/** 8.3 rule 8 / 8.1-T17: a loan boarded in default is omitted from the cycle until the FDCPA gate opens; omitted months render `D` in the PHP thereafter. */
export function fdcpaCycleInclusion(f: { boarded_in_default: boolean; gate: FdcpaGateInput; cycle_as_of: PlainDate }): { include: boolean; omit_reason: "fdcpa_pre_furnishing_gate" | null; gate_opens_on: PlainDate | null; php_char_for_omitted_month: "D" } {
  if (!f.boarded_in_default) return { include: true, omit_reason: null, gate_opens_on: null, php_char_for_omitted_month: "D" };
  const inc = fdcpaGateIncludes(f.gate, f.cycle_as_of);
  return { include: inc, omit_reason: inc ? null : "fdcpa_pre_furnishing_gate", gate_opens_on: fdcpaGateOpensOn(f.gate), php_char_for_omitted_month: "D" };
}
export interface BureauConfig { readonly program_identifier: string; readonly subscriber_code: string; readonly file_naming: string; }
export interface Metro2File { readonly bureau: Bureau; readonly file_name: string; readonly header: { program_identifier: string; identification_number: string; record_count: number }; readonly records: readonly Record<string, string>[]; readonly trailer: { total_base_records: number }; readonly encrypted_to: string; }
/** 8.1 rule 10 / T18: one canonical snapshot set renders exactly four files — one per bureau, Innovis included — with identical base segments and per-bureau headers. */
export function cycleFiles(f: { cycle_id: string; snapshots: readonly Metro2Snapshot[]; config: Record<Bureau, BureauConfig> }): Metro2File[] {
  const records = f.snapshots.map((s) => renderBase(s));
  return BUREAUS.map((b) => {
    const c = f.config[b]; if (!c) throw new RangeError(`no furnisher_config for ${b}`);
    return { bureau: b, file_name: c.file_naming.replace("{cycle}", f.cycle_id).replace("{bureau}", b), header: { program_identifier: c.program_identifier, identification_number: c.subscriber_code, record_count: records.length }, records, trailer: { total_base_records: records.length }, encrypted_to: `pgp:${b}` };
  });
}

// ---------------------------------------------------------------------------
// 8.2
// ---------------------------------------------------------------------------
/** 8.2-T10: an oral statement on an AI voice call that the credit report is wrong opens a direct dispute; XB applies on receipt; results are due within 30 days; automation is disclosed. */
export function oralDisputeIntake(f: { utterance: string; received_on: PlainDate; next_cycle_transmit_on: PlainDate; automation_disclosed: boolean }): { opens_case: boolean; channel: "oral"; category: "payment_history" | "balance" | "not_mine" | "other"; ccc: "XB"; ccc_via: "aud" | "next_cycle"; results_due: PlainDate; results_template: "NTC_FCRA_1022_43E_RESULTS"; human_transfer_requested: boolean; automation_disclosed: boolean } {
  const u = f.utterance.toLowerCase();
  const disputes = /(credit report|credit bureau|my credit)/.test(u) && /(late|wrong|incorrect|not mine|never|inaccurate|error)/.test(u);
  const category = /late|payment|paid/.test(u) ? "payment_history" : /balance|owe/.test(u) ? "balance" : /not mine|never had/.test(u) ? "not_mine" : "other";
  const clocks = directDisputeClocks(f.received_on);
  return { opens_case: disputes, channel: "oral", category, ccc: "XB", ccc_via: cccOnReceipt(f.received_on, f.next_cycle_transmit_on).via, results_due: clocks.results_due, results_template: "NTC_FCRA_1022_43E_RESULTS", human_transfer_requested: handleUtterance(f.utterance).human_transfer_requested, automation_disclosed: f.automation_disclosed };
}
/** 8.2 rule 9 / T13: a letter alleging a servicing error and a wrong credit report opens both an NoE case (4.1, 30 business days) and a direct dispute (30 calendar days); corrections are shared and the letters meet their own clocks. */
export function linkedNoeDispute(f: { received_on: PlainDate; allegations: readonly string[] }): { noe_case: { opens: boolean; response_due: PlainDate; basis: string } | null; direct_dispute: { opens: boolean; results_due: PlainDate } | null; shared_corrections: boolean; combined_letter_allowed: boolean; earlier_clock: PlainDate | null } {
  const servicing = f.allegations.some((a) => /misapplied|late fee|late charge|escrow|payment/i.test(a));
  const credit = f.allegations.some((a) => /credit report|credit bureau|tradeline|furnish/i.test(a));
  const noeDue = addBusinessDays(f.received_on, 30, servicer);
  const dd = directDisputeClocks(f.received_on).results_due;
  const noe = servicing ? { opens: true, response_due: noeDue, basis: "§1024.35(e)(3)(i)(C): 30 business days (servicer calendar)" } : null;
  const direct = credit ? { opens: true, results_due: dd } : null;
  const earlier = noe && direct ? (noeDue < dd ? noeDue : dd) : null;
  return { noe_case: noe, direct_dispute: direct, shared_corrections: !!(noe && direct), combined_letter_allowed: !!(noe && direct), earlier_clock: earlier };
}
/** e-OSCAR AUD rule / 8.2-T14: an AUD never substitutes for in-cycle reporting — the next cycle carries the corrected values regardless of the AUD. */
export function audAndCycle(f: { aud_sent_on: PlainDate; cycle_as_of: PlainDate; corrected_fields: Record<string, string>; snapshot_fields: Record<string, string> }): { aud_in_cycle_substitute: false; cycle_carries_correction: boolean; mismatches: string[] } {
  const mismatches = Object.entries(f.corrected_fields).filter(([k, v]) => f.snapshot_fields[k] !== v).map(([k]) => k);
  return { aud_in_cycle_substitute: false, cycle_carries_correction: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// 8.3
// ---------------------------------------------------------------------------
const DISMISSAL_CII: Readonly<Record<BankruptcyState["chapter"], Cii>> = { 7: "I", 11: "J", 12: "K", 13: "L" };
/** 8.3 edge "Bankruptcy monitor outage" / T11: the 30-day suppression review compares the live suppression with the docket; a dismissal the monitor missed is applied retroactively with the dismissal order as evidence (CII I/J/K/L for one cycle, then Q). */
export function staleSuppressionReview(f: { suppression: { reason: "bankruptcy"; chapter: BankruptcyState["chapter"]; phase: "petition" | "plan_confirmed" | "discharged" | "dismissed"; last_event_on: PlainDate }; docket: { status: "open" | "dismissed" | "discharged"; event_on: PlainDate | null; order_document_id: string | null }; review_on: PlainDate }): { review_due_on: PlainDate; mismatch: boolean; action: { cii_this_cycle: Cii; cii_next_cycle: "Q"; release_freeze: true; evidence_document_id: string; via: "aud_and_next_cycle" } | null; escalation: "officer" | null } {
  const due = staleSuppressionReviewDue(f.suppression.last_event_on);
  const mismatch = f.docket.status === "dismissed" && f.suppression.phase !== "dismissed";
  if (!mismatch) return { review_due_on: due, mismatch: false, action: null, escalation: null };
  if (!f.docket.order_document_id) return { review_due_on: due, mismatch: true, action: null, escalation: "officer" };
  return { review_due_on: due, mismatch: true, action: { cii_this_cycle: DISMISSAL_CII[f.suppression.chapter], cii_next_cycle: "Q", release_freeze: true, evidence_document_id: f.docket.order_document_id, via: "aud_and_next_cycle" }, escalation: null };
}
export const dayAfter = (d: PlainDate): PlainDate => addDays(d, 1);
