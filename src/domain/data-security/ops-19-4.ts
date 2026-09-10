/**
 * §19.4 fair-lending data elements — operating rules over the enclave: the
 * boarding exception and 30-day transferor follow-up (T3), the CI static check
 * that no code outside packages/fl-enclave references `restricted_fl` (T4), the
 * schema access check with its SIEM alert (T5), approved Fannie Mae queries
 * with their 1-BD response clock and access log (T6), the 30-day material
 * finding review escalation (T14), and the deterministic monthly monitor that
 * produces identical outputs with AI on or off (T16).
 *
 * The second half of the module is the event-appending code paths the 19.4 timers
 * arm and close on (spec "Inputs and triggers", "Timers and gates"): the FL intake at
 * boarding (`fl.record.received` / `.validated` / `.followup_needed`), the transferor
 * confirmation (`fl.record.not_obtained` + `.validated{status=not_obtained}`), the 17.3
 * transfer-out export (`servicing.transfer_out.scheduled` → `fl.export.delivered`), the
 * monitoring runs (`fair_servicing_run.completed`, `fair_servicing_result.flagged{material}`,
 * `fair_servicing_review.closed`), the AI bias suite (`ai.bias_tests.completed`), the
 * Colorado AI Act register (`ai_system.registered{high_consequential}`, `ai_system.changed{substantial}`,
 * `impact_assessment.completed{kind}`), the assumption version path and the CCPA response.
 *
 * Shared-calculator notes (./fairlending.ts is read-only): `scifLanguage` maps the Form 1103
 * answer "I do not wish to respond" to `other`; `scifLanguageOf` below maps it to `not_provided`
 * (Form 1103 option list). `transferOutExport` uses −7 calendar days for "T−5 business days";
 * `scheduleTransferOutExport` below walks the servicer business calendar (same date for T7).
 */
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { boardingFollowupDue, inScope, materialReviewDue, rateTest, ageAtApplication, biasGate, leakageScan, type RateTest, type RateResult, type BiasTests, type Language } from "./fairlending.ts";

export const FL_ELEMENTS = ["ethnicity", "race", "sex", "age_at_application", "preferred_language"] as const;
export type FlElement = (typeof FL_ELEMENTS)[number];
export interface FlElements { readonly ethnicity?: readonly number[] | null; readonly race?: readonly number[] | null; readonly sex?: string | null; readonly age_at_application?: number | null; readonly preferred_language?: string | null; }
const present = (e: FlElements, k: FlElement): boolean => { const v = e[k]; return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0); };

/** Rule 19.4 lifecycle (T3): an in-scope tape without the elements boards with an open exception; the transferor follow-up is due 30 days later; after confirmation the row is `not_obtained` with the evidence. */
export function boardingFlException(i: { note_date: PlainDate; boarded_on: PlainDate; elements: FlElements; transferor_confirmation?: { on: PlainDate; evidence_document_id: string } | null }): { in_scope: boolean; missing: FlElement[]; boarding_completes: true; exception: { kind: "boarding"; code: "FL_DATA_MISSING"; open: boolean } | null; followup_timer: "SM_BOARD_FL_DATA_FOLLOWUP_30" | null; followup_due: PlainDate | null; row: { status: "out_of_scope" | "validated" | "incomplete" | "not_obtained"; source: "transferor_tape" | "not_obtained" | null; evidence_document_id: string | null } } {
  if (!inScope(i.note_date)) return { in_scope: false, missing: [], boarding_completes: true, exception: null, followup_timer: null, followup_due: null, row: { status: "out_of_scope", source: null, evidence_document_id: null } };
  const missing = FL_ELEMENTS.filter((k) => !present(i.elements, k));
  if (!missing.length) return { in_scope: true, missing: [], boarding_completes: true, exception: null, followup_timer: null, followup_due: null, row: { status: "validated", source: "transferor_tape", evidence_document_id: null } };
  const confirmed = i.transferor_confirmation ?? null;
  return { in_scope: true, missing, boarding_completes: true, exception: { kind: "boarding", code: "FL_DATA_MISSING", open: !confirmed }, followup_timer: "SM_BOARD_FL_DATA_FOLLOWUP_30", followup_due: boardingFollowupDue(i.boarded_on), row: confirmed ? { status: "not_obtained", source: "not_obtained", evidence_document_id: confirmed.evidence_document_id } : { status: "incomplete", source: "transferor_tape", evidence_document_id: null } };
}

/** Rule 19.4 use restriction (T4): the CI static check fails the build when anything outside packages/fl-enclave references the restricted schema. */
export function ciRestrictedSchemaCheck(files: readonly { path: string; content: string }[]): { passed: boolean; violations: { path: string; line: number }[] } {
  const violations: { path: string; line: number }[] = [];
  for (const f of files) {
    if (f.path.startsWith("packages/fl-enclave/")) continue;
    f.content.split("\n").forEach((line, k) => { if (/restricted_fl/.test(line)) violations.push({ path: f.path, line: k + 1 }); });
  }
  return { passed: violations.length === 0, violations };
}

/** Rule 19.4 use restriction (T5): only the `fl_analytics` role may SELECT from restricted_fl.*; any other principal is denied and a SIEM alert is due within 5 minutes. */
export function restrictedAccessCheck(i: { principal: string; role: string; schema: string; table: string; statement: "SELECT" | "INSERT" | "UPDATE" | "DELETE"; at_ms: number }): { allowed: boolean; denial: string | null; siem_alert: { severity: "sev1"; rule: "FL_UNEXPECTED_PRINCIPAL"; fire_by_ms: number } | null; audit_log: { at_ms: number; principal: string; role: string; statement: string; object: string } } {
  const log = { at_ms: i.at_ms, principal: i.principal, role: i.role, statement: i.statement, object: `${i.schema}.${i.table}` };
  if (i.schema !== "restricted_fl") return { allowed: true, denial: null, siem_alert: null, audit_log: log };
  if (i.role === "fl_analytics" && i.statement === "SELECT") return { allowed: true, denial: null, siem_alert: null, audit_log: log };
  return { allowed: false, denial: `permission denied for schema restricted_fl (role ${i.role}; only fl_analytics may SELECT)`, siem_alert: { severity: "sev1", rule: "FL_UNEXPECTED_PRINCIPAL", fire_by_ms: i.at_ms + 5 * 60_000 }, audit_log: log };
}

export interface FlRow { readonly loan_id: string; readonly borrower_seq: number; readonly note_date: PlainDate; readonly state: string; readonly elements: FlElements; readonly status: "validated" | "not_obtained" | "incomplete" | "out_of_scope"; }
/** Rule 19.4 (T6): an approved Fannie Mae query returns the per-loan elements within one business day, logged with purpose_code fnma_query and a records_requests id. */
export function fnmaQuery(i: { request_id: string; approved_by: string | null; note_date_from: PlainDate; note_date_to: PlainDate; state: string; received_on: PlainDate; rows: readonly FlRow[] }): { allowed: boolean; refusal: string | null; due_by: PlainDate; results: { loan_id: string; borrower_seq: number; elements: FlElements | "not_obtained" }[]; access_log: { purpose_code: "fnma_query"; records_request_id: string; approved_by: string | null; row_count: number } } {
  const due = addBusinessDays(i.received_on, 1, servicer);
  if (!i.approved_by) return { allowed: false, refusal: "restricted_fl queries run only from the approved fl_queries catalogue with an approver (19.4 rule 3)", due_by: due, results: [], access_log: { purpose_code: "fnma_query", records_request_id: i.request_id, approved_by: null, row_count: 0 } };
  const hits = i.rows.filter((r) => r.state === i.state && r.note_date >= i.note_date_from && r.note_date <= i.note_date_to && r.status !== "out_of_scope");
  const results = hits.map((r) => ({ loan_id: r.loan_id, borrower_seq: r.borrower_seq, elements: r.status === "not_obtained" ? ("not_obtained" as const) : r.elements }));
  return { allowed: true, refusal: null, due_by: due, results, access_log: { purpose_code: "fnma_query", records_request_id: i.request_id, approved_by: i.approved_by, row_count: results.length } };
}

/** Rule 19.4 rule 10 (T14): a material finding not reviewed within 30 days → sev-1 officer escalation and a line in the board report. */
export function materialFindingReview(i: { finding_id: string; flagged_on: PlainDate; reviewed_on: PlainDate | null; today: PlainDate }): { due: PlainDate; breached: boolean; escalation: { kind: "officer"; severity: "sev1"; reason: string } | null; board_report_entry: { finding_id: string; status: "review_overdue" | "reviewed" | "pending" } } {
  const due = materialReviewDue(i.flagged_on);
  if (i.reviewed_on && i.reviewed_on <= due) return { due, breached: false, escalation: null, board_report_entry: { finding_id: i.finding_id, status: "reviewed" } };
  const breached = !i.reviewed_on && i.today > due;
  return { due, breached, escalation: breached ? { kind: "officer", severity: "sev1", reason: `material fair-servicing finding ${i.finding_id} not reviewed by ${due} (SM_FAIR_SERVICING_REVIEW_30D)` } : null, board_report_entry: { finding_id: i.finding_id, status: breached ? "review_overdue" : "pending" } };
}

export interface MonitorMetric { readonly metric: string; readonly dimension: string; readonly test: RateTest; }
export interface MonitorRun { readonly period: string; readonly ai_off: boolean; readonly results: { metric: string; dimension: string; result: RateResult }[]; readonly material: string[]; readonly timers: { code: string; anchor: string }[]; readonly output_hash: string; }
const fnv = (s: string): string => { let h = 0x811c9dc5; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
/** Rule 19.4 (T16): the monthly monitor is a deterministic computation over the enclave inputs — identical outputs and timers with AI on or off. */
export function monthlyMonitorRun(i: { period: string; run_on: PlainDate; ai_off: boolean; metrics: readonly MonitorMetric[] }): MonitorRun {
  const results = [...i.metrics].sort((a, b) => (a.metric + a.dimension < b.metric + b.dimension ? -1 : 1)).map((m) => ({ metric: m.metric, dimension: m.dimension, result: rateTest(m.test) }));
  const material = results.filter((r) => (r.result as { material?: boolean }).material === true || (!r.result.suppressed && r.result.screen && r.result.p < 0.05)).map((r) => `${r.metric}:${r.dimension}`);
  const timers = [{ code: "SM_FAIR_SERVICING_MONITOR_MONTHLY", anchor: i.period }, ...material.map((m) => ({ code: "SM_FAIR_SERVICING_REVIEW_30D", anchor: `${m}@${i.run_on}` }))];
  const canonical = JSON.stringify({ period: i.period, results: results.map((r) => ({ m: r.metric, d: r.dimension, air: r.result.air.toFixed(4), z: r.result.z.toFixed(3), p: r.result.p.toFixed(6), s: r.result.suppressed })), material, timers });
  return { period: i.period, ai_off: i.ai_off, results, material, timers, output_hash: fnv(canonical) };
}
export const followupDue = (boardedOn: PlainDate): PlainDate => addDays(boardedOn, 30);

// =====================================================================================
// Event-appending code paths (the enclave jobs the security-records / qc-audit agents run)
// =====================================================================================
export const SECURITY_RECORDS: Actor = { kind: "agent", id: "security-records" };
export const QC_AUDIT: Actor = { kind: "agent", id: "qc-audit" };

/** HMDA/Reg C enumerations the data model names (canonical code set, open decision 7). */
export const ETHNICITY_CODES: readonly number[] = [1, 11, 12, 13, 14, 2, 3, 4];
export const RACE_CODES: readonly number[] = [1, 2, 21, 22, 23, 24, 25, 26, 27, 3, 4, 41, 42, 43, 44, 5, 6, 7];
export const SEX_CODES: readonly number[] = [1, 2, 3, 4, 6];
export type FlLanguage = Language | "not_obtained";
/** Form 1103 SCIF answer → data-model value: the six listed languages, "Other", "I do not wish to respond" → not_provided; no SCIF → not_obtained. */
export function scifLanguageOf(value: string | null | undefined): FlLanguage {
  if (value === null || value === undefined) return "not_obtained";
  const v = value.trim().toLowerCase();
  if (!v || /do not wish/.test(v)) return "not_provided";
  return (["english", "chinese", "korean", "spanish", "tagalog", "vietnamese"].includes(v) ? v : "other") as FlLanguage;
}

export interface FlTapeRecord {
  readonly loan_id: string; readonly borrower_seq: number; readonly note_date: PlainDate; readonly boarded_on: PlainDate;
  readonly source: "urla_1003" | "transferor_tape" | "prior_servicer_file" | "hmda_lar";
  readonly ethnicity_codes?: readonly number[] | null; readonly race_codes?: readonly number[] | null; readonly sex_code?: number | null;
  readonly dob?: PlainDate | null; readonly application_date?: PlainDate | null;
  /** Form 1103 SCIF language answer; null/undefined = no SCIF in the file (`not_obtained`). */
  readonly scif_language?: string | null;
}
export interface FlIntakeRow { readonly status: "validated" | "incomplete"; readonly source: FlTapeRecord["source"]; readonly ethnicity_codes: readonly number[]; readonly race_codes: readonly number[]; readonly sex_code: number | null; readonly age_at_application: number | null; readonly age_basis: "dob" | "unknown"; readonly preferred_language: FlLanguage; readonly version: 1; readonly updated_reason: "initial"; readonly evidence_document_id: null; }
export type GateFacts = { readonly fl_row_status: "validated" | "incomplete" | "not_obtained"; readonly not_obtained_evidence_id: string | null };
export interface FlIntakeResult {
  readonly in_scope: boolean;
  /** `null` for out-of-scope loans — no row is written (state machine `out_of_scope`). */
  readonly row: FlIntakeRow | null;
  readonly missing: FlElement[];
  /** Enumerations the tape carried that the HMDA code set does not know — mapped to `not_obtained` with a follow-up (rule 4). */
  readonly unmapped: FlElement[];
  readonly boarding_completes: true;
  readonly exception: { kind: "boarding"; code: "FL_DATA_MISSING"; open: true } | null;
  readonly followup_timer: "SM_BOARD_FL_DATA_FOLLOWUP_30" | null; readonly followup_due: PlainDate | null;
  /** Facts for the `19.4.fairLendingRowPresent` gate evaluator (FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING); null when the gate is not evaluated. */
  readonly gate: { timer: "FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING"; evaluated: true; facts: GateFacts } | null;
  /** Operational `borrowers.preferred_language` seeded from the SCIF (open decision 6). */
  readonly borrower_preferred_language: { value: Language; source: "scif" } | null;
  readonly events: DomainEvent[];
}
/**
 * Rule 1 / rule 4 inbound (T1, T2, T3): the boarding tape's FL fields for one borrower. Out of scope (note_date < 2023-03-01)
 * → no row, no event, no gate. In scope → `fl.record.received{note_date, boarded_at}` (arms the boarding gate), then
 * `fl.record.validated` when all five elements were obtained or `fl.record.followup_needed{boarded_at, missing}` (arms the 30-day
 * transferor follow-up; boarding completes with the open `boarding` exception). Values are never solicited from the borrower.
 */
export function flIntake(events: EventStore, i: FlTapeRecord, actor: Actor = SECURITY_RECORDS): FlIntakeResult {
  if (!i.loan_id) throw new RangeError("flIntake needs loan_id");
  if (!Number.isInteger(i.borrower_seq) || i.borrower_seq < 1) throw new RangeError("flIntake needs borrower_seq ≥ 1");
  if (!inScope(i.note_date)) return { in_scope: false, row: null, missing: [], unmapped: [], boarding_completes: true, exception: null, followup_timer: null, followup_due: null, gate: null, borrower_preferred_language: null, events: [] };
  const unmapped: FlElement[] = [];
  const codes = (k: "ethnicity" | "race", vals: readonly number[] | null | undefined, allowed: readonly number[]): readonly number[] => {
    const v = vals ?? [];
    if (v.length && v.some((c) => !allowed.includes(c))) { unmapped.push(k); return []; }
    return v;
  };
  const ethnicity = codes("ethnicity", i.ethnicity_codes, ETHNICITY_CODES);
  const race = codes("race", i.race_codes, RACE_CODES);
  let sex: number | null = i.sex_code ?? null;
  if (sex !== null && !SEX_CODES.includes(sex)) { unmapped.push("sex"); sex = null; }
  const age = i.dob && i.application_date ? ageAtApplication(i.dob, i.application_date) : null;
  const language = scifLanguageOf(i.scif_language);
  const elements: FlElements = { ethnicity, race, sex: sex === null ? null : String(sex), age_at_application: age, preferred_language: language === "not_obtained" ? null : language };
  const missing = FL_ELEMENTS.filter((k) => !present(elements, k));
  const status: FlIntakeRow["status"] = missing.length ? "incomplete" : "validated";
  const row: FlIntakeRow = { status, source: i.source, ethnicity_codes: ethnicity, race_codes: race, sex_code: sex, age_at_application: age, age_basis: age === null ? "unknown" : "dob", preferred_language: language, version: 1, updated_reason: "initial", evidence_document_id: null };
  const base = { loan_id: i.loan_id, borrower_seq: i.borrower_seq, note_date: i.note_date, in_scope: true, boarded_at: i.boarded_on, source: i.source };
  const out: DomainEvent[] = [];
  out.push(events.append({ type: "fl.record.received", loanId: i.loan_id, actor, payload: { ...base, elements_present: FL_ELEMENTS.filter((k) => !missing.includes(k)), elements_missing: missing, unmapped, access_log: { purpose_code: "boarding_load", row_count: 1 } } }));
  const seeded: FlIntakeResult["borrower_preferred_language"] = language !== "not_obtained" && language !== "not_provided" ? { value: language, source: "scif" } : null;
  if (seeded) out.push(events.append({ type: "borrower.preferred_language.seeded", loanId: i.loan_id, actor, payload: { loan_id: i.loan_id, borrower_seq: i.borrower_seq, preferred_language: seeded.value, preferred_language_source: "scif" } }));
  if (status === "validated") {
    out.push(events.append({ type: "fl.record.validated", loanId: i.loan_id, actor, causationId: out[0]!.id, payload: { ...base, status: "validated", version: 1, updated_reason: "initial", age_at_application: age, preferred_language: language, evidence_document_id: null } }));
    return { in_scope: true, row, missing, unmapped, boarding_completes: true, exception: null, followup_timer: null, followup_due: null, gate: { timer: "FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING", evaluated: true, facts: { fl_row_status: "validated", not_obtained_evidence_id: null } }, borrower_preferred_language: seeded, events: out };
  }
  const followup_due = boardingFollowupDue(i.boarded_on);
  out.push(events.append({ type: "fl.record.followup_needed", loanId: i.loan_id, actor, causationId: out[0]!.id, payload: { ...base, status: "incomplete", missing, unmapped, followup_due, exception: { kind: "boarding", code: "FL_DATA_MISSING", severity: "sev2" }, timer: "SM_BOARD_FL_DATA_FOLLOWUP_30" } }));
  return { in_scope: true, row, missing, unmapped, boarding_completes: true, exception: { kind: "boarding", code: "FL_DATA_MISSING", open: true }, followup_timer: "SM_BOARD_FL_DATA_FOLLOWUP_30", followup_due, gate: { timer: "FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING", evaluated: true, facts: { fl_row_status: "incomplete", not_obtained_evidence_id: null } }, borrower_preferred_language: seeded, events: out };
}

/**
 * T3 close: the transferor confirms the elements were not obtained at origination (or the file has no 1003 demographic
 * section / no 1103). The row becomes `not_obtained` with the evidence document; `fl.record.not_obtained` and
 * `fl.record.validated{status=not_obtained}` close SM_BOARD_FL_DATA_FOLLOWUP_30; the transferor's F-1-11 gap is logged for the partner.
 */
export function transferorConfirmation(events: EventStore, i: { loan_id: string; borrower_seq: number; note_date: PlainDate; boarded_on: PlainDate; confirmed_on: PlainDate; evidence_document_id: string; missing: readonly FlElement[]; transferor_id?: string }, actor: Actor = SECURITY_RECORDS): { row: { status: "not_obtained"; source: "not_obtained"; evidence_document_id: string; version: 1 }; exception: { kind: "boarding"; code: "FL_DATA_MISSING"; open: false }; gate_facts: GateFacts; followup_due: PlainDate; late: boolean; f111_gap_logged: true; events: DomainEvent[] } {
  if (!i.evidence_document_id) throw new RangeError("a not_obtained row needs the transferor's confirmation document (evidence_document_id)");
  if (!i.missing.length) throw new RangeError("nothing to confirm: no missing elements");
  const followup_due = boardingFollowupDue(i.boarded_on);
  const base = { loan_id: i.loan_id, borrower_seq: i.borrower_seq, note_date: i.note_date, boarded_at: i.boarded_on, source: "not_obtained", evidence_document_id: i.evidence_document_id, elements: [...i.missing], confirmed_on: i.confirmed_on };
  const out: DomainEvent[] = [];
  out.push(events.append({ type: "fl.record.not_obtained", loanId: i.loan_id, actor, payload: base }));
  out.push(events.append({ type: "fl.record.validated", loanId: i.loan_id, actor, causationId: out[0]!.id, payload: { ...base, status: "not_obtained", version: 1, updated_reason: "initial" } }));
  out.push(events.append({ type: "transferor.f111_gap.logged", loanId: i.loan_id, actor, causationId: out[0]!.id, payload: { loan_id: i.loan_id, transferor_id: i.transferor_id ?? null, elements: [...i.missing], guide: "F-1-11", late: i.confirmed_on > followup_due } }));
  return { row: { status: "not_obtained", source: "not_obtained", evidence_document_id: i.evidence_document_id, version: 1 }, exception: { kind: "boarding", code: "FL_DATA_MISSING", open: false }, gate_facts: { fl_row_status: "not_obtained", not_obtained_evidence_id: i.evidence_document_id }, followup_due, late: i.confirmed_on > followup_due, f111_gap_logged: true, events: out };
}

// ---------------------------------------------------------------- transfer-out (F-1-11, 17.3 file)
/**
 * Rule 4 outbound (T7): the 17.3 transfer schedule reaches the enclave; the FL export job is queued with its target
 * (T−5 servicer business days) and the T−0 clock (`servicing.transfer_out.scheduled{transfer_date}` arms FNMA_F111_FL_DATA_TRANSFER_OUT_T0).
 */
export function scheduleTransferOutExport(events: EventStore, i: { transfer_id: string; transfer_date: PlainDate; loan_ids: readonly string[]; transferee_id?: string }, actor: Actor = SECURITY_RECORDS): { transfer_id: string; transfer_date: PlainDate; target_delivery_date: PlainDate; breach_if_no_ack_by: PlainDate; timer: "FNMA_F111_FL_DATA_TRANSFER_OUT_T0"; loan_count: number; event: DomainEvent } {
  if (!i.transfer_id) throw new RangeError("scheduleTransferOutExport needs transfer_id");
  if (!i.loan_ids.length) throw new RangeError("scheduleTransferOutExport needs at least one loan");
  const target_delivery_date = addBusinessDays(i.transfer_date, -5, servicer);
  const event = events.append({ type: "servicing.transfer_out.scheduled", aggregate: { kind: "transfer_batch", id: i.transfer_id }, actor, payload: { transfer_id: i.transfer_id, transfer_date: i.transfer_date, transferee_id: i.transferee_id ?? null, target_delivery_date, loan_count: i.loan_ids.length, file: "FILE_FL_TRANSFER_OUT", timer: "FNMA_F111_FL_DATA_TRANSFER_OUT_T0" } });
  return { transfer_id: i.transfer_id, transfer_date: i.transfer_date, target_delivery_date, breach_if_no_ack_by: i.transfer_date, timer: "FNMA_F111_FL_DATA_TRANSFER_OUT_T0", loan_count: i.loan_ids.length, event };
}
export interface FlExportRow { readonly loan_id: string; readonly borrower_seq: number; readonly note_date: PlainDate; readonly elements: FlElements | "not_obtained"; readonly evidence_basis: string | null; }
/**
 * FILE_FL_TRANSFER_OUT: one row per in-scope loan/borrower (elements or `not_obtained` with its evidence basis), encrypted and
 * hashed, delivered with the transfer file. `fl.export.delivered` is appended only once the transferee's manifest acknowledgement
 * exists — that is what closes FNMA_F111_FL_DATA_TRANSFER_OUT_T0; a file without an ack leaves the clock running.
 */
export function deliverTransferOutExport(events: EventStore, i: { transfer_id: string; transfer_date: PlainDate; delivered_on: PlainDate; rows: readonly FlRow[]; manifest_hash: string; transferee_ack: { acked_on: PlainDate; by: string } | null }, actor: Actor = SECURITY_RECORDS): { file: FlExportRow[]; access_log: { purpose_code: "transfer_out_export"; request_id: string; row_count: number }; on_target: boolean; delivered: boolean; events: DomainEvent[] } {
  if (!i.rows.length) throw new RangeError("deliverTransferOutExport needs the transfer's FL rows");
  if (!i.manifest_hash) throw new RangeError("deliverTransferOutExport needs the manifest hash");
  const file: FlExportRow[] = i.rows.filter((r) => r.status !== "out_of_scope" && inScope(r.note_date)).map((r) => ({ loan_id: r.loan_id, borrower_seq: r.borrower_seq, note_date: r.note_date, elements: r.status === "not_obtained" ? "not_obtained" : r.elements, evidence_basis: r.status === "not_obtained" ? "transferor confirmation / no 1003 demographic section or 1103 in file" : null }));
  const target = addBusinessDays(i.transfer_date, -5, servicer);
  const access_log = { purpose_code: "transfer_out_export" as const, request_id: i.transfer_id, row_count: file.length };
  const out: DomainEvent[] = [];
  out.push(events.append({ type: "fl.export.produced", aggregate: { kind: "transfer_batch", id: i.transfer_id }, actor, payload: { transfer_id: i.transfer_id, transfer_date: i.transfer_date, delivered_on: i.delivered_on, row_count: file.length, manifest_hash: i.manifest_hash, on_target: i.delivered_on <= target, access_log } }));
  if (i.transferee_ack) out.push(events.append({ type: "fl.export.delivered", aggregate: { kind: "transfer_batch", id: i.transfer_id }, actor, causationId: out[0]!.id, payload: { transfer_id: i.transfer_id, transfer_date: i.transfer_date, delivered_on: i.delivered_on, manifest_hash: i.manifest_hash, manifest_acked: true, acked_on: i.transferee_ack.acked_on, acked_by: i.transferee_ack.by, row_count: file.length } }));
  return { file, access_log, on_target: i.delivered_on <= target, delivered: i.transferee_ack !== null, events: out };
}

// ---------------------------------------------------------------- monitoring runs, flags, reviews
export type ResultFlag = "none" | "screen" | "significant" | "material" | "suppressed";
export interface ReportRow { readonly metric: string; readonly dimension: string; readonly flag: ResultFlag; readonly n_group: number; readonly n_comparison: number; readonly rate_group: number | null; readonly rate_comparison: number | null; readonly air: number | null; readonly z: number | null; readonly p: number | null; }
export const flagOf = (r: RateResult): ResultFlag => (r.suppressed ? "suppressed" : r.material ? "material" : r.significant ? "significant" : r.screen ? "screen" : "none");
/** RPT_FAIR_SERVICING_* row with small-cell suppression applied (T9): a suppressed group shows no rate, AIR or statistic. */
export function reportRow(m: MonitorMetric, r: RateResult): ReportRow {
  const flag = flagOf(r);
  if (flag === "suppressed") return { metric: m.metric, dimension: m.dimension, flag, n_group: m.test.group_n, n_comparison: m.test.comparison_n, rate_group: null, rate_comparison: null, air: null, z: null, p: null };
  return { metric: m.metric, dimension: m.dimension, flag, n_group: m.test.group_n, n_comparison: m.test.comparison_n, rate_group: r.group_rate, rate_comparison: r.comparison_rate, air: r.air, z: r.z, p: r.p };
}
export interface MonitorRunInput { readonly period: string; readonly period_start: PlainDate; readonly period_end: PlainDate; readonly run_on: PlainDate; readonly kind: "monthly" | "regression"; readonly controls?: readonly string[]; readonly ai_off: boolean; readonly metrics: readonly MonitorMetric[]; readonly method_version?: string; }
export interface CompletedRun extends MonitorRun { readonly run_id: string; readonly kind: "monthly" | "regression"; readonly controls: boolean; readonly report_rows: ReportRow[]; readonly completed: DomainEvent; readonly flagged: DomainEvent[]; }
/**
 * `monitor.run(period)` (T8, T14, T16): the deterministic computation of `monthlyMonitorRun`, recorded as `fair_servicing_runs` /
 * `fair_servicing_results`; `fair_servicing_run.completed{kind, controls}` closes SM_FAIR_SERVICING_MONITOR_MONTHLY (monthly) and
 * SM_FAIR_SERVICING_REGRESSION_QUARTERLY (regression with controls); every `material` result appends
 * `fair_servicing_result.flagged{material=true, flagged_at}` which opens the 30-day review clock (SM_FAIR_SERVICING_REVIEW_30D).
 */
export function completeMonitorRun(events: EventStore, i: MonitorRunInput, actor: Actor = QC_AUDIT): CompletedRun {
  if (!i.metrics.length) throw new RangeError("completeMonitorRun needs at least one metric");
  const controls = [...(i.controls ?? [])];
  if (i.kind === "regression" && !controls.length) throw new RangeError("a regression run needs its legitimate controls (rule 7)");
  const run = monthlyMonitorRun({ period: i.period, run_on: i.run_on, ai_off: i.ai_off, metrics: i.metrics });
  const run_id = `FSR-${i.period}-${i.kind}`;
  const byKey = new Map(i.metrics.map((m) => [`${m.metric}:${m.dimension}`, m] as const));
  const report_rows = run.results.map((r) => reportRow(byKey.get(`${r.metric}:${r.dimension}`)!, r.result));
  const population_counts = Object.fromEntries(run.results.map((r) => [`${r.metric}:${r.dimension}`, { n_group: byKey.get(`${r.metric}:${r.dimension}`)!.test.group_n, n_comparison: byKey.get(`${r.metric}:${r.dimension}`)!.test.comparison_n }]));
  const completed = events.append({ type: "fair_servicing_run.completed", aggregate: { kind: "fair_servicing_run", id: run_id }, actor, payload: { run_id, period: i.period, period_start: i.period_start, period_end: i.period_end, kind: i.kind, controls: i.kind === "regression" && controls.length > 0, legitimate_controls: controls, method_version: i.method_version ?? "METH-FL-01", dataset_hash: run.output_hash, population_counts, status: run.material.length ? "flagged" : "computed", ai_off: i.ai_off, ran_at: i.run_on, report: i.kind === "regression" ? "RPT_FAIR_SERVICING_QUARTERLY_REGRESSION" : "RPT_FAIR_SERVICING_MONTHLY" } });
  const flagged = run.results.filter((r) => r.result.material).map((r) => events.append({ type: "fair_servicing_result.flagged", aggregate: { kind: "fair_servicing_run", id: run_id }, actor, causationId: completed.id, payload: { run_id, result_id: `${run_id}:${r.metric}:${r.dimension}`, metric_code: r.metric, dimension: r.dimension, flag: "material", material: true, flagged_at: i.run_on, review_due: materialReviewDue(i.run_on), air: r.result.air, z: r.result.z, p: r.result.p, suppression_applied: false, escalation: "officer" } }));
  return { ...run, run_id, kind: i.kind, controls: i.kind === "regression" && controls.length > 0, report_rows, completed, flagged };
}
/** Rule 10: the officer closes a material finding's review with documented corrective action or a documented legitimate justification (`fair_servicing_review.closed`). */
export function closeFairServicingReview(events: EventStore, i: { run_id: string; result_id: string; reviewer: Actor; closed_on: PlainDate; root_cause: string; corrective_actions: readonly string[]; legitimate_justification?: string | null; privilege_marker?: boolean }): { outcome: "corrective_action" | "legitimate_justification"; event: DomainEvent } {
  if (i.reviewer.role !== "officer") throw new RangeError("fair-servicing reviews are closed by the officer (Chief Compliance Officer)");
  if (!i.corrective_actions.length && !i.legitimate_justification) throw new RangeError("a material finding closes only with corrective action or a documented legitimate business justification (rule 10)");
  const outcome = i.corrective_actions.length ? "corrective_action" as const : "legitimate_justification" as const;
  const event = events.append({ type: "fair_servicing_review.closed", aggregate: { kind: "fair_servicing_run", id: i.run_id }, actor: i.reviewer, payload: { run_id: i.run_id, result_id: i.result_id, reviewer: i.reviewer.id, closed_on: i.closed_on, root_cause: i.root_cause, corrective_actions: [...i.corrective_actions], legitimate_justification: i.legitimate_justification ?? null, outcome, privilege_marker: i.privilege_marker ?? true, status: "closed" } });
  return { outcome, event };
}

// ---------------------------------------------------------------- AI bias tests, leakage, deploy gate
export const BIAS_TEST_KINDS = ["attribute_leakage", "counterfactual_perturbation", "outcome_parity", "explanation_consistency"] as const;
export type BiasTestKind = (typeof BIAS_TEST_KINDS)[number];
/**
 * `bias.runSuite(ai_system, version)` (rule 9, T10): the four test kinds; pre-deploy failures block the deploy, production
 * (quarterly) failures open a sev-1 review. `ai.bias_tests.completed{scope, cadence}` closes SM_AI_BIAS_TEST_QUARTERLY_90 when scope=production.
 */
export function runBiasSuite(events: EventStore, i: { ai_system_id: string; model_version: string; prompt_version: string; scope: "pre_deploy" | "production"; ran_on: PlainDate; dataset_id: string; dataset_cases?: number; tests: BiasTests }, actor: Actor = QC_AUDIT): { pass: boolean; failures: BiasTestKind[]; passed_tests: BiasTestKind[]; deploy: { gate: "SM_AI_BIAS_TEST_PRE_DEPLOY"; blocked: boolean } | null; review: { severity: "sev1"; opened: boolean } | null; events: DomainEvent[] } {
  if (!i.ai_system_id) throw new RangeError("runBiasSuite needs ai_system_id");
  if (i.dataset_cases !== undefined && i.dataset_cases < 500) throw new RangeError("the counterfactual evaluation set is ≥ 500 cases per agent (rule 9b)");
  const g = biasGate(i.tests);
  const failures = g.failures as BiasTestKind[];
  const passed_tests = BIAS_TEST_KINDS.filter((k) => !failures.includes(k));
  const out: DomainEvent[] = [];
  const cadence = i.scope === "production" ? "quarterly" : "pre_deploy";
  out.push(events.append({ type: "ai.bias_tests.completed", aggregate: { kind: "ai_systems", id: i.ai_system_id }, actor, payload: { ai_system_id: i.ai_system_id, model_version: i.model_version, prompt_version: i.prompt_version, scope: i.scope, cadence, dataset_id: i.dataset_id, pass: g.pass, failures, passed_tests, flip_rate: i.tests.counterfactual_flip_rate, directional_shift: i.tests.directional_shift, ran_at: i.ran_on, report: `DOC_AI_BIAS_TEST_REPORT_${i.ai_system_id}_${i.prompt_version}` } }));
  if (i.scope === "pre_deploy") {
    if (!g.pass) out.push(events.append({ type: "ai_system.deploy_blocked", aggregate: { kind: "ai_systems", id: i.ai_system_id }, actor, causationId: out[0]!.id, payload: { ai_system_id: i.ai_system_id, prompt_version: i.prompt_version, model_version: i.model_version, gate: "SM_AI_BIAS_TEST_PRE_DEPLOY", failures, escalate_to: ["engineering_owner", "officer"] } }));
    return { pass: g.pass, failures, passed_tests, deploy: { gate: "SM_AI_BIAS_TEST_PRE_DEPLOY", blocked: !g.pass }, review: null, events: out };
  }
  if (!g.pass) out.push(events.append({ type: "fair_servicing_review.opened", aggregate: { kind: "ai_systems", id: i.ai_system_id }, actor, causationId: out[0]!.id, payload: { kind: "bias_test_failure", severity: "sev1", ai_system_id: i.ai_system_id, failures, opened_at: i.ran_on, escalate_to: ["officer"] } }));
  return { pass: g.pass, failures, passed_tests, deploy: null, review: g.pass ? null : { severity: "sev1", opened: true }, events: out };
}
/** The pre-deploy gate (T10): open only when a pre-deploy suite run after the system's latest change passed all four kinds. */
export function deployGate(events: EventStore, ai_system_id: string): { open: boolean; reason: string | null; gate: "SM_AI_BIAS_TEST_PRE_DEPLOY" } {
  const lastChange = events.ofType("ai_system.changed").filter((e) => e.payload.id === ai_system_id).at(-1);
  const suite = events.ofType("ai.bias_tests.completed").filter((e) => e.payload.ai_system_id === ai_system_id && e.payload.scope === "pre_deploy" && (!lastChange || e.sequence > lastChange.sequence)).at(-1);
  if (!suite) return { open: false, reason: "no pre-deploy bias suite has run for this version", gate: "SM_AI_BIAS_TEST_PRE_DEPLOY" };
  const failures = suite.payload.failures as string[];
  return failures.length ? { open: false, reason: `bias tests failed: ${failures.join(", ")}`, gate: "SM_AI_BIAS_TEST_PRE_DEPLOY" } : { open: true, reason: null, gate: "SM_AI_BIAS_TEST_PRE_DEPLOY" };
}
/** Rule 9a (T11): an `agent_runs.inputs` manifest carrying a restricted field fails the leakage test — the run is quarantined and a sev-1 review opens. */
export function scanAgentRunInputs(events: EventStore, i: { run_id: string; ai_system_id: string; inputs: Record<string, unknown>; at: PlainDate }, actor: Actor = QC_AUDIT): { leakage: ReturnType<typeof leakageScan>; quarantined: boolean; review: { severity: "sev1"; kind: "attribute_leakage"; opened: true; escalate_to: ["officer"] } | null; events: DomainEvent[] } {
  if (!i.run_id) throw new RangeError("scanAgentRunInputs needs run_id");
  const leakage = leakageScan(i.inputs);
  const out: DomainEvent[] = [];
  out.push(events.append({ type: "ai.bias_test.attribute_leakage", aggregate: { kind: "agent_runs", id: i.run_id }, actor, payload: { run_id: i.run_id, ai_system_id: i.ai_system_id, clean: leakage.clean, fields: leakage.fields, test_kind: "attribute_leakage", pass: leakage.clean, ran_at: i.at } }));
  if (leakage.clean) return { leakage, quarantined: false, review: null, events: out };
  out.push(events.append({ type: "agent_run.quarantined", aggregate: { kind: "agent_runs", id: i.run_id }, actor, causationId: out[0]!.id, payload: { run_id: i.run_id, ai_system_id: i.ai_system_id, fields: leakage.fields, reason: "restricted fair-lending field in agent inputs (rule 3 / rule 9a)" } }));
  out.push(events.append({ type: "fair_servicing_review.opened", aggregate: { kind: "agent_runs", id: i.run_id }, actor, causationId: out[0]!.id, payload: { kind: "attribute_leakage", severity: "sev1", run_id: i.run_id, ai_system_id: i.ai_system_id, fields: leakage.fields, opened_at: i.at, escalate_to: ["officer"] } }));
  return { leakage, quarantined: true, review: { severity: "sev1", kind: "attribute_leakage", opened: true, escalate_to: ["officer"] }, events: out };
}

// ---------------------------------------------------------------- Colorado AI Act register (rule 11)
export type AiSystemsTier = "T0_deterministic" | "T1_consequential" | "T2_borrower_facing" | "T3_internal";
const riskTierOf = (tier: AiSystemsTier): { risk_tier: "high_consequential" | AiSystemsTier; high_consequential: boolean } => (tier === "T1_consequential" ? { risk_tier: "high_consequential", high_consequential: true } : { risk_tier: tier, high_consequential: false });
/** A system enters the deployer program's high-risk register: `ai_system.registered{high_consequential}` arms the annual impact assessment (CO_AI_ACT_IMPACT_ASSESSMENT_365). */
export function registerAiSystem(events: EventStore, i: { system_id: string; name: string; tier: AiSystemsTier; registered_on: PlainDate; decision_domain?: string }, actor: Actor = QC_AUDIT): { high_consequential: boolean; impact_assessment_due: PlainDate | null; event: DomainEvent } {
  if (!i.system_id) throw new RangeError("registerAiSystem needs system_id");
  const tier = riskTierOf(i.tier);
  const impact_assessment_due = tier.high_consequential ? addYears(i.registered_on, 1) : null;
  const event = events.append({ type: "ai_system.registered", aggregate: { kind: "ai_systems", id: i.system_id }, actor, payload: { id: i.system_id, name: i.name, ai_systems_tier: i.tier, ...tier, decision_domain: i.decision_domain ?? null, registered_on: i.registered_on, impact_assessment_due, program: "CO_SB24-205_deployer" } });
  return { high_consequential: tier.high_consequential, impact_assessment_due, event };
}
/**
 * A change to a registered system: `ai_system.changed{risk_tier=high_consequential}` arms the pre-deploy bias gate (SM_AI_BIAS_TEST_PRE_DEPLOY);
 * `{substantial=true, change_date}` arms the 90-day modification impact assessment (CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D).
 */
export function recordAiSystemChange(events: EventStore, i: { system_id: string; tier: AiSystemsTier; change_kind: "prompt_version" | "model_version" | "inputs" | "decision_scope"; substantial: boolean; changed_on: PlainDate; prompt_version?: string; model_version?: string }, actor: Actor = QC_AUDIT): { deploy_gate: "SM_AI_BIAS_TEST_PRE_DEPLOY" | null; impact_assessment_due: PlainDate | null; event: DomainEvent } {
  if (!i.system_id) throw new RangeError("recordAiSystemChange needs system_id");
  const tier = riskTierOf(i.tier);
  const impact_assessment_due = tier.high_consequential && i.substantial ? addDays(i.changed_on, 90) : null;
  const deploy_gate = tier.high_consequential ? "SM_AI_BIAS_TEST_PRE_DEPLOY" as const : null;
  const event = events.append({ type: "ai_system.changed", aggregate: { kind: "ai_systems", id: i.system_id }, actor, payload: { id: i.system_id, ai_systems_tier: i.tier, ...tier, change_kind: i.change_kind, substantial: i.substantial, change_date: i.changed_on, prompt_version: i.prompt_version ?? null, model_version: i.model_version ?? null, deploy_gate, impact_assessment_due } });
  return { deploy_gate, impact_assessment_due, event };
}
/** `impact_assessment.completed{kind}` (T15): closes the annual / modification clocks; the annual one re-arms from `completed_at`. Records kept `ai_governance_7y`. */
export function completeImpactAssessment(events: EventStore, i: { system_id: string; kind: "annual" | "modification"; document_id: string; completed_on: PlainDate }, actor: Actor = QC_AUDIT): { next_due_at: PlainDate; event: DomainEvent } {
  if (!i.document_id) throw new RangeError("an impact assessment is a document (DOC_AI_IMPACT_ASSESSMENT_<agent>); document_id required");
  const next_due_at = addYears(i.completed_on, 1);
  const event = events.append({ type: "impact_assessment.completed", aggregate: { kind: "ai_systems", id: i.system_id }, actor, payload: { ai_system_id: i.system_id, kind: i.kind, document_id: i.document_id, completed_at: i.completed_on, next_due_at, retention_class: "ai_governance_7y" } });
  return { next_due_at, event };
}

// ---------------------------------------------------------------- assumption / ownership transfer (rule 5, T12)
/** "Authorized, but not required": a new version for the assuming borrower only when §1002.13 monitoring information was lawfully collected in the assumption application; otherwise the record is unchanged and annotated. Never solicited. */
export function assumptionUpdate(events: EventStore, i: { loan_id: string; completed_on: PlainDate; assuming_borrower_seq: number; current_version: number; monitoring_data: { lawfully_collected_1002_13: boolean; elements: FlElements } | null }, actor: Actor = SECURITY_RECORDS): { outcome: "new_version_assumption" | "unchanged_annotated"; version: number; updated_reason: "assumption" | null; event: DomainEvent } {
  if (!i.loan_id) throw new RangeError("assumptionUpdate needs loan_id");
  const md = i.monitoring_data;
  const lawful = md !== null && md.lawfully_collected_1002_13 && FL_ELEMENTS.some((k) => present(md.elements, k));
  if (lawful) {
    const version = i.current_version + 1;
    const event = events.append({ type: "fl.record.version_written", loanId: i.loan_id, actor, payload: { loan_id: i.loan_id, borrower_seq: i.assuming_borrower_seq, version, updated_reason: "assumption", collected_at: i.completed_on, source: "urla_1003", basis: "Reg B §1002.13 monitoring information collected in the assumption application" } });
    return { outcome: "new_version_assumption", version, updated_reason: "assumption", event };
  }
  const event = events.append({ type: "fl.record.annotated", loanId: i.loan_id, actor, payload: { loan_id: i.loan_id, version: i.current_version, annotation: `assumption completed ${i.completed_on} without §1002.13 monitoring information for the assuming borrower; origination record unchanged (A2-1-01: authorized, not required)`, solicited: false } });
  return { outcome: "unchanged_annotated", version: i.current_version, updated_reason: null, event };
}

// ---------------------------------------------------------------- state privacy requests (edge case, T13)
/** CCPA deletion/access request: GLBA-covered data are exempt (Cal. Civ. Code §1798.145(e)); respond under Reg P/GLBA and Fannie Mae ownership — nothing is deleted. */
export function privacyRequestResponse(events: EventStore, i: { request_id: string; loan_id: string; kind: "deletion" | "access"; received_on: PlainDate; state: string }, actor: Actor = SECURITY_RECORDS): { deleted: false; basis: "GLBA_exemption"; citation: string; respond_under: string; records_retained: string[]; event: DomainEvent } {
  if (!i.request_id) throw new RangeError("privacyRequestResponse needs request_id");
  const response = { deleted: false as const, basis: "GLBA_exemption" as const, citation: "Cal. Civ. Code §1798.145(e)", respond_under: "Reg P / GLBA; Fannie Mae ownership of the loan record (A2-1-01)", records_retained: ["restricted_fl.fair_lending_data", "loan record"] };
  const event = events.append({ type: "privacy.request.responded", loanId: i.loan_id, actor, payload: { request_id: i.request_id, kind: i.kind, state: i.state, received_on: i.received_on, ...response } });
  return { ...response, event };
}
