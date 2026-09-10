/**
 * §19.1 operating rules over the retention calculator (./retention.ts): the versioned
 * retention-class registry (jurisdiction overrides, disposal method, effective dates) and
 * record-type classification (data model), the disposal gates of the timer table — every
 * not-before gate is condition-shaped ("gate opens; disposal blocked"), so each is an
 * evaluator asserted by the disposal command through `assertGateOpen` and never a clock that
 * breaches — the record-object lifecycle engine, in which the sweep, the planner and the
 * executing command all evaluate every class of the object's record type (rule 1, max rule)
 * rather than a loan-level summary; holds placed, reviewed and released with real events;
 * the five-day servicing-file bundle of rule 5 (transaction schedule with running balances
 * rendered as CSV and print pages, security instrument, personnel notes, data-field report,
 * borrower submissions) and the monthly CTL-REC-01 drill that samples 25 loans and runs the
 * compile tool for each (T5); the WORM integrity job that blocks disposal and opens a 19.2
 * sev-1 incident (T12); records-request intake (authority, scope, due date, automatic hold,
 * attorney escalation within one hour for subpoenas, borrower RFIs re-routed to 4.2, the
 * `refused` branch with attorney review — T4, T6, T13, T14); production approvals that are
 * events by the role the spec names, never caller flags; the schedule ticks that arm the
 * recurring rows; and the guards that are identical on the AI path and the ops-console
 * human path (T15).
 *
 * Shared-calculator note: ./retention.ts `retention()` drops the Reg B gate when
 * `enforcement_open` is true (line 34: `enforcement_open ? null : …`), which is the opposite
 * of §1002.12(b)(4) / the timer row ("extended to `investigation.closed`"). `loanRetention`
 * below is the corrected loan-level calculator; nothing in this process's disposal path
 * calls `retention()`.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, dayOfWeek, parts, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventInput } from "../../kernel/events/index.ts";
import { itemDeadlines } from "../servicing-requests/rfi.ts";
import { anniversary, holdReleaseAllowed, subpoenaActions, type RetentionInput, type RetentionGates } from "./retention.ts";

// ============================================================ data model: retention classes and record types
export type AnchorRule = "later_of_liquidation_or_transfer_out" | "discharge_or_transfer_out" | "record_created" | "last_collection_activity" | "call_date" | "decision_notified" | "form_due_date" | "report_filed" | "last_use" | "revocation_or_last_reliance";
export type DisposalMethod = "crypto_shred" | "object_delete" | "physical_destroy" | "none";
/** A longer local period on the class's own anchor (data model: `jurisdiction_overrides jsonb` — state → longer offset). */
export interface JurisdictionOverride { readonly offset_value: number; readonly offset_unit: "years"; readonly citation: string; readonly verified: boolean; }
export interface RetentionClass {
  readonly code: string; readonly citation: string; readonly basis: "law" | "guide" | "contract" | "policy"; readonly anchor_event: string; readonly anchor_rule: AnchorRule;
  readonly offset_value: number; readonly offset_unit: "days" | "months" | "years"; readonly permanent_while_active: boolean;
  readonly jurisdiction_overrides: Readonly<Record<string, JurisdictionOverride>>; readonly disposal_method: DisposalMethod; readonly may_shorten: boolean;
  readonly version: string; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null;
  /** The timer-table row that carries this class's gate or deadline; null for a class the table has no row for (its anniversary still gates the object). */
  readonly timer_code: string | null;
}
export const RETENTION_SCHEDULE_VERSION = "v1";
const SCHEDULE_EFFECTIVE_FROM = plainDate("2026-09-01");
const cls = (code: string, citation: string, basis: RetentionClass["basis"], anchor_event: string, anchor_rule: AnchorRule, offset_value: number, offset_unit: RetentionClass["offset_unit"], permanent_while_active: boolean, timer_code: string | null, extra: Partial<Pick<RetentionClass, "may_shorten" | "disposal_method" | "jurisdiction_overrides">> = {}): RetentionClass =>
  ({ code, citation, basis, anchor_event, anchor_rule, offset_value, offset_unit, permanent_while_active, timer_code, may_shorten: extra.may_shorten ?? false, disposal_method: extra.disposal_method ?? "crypto_shred", jurisdiction_overrides: extra.jurisdiction_overrides ?? {}, version: RETENTION_SCHEDULE_VERSION, effective_from: SCHEDULE_EFFECTIVE_FROM, effective_to: null });

/**
 * `retention_classes` v1 (versioned, effective-dated) — one row per 19.1 class; `anchor_event` is the timer table's trigger and
 * `anchor_rule` the data model's enum value for its anchor column. Fannie Mae classes may never be shortened (rule 9); the FTC
 * two-year class is the one class that may be (it is a ceiling, not a floor). Electronic objects crypto-shred (rule 7); the
 * `physical_destroy` method is chosen per run for paper media, never per class.
 * The NY class anchors on `loan.final_entry` — the final entry is itself a record whose creation date is the "entry date"
 * (3 NYCRR 419.9: "three years after making the final entry"); Reg Z anchors on the disclosure due date ("the date disclosures
 * are required to be made", §1026.25(a)) — the enum's `form_due_date`. `corporate_7y` has no timer-table row: its anniversary
 * gates manifests and registry rows without a timer code (the annual inventory review is a schedule, not a retention gate).
 */
export const RETENTION_CLASSES: readonly RetentionClass[] = [
  cls("life_of_loan_plus_4y", "Selling Guide A2-4.1-02 (via Servicing Guide A2-5-01)", "guide", "loan.liquidated | servicing.transferred_out", "later_of_liquidation_or_transfer_out", 4, "years", true, "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION"),
  cls("regx_1024_38c1_1y_post_discharge_or_transfer", "12 CFR 1024.38(c)(1)", "law", "loan.discharged | servicing.transferred_out", "discharge_or_transfer_out", 1, "years", true, "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER"),
  cls("fnma_reporting_18m", "Selling Guide A2-4.1-02 (accounting reports, 18 months)", "guide", "investor_report.filed", "report_filed", 18, "months", false, "FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M"),
  cls("regb_1002_12b_25m", "12 CFR 1002.12(b)(1), (b)(4)", "law", "lossmit.decision.notified", "decision_notified", 25, "months", false, "REGB_1002_12B_RETENTION_25M"),
  cls("regz_1026_25a_2y", "12 CFR 1026.25(a)", "law", "notice.sent{regz}", "form_due_date", 2, "years", false, "REGZ_1026_25A_RETENTION_2Y"),
  cls("regf_1006_100a_3y_post_last_collection", "12 CFR 1006.100(a)", "law", "collection.activity.last", "last_collection_activity", 3, "years", false, "REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION"),
  cls("regf_1006_100b_call_3y", "12 CFR 1006.100(b)", "law", "call.recorded", "call_date", 3, "years", false, "REGF_1006_100B_CALL_RECORDING_3Y"),
  cls("ny_419_9_3y_post_final_entry", "3 NYCRR 419.9", "law", "loan.final_entry", "record_created", 3, "years", false, "NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY"),
  cls("nydfs_500_6_audit_trail_5y", "23 NYCRR 500.6", "law", "security_log.written | ledger_entry.created", "record_created", 5, "years", false, "NYDFS_500_6_AUDIT_TRAIL_5Y"),
  cls("tax_4y", "IRS General Instructions for Certain Information Returns (3 years; 4 for 1099-C / backup withholding)", "law", "tax.form.filed", "form_due_date", 4, "years", false, "IRS_INFO_RETURN_RETENTION_4Y"),
  cls("tcpa_consent_4y", "47 CFR 64.1200; 28 U.S.C. 1658(a)", "law", "consent.revoked | last reliance", "revocation_or_last_reliance", 4, "years", false, "TCPA_CONSENT_EVIDENCE_4Y"),
  cls("ftc_314_disposal_2y_post_last_use", "16 CFR 314.4(c)(6)", "law", "contact.last_use", "last_use", 2, "years", false, "FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE", { may_shorten: true, disposal_method: "object_delete" }),
  cls("corporate_7y", "policy (manifests, registry, disposal runs)", "policy", "record.created", "record_created", 7, "years", false, null),
];
export const retentionClass = (code: string): RetentionClass => { const c = RETENTION_CLASSES.find((x) => x.code === code); if (!c) throw new RangeError(`unknown retention class ${code}`); return c; };

/**
 * `jurisdiction_rules.record_retention` — property/borrower state → a longer post-liquidation loan-record period on the Fannie Mae
 * anchor. Populated by licensing counsel [UNVERIFIED — counsel matrix]; an entry, once populated, only ever lengthens (edge
 * case) and never shortens a Fannie Mae class (rule 9). NY's "three years after making the final entry" is a different anchor
 * and is carried as the `ny_419_9_3y_post_final_entry` class, not as an override. `JURISDICTION_STATES_REVIEWED` lists the states
 * counsel has confirmed carry no longer period; every other state is unknown and "defaults to the longest known class".
 */
export const JURISDICTION_RECORD_RETENTION: Readonly<Record<string, JurisdictionOverride>> = {};
export const JURISDICTION_STATES_REVIEWED: ReadonlySet<string> = new Set<string>();
export interface JurisdictionYears { readonly years: number; readonly basis: "class_default" | "jurisdiction_override" | "unknown_state_longest_known"; readonly state: string | null; }
/** Rule 1 / timer table: the 4-year class "or a longer local period" — the engine always applies the maximum; unknown states default to the longest known period. */
export function jurisdictionYears(state: string | null, c: RetentionClass = retentionClass("life_of_loan_plus_4y")): JurisdictionYears {
  const matrix: Record<string, JurisdictionOverride> = { ...c.jurisdiction_overrides, ...JURISDICTION_RECORD_RETENTION };
  const known = state !== null ? matrix[state] : undefined;
  if (known) return { years: Math.max(c.offset_value, known.offset_value), basis: "jurisdiction_override", state };
  if (state !== null && JURISDICTION_STATES_REVIEWED.has(state)) return { years: c.offset_value, basis: "class_default", state };
  const longest = Object.values(matrix).reduce((a, o) => Math.max(a, o.offset_value), 0);
  return longest > c.offset_value ? { years: longest, basis: "unknown_state_longest_known", state } : { years: c.offset_value, basis: "class_default", state };
}

/** Rule 1 anniversary arithmetic per unit (years: same month/day, Feb 29 → Mar 1; months: calendar months; days: calendar days). */
export function gateOpensOn(anchor: PlainDate, c: Pick<RetentionClass, "offset_value" | "offset_unit">): PlainDate {
  if (c.offset_unit === "years") return anniversary(anchor, c.offset_value);
  if (c.offset_unit === "months") return addMonths(anchor, c.offset_value);
  return addDays(anchor, c.offset_value);
}

export type ServicingFileCategory = "i_transactions" | "ii_security_instrument" | "iii_personnel_notes" | "iv_data_fields" | "v_borrower_submitted" | "none";
export interface RecordTypeRow { readonly code: string; readonly system_of_record: string; readonly servicing_file_category: ServicingFileCategory; readonly retention_class_codes: readonly string[]; readonly pii_level: "none" | "low" | "high" | "restricted"; readonly fnma_property: boolean; readonly ny_419_9_scope: boolean; }
const LOAN = ["life_of_loan_plus_4y", "regx_1024_38c1_1y_post_discharge_or_transfer"] as const;   // every loan-linked type: Fannie Mae property + Reg X (c)(1) "records that document actions taken with respect to a borrower's mortgage loan account"
/** `record_types` — the spec's example codes (plus the FTC prospect data of rule 8 and the rule-5 bundle itself); every loan-linked type is Fannie Mae property (A2-4.1-02 "all records related to loans … are Fannie Mae's property") and carries the Reg X (c)(1) floor. */
export const RECORD_TYPES: readonly RecordTypeRow[] = [
  { code: "note_image", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "security_instrument", system_of_record: "documents", servicing_file_category: "ii_security_instrument", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "payment_history", system_of_record: "ledger_entries", servicing_file_category: "i_transactions", retention_class_codes: [...LOAN, "ny_419_9_3y_post_final_entry", "nydfs_500_6_audit_trail_5y"], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "escrow_analysis", system_of_record: "documents", servicing_file_category: "i_transactions", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "notice_rendered", system_of_record: "notices", servicing_file_category: "none", retention_class_codes: [...LOAN, "regz_1026_25a_2y"], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "contact_note", system_of_record: "contacts", servicing_file_category: "iii_personnel_notes", retention_class_codes: [...LOAN, "ny_419_9_3y_post_final_entry", "regf_1006_100a_3y_post_last_collection"], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "call_recording", system_of_record: "recordings", servicing_file_category: "iii_personnel_notes", retention_class_codes: [...LOAN, "regf_1006_100b_call_3y"], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "agent_decision", system_of_record: "agent_decisions", servicing_file_category: "iii_personnel_notes", retention_class_codes: [...LOAN, "nydfs_500_6_audit_trail_5y"], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "lossmit_document_borrower", system_of_record: "documents", servicing_file_category: "v_borrower_submitted", retention_class_codes: [...LOAN, "regb_1002_12b_25m"], pii_level: "restricted", fnma_property: true, ny_419_9_scope: true },
  { code: "noe_document_borrower", system_of_record: "documents", servicing_file_category: "v_borrower_submitted", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "investor_report", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: ["fnma_reporting_18m", "corporate_7y"], pii_level: "low", fnma_property: true, ny_419_9_scope: false },
  { code: "custodial_recon", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: ["corporate_7y", "nydfs_500_6_audit_trail_5y"], pii_level: "low", fnma_property: true, ny_419_9_scope: false },
  { code: "tax_form_1098", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: [...LOAN, "tax_4y"], pii_level: "restricted", fnma_property: true, ny_419_9_scope: true },
  { code: "consent_esign", system_of_record: "consents", servicing_file_category: "none", retention_class_codes: [...LOAN], pii_level: "low", fnma_property: true, ny_419_9_scope: true },
  { code: "consent_tcpa", system_of_record: "consents", servicing_file_category: "none", retention_class_codes: [...LOAN, "tcpa_consent_4y"], pii_level: "low", fnma_property: true, ny_419_9_scope: true },
  { code: "complaint_file", system_of_record: "cases", servicing_file_category: "iii_personnel_notes", retention_class_codes: [...LOAN, "ny_419_9_3y_post_final_entry"], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "foreclosure_file", system_of_record: "cases", servicing_file_category: "none", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "bankruptcy_file", system_of_record: "cases", servicing_file_category: "none", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
  { code: "security_log", system_of_record: "security_logs", servicing_file_category: "none", retention_class_codes: ["nydfs_500_6_audit_trail_5y"], pii_level: "low", fnma_property: false, ny_419_9_scope: false },
  { code: "board_report", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: ["corporate_7y"], pii_level: "none", fnma_property: false, ny_419_9_scope: false },
  { code: "vendor_assessment", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: ["corporate_7y"], pii_level: "none", fnma_property: false, ny_419_9_scope: false },
  { code: "fl_data", system_of_record: "restricted_fl.fair_lending_data", servicing_file_category: "none", retention_class_codes: [...LOAN, "regb_1002_12b_25m"], pii_level: "restricted", fnma_property: true, ny_419_9_scope: false },
  { code: "prospect_contact", system_of_record: "contacts", servicing_file_category: "none", retention_class_codes: ["ftc_314_disposal_2y_post_last_use"], pii_level: "low", fnma_property: false, ny_419_9_scope: false },
  { code: "servicing_file_bundle", system_of_record: "documents", servicing_file_category: "none", retention_class_codes: [...LOAN], pii_level: "high", fnma_property: true, ny_419_9_scope: true },
];

/** Facts that decide whether a conditional class applies to one object: Reg F (a) only on `fdcpa_debt_collector_flag` loans (Section 11.4); Reg Z only for a Reg Z disclosure. Unknown (null/absent) keeps the class — the conservative default. */
export interface ClassificationFlags { readonly fdcpa_debt_collector?: boolean | null; readonly regz_disclosure?: boolean | null; }
export interface Classification { readonly record_type: string; readonly retention_class_codes: readonly string[]; readonly timer_codes: readonly string[]; readonly anchors: readonly { class_code: string; anchor_event: string; anchor_rule: AnchorRule }[]; readonly dropped: readonly { class_code: string; reason: string }[]; readonly servicing_file_category: ServicingFileCategory; readonly fnma_property: boolean; readonly pii_level: RecordTypeRow["pii_level"]; readonly ny_419_9_scope: boolean; readonly effective_rule: "max_over_all_classes"; readonly may_shorten: false; readonly schedule_version: string; }
/**
 * `records.classify`: record type → every applicable class (effective = max, rule 1); refuses unknown types rather than guessing
 * a shorter class. The NY 419.9 class applies to "any New York mortgage loan" — added for NY loans of every in-scope type and
 * dropped for a loan of another known state; an unknown state keeps it (edge case: unknown jurisdictions default to the longest class).
 */
export function classifyRecord(recordType: string, state: string | null = null, flags: ClassificationFlags = {}): Classification {
  const rt = RECORD_TYPES.find((r) => r.code === recordType);
  if (!rt) throw new RangeError(`unknown record_type ${recordType}: default is the longest known class — classify by hand`);
  const NY = "ny_419_9_3y_post_final_entry";
  let codes = [...rt.retention_class_codes];
  const dropped: { class_code: string; reason: string }[] = [];
  if (state === "NY" && rt.ny_419_9_scope && !codes.includes(NY)) codes.push(NY);
  const drop = (code: string, reason: string) => { if (codes.includes(code)) { codes = codes.filter((c) => c !== code); dropped.push({ class_code: code, reason }); } };
  if (state !== null && state !== "NY") drop(NY, `3 NYCRR 419.9 applies to New York mortgage loans; this loan's state is ${state}`);
  if (flags.fdcpa_debt_collector === false) drop("regf_1006_100a_3y_post_last_collection", "12 CFR 1006.100(a) applies where fdcpa_debt_collector_flag = true (Section 11.4); this loan is not collected as a debt collector");
  if (flags.regz_disclosure === false) drop("regz_1026_25a_2y", "12 CFR 1026.25(a) evidence-of-compliance retention applies to Reg Z disclosures; this notice is not one");
  return { record_type: rt.code, retention_class_codes: codes, timer_codes: codes.map((c) => retentionClass(c).timer_code).filter((t): t is string => t !== null), anchors: codes.map((c) => { const k = retentionClass(c); return { class_code: c, anchor_event: k.anchor_event, anchor_rule: k.anchor_rule }; }), dropped, servicing_file_category: rt.servicing_file_category, fnma_property: rt.fnma_property, pii_level: rt.pii_level, ny_419_9_scope: rt.ny_419_9_scope, effective_rule: "max_over_all_classes", may_shorten: false, schedule_version: RETENTION_SCHEDULE_VERSION };
}

// ============================================================ disposal gates (timer table) — condition-shaped, never clocks
export interface GateOutcome { readonly open: boolean; readonly opens_on: PlainDate | null; readonly reason: string | null; }
const later = (a: PlainDate | null, b: PlainDate | null): PlainDate | null => (a && b ? (a > b ? a : b) : a ?? b);
const closed = (reason: string, opens_on: PlainDate | null = null): GateOutcome => ({ open: false, opens_on, reason });
const onOrAfter = (today: PlainDate, opens: PlainDate): GateOutcome => (today >= opens ? { open: true, opens_on: opens, reason: null } : closed(`retention runs to ${opens}`, opens));
/** Rule 1: every gate is indefinitely extended while `hold_count > 0` (overlay `held`). A missing hold fact is not "no hold". */
const withHold = (g: GateOutcome, hold: number | null | undefined): GateOutcome => (hold === undefined ? g : hold === null ? closed("hold_count fact required", g.opens_on) : hold > 0 ? closed("legal_hold", g.opens_on) : g);

/** FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION: later of liquidation/transfer-out + 4 years (or a longer local period); permanent while serviced; never while held. */
export function fnmaRetentionGate(i: { today: PlainDate; liquidated_on: PlainDate | null; transferred_out_on: PlainDate | null; loan_active: boolean; hold_count?: number | null; jurisdiction_years?: number | null }): GateOutcome {
  if (i.loan_active && i.transferred_out_on === null) return closed("permanent_while_active");
  const anchor = later(i.liquidated_on, i.transferred_out_on);
  if (!anchor) return closed("no_anchor_event");
  const years = Math.max(4, i.jurisdiction_years ?? 4);
  return withHold(onOrAfter(i.today, anniversary(anchor, years)), i.hold_count);
}
/** REGX_1024_38C1: one year after discharge (paid in full) or transfer-out — the later if both. A bankruptcy discharge is not a loan discharge (rule 2). */
export function regXRetentionGate(i: { today: PlainDate; discharged_on: PlainDate | null; transferred_out_on: PlainDate | null; bankruptcy_discharge_only?: boolean; hold_count?: number | null }): GateOutcome {
  if (i.bankruptcy_discharge_only && !i.discharged_on && !i.transferred_out_on) return closed("bankruptcy_discharge_is_not_loan_discharge");
  const anchor = later(i.discharged_on, i.transferred_out_on);
  if (!anchor) return closed("no_anchor_event");
  return withHold(onOrAfter(i.today, anniversary(anchor, 1)), i.hold_count);
}
/**
 * REGB_1002_12B_RETENTION_25M (T9): 25 months from notification; §1002.12(b)(4) — "actual notice that it is under investigation
 * or is subject to an enforcement proceeding" extends retention "until final disposition of the matter". The extension is
 * unconditional in time: an enforcement notice received while the record still exists re-closes an already-open gate.
 */
export function regBRetentionGate(i: { today: PlainDate; notified_on: PlainDate | null; enforcement_notice_received_on?: PlainDate | null; investigation_closed_on?: PlainDate | null; hold_count?: number | null }): GateOutcome & { readonly base_opens_on: PlainDate | null; readonly extended_until: "investigation.closed" | null } {
  if (!i.notified_on) return { ...closed("no_anchor_event"), base_opens_on: null, extended_until: null };
  const base = addMonths(i.notified_on, 25);
  const enf = i.enforcement_notice_received_on ?? null;
  const closedOn = i.investigation_closed_on ?? null;
  if (enf !== null && closedOn === null) return { ...withHold(closed("enforcement_open_until_investigation_closed"), i.hold_count), base_opens_on: base, extended_until: "investigation.closed" };
  const opens = enf !== null && closedOn !== null && closedOn > base ? closedOn : base;
  return { ...withHold(onOrAfter(i.today, opens), i.hold_count), base_opens_on: base, extended_until: null };
}
/** TCPA_CONSENT_EVIDENCE_4Y: later of revocation or last reliance + 4 years (federal catch-all limitations period). */
export function tcpaConsentGate(i: { today: PlainDate; revoked_on: PlainDate | null; last_reliance_on: PlainDate | null; hold_count?: number | null }): GateOutcome {
  const anchor = later(i.revoked_on, i.last_reliance_on);
  if (!anchor) return closed("no_anchor_event");
  return withHold(onOrAfter(i.today, anniversary(anchor, 4)), i.hold_count);
}
/** The single-anchor anniversary gates (18-month reports, Reg Z, Reg F (a)/(b), NY 419.9, NYDFS 500.6, IRS): anchor + class offset, held while `hold_count > 0`. */
export function classGate(classCode: string, i: { today: PlainDate; anchor: PlainDate | null; hold_count?: number | null }): GateOutcome {
  const c = retentionClass(classCode);
  if (!i.anchor) return closed("no_anchor_event");
  return withHold(onOrAfter(i.today, gateOpensOn(i.anchor, c)), i.hold_count);
}

/** The facts a disposal command carries to the gates: PlainDates (null = the anchor event has not fired), `hold_count` (null = unknown → closed), `loan_active` for Fannie Mae-property objects, and the applicability flags of the conditional classes. */
export interface GateFacts {
  readonly today: PlainDate; readonly hold_count: number | null; readonly loan_active?: boolean | null; readonly jurisdiction_years?: number | null;
  readonly fdcpa_debt_collector?: boolean | null; readonly regz_disclosure?: boolean | null;
  readonly liquidated_on?: PlainDate | null; readonly transferred_out_on?: PlainDate | null; readonly discharged_on?: PlainDate | null; readonly bankruptcy_discharge_only?: boolean;
  readonly notified_on?: PlainDate | null; readonly enforcement_notice_received_on?: PlainDate | null; readonly investigation_closed_on?: PlainDate | null;
  readonly revoked_on?: PlainDate | null; readonly last_reliance_on?: PlainDate | null;
  readonly filed_on?: PlainDate | null; readonly disclosure_due_date?: PlainDate | null; readonly last_collection_activity_on?: PlainDate | null; readonly call_on?: PlainDate | null; readonly final_entry_on?: PlainDate | null; readonly record_on?: PlainDate | null; readonly form_due_date?: PlainDate | null; readonly last_use_on?: PlainDate | null; readonly created_on?: PlainDate | null;
}
export interface DisposalGate { readonly code: string; readonly class_code: string; readonly evaluator: string; readonly open: (f: GateFacts) => GateOutcome; }
const single = (code: string, class_code: string, evaluator: string, key: keyof GateFacts): DisposalGate => ({ code, class_code, evaluator, open: (f) => classGate(class_code, { today: f.today, anchor: (f[key] as PlainDate | null | undefined) ?? null, hold_count: f.hold_count }) });
/** Every 19.1 not-before gate, keyed by timer code: the evaluator ref the timer row names and the predicate over the object's facts (one source of truth for evaluators-19-1.ts and `assertGateOpen`). */
export const DISPOSAL_GATES: readonly DisposalGate[] = [
  { code: "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", class_code: "life_of_loan_plus_4y", evaluator: "19.1.fnmaRetentionGateOpen", open: (f) => (f.loan_active === undefined || f.loan_active === null ? closed("loan_active fact required (permanent while active)") : fnmaRetentionGate({ today: f.today, liquidated_on: f.liquidated_on ?? null, transferred_out_on: f.transferred_out_on ?? null, loan_active: f.loan_active, hold_count: f.hold_count, jurisdiction_years: f.jurisdiction_years ?? null })) },
  { code: "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER", class_code: "regx_1024_38c1_1y_post_discharge_or_transfer", evaluator: "19.1.regXRetentionGateOpen", open: (f) => regXRetentionGate({ today: f.today, discharged_on: f.discharged_on ?? null, transferred_out_on: f.transferred_out_on ?? null, bankruptcy_discharge_only: f.bankruptcy_discharge_only ?? false, hold_count: f.hold_count }) },
  { code: "REGB_1002_12B_RETENTION_25M", class_code: "regb_1002_12b_25m", evaluator: "19.1.regBRetentionGateOpen", open: (f) => regBRetentionGate({ today: f.today, notified_on: f.notified_on ?? null, enforcement_notice_received_on: f.enforcement_notice_received_on ?? null, investigation_closed_on: f.investigation_closed_on ?? null, hold_count: f.hold_count }) },
  { code: "TCPA_CONSENT_EVIDENCE_4Y", class_code: "tcpa_consent_4y", evaluator: "19.1.tcpaConsentGateOpen", open: (f) => tcpaConsentGate({ today: f.today, revoked_on: f.revoked_on ?? null, last_reliance_on: f.last_reliance_on ?? null, hold_count: f.hold_count }) },
  single("FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M", "fnma_reporting_18m", "19.1.accountingReportGateOpen", "filed_on"),
  single("REGZ_1026_25A_RETENTION_2Y", "regz_1026_25a_2y", "19.1.regZRetentionGateOpen", "disclosure_due_date"),
  single("REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION", "regf_1006_100a_3y_post_last_collection", "19.1.regFCollectionGateOpen", "last_collection_activity_on"),
  single("REGF_1006_100B_CALL_RECORDING_3Y", "regf_1006_100b_call_3y", "19.1.callRecordingGateOpen", "call_on"),
  single("NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY", "ny_419_9_3y_post_final_entry", "19.1.nyFinalEntryGateOpen", "final_entry_on"),
  single("NYDFS_500_6_AUDIT_TRAIL_5Y", "nydfs_500_6_audit_trail_5y", "19.1.nydfsAuditTrailGateOpen", "record_on"),
  single("IRS_INFO_RETURN_RETENTION_4Y", "tax_4y", "19.1.irsInfoReturnGateOpen", "form_due_date"),
];
export const disposalGate = (code: string): DisposalGate => { const g = DISPOSAL_GATES.find((x) => x.code === code); if (!g) throw new RangeError(`no 19.1 disposal gate ${code}`); return g; };
/** Classes without a not-before timer row (FTC two-year deadline; corporate_7y) still gate the object's eligibility by their own anniversary. */
function gateForClass(classCode: string, f: GateFacts): GateOutcome {
  const g = DISPOSAL_GATES.find((x) => x.class_code === classCode);
  if (g) return g.open(f);
  return classGate(classCode, { today: f.today, anchor: classCode === "ftc_314_disposal_2y_post_last_use" ? (f.last_use_on ?? null) : (f.created_on ?? null), hold_count: f.hold_count });
}

export class GateClosed extends Error {
  readonly gate: string; readonly reason: string; readonly opens_on: PlainDate | null;
  constructor(gate: string, reason: string, opens_on: PlainDate | null) { super(`${gate} closed: ${reason}${opens_on ? ` (opens ${opens_on})` : ""}`); this.name = "GateClosed"; this.gate = gate; this.reason = reason; this.opens_on = opens_on; }
}
/** `assertGateOpen` for a disposal command: throws `GateClosed` carrying the timer row and the reason (`permanent_while_active`, `legal_hold`, `retention runs to …`). */
export function assertGateOpen(code: string, facts: GateFacts): { allowed: true; gate: string; opens_on: PlainDate | null } {
  const g = disposalGate(code).open(facts);
  if (!g.open) throw new GateClosed(code, g.reason ?? "closed", g.opens_on);
  return { allowed: true, gate: code, opens_on: g.opens_on };
}
export interface GateRow { readonly class_code: string; readonly timer_code: string | null; readonly open: boolean; readonly opens_on: PlainDate | null; readonly reason: string | null; }
export interface ObjectEligibility { readonly record_type: string; readonly gates: readonly GateRow[]; readonly eligible_for_disposal_at: PlainDate | null; readonly effective_class_code: string | null; readonly disposable: boolean; readonly blocking: readonly string[]; readonly dropped: readonly { class_code: string; reason: string }[]; readonly jurisdiction_years: JurisdictionYears; }
/**
 * Rule 1 for one object: every applicable class of its record type (the NY overlay for NY loans, Reg F (a) on debt-collector
 * loans) must be open — effective eligibility is the max over the classes' opening dates, the effective class the one that
 * opens last; null while any anchor is missing or the loan is active. The jurisdiction override the object's state carries is
 * applied here (max with anything the command asserts), so "the engine always applies the maximum" holds on the disposal path.
 */
export function objectEligibility(recordType: string, state: string | null, facts: GateFacts): ObjectEligibility {
  const c = classifyRecord(recordType, state, { fdcpa_debt_collector: facts.fdcpa_debt_collector ?? null, regz_disclosure: facts.regz_disclosure ?? null });
  const jy = jurisdictionYears(state);
  const f: GateFacts = { ...facts, jurisdiction_years: Math.max(facts.jurisdiction_years ?? 0, jy.years) };
  const gates: GateRow[] = c.retention_class_codes.map((code) => { const g = gateForClass(code, f); return { class_code: code, timer_code: retentionClass(code).timer_code, open: g.open, opens_on: g.opens_on, reason: g.reason }; });
  const opens = gates.map((g) => g.opens_on);
  const eligible = opens.every((d): d is PlainDate => d !== null) && opens.length ? opens.reduce((a, b) => (b > a ? b : a)) : null;
  const effective = eligible ? (gates.find((g) => g.opens_on === eligible)?.class_code ?? null) : null;
  return { record_type: recordType, gates, eligible_for_disposal_at: eligible, effective_class_code: effective, disposable: gates.every((g) => g.open), blocking: gates.filter((g) => !g.open).map((g) => `${g.timer_code ?? g.class_code}: ${g.reason}`), dropped: c.dropped, jurisdiction_years: jy };
}
/** The disposal command's assertion for one object: every gate of every applicable class, through `assertGateOpen` for the timer-table rows; throws `GateClosed` on the first closed gate. */
export function assertObjectGatesOpen(recordType: string, state: string | null, facts: GateFacts): ObjectEligibility {
  const e = objectEligibility(recordType, state, facts);
  const jy = Math.max(facts.jurisdiction_years ?? 0, e.jurisdiction_years.years);
  for (const g of e.gates) {
    if (g.timer_code && DISPOSAL_GATES.some((x) => x.code === g.timer_code)) assertGateOpen(g.timer_code, { ...facts, jurisdiction_years: jy });
    else if (!g.open) throw new GateClosed(g.timer_code ?? g.class_code, g.reason ?? "closed", g.opens_on);
  }
  return e;
}

// ============================================================ corrected loan-level calculator (worked examples A/B; Reg B extension)
export interface LoanRetentionInput extends RetentionInput { readonly enforcement_notice_received_on?: PlainDate | null; readonly investigation_closed_on?: PlainDate | null; readonly jurisdiction_years?: number | null; }
export interface LoanRetentionGates extends RetentionGates { readonly reg_b_extended_until: "investigation.closed" | null; }
/**
 * Rule 1 at loan level (worked examples A and B) with the Reg B branch corrected: an open enforcement proceeding extends the
 * Reg B gate until `investigation.closed` (§1002.12(b)(4)) — the effective date is unknown, never earlier, while it is open;
 * once closed the gate is the later of the 25 months and the closing date. Fannie Mae's 4 years take the longer local period.
 */
export function loanRetention(i: LoanRetentionInput, asOf: PlainDate): LoanRetentionGates {
  const regx = i.transferred_out_on ? anniversary(i.transferred_out_on, 1) : i.discharged_on ? anniversary(i.discharged_on, 1) : null;
  const regf = i.fdcpa_debt_collector && i.last_collection_activity_on ? anniversary(i.last_collection_activity_on, 3) : null;
  const ny = i.state === "NY" && i.final_entry_on ? anniversary(i.final_entry_on, 3) : null;
  const years = Math.max(4, i.jurisdiction_years ?? 0, jurisdictionYears(i.state).years);
  const fnma = i.liquidated_on ? anniversary(i.liquidated_on, years) : null;
  const policy = i.transferred_out_on ? anniversary(i.transferred_out_on, years) : null;
  const enforcement = (i.enforcement_open ?? false) || (i.enforcement_notice_received_on ?? null) !== null;
  const closedOn = i.investigation_closed_on ?? null;
  const base = i.reg_b_notified_on ? addMonths(i.reg_b_notified_on, 25) : null;
  const extended = base !== null && enforcement && closedOn === null;
  const regB = base === null ? null : extended ? null : enforcement && closedOn !== null && closedOn > base ? closedOn : base;
  const gates = [regx, regf, ny, fnma, policy, regB].filter((x): x is PlainDate => x !== null);
  const eligible = extended || gates.length === 0 ? null : gates.reduce((a, b) => (b > a ? b : a));
  const status: RetentionGates["status"] = i.loan_active && i.transferred_out_on === null ? "permanent_while_active" : i.hold_count > 0 ? "held" : eligible !== null && eligible <= asOf ? "eligible" : "retained";
  return { regx, regf, ny, fnma, policy_transfer: policy, reg_b: regB, eligible_for_disposal_at: eligible, status, reg_b_extended_until: extended ? "investigation.closed" : null };
}

// ============================================================ record-object lifecycle (state machine)
export type RecordStatus = "active" | "retention_running" | "eligible" | "held" | "disposed";
/** The object's own anchors and applicability facts (`record_objects.anchors`): what the sweep evaluates every class against. */
export type ObjectFacts = Omit<GateFacts, "today" | "hold_count">;
export interface RecordObject { readonly id: string; readonly record_type: string; readonly loan_id: string | null; readonly state: string | null; readonly facts: ObjectFacts; readonly sha256: string; readonly worm_sha256: string | null; readonly status: RecordStatus; readonly hold_count: number; readonly hold_ids: readonly string[]; readonly eligible_for_disposal_at: PlainDate | null; readonly effective_class_code: string | null; readonly gates: readonly GateRow[]; readonly disposed_at: string | null; readonly disposal_run_id: string | null; }
export type EventSink = { append<P extends Record<string, unknown>>(input: EventInput<P>): DomainEvent<P> };
export interface LifecycleContext { readonly events: EventSink; readonly actor: Actor; readonly now: string; }

/** Rule 1 for one object as the sweep sees it today. */
export const objectGates = (o: RecordObject, today: PlainDate): ObjectEligibility => objectEligibility(o.record_type, o.state, { ...o.facts, today, hold_count: o.hold_count });
/**
 * `retention-sweep` (daily 01:00 ET): every class of every object (`objectEligibility`) — `active` while the loan is serviced or
 * no anchor has fired, `retention_running` until the max gate, `eligible` on/after it, `held` while `hold_count > 0`;
 * `disposed` is terminal. The per-class outcomes are kept on the object (`record_objects.gate_outcomes`) for the planner's
 * decision record.
 */
export function sweep(objects: readonly RecordObject[], today: PlainDate): RecordObject[] {
  return objects.map((o) => {
    if (o.status === "disposed") return o;
    const e = objectGates(o, today);
    const permanent = e.gates.some((g) => g.reason === "permanent_while_active");
    const unanchored = e.gates.length > 0 && e.gates.every((g) => g.reason === "no_anchor_event");
    const status: RecordStatus = o.hold_count > 0 ? "held" : permanent || unanchored ? "active" : e.disposable ? "eligible" : "retention_running";
    return { ...o, status, eligible_for_disposal_at: e.eligible_for_disposal_at, effective_class_code: e.effective_class_code, gates: e.gates };
  });
}
export type HoldReason = "litigation" | "litigation_anticipated" | "subpoena" | "regulator_exam" | "fannie_mae_request" | "mora" | "complaint_escalated" | "internal_investigation" | "audit" | "incident";
export type HoldScope = "loan" | "borrower" | "case" | "portfolio_batch" | "record_type" | "vendor" | "global";
export interface LegalHold { readonly id: string; readonly scope: HoldScope; readonly scope_ref: string; readonly reason: HoldReason; readonly matter_ref: string; readonly placed_by: string; readonly placed_at: string; readonly next_review_at: string; readonly auto_placed: boolean; readonly released_at: string | null; readonly release_approvals: readonly string[]; readonly last_reviewed_at: string | null; }
export const HOLD_REVIEW_DAYS = 180;
const inScope = (h: Pick<LegalHold, "scope" | "scope_ref">, o: RecordObject): boolean => h.scope === "global" || (h.scope === "loan" && o.loan_id === h.scope_ref) || (h.scope === "record_type" && o.record_type === h.scope_ref) || (h.scope === "portfolio_batch" && h.scope_ref.split(",").includes(o.loan_id ?? ""));
const holdEvent = (h: LegalHold): { loanId?: string; aggregate: { kind: "legal_hold"; id: string } } => ({ ...(h.scope === "loan" ? { loanId: h.scope_ref } : {}), aggregate: { kind: "legal_hold", id: h.id } });
/** `holds.place`: agent, officer or attorney may place; every object in scope becomes `held` (`legal_hold_objects` materialized) and `legal_hold.placed` arms SM_LEGAL_HOLD_REVIEW_180. */
export function placeHold(objects: readonly RecordObject[], h: { id: string; scope: HoldScope; scope_ref: string; reason: HoldReason; matter_ref: string; auto_placed?: boolean }, ctx: LifecycleContext): { hold: LegalHold; objects: RecordObject[]; event: DomainEvent } {
  const placedMs = Date.parse(ctx.now);
  if (Number.isNaN(placedMs)) throw new RangeError("now must be an ISO timestamp");
  const hold: LegalHold = { id: h.id, scope: h.scope, scope_ref: h.scope_ref, reason: h.reason, matter_ref: h.matter_ref, placed_by: `${ctx.actor.kind}:${ctx.actor.id}`, placed_at: ctx.now, next_review_at: new Date(placedMs + HOLD_REVIEW_DAYS * 86_400_000).toISOString(), auto_placed: h.auto_placed ?? false, released_at: null, release_approvals: [], last_reviewed_at: null };
  const next = objects.map((o) => (o.status !== "disposed" && inScope(hold, o) ? { ...o, hold_count: o.hold_count + 1, hold_ids: [...o.hold_ids, hold.id], status: "held" as const } : o));
  const event = ctx.events.append({ type: "legal_hold.placed", ...holdEvent(hold), actor: ctx.actor, payload: { hold_id: hold.id, scope: hold.scope, scope_ref: hold.scope_ref, reason: hold.reason, matter_ref: hold.matter_ref, placed_at: hold.placed_at, next_review_at: hold.next_review_at, auto_placed: hold.auto_placed, object_ids: next.filter((o) => o.hold_ids.includes(hold.id)).map((o) => o.id) } });
  return { hold, objects: next, event };
}
/** SM_LEGAL_HOLD_REVIEW_180 (every 180 days per hold): the review is a recorded act — `legal_hold.reviewed` satisfies the clock and re-arms it 180 days out. A review never releases: `release_recommended` only queues the officer + attorney act. */
export function reviewLegalHold(hold: LegalHold, i: { outcome: "continue" | "release_recommended"; matter_status: string }, ctx: LifecycleContext): { hold: LegalHold; event: DomainEvent } {
  if (hold.released_at) throw new RangeError(`hold ${hold.id} was released ${hold.released_at}: nothing to review`);
  if (!i.matter_status.trim()) throw new RangeError("a hold review records the matter's status");
  const nowMs = Date.parse(ctx.now);
  if (Number.isNaN(nowMs)) throw new RangeError("now must be an ISO timestamp");
  const next: LegalHold = { ...hold, last_reviewed_at: ctx.now, next_review_at: new Date(nowMs + HOLD_REVIEW_DAYS * 86_400_000).toISOString() };
  const event = ctx.events.append({ type: "legal_hold.reviewed", ...holdEvent(hold), actor: ctx.actor, payload: { hold_id: hold.id, outcome: i.outcome, matter_status: i.matter_status.trim(), reviewed_by: `${ctx.actor.kind}:${ctx.actor.id}`, reviewed_at: ctx.now, next_review_at: next.next_review_at, release_requires: "officer_and_attorney" } });
  return { hold: next, event };
}
export interface HoldRelease { readonly allowed: boolean; readonly code: "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY" | null; readonly hold: LegalHold; readonly objects: RecordObject[]; readonly event: DomainEvent | null; }
/** `holds.release` — human only (POL-REC-02): officer + attorney jointly; never automatic. On release the sweep re-evaluates every object that was held (rule 3). */
export function releaseHold(objects: readonly RecordObject[], hold: LegalHold, approvals: readonly ("officer" | "attorney")[], ctx: LifecycleContext, today: PlainDate = wallClock(Date.parse(ctx.now), "America/New_York").date): HoldRelease {
  if (ctx.actor.kind !== "human" || !holdReleaseAllowed(approvals)) return { allowed: false, code: "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY", hold, objects: [...objects], event: null };
  const released: LegalHold = { ...hold, released_at: ctx.now, release_approvals: [...approvals] };
  const lifted = objects.map((o) => (o.hold_ids.includes(hold.id) ? { ...o, hold_count: Math.max(0, o.hold_count - 1), hold_ids: o.hold_ids.filter((x) => x !== hold.id) } : o));
  const event = ctx.events.append({ type: "legal_hold.released", ...holdEvent(hold), actor: ctx.actor, payload: { hold_id: hold.id, released_by: `${ctx.actor.kind}:${ctx.actor.id}`, release_approvals: [...approvals], released_at: ctx.now } });
  return { allowed: true, code: null, hold: released, objects: sweep(lifted, today), event };
}

// ============================================================ anchor events (inputs and triggers): enrolment in the lifecycle engine
export const LIQUIDATION_KINDS = ["paid_in_full", "foreclosure_sale", "short_sale", "dil", "charge_off", "repurchase", "make_whole"] as const;
export type LiquidationKind = (typeof LIQUIDATION_KINDS)[number];
const isPlainDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
/** The anchor an event carries onto every (undisposed) record object of its loan — `record_objects.anchors`, written in the same transaction as the event (inputs paragraph). */
function anchorLoanObjects(objects: readonly RecordObject[], loanId: string, patch: Partial<ObjectFacts>): RecordObject[] {
  return objects.map((o) => (o.loan_id === loanId && o.status !== "disposed" ? { ...o, facts: { ...o.facts, ...patch } } : o));
}
/**
 * `loan.liquidated{liquidation_kind}` — the Fannie Mae liquidation of rule 2 (payoff, foreclosure/REO conveyance, short sale,
 * Mortgage Release, charge-off, repurchase/make-whole): arms FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION for the loan and
 * anchors `liquidated_on` (the loan is no longer active) on every record object of the loan. A payoff is also the Reg X
 * discharge (paid in full / satisfied), so `paid_in_full` records `loan.discharged` in the same transaction.
 */
export function recordLoanLiquidated(objects: readonly RecordObject[], i: { loan_id: string; liquidation_kind: LiquidationKind; liquidated_on: PlainDate; source_process?: string }, ctx: LifecycleContext): { objects: RecordObject[]; events: readonly DomainEvent[] } {
  if (!(LIQUIDATION_KINDS as readonly string[]).includes(i.liquidation_kind)) throw new RangeError(`liquidation_kind must be one of ${LIQUIDATION_KINDS.join(", ")}, not ${String(i.liquidation_kind)}`);
  if (!isPlainDate(i.liquidated_on)) throw new RangeError("liquidated_on must be a PlainDate (YYYY-MM-DD)");
  if (!i.loan_id.trim()) throw new RangeError("loan_id is required");
  const events: DomainEvent[] = [ctx.events.append({ type: "loan.liquidated", loanId: i.loan_id, actor: ctx.actor, payload: { liquidation_kind: i.liquidation_kind, liquidated_on: i.liquidated_on, loan_active: false, source_process: i.source_process ?? "19.1", anchor_rule: "later_of_liquidation_or_transfer_out" satisfies AnchorRule, timer_code: "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION" } })];
  let next = anchorLoanObjects(objects, i.loan_id, { liquidated_on: i.liquidated_on, loan_active: false });
  if (i.liquidation_kind === "paid_in_full") { const d = recordLoanDischarged(next, { loan_id: i.loan_id, basis: "paid_in_full", discharged_on: i.liquidated_on }, ctx); next = d.objects; events.push(d.event); }
  return { objects: next, events };
}
/**
 * `loan.discharged{basis}` — Reg X §1024.38(c)(1)'s "discharged": paid in full / satisfied. A bankruptcy discharge of personal
 * liability never discharges the loan (rule 2; edge case) and is refused here — the bankruptcy case places a hold instead.
 * Arms REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER and anchors `discharged_on` on the loan's objects.
 */
export function recordLoanDischarged(objects: readonly RecordObject[], i: { loan_id: string; basis: "paid_in_full" | "satisfied" | "bankruptcy_discharge"; discharged_on: PlainDate }, ctx: LifecycleContext): { objects: RecordObject[]; event: DomainEvent } {
  if (i.basis === "bankruptcy_discharge") throw new RangeError("a bankruptcy discharge of personal liability does not discharge the loan (19.1 rule 2): not a `loan.discharged` anchor — place a legal hold (reason litigation) for the case instead");
  if (i.basis !== "paid_in_full" && i.basis !== "satisfied") throw new RangeError(`discharge basis must be paid_in_full or satisfied, not ${String(i.basis)}`);
  if (!isPlainDate(i.discharged_on)) throw new RangeError("discharged_on must be a PlainDate (YYYY-MM-DD)");
  if (!i.loan_id.trim()) throw new RangeError("loan_id is required");
  const event = ctx.events.append({ type: "loan.discharged", loanId: i.loan_id, actor: ctx.actor, payload: { basis: i.basis, discharged_on: i.discharged_on, bankruptcy_discharge: false, anchor_rule: "discharge_or_transfer_out" satisfies AnchorRule, timer_code: "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER" } });
  return { objects: anchorLoanObjects(objects, i.loan_id, { discharged_on: i.discharged_on, bankruptcy_discharge_only: false }), event };
}
/**
 * Edge case "loan reported liquidated in error": the internal anchor is reversed by a correcting `loan.liquidation.reversed`
 * — the loan's retention gate timers are cancelled with the reason and the objects' anchors cleared (the loan is active
 * again); they are re-created by `recordLoanLiquidated` on the true liquidation.
 */
export function reverseLoanLiquidation(objects: readonly RecordObject[], i: { loan_id: string; reason: string }, ctx: LifecycleContext, timers: TimerPort): { objects: RecordObject[]; event: DomainEvent; cancelled_timer_ids: readonly string[] } {
  if (!i.reason.trim()) throw new RangeError("a liquidation reversal records its reason");
  const gates = ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER"];
  const open = timers.forSubject("loan", i.loan_id).filter((t) => gates.includes(t.code) && (t.status === "armed" || t.status === "breached"));
  const reason = `liquidation reversed: ${i.reason.trim()}`;
  for (const t of open) timers.cancel(t.id, reason, ctx.actor);
  const event = ctx.events.append({ type: "loan.liquidation.reversed", loanId: i.loan_id, actor: ctx.actor, payload: { reason: i.reason.trim(), cancelled_timer_ids: open.map((t) => t.id), loan_active: true, reversed_at: ctx.now } });
  return { objects: anchorLoanObjects(objects, i.loan_id, { liquidated_on: null, discharged_on: null, loan_active: true }), event, cancelled_timer_ids: open.map((t) => t.id) };
}
export type SecurityLogKind = "auth" | "access" | "admin" | "config_change" | "data_access" | "cybersecurity_event" | "transaction_reconstruction";
export interface SecurityLogEntry { readonly id: string; readonly kind: SecurityLogKind; readonly record_on?: PlainDate; readonly loan_id?: string | null; readonly detail: Record<string, unknown>; readonly worm_location?: string | null; }
/**
 * `security_log.written` — every audit-trail write (23 NYCRR 500.6) is enrolled in the lifecycle engine synchronously as a
 * `security_log` record object anchored on its record date (`record_on`, the entry's civil date): the event arms
 * NYDFS_500_6_AUDIT_TRAIL_5Y for the entry, and the object's gate opens five years later. The entry is hashed for the WORM copy.
 */
export function writeSecurityLog(i: SecurityLogEntry, ctx: LifecycleContext): { object: RecordObject; event: DomainEvent } {
  if (!i.id.trim()) throw new RangeError("a security log entry has an id");
  if (!["auth", "access", "admin", "config_change", "data_access", "cybersecurity_event", "transaction_reconstruction"].includes(i.kind)) throw new RangeError(`unknown security log kind ${String(i.kind)}`);
  const record_on = i.record_on ?? civilDate(ctx.now);
  if (!isPlainDate(record_on)) throw new RangeError("record_on must be a PlainDate (YYYY-MM-DD)");
  const sha256 = createHash("sha256").update(JSON.stringify({ id: i.id, kind: i.kind, record_on, detail: i.detail }, bigintSafe)).digest("hex");
  const object: RecordObject = { id: `ro-seclog-${i.id}`, record_type: "security_log", loan_id: i.loan_id ?? null, state: null, facts: { record_on, created_on: record_on }, sha256, worm_sha256: i.worm_location ? sha256 : null, status: "active", hold_count: 0, hold_ids: [], eligible_for_disposal_at: null, effective_class_code: null, gates: [], disposed_at: null, disposal_run_id: null };
  const event = ctx.events.append({ type: "security_log.written", ...(i.loan_id ? { loanId: i.loan_id } : {}), aggregate: { kind: "security_log", id: i.id }, actor: ctx.actor, payload: { log_id: i.id, kind: i.kind, record_on, record_type: "security_log", record_object_id: object.id, sha256, worm_location: i.worm_location ?? null, class_code: "nydfs_500_6_audit_trail_5y", timer_code: "NYDFS_500_6_AUDIT_TRAIL_5Y" } });
  return { object: sweep([object], record_on)[0]!, event };
}

// ---- the other anchor events of the inputs paragraph: each is a real write of a record (enrolled in the lifecycle engine
// synchronously, "same transaction") that appends the anchor event with its anchor field — the trigger the timer table names.
const requireDate = (v: unknown, name: string): PlainDate => { if (!isPlainDate(v)) throw new RangeError(`${name} must be a PlainDate (YYYY-MM-DD)`); return v; };
const requireText = (v: unknown, name: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${name} is required`); return v.trim(); };
const hashOf = (v: unknown): string => createHash("sha256").update(JSON.stringify(v, bigintSafe)).digest("hex");
/** A new record object, classified and swept on its anchor date (`record_objects` row written with the event). */
function enrol(i: { id: string; record_type: string; loan_id: string | null; state: string | null; facts: ObjectFacts; content: unknown; worm_location?: string | null }, today: PlainDate): RecordObject {
  const sha256 = hashOf(i.content);
  return sweep([{ id: i.id, record_type: i.record_type, loan_id: i.loan_id, state: i.state, facts: i.facts, sha256, worm_sha256: i.worm_location ? sha256 : null, status: "active", hold_count: 0, hold_ids: [], eligible_for_disposal_at: null, effective_class_code: null, gates: [], disposed_at: null, disposal_run_id: null }], today)[0]!;
}
/** The loan's anchor already on file (liquidation or transfer-out) — a later entry must not precede it. */
const loanAnchorOf = (objects: readonly RecordObject[], loanId: string): PlainDate | null => objects.filter((o) => o.loan_id === loanId).map((o) => later(o.facts.liquidated_on ?? null, o.facts.transferred_out_on ?? null)).reduce<PlainDate | null>((a, b) => later(a, b), null);
/**
 * `loan.final_entry` (3 NYCRR 419.9; rule 2): the last ledger or servicing entry of a liquidated or transferred-out loan —
 * typically the escrow refund or the final remittance — computed by the lifecycle engine when that entry posts. It arms
 * NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY and anchors `final_entry_on` on the loan's objects (the class applies to NY loans;
 * `records.classify` drops it for a loan of another state, so the anchor is harmless there).
 */
export function recordLoanFinalEntry(objects: readonly RecordObject[], i: { loan_id: string; entry_on: PlainDate; entry_kind: "escrow_refund" | "final_remittance" | "ledger_entry" | "servicing_entry"; entry_ref: string; state: string | null }, ctx: LifecycleContext): { objects: RecordObject[]; event: DomainEvent } {
  const loanId = requireText(i.loan_id, "loan_id"); const on = requireDate(i.entry_on, "entry_on"); requireText(i.entry_ref, "entry_ref");
  if (!["escrow_refund", "final_remittance", "ledger_entry", "servicing_entry"].includes(i.entry_kind)) throw new RangeError(`entry_kind must name the final ledger or servicing entry, not ${String(i.entry_kind)}`);
  const anchor = loanAnchorOf(objects, loanId);
  if (anchor === null) throw new RangeError(`loan ${loanId} has no liquidation or transfer-out anchor on file: a final entry follows the liquidation (rule 2)`);
  if (on < anchor) throw new RangeError(`final entry ${on} precedes the loan's liquidation/transfer-out anchor ${anchor}`);
  const event = ctx.events.append({ type: "loan.final_entry", loanId, actor: ctx.actor, payload: { entry_on: on, final_entry_on: on, entry_kind: i.entry_kind, entry_ref: i.entry_ref.trim(), state: i.state, ny_419_9_scope: i.state === "NY", anchor_rule: "record_created" satisfies AnchorRule, class_code: "ny_419_9_3y_post_final_entry", timer_code: "NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY" } });
  return { objects: anchorLoanObjects(objects, loanId, { final_entry_on: on }), event };
}
/**
 * `lossmit.decision.notified` (Reg B anchor, §1002.12(b)(1); Section 12 treats loss-mitigation decisions as credit decisions):
 * the notice of action taken on the loan's application — arms REGB_1002_12B_RETENTION_25M and anchors `notified_on` on the
 * loan's objects (the Reg B class binds its loss-mitigation file and fair-lending data through `records.classify`).
 */
export function recordLossmitDecisionNotified(objects: readonly RecordObject[], i: { loan_id: string; case_id: string; decision: "approved" | "denied" | "counteroffer" | "incomplete" | "withdrawn"; notified_on: PlainDate; notice_id: string }, ctx: LifecycleContext): { objects: RecordObject[]; event: DomainEvent } {
  const loanId = requireText(i.loan_id, "loan_id"); const on = requireDate(i.notified_on, "notified_on"); requireText(i.case_id, "case_id"); requireText(i.notice_id, "notice_id");
  if (!["approved", "denied", "counteroffer", "incomplete", "withdrawn"].includes(i.decision)) throw new RangeError(`decision must be the action taken on the application, not ${String(i.decision)}`);
  const event = ctx.events.append({ type: "lossmit.decision.notified", loanId, aggregate: { kind: "case", id: i.case_id.trim() }, actor: ctx.actor, payload: { case_id: i.case_id.trim(), decision: i.decision, notified_on: on, notice_id: i.notice_id.trim(), anchor_rule: "decision_notified" satisfies AnchorRule, class_code: "regb_1002_12b_25m", timer_code: "REGB_1002_12B_RETENTION_25M" } });
  return { objects: anchorLoanObjects(objects, loanId, { notified_on: on }), event };
}
/** `call.recorded` (12 CFR 1006.100(b)): the telephony integration's recording is enrolled as a `call_recording` object anchored on the call date; arms REGF_1006_100B_CALL_RECORDING_3Y (a floor — the object also carries the loan's classes). */
export function recordCallRecorded(i: { loan_id: string; call_id: string; call_on: PlainDate; recording_ref: string; duration_seconds: number; state?: string | null; worm_location?: string | null }, ctx: LifecycleContext): { object: RecordObject; event: DomainEvent } {
  const loanId = requireText(i.loan_id, "loan_id"); const callId = requireText(i.call_id, "call_id"); const on = requireDate(i.call_on, "call_on"); requireText(i.recording_ref, "recording_ref");
  if (!(Number.isFinite(i.duration_seconds) && i.duration_seconds > 0)) throw new RangeError("a recording has a positive duration");
  const object = enrol({ id: `ro-call-${callId}`, record_type: "call_recording", loan_id: loanId, state: i.state ?? null, facts: { call_on: on, created_on: on, loan_active: true }, content: { call_id: callId, call_on: on, recording_ref: i.recording_ref, duration_seconds: i.duration_seconds }, worm_location: i.worm_location ?? null }, on);
  const event = ctx.events.append({ type: "call.recorded", loanId, aggregate: { kind: "call", id: callId }, actor: ctx.actor, payload: { call_id: callId, call_on: on, recording_ref: i.recording_ref.trim(), duration_seconds: i.duration_seconds, record_type: "call_recording", record_object_id: object.id, sha256: object.sha256, anchor_rule: "call_date" satisfies AnchorRule, class_code: "regf_1006_100b_call_3y", timer_code: "REGF_1006_100B_CALL_RECORDING_3Y" } });
  return { object, event };
}
export const INFORMATION_RETURN_FORMS = ["1098", "1099-A", "1099-C", "1099-INT", "1099-MISC"] as const;
/** `tax.form.filed` (IRS anchor): a filed information return is enrolled as a `tax_form_1098` object anchored on the form's due date (`form_due_date`, the timer row's anchor field); arms IRS_INFO_RETURN_RETENTION_4Y. */
export function recordTaxFormFiled(i: { loan_id: string; form: (typeof INFORMATION_RETURN_FORMS)[number]; tax_year: number; filed_on: PlainDate; form_due_date: PlainDate; document_id: string; state?: string | null; worm_location?: string | null }, ctx: LifecycleContext): { object: RecordObject; event: DomainEvent } {
  const loanId = requireText(i.loan_id, "loan_id"); const docId = requireText(i.document_id, "document_id"); const filed = requireDate(i.filed_on, "filed_on"); const due = requireDate(i.form_due_date, "form_due_date");
  if (!(INFORMATION_RETURN_FORMS as readonly string[]).includes(i.form)) throw new RangeError(`form must be one of ${INFORMATION_RETURN_FORMS.join(", ")}, not ${String(i.form)}`);
  if (!Number.isInteger(i.tax_year) || Number(due.slice(0, 4)) !== i.tax_year + 1) throw new RangeError(`form due date ${due} is not the filing due date for tax year ${i.tax_year} (information returns are due in the following year)`);
  if (filed > due && !i.worm_location) { /* late filings are still enrolled: the anchor is the due date, not the filing date */ }
  const object = enrol({ id: `ro-tax-${docId}`, record_type: "tax_form_1098", loan_id: loanId, state: i.state ?? null, facts: { form_due_date: due, filed_on: filed, created_on: filed, loan_active: true }, content: { form: i.form, tax_year: i.tax_year, filed_on: filed, form_due_date: due, document_id: docId }, worm_location: i.worm_location ?? null }, filed);
  const event = ctx.events.append({ type: "tax.form.filed", loanId, aggregate: { kind: "document", id: docId }, actor: ctx.actor, payload: { form: i.form, tax_year: i.tax_year, filed_on: filed, form_due_date: due, document_id: docId, record_type: "tax_form_1098", record_object_id: object.id, sha256: object.sha256, anchor_rule: "form_due_date" satisfies AnchorRule, class_code: "tax_4y", timer_code: "IRS_INFO_RETURN_RETENTION_4Y" } });
  return { object, event };
}
/** `investor_report.filed` (A2-4.1-02, 18-month accounting-report anchor): a monthly accounting report filed with Fannie Mae is enrolled as an `investor_report` object anchored on its filed date; arms FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M. */
export function recordInvestorReportFiled(i: { report_id: string; period: string; filed_on: PlainDate; document_id: string; worm_location?: string | null }, ctx: LifecycleContext): { object: RecordObject; event: DomainEvent } {
  const reportId = requireText(i.report_id, "report_id"); const docId = requireText(i.document_id, "document_id"); const filed = requireDate(i.filed_on, "filed_on");
  if (!/^\d{4}-\d{2}$/.test(i.period)) throw new RangeError("period is the reporting month (YYYY-MM)");
  const object = enrol({ id: `ro-rpt-${reportId}`, record_type: "investor_report", loan_id: null, state: null, facts: { filed_on: filed, created_on: filed }, content: { report_id: reportId, period: i.period, filed_on: filed, document_id: docId }, worm_location: i.worm_location ?? null }, filed);
  const event = ctx.events.append({ type: "investor_report.filed", aggregate: { kind: "investor_report", id: reportId }, actor: ctx.actor, payload: { report_id: reportId, period: i.period, filed_on: filed, document_id: docId, record_type: "investor_report", record_object_id: object.id, sha256: object.sha256, anchor_rule: "report_filed" satisfies AnchorRule, class_code: "fnma_reporting_18m", timer_code: "FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M" } });
  return { object, event };
}
/**
 * `contact.last_use` (16 CFR 314.4(c)(6), rule 8): customer information **not** linked to a serviced loan — prospect contact
 * data, abandoned third-party enrolments — is enrolled as a `prospect_contact` object anchored on its last use and arms the
 * FTC two-year deadline. Loan-linked information is refused here: it is "otherwise required to be retained" (Fannie Mae /
 * Reg X) and never carries the FTC clock — the loan's own anchors govern it.
 */
export function recordContactLastUse(objects: readonly RecordObject[], i: { contact_id: string; last_used_on: PlainDate; loan_linked: boolean; use: string }, ctx: LifecycleContext, timers?: TimerPort): { objects: RecordObject[]; object: RecordObject; event: DomainEvent; superseded_timer_ids: readonly string[] } {
  const contactId = requireText(i.contact_id, "contact_id"); const on = requireDate(i.last_used_on, "last_used_on"); requireText(i.use, "use");
  if (i.loan_linked) throw new RangeError(`contact ${contactId} is linked to a serviced loan: loan-linked information is otherwise required to be retained (rule 8) — the FTC two-year clock does not run`);
  const id = `ro-contact-${contactId}`;
  const existing = objects.find((o) => o.id === id);
  if (existing?.status === "disposed") throw new RangeError(`contact ${contactId} was disposed ${existing.disposed_at}: disposed is terminal`);
  if (existing && isPlainDate(existing.facts.last_use_on) && on < existing.facts.last_use_on) throw new RangeError(`use on ${on} precedes the last use on file (${existing.facts.last_use_on}): the clock runs from the last date the information is used`);
  const object = existing ? sweep([{ ...existing, facts: { ...existing.facts, last_use_on: on } }], on)[0]! : enrol({ id, record_type: "prospect_contact", loan_id: null, state: null, facts: { last_use_on: on, created_on: on }, content: { contact_id: contactId } }, on);
  // 16 CFR 314.4(c)(6): "two years after the last date the information is used" — a later use supersedes the clock the earlier use armed
  const prior = timers ? timers.forSubject("contact", contactId).filter((t) => t.code === FTC_DISPOSAL_TIMER && (t.status === "armed" || t.status === "breached")) : [];
  for (const t of prior) timers!.cancel(t.id, `superseded: information used again ${on}; the two-year clock runs from the last use`, ctx.actor);
  const event = ctx.events.append({ type: "contact.last_use", aggregate: { kind: "contact", id: contactId }, actor: ctx.actor, payload: { contact_id: contactId, last_used_on: on, last_use_on: on, use: i.use.trim(), loan_linked: false, record_type: "prospect_contact", record_object_id: object.id, superseded_timer_ids: prior.map((t) => t.id), anchor_rule: "last_use" satisfies AnchorRule, class_code: "ftc_314_disposal_2y_post_last_use", timer_code: FTC_DISPOSAL_TIMER } });
  return { objects: existing ? objects.map((o) => (o.id === id ? object : o)) : [...objects, object], object, event, superseded_timer_ids: prior.map((t) => t.id) };
}
export type IngestedAnchor = "servicing.transferred_out" | "collection.activity.last" | "consent.revoked" | "notice.sent" | "ledger_entry.created";
/**
 * Anchor events other processes append (17.3's `servicing.transferred_out`, 11.4's `collection.activity.last`, 11.1's
 * `consent.revoked`, the notice registry's `notice.sent{regz}`, the ledger's `ledger_entry.created`): the lifecycle engine
 * ingests each — validated for the loan and the anchor date it carries — and lands the anchor on the loan's objects. Refuses an
 * event it does not ingest, one without a loan, or one whose anchor date is missing.
 */
export function ingestAnchorEvent(objects: readonly RecordObject[], e: DomainEvent): { objects: RecordObject[]; anchored: readonly string[]; patch: Partial<ObjectFacts> } {
  const p = e.payload as Record<string, unknown>;
  const loanId = e.loanId; if (!loanId) throw new RangeError(`${e.type} ${e.id} names no loan: nothing to anchor`);
  const dateOf = (...keys: string[]): PlainDate => { for (const k of keys) if (isPlainDate(p[k])) return p[k] as PlainDate; for (const k of keys) if (typeof p[k] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(p[k] as string)) return civilDate(p[k] as string); return civilDate(e.occurredAt); };
  let patch: Partial<ObjectFacts>;
  switch (e.type as IngestedAnchor) {
    case "servicing.transferred_out": patch = { transferred_out_on: dateOf("transferred_on", "transfer_date", "effective_date", "transferred_out_on") }; break;
    case "collection.activity.last": patch = { last_collection_activity_on: dateOf("last_activity_on", "activity_on", "last_collection_activity_on"), fdcpa_debt_collector: p.fdcpa_debt_collector_flag === false ? false : true }; break;
    case "consent.revoked": patch = { revoked_on: dateOf("revoked_on", "effective_on", "received_on") }; break;
    case "notice.sent": if (!p.regz) throw new RangeError(`notice.sent ${e.id} is not a Reg Z disclosure (regz absent): not a Reg Z anchor`); patch = { disclosure_due_date: dateOf("disclosure_due_date", "due_on", "sent_on"), regz_disclosure: true }; break;
    case "ledger_entry.created": patch = { record_on: dateOf("posted_at", "effective_date", "record_on") }; break;
    default: throw new RangeError(`${e.type} is not an anchor event the 19.1 lifecycle engine ingests`);
  }
  const next = anchorLoanObjects(objects, loanId, patch);
  return { objects: next, anchored: next.filter((o, k) => o !== objects[k]).map((o) => o.id), patch };
}

// ============================================================ T12 — WORM integrity
export interface WormObject { readonly id: string; readonly sha256: string; readonly worm_sha256: string | null; }
export interface WormCheck { readonly failed_object_ids: readonly string[]; readonly disposal_blocked_object_ids: readonly string[]; readonly incident: { severity: "sev1"; process: "19.2"; control: "CTL-SEC-22"; object_ids: readonly string[] } | null; readonly run_halted: boolean; }
/** Integrations: daily hash verification; one mismatch blocks that object's disposal and opens a 19.2 sev-1 (CTL-SEC-22); no verified WORM copy → the run halts. */
export function wormIntegrityCheck(objects: readonly WormObject[], wormAvailable = true): WormCheck {
  if (!wormAvailable) return { failed_object_ids: [], disposal_blocked_object_ids: objects.map((o) => o.id), incident: { severity: "sev1", process: "19.2", control: "CTL-SEC-22", object_ids: [] }, run_halted: true };
  const failed = objects.filter((o) => o.worm_sha256 === null || o.worm_sha256 !== o.sha256).map((o) => o.id);
  return { failed_object_ids: failed, disposal_blocked_object_ids: failed, incident: failed.length ? { severity: "sev1", process: "19.2", control: "CTL-SEC-22", object_ids: failed } : null, run_halted: false };
}
export interface EscalationSink { open(input: { kind: "human_portal_task" | "officer" | "attorney" | "signing_officer" | "sev1" | "sev2" | "sev3"; ownerRole?: string; loanId?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { readonly id: string }; }
export interface IncidentContext extends LifecycleContext { readonly escalations: EscalationSink; }
export interface WormJobResult { readonly check: WormCheck; readonly checked_event: DomainEvent; readonly incident_event: DomainEvent | null; readonly escalation_id: string | null; }
/** The daily integrity job (and the pre-run check): records `worm_integrity.checked` for the run, and on any mismatch or outage opens the 19.2 sev-1 — `security.incident.identified{severity=S1, control=CTL-SEC-22}` plus the sev1 escalation the 19.2 triage owns. */
export function wormIntegrityJob(objects: readonly WormObject[], ctx: IncidentContext, opts: { run_id?: string | null; worm_available?: boolean } = {}): WormJobResult {
  const check = wormIntegrityCheck(objects, opts.worm_available ?? true);
  const run_id = opts.run_id ?? null;
  const checked = ctx.events.append({ type: "worm_integrity.checked", ...(run_id ? { aggregate: { kind: "disposal_run", id: run_id } } : {}), actor: ctx.actor, payload: { run_id, object_count: objects.length, failed_object_ids: check.failed_object_ids, disposal_blocked_object_ids: check.disposal_blocked_object_ids, run_halted: check.run_halted, worm_available: opts.worm_available ?? true } });
  if (!check.incident) return { check, checked_event: checked, incident_event: null, escalation_id: null };
  const incident = ctx.events.append({ type: "security.incident.identified", actor: ctx.actor, payload: { severity: "S1", category: check.run_halted ? "worm_store_unavailable" : "worm_integrity_failure", control: "CTL-SEC-22", source_process: "19.1", fnma_application_data: false, identified_at_basis: "confirmed_identification", data_impact: "integrity", object_ids: check.incident.object_ids, run_id, identified_at: ctx.now } });
  const esc = ctx.escalations.open({ kind: "sev1", ownerRole: "ciso", severity: "S1", payload: { control: "CTL-SEC-22", source_process: "19.1", reason: check.run_halted ? "WORM store unavailable: disposal runs and productions requiring WORM verification pause" : `WORM hash mismatch on ${check.failed_object_ids.length} object(s): disposal blocked`, object_ids: check.incident.object_ids, run_id, incident_event_id: incident.id } }, ctx.actor);
  return { check, checked_event: checked, incident_event: incident, escalation_id: esc.id };
}

// ============================================================ disposal runs: plan → officer attestation → execute (rule 7)
export interface DisposalRun { readonly id: string; readonly run_on: PlainDate; readonly class_code: string; readonly method: Exclude<DisposalMethod, "none">; readonly object_ids: readonly string[]; readonly excluded: readonly { object_id: string; reason: string }[]; readonly gates_checked: readonly string[]; readonly holds_checked: true; readonly status: "planned" | "awaiting_attestation" | "executed" | "failed"; readonly attested_by: string | null; readonly attested_at: string | null; readonly manifest_sha256: string; }
/**
 * `disposal.plan` (first Sunday 02:00 ET): a run of one class takes the objects whose every class gate is open today (the sweep),
 * whose effective class is the run's, with a verified WORM copy and no open records request on the loan; every exclusion is
 * recorded with the gate reason (decision record `gates_checked[]`, `holds_checked`, `exceptions[]`). The method is the class's
 * `disposal_method` unless the run is for physical media.
 */
export function planDisposalRun(i: { run_on: PlainDate; class_code: string; objects: readonly RecordObject[]; worm: WormCheck; open_request_loan_ids?: readonly string[]; method?: DisposalRun["method"] }): DisposalRun {
  const c = retentionClass(i.class_code);
  if (c.disposal_method === "none" && !i.method) throw new RangeError(`class ${c.code} has disposal_method none: nothing to plan`);
  const swept = sweep(i.objects, i.run_on);
  const ids: string[] = []; const excluded: { object_id: string; reason: string }[] = []; const gates = new Set<string>();
  for (const o of swept) {
    if (o.status === "disposed") continue;
    const blocking = o.gates.filter((g) => !g.open);
    const reason = i.worm.run_halted ? "worm_store_unavailable"
      : i.worm.disposal_blocked_object_ids.includes(o.id) ? "worm_integrity_failed_sev1"
      : o.status === "held" ? "legal_hold"
      : o.status === "active" ? (blocking.some((g) => g.reason === "permanent_while_active") ? "permanent_while_active" : "no_anchor_event")
      : o.status === "retention_running" ? blocking.map((g) => `${g.timer_code ?? g.class_code}: ${g.reason}`).join("; ")
      : (i.open_request_loan_ids ?? []).includes(o.loan_id ?? "") ? "open_records_request"
      : o.effective_class_code !== i.class_code ? `effective class ${o.effective_class_code}, not ${i.class_code}` : null;
    if (reason) excluded.push({ object_id: o.id, reason }); else { ids.push(o.id); for (const g of o.gates) gates.add(g.timer_code ?? g.class_code); }
  }
  const manifest_sha256 = createHash("sha256").update(JSON.stringify(swept.filter((o) => ids.includes(o.id)).map((o) => [o.id, o.sha256]))).digest("hex");
  return { id: `DR-${i.run_on}-${i.class_code}`, run_on: i.run_on, class_code: i.class_code, method: i.method ?? (c.disposal_method as DisposalRun["method"]), object_ids: ids, excluded, gates_checked: [...gates], holds_checked: true, status: ids.length ? "awaiting_attestation" : "planned", attested_by: null, attested_at: null, manifest_sha256 };
}
export interface Attestation { readonly by: string; readonly by_role: string; readonly at: string; }
/** Rule 7: every run requires an `officer` attestation before execution — a human officer's act, recorded as `disposal_run.attested`. */
export function attestDisposalRun(run: DisposalRun, ctx: LifecycleContext): { allowed: boolean; code: "OFFICER_ATTESTATION_REQUIRED" | null; run: DisposalRun; event: DomainEvent | null } {
  if (ctx.actor.kind !== "human" || ctx.actor.role !== "officer") return { allowed: false, code: "OFFICER_ATTESTATION_REQUIRED", run, event: null };
  const event = ctx.events.append({ type: "disposal_run.attested", aggregate: { kind: "disposal_run", id: run.id }, actor: ctx.actor, payload: { run_id: run.id, attested_by: ctx.actor.id, attested_by_role: ctx.actor.role, attested_at: ctx.now, object_count: run.object_ids.length, gates_checked: run.gates_checked, manifest_sha256: run.manifest_sha256 } });
  return { allowed: true, code: null, run: { ...run, attested_by: ctx.actor.id, attested_at: ctx.now }, event };
}
/** The attestation fact the disposal guards use: the latest `disposal_run.attested` for the run in the event log, by whom. Never a caller-asserted flag. */
export function attestationFromEvents(events: readonly DomainEvent[], runId: string): Attestation | null {
  const e = [...events].reverse().find((x) => x.type === "disposal_run.attested" && (x.payload as { run_id?: unknown }).run_id === runId);
  return e ? { by: e.actor.id, by_role: e.actor.role ?? e.actor.kind, at: e.occurredAt } : null;
}
export interface WormVerification { readonly verified: boolean; readonly blocked_object_ids: readonly string[]; readonly at: string; }
/** The WORM fact the disposal guards use: the latest `worm_integrity.checked` for the run (absent = unverified = blocked). */
export function wormFromEvents(events: readonly DomainEvent[], runId: string): WormVerification | null {
  const e = [...events].reverse().find((x) => x.type === "worm_integrity.checked" && (x.payload as { run_id?: unknown }).run_id === runId);
  if (!e) return null;
  const p = e.payload as { run_halted?: unknown; disposal_blocked_object_ids?: unknown };
  return { verified: p.run_halted === false, blocked_object_ids: Array.isArray(p.disposal_blocked_object_ids) ? (p.disposal_blocked_object_ids as string[]) : [], at: e.occurredAt };
}
export interface DisposalExecution { readonly executed: boolean; readonly refusal: GuardDecision | null; readonly run: DisposalRun; readonly objects: RecordObject[]; readonly events: readonly DomainEvent[]; }
/**
 * `disposal.execute`: the attested, WORM-verified run re-asserts every gate of every object on the day it executes
 * (`assertObjectGatesOpen` — the timer-table rows through `assertGateOpen`), disposes each (`record_object.disposed`, terminal)
 * and closes with `disposal_run.executed` (satisfies SM_DISPOSAL_RUN_MONTHLY). Refusals come from the same guards on both paths.
 */
export function executeDisposalRun(run: DisposalRun, objects: readonly RecordObject[], ctx: LifecycleContext, log: readonly DomainEvent[]): DisposalExecution {
  const guard = disposalGuards({ op: "dispose", actor: ctx.actor, disposal_run_id: run.id, attestation: attestationFromEvents(log, run.id), worm: wormFromEvents(log, run.id) });
  if (!guard.allowed) return { executed: false, refusal: guard, run, objects: [...objects], events: [] };
  const today = civilDate(ctx.now);
  const out: DomainEvent[] = []; const next = [...objects];
  const c = retentionClass(run.class_code);
  for (const id of run.object_ids) {
    const idx = next.findIndex((o) => o.id === id); const o = next[idx];
    if (!o || o.status !== "eligible") return { executed: false, refusal: { allowed: false, code: "DISPOSAL_ONLY_VIA_ATTESTED_RUN", citation: `object ${id} is ${o?.status ?? "unknown"}, not eligible: the run must be re-planned` }, run: { ...run, status: "failed" }, objects: [...objects], events: out };
    let e: ObjectEligibility;
    try { e = assertObjectGatesOpen(o.record_type, o.state, { ...o.facts, today, hold_count: o.hold_count }); }
    catch (err) { if (err instanceof GateClosed) return { executed: false, refusal: { allowed: false, code: "GATE_CLOSED", citation: `object ${id}: ${err.message} — assertGateOpen (timer table: disposal command blocked)` }, run: { ...run, status: "failed" }, objects: [...objects], events: out }; throw err; }
    out.push(ctx.events.append({ type: "record_object.disposed", ...(o.loan_id ? { loanId: o.loan_id } : {}), aggregate: { kind: "record_object", id: o.id }, actor: ctx.actor, payload: { object_id: o.id, record_type: o.record_type, class_code: run.class_code, effective_class_code: e.effective_class_code, timer_code: c.timer_code, gates_checked: e.gates.map((g) => g.timer_code ?? g.class_code), disposal_run_id: run.id, method: run.method, sha256: o.sha256, disposed_at: ctx.now } }));
    next[idx] = { ...o, status: "disposed", disposed_at: ctx.now, disposal_run_id: run.id };
  }
  out.push(ctx.events.append({ type: "disposal_run.executed", aggregate: { kind: "disposal_run", id: run.id }, actor: ctx.actor, payload: { run_id: run.id, class_code: run.class_code, object_count: run.object_ids.length, method: run.method, gates_checked: run.gates_checked, exceptions: run.excluded, manifest_sha256: run.manifest_sha256, attested_by: run.attested_by, executed_at: ctx.now } }));
  return { executed: true, refusal: null, run: { ...run, status: "executed" }, objects: next, events: out };
}

// ============================================================ T15 — guards shared by the AI path and the ops-console human path
export interface DisposalCommand { readonly op: "classify" | "compile" | "plan" | "dispose" | "delete" | "release_hold"; readonly actor: Actor; readonly disposal_run_id: string | null; readonly attestation: Attestation | null; readonly worm: WormVerification | null; readonly object_id?: string | null; readonly release_approvals?: readonly ("officer" | "attorney")[]; }
export interface GuardDecision { readonly allowed: boolean; readonly code: "NO_DELETE" | "DISPOSAL_ONLY_VIA_ATTESTED_RUN" | "OFFICER_ATTESTATION_REQUIRED" | "WORM_INTEGRITY_FAILED_SEV1" | "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY" | "GATE_CLOSED" | null; readonly citation: string | null; }
/** Guardrails (agent) = ops-console guards (human path): nobody deletes; disposal only through a run whose officer attestation and WORM verification are events in the log, not flags; holds never auto-release. */
export function disposalGuards(c: DisposalCommand): GuardDecision {
  if (c.op === "delete") return { allowed: false, code: "NO_DELETE", citation: "19.1 guardrails: the agent can never delete; human path: same guards (T15)" };
  if (c.op === "release_hold") return c.actor.kind === "human" && holdReleaseAllowed(c.release_approvals ?? []) ? { allowed: true, code: null, citation: null } : { allowed: false, code: "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY", citation: "POL-REC-02: release by officer + attorney jointly; holds are never auto-released" };
  if (c.op === "dispose") {
    if (!c.disposal_run_id) return { allowed: false, code: "DISPOSAL_ONLY_VIA_ATTESTED_RUN", citation: "19.1 guardrails: disposal executes only through the attested run" };
    if (!c.worm || !c.worm.verified || (c.object_id && c.worm.blocked_object_ids.includes(c.object_id))) return { allowed: false, code: "WORM_INTEGRITY_FAILED_SEV1", citation: "19.1 integrations: never delete without the verified WORM copy existence check passing first (`worm_integrity.checked` for this run)" };
    if (!c.attestation || c.attestation.by_role !== "officer") return { allowed: false, code: "OFFICER_ATTESTATION_REQUIRED", citation: "19.1 rule 7: every run requires an officer attestation before execution (`disposal_run.attested` by a human officer)" };
  }
  return { allowed: true, code: null, citation: null };
}

// ============================================================ rule 5 — servicing file (five-day capability) and CTL-REC-01 drill
export const SERVICING_FILE_TARGET_MS = 5 * 60 * 1000;
export const SERVICING_FILE_HARD_LIMIT_DAYS = 5;
export const DRILL_SAMPLE_SIZE = 25;
export type Row = Record<string, unknown>;
export interface TransactionSources { readonly ledger_entries: readonly Row[]; readonly payments?: readonly Row[]; readonly payment_allocations?: readonly Row[]; readonly suspense_items?: readonly Row[]; readonly escrow_lines?: readonly Row[]; readonly disbursements?: readonly Row[]; }
export interface Balances { readonly principal_cents: bigint; readonly interest_cents: bigint; readonly escrow_cents: bigint; readonly suspense_cents: bigint; readonly fee_cents: bigint; }
export type ScheduleSource = "ledger_entry" | "payment" | "payment_allocation" | "suspense_item" | "escrow_line" | "disbursement";
export interface ScheduleRow extends Balances { readonly posted_at: string; readonly source: ScheduleSource; readonly ref: string; readonly description: string; readonly joined: readonly string[]; readonly running: Balances; }
export interface NoteSources { readonly contacts: readonly Row[]; readonly case_notes?: readonly Row[]; readonly agent_decisions?: readonly Row[]; }
export interface PersonnelNote { readonly at: string; readonly source: "contact" | "case_note" | "agent_decision"; readonly author: string; readonly text: string; }
export interface DataFieldSources { readonly loans: Row; readonly loan_terms?: Row | null; readonly borrowers?: readonly Row[]; readonly properties?: readonly Row[]; readonly escrow_accounts?: readonly Row[]; readonly escrow_lines?: readonly Row[]; readonly delinquency?: Row | null; }
export interface DataFieldRow { readonly table: string; readonly field: string; readonly value: unknown; readonly redacted: boolean; }
export const BORROWER_SUBMISSION_CASE_TYPES = ["noe", "rfi", "lossmit", "appeal", "forbearance", "deferral", "modification", "shortsale", "dil"] as const;
export interface ServicingFileInput {
  readonly loan_id: string; readonly transactions: TransactionSources; readonly security_instrument: Row | null; readonly recorded_modifications?: readonly Row[];
  readonly personnel_notes: NoteSources; readonly data_fields: DataFieldSources; readonly documents: readonly Row[];
  readonly borrower_submitted_not_applicable_reason?: string | null; readonly compile_ms: number; readonly compiled_at: string; readonly requested_by: string;
}
export interface ServicingFileSections { readonly i_transactions: number; readonly ii_security_instrument: number; readonly ii_recorded_modifications: number; readonly iii_personnel_notes: number; readonly iv_data_fields: number; readonly v_borrower_submitted: number | "not_applicable"; }
export interface ServicingFileBundle {
  readonly loan_id: string; readonly compiled_at: string; readonly compile_ms: number; readonly sha256: string; readonly sections: ServicingFileSections; readonly v_not_applicable_reason: string | null; readonly requested_by: string; readonly within_target: boolean; readonly gaps: readonly string[];
  readonly transaction_schedule: { readonly rows: readonly ScheduleRow[]; readonly closing: Balances; readonly csv: string; readonly pdf_pages: readonly string[] };
  readonly security_instrument: { readonly document: Row | null; readonly recorded_modifications: readonly Row[] };
  readonly personnel_notes: readonly PersonnelNote[]; readonly data_field_report: readonly DataFieldRow[]; readonly borrower_submitted: readonly Row[];
  readonly formats: readonly ["json", "csv", "pdf"];
}
const ZERO: Balances = { principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, suspense_cents: 0n, fee_cents: 0n };
const toCents = (v: unknown): bigint => (typeof v === "bigint" ? v : typeof v === "number" && Number.isFinite(v) ? BigInt(Math.round(v)) : typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : 0n);
const text = (r: Row, ...keys: string[]): string => { for (const k of keys) { const v = r[k]; if (typeof v === "string" && v.trim()) return v.trim(); if (typeof v === "number") return String(v); } return ""; };
const bucketOf = (name: string): keyof Balances | null => (/principal|upb/i.test(name) ? "principal_cents" : /interest/i.test(name) ? "interest_cents" : /escrow|tax|insurance|impound/i.test(name) ? "escrow_cents" : /suspense|unapplied/i.test(name) ? "suspense_cents" : /fee|charge|advance|late/i.test(name) ? "fee_cents" : null);
/** One source row → its bucket amounts: explicit `<bucket>_cents` columns, ledger `lines[{account, amountCents}]`, or a single `amount_cents` classified by the row's bucket/account/reason name (suspense items and escrow lines by their own kind). */
function amountsOf(r: Row, source: ScheduleSource): Balances {
  const b = { ...ZERO } as { -readonly [K in keyof Balances]: bigint };
  const explicit = (["principal_cents", "interest_cents", "escrow_cents", "suspense_cents", "fee_cents"] as const).filter((k) => r[k] !== undefined && r[k] !== null);
  if (r.fees_cents !== undefined) b.fee_cents += toCents(r.fees_cents);
  for (const k of explicit) b[k] += toCents(r[k]);
  const lines = Array.isArray(r.lines) ? (r.lines as Row[]) : [];
  for (const l of lines) { const k = bucketOf(text(l, "account", "bucket", "name")); if (k) b[k] += toCents(l.amountCents ?? l.amount_cents); }
  if (!explicit.length && !lines.length && r.fees_cents === undefined && r.amount_cents !== undefined) {
    const k = source === "suspense_item" ? "suspense_cents" : source === "escrow_line" ? "escrow_cents" : (bucketOf(text(r, "bucket", "account", "reason", "kind", "type")) ?? (source === "disbursement" ? "escrow_cents" : "principal_cents"));
    b[k] += toCents(r.amount_cents);
  }
  return b;
}
const postedAt = (r: Row): string => text(r, "posted_at", "postedAt", "effective_date", "effectiveDate", "credited_as_of", "received_on", "issued_on", "applied_on", "date", "created_at");
const SOURCE_ORDER: readonly ScheduleSource[] = ["ledger_entry", "payment", "payment_allocation", "suspense_item", "escrow_line", "disbursement"];
/**
 * Rule 5 (i): `ledger_entries` joined to `payments`, `payment_allocations`, `suspense_items`, `escrow_lines` and `disbursements`
 * (a payment or allocation whose id a ledger entry names is folded into that entry rather than counted twice), ordered by posting
 * timestamp, with running balances (principal, interest, escrow, suspense, fees) in bigint cents.
 */
export function transactionSchedule(t: TransactionSources): { rows: ScheduleRow[]; closing: Balances } {
  const ledger = t.ledger_entries;
  const linked = new Set<string>();
  for (const e of ledger) for (const k of ["payment_id", "allocation_id", "suspense_item_id", "escrow_line_id", "disbursement_id"]) { const v = e[k]; if (typeof v === "string" && v) linked.add(`${k}:${v}`); }
  const base = (source: ScheduleSource, rows: readonly Row[] | undefined, key: string): (Omit<ScheduleRow, "running">)[] =>
    (rows ?? []).filter((r) => !linked.has(`${key}:${text(r, "id")}`)).map((r) => ({ posted_at: postedAt(r), source, ref: text(r, "id", "ref", "reference"), description: text(r, "description", "memo", "reason", "kind", "type", "channel") || source, joined: [], ...amountsOf(r, source) }));
  const entries = ledger.map((e) => ({ posted_at: postedAt(e), source: "ledger_entry" as const, ref: text(e, "id", "ref"), description: [text(e, "description", "memo", "type") || "ledger entry", ...(typeof e.payment_id === "string" ? [`payment ${e.payment_id}`] : [])].join(" — "), joined: ["payment_id", "allocation_id", "suspense_item_id", "escrow_line_id", "disbursement_id"].filter((k) => typeof e[k] === "string" && e[k]).map((k) => `${k}:${String(e[k])}`), ...amountsOf(e, "ledger_entry") }));
  const all = [...entries, ...base("payment", t.payments, "payment_id"), ...base("payment_allocation", t.payment_allocations, "allocation_id"), ...base("suspense_item", t.suspense_items, "suspense_item_id"), ...base("escrow_line", t.escrow_lines, "escrow_line_id"), ...base("disbursement", t.disbursements, "disbursement_id")]
    .sort((a, b) => (a.posted_at < b.posted_at ? -1 : a.posted_at > b.posted_at ? 1 : SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)));
  let run: Balances = ZERO;
  const rows: ScheduleRow[] = all.map((r) => { run = { principal_cents: run.principal_cents + r.principal_cents, interest_cents: run.interest_cents + r.interest_cents, escrow_cents: run.escrow_cents + r.escrow_cents, suspense_cents: run.suspense_cents + r.suspense_cents, fee_cents: run.fee_cents + r.fee_cents }; return { ...r, running: run }; });
  return { rows, closing: run };
}
/** Cents → dollars for the CSV/print renderings ("-12.34"); the JSON keeps bigint cents. */
export const dollars = (c: bigint): string => { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`; };
const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s);
const SCHEDULE_COLUMNS = ["posted_at", "source", "ref", "description", "principal", "interest", "escrow", "suspense", "fees", "running_principal", "running_interest", "running_escrow", "running_suspense", "running_fees"] as const;
const scheduleCells = (r: ScheduleRow): string[] => [r.posted_at, r.source, r.ref, r.description, dollars(r.principal_cents), dollars(r.interest_cents), dollars(r.escrow_cents), dollars(r.suspense_cents), dollars(r.fee_cents), dollars(r.running.principal_cents), dollars(r.running.interest_cents), dollars(r.running.escrow_cents), dollars(r.running.suspense_cents), dollars(r.running.fee_cents)];
export function scheduleCsv(rows: readonly ScheduleRow[]): string { return [SCHEDULE_COLUMNS.join(","), ...rows.map((r) => scheduleCells(r).map(csvCell).join(","))].join("\n"); }
export const PRINT_ROWS_PER_PAGE = 40;
/** The PDF rendering as the print/mail integration receives it: paginated fixed-width pages, a header on each. */
export function schedulePages(loanId: string, rows: readonly ScheduleRow[], compiledAt: string): string[] {
  const header = `Transaction schedule — loan ${loanId} — compiled ${compiledAt}\n${SCHEDULE_COLUMNS.join(" | ")}`;
  const lines = rows.map((r) => scheduleCells(r).join(" | "));
  const pages: string[] = [];
  const n = Math.max(1, Math.ceil(lines.length / PRINT_ROWS_PER_PAGE));
  for (let p = 0; p < n; p++) pages.push([`${header}\npage ${p + 1} of ${n}`, ...lines.slice(p * PRINT_ROWS_PER_PAGE, (p + 1) * PRINT_ROWS_PER_PAGE), ...(lines.length === 0 ? ["(no transactions)"] : [])].join("\n"));
  return pages;
}
const SSN_KEY = /ssn|social_security|tax_id|\btin\b|taxpayer_id/i;
const redactSsn = (v: unknown): string => { const digits = String(v ?? "").replace(/\D/g, ""); return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : "[redacted]"; };
/** Rule 5 (iv): every column of the named tables, "listed by name, populated" — SSNs redacted to their last four (§1024.38(c)(2)(iv), comment 38(c)(2)(iv)-1). */
export function dataFieldReport(d: DataFieldSources): DataFieldRow[] {
  const out: DataFieldRow[] = [];
  const add = (table: string, r: Row | null | undefined) => { for (const [field, value] of Object.entries(r ?? {})) { const redacted = SSN_KEY.test(field); out.push({ table, field, value: redacted ? redactSsn(value) : value, redacted }); } };
  add("loans", d.loans); add("loan_terms", d.loan_terms);
  (d.borrowers ?? []).forEach((b, k) => add(`borrowers[${k}]`, b)); (d.properties ?? []).forEach((p, k) => add(`properties[${k}]`, p));
  (d.escrow_accounts ?? []).forEach((a, k) => add(`escrow_accounts[${k}]`, a)); (d.escrow_lines ?? []).forEach((l, k) => add(`escrow_lines[${k}]`, l));
  add("delinquency", d.delinquency);
  return out;
}
/** Rule 5 (iii): `contacts` narratives, case notes and `agent_decisions.rationale` — AI-agent notes are "notes created by servicer personnel" for this purpose. */
export function personnelNotes(n: NoteSources): PersonnelNote[] {
  const note = (r: Row, source: PersonnelNote["source"], keys: string[]): PersonnelNote | null => { const t = text(r, ...keys); return t ? { at: text(r, "at", "attempted_at", "occurred_at", "created_at", "date"), source, author: text(r, "author", "agent", "by", "user") || (source === "agent_decision" ? "agent" : "servicer"), text: t } : null; };
  return [...n.contacts.map((r) => note(r, "contact", ["narrative", "note", "notes", "summary", "result", "outcome"])), ...(n.case_notes ?? []).map((r) => note(r, "case_note", ["note", "narrative", "text"])), ...(n.agent_decisions ?? []).map((r) => note(r, "agent_decision", ["rationale"]))].filter((x): x is PersonnelNote => x !== null);
}
/** Rule 5 (v): `documents` where `source = borrower` and `case_type` is one of the §1024.35 / §1024.41 procedures. */
export function borrowerSubmissions(documents: readonly Row[]): Row[] { return documents.filter((d) => d.source === "borrower" && (BORROWER_SUBMISSION_CASE_TYPES as readonly string[]).includes(String(d.case_type ?? ""))); }
const bigintSafe = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? `${v.toString()}n` : v);   // cents stay exact in the manifest hash
/**
 * `compileServicingFile(loanId)`: the §1024.38(c)(2)(i)–(v) bundle — the transaction schedule with running balances rendered
 * as CSV and print pages, the latest security instrument plus recorded modifications (mandatory: edge case `documents.gap`),
 * personnel and agent notes, the data-field report by name with SSNs redacted, and the borrower-submitted documents (or a
 * documented "not applicable") — hashed as one signed bundle; `compile_ms` is the caller's measured wall-clock.
 */
export function compileServicingFile(i: ServicingFileInput): ServicingFileBundle {
  const schedule = transactionSchedule(i.transactions);
  const report = dataFieldReport(i.data_fields);
  const notes = personnelNotes(i.personnel_notes);
  const submitted = borrowerSubmissions(i.documents);
  const mods = i.recorded_modifications ?? [];
  const v: number | "not_applicable" = submitted.length > 0 ? submitted.length : i.borrower_submitted_not_applicable_reason ? "not_applicable" : 0;
  const sections: ServicingFileSections = { i_transactions: schedule.rows.length, ii_security_instrument: i.security_instrument ? 1 : 0, ii_recorded_modifications: mods.length, iii_personnel_notes: notes.length, iv_data_fields: report.length, v_borrower_submitted: v };
  const gaps: string[] = [];
  if (sections.i_transactions === 0) gaps.push("(i) transaction schedule empty");
  if (sections.ii_security_instrument === 0) gaps.push("(ii) security instrument missing → documents.gap");
  if (sections.iii_personnel_notes === 0) gaps.push("(iii) no personnel/agent notes");
  if (sections.iv_data_fields === 0) gaps.push("(iv) data-field report empty");
  if (v === 0) gaps.push("(v) borrower-submitted documents neither present nor documented not applicable");
  const csv = scheduleCsv(schedule.rows);
  const pdf_pages = schedulePages(i.loan_id, schedule.rows, i.compiled_at);
  const content = { loan_id: i.loan_id, transaction_schedule: { rows: schedule.rows, closing: schedule.closing, csv, pdf_pages }, security_instrument: { document: i.security_instrument, recorded_modifications: mods }, personnel_notes: notes, data_field_report: report, borrower_submitted: submitted };
  const sha256 = createHash("sha256").update(JSON.stringify(content, bigintSafe)).digest("hex");
  return { ...content, compiled_at: i.compiled_at, compile_ms: i.compile_ms, sha256, sections, v_not_applicable_reason: v === "not_applicable" ? (i.borrower_submitted_not_applicable_reason ?? null) : null, requested_by: i.requested_by, within_target: i.compile_ms <= SERVICING_FILE_TARGET_MS, gaps, formats: ["json", "csv", "pdf"] };
}
export interface DrillResult { readonly control: "CTL-REC-01"; readonly sample_size: number; readonly passed: boolean; readonly failures: readonly { loan_id: string; reasons: readonly string[] }[]; readonly qc_finding: "18.1" | null; readonly severity: "sev2" | null; }
/** SM_SERVICING_FILE_DRILL_MONTHLY (T5): 25 random loans; every bundle ≤5 minutes with (i)–(v) populated or (v) documented "not applicable", else CTL-REC-01 fails (sev-2 → 18.1 QC finding). */
export function servicingFileDrill(bundles: readonly Pick<ServicingFileBundle, "loan_id" | "gaps" | "within_target" | "compile_ms">[], sampleSize = DRILL_SAMPLE_SIZE): DrillResult {
  const failures: { loan_id: string; reasons: string[] }[] = [];
  for (const b of bundles) {
    const reasons = [...b.gaps];
    if (!b.within_target) reasons.push(`compile ${b.compile_ms} ms > 5 minutes`);
    if (reasons.length) failures.push({ loan_id: b.loan_id, reasons });
  }
  if (bundles.length < sampleSize) failures.push({ loan_id: "*", reasons: [`only ${bundles.length} of ${sampleSize} bundles compiled`] });
  const passed = failures.length === 0;
  return { control: "CTL-REC-01", sample_size: sampleSize, passed, failures, qc_finding: passed ? null : "18.1", severity: passed ? null : "sev2" };
}
/** The drill's random sample: `n` distinct loans drawn uniformly (partial Fisher–Yates over the portfolio) — the whole portfolio when it is smaller than `n`. */
export function sampleDrillLoans(loanIds: readonly string[], n = DRILL_SAMPLE_SIZE, rng: () => number = Math.random): string[] {
  const pool = [...new Set(loanIds)];
  if (!pool.length) throw new RangeError("the drill needs a portfolio to sample");
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rng() * (pool.length - i)); const t = pool[i]!; pool[i] = pool[j]!; pool[j] = t; }
  return pool.slice(0, k);
}
export interface DrillCompile { readonly loan_id: string; readonly compile_ms: number; readonly within_target: boolean; readonly gaps: readonly string[]; readonly sha256: string; }
export interface DrillRun { readonly drill_id: string; readonly run_on: PlainDate; readonly sample: readonly string[]; readonly population: number; readonly result: DrillResult; readonly bundles: readonly DrillCompile[]; readonly events: readonly DomainEvent[]; readonly escalation_id: string | null; }
/**
 * The monthly drill (CTL-REC-01): samples 25 loans, runs the compile tool for each through `compile` (the bus tool, which
 * measures its own wall-clock and emits `servicing_file.compiled` tagged with the drill), scores the result and records
 * `control_test.completed{control=CTL-REC-01}`; a failure is a sev-2 with an 18.1 QC finding. The timer row is satisfied only by
 * the 25th compile of a drill whose every compile stayed within the target — never by this function.
 */
export function runServicingFileDrill(i: { drill_id: string; run_on: PlainDate; loan_ids: readonly string[]; compile: (loanId: string, drill: { drill_id: string; index: number; sample_size: number }) => DrillCompile; rng?: () => number; sample_size?: number }, ctx: IncidentContext): DrillRun {
  const sample = sampleDrillLoans(i.loan_ids, i.sample_size ?? DRILL_SAMPLE_SIZE, i.rng ?? Math.random);
  const bundles = sample.map((loanId, k) => i.compile(loanId, { drill_id: i.drill_id, index: k + 1, sample_size: sample.length }));
  const result = servicingFileDrill(bundles, sample.length);
  const events: DomainEvent[] = [ctx.events.append({ type: "control_test.completed", aggregate: { kind: "control", id: "CTL-REC-01" }, actor: ctx.actor, payload: { control: "CTL-REC-01", drill_id: i.drill_id, run_on: i.run_on, result: result.passed ? "pass" : "fail", sample_size: sample.length, population: new Set(i.loan_ids).size, sample, failures: result.failures, ran_at: ctx.now } })];
  let escalation_id: string | null = null;
  if (!result.passed) {
    events.push(ctx.events.append({ type: "qc_finding.opened", aggregate: { kind: "control", id: "CTL-REC-01" }, actor: ctx.actor, payload: { process: "18.1", source_process: "19.1", control: "CTL-REC-01", severity: "sev2", drill_id: i.drill_id, failures: result.failures } }));
    escalation_id = ctx.escalations.open({ kind: "sev2", ownerRole: "security-records", severity: "sev2", payload: { control: "CTL-REC-01", drill_id: i.drill_id, reason: "servicing-file drill failed: 18.1 QC finding", failures: result.failures } }, ctx.actor).id;
  }
  return { drill_id: i.drill_id, run_on: i.run_on, sample, population: new Set(i.loan_ids).size, result, bundles, events, escalation_id };
}

// ============================================================ schedules (inputs and triggers) and the annual inventory review
export type ScheduleJob = "retention-sweep" | "disposal-run" | "records-inventory-review" | "servicing-file-drill";
/**
 * The 19.1 schedules as events: `schedule.tick{cadence=daily}` for the 01:00 ET sweep every day, `schedule.tick{cadence=monthly,
 * day=1}` on the 1st (drill), `schedule.tick{cadence=monthly, weekday=sunday, ordinal=1}` on the first Sunday (disposal run) and
 * `period.year_end` on Dec 31 (the Jan 15 inventory review) — the triggers the recurring timer rows name.
 */
export function scheduleTicks(today: PlainDate): EventInput[] {
  const { y, m, d } = parts(today);
  const out: EventInput[] = [{ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, payload: { cadence: "daily", job: "retention-sweep" satisfies ScheduleJob, at: "01:00", tz: "America/New_York", date: today } }];
  if (d === 1) out.push({ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, payload: { cadence: "monthly", day: 1, job: "servicing-file-drill" satisfies ScheduleJob, date: today } });
  if (dayOfWeek(today) === 0 && d <= 7) out.push({ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, payload: { cadence: "monthly", weekday: "sunday", ordinal: 1, job: "disposal-run" satisfies ScheduleJob, at: "02:00", tz: "America/New_York", date: today } });
  if (m === 12 && d === 31) out.push({ type: "period.year_end", actor: { kind: "system", id: "scheduler" }, payload: { year: y, date: today, jobs: ["records-inventory-review" satisfies ScheduleJob] } });
  return out;
}
export function emitScheduleTicks(today: PlainDate, events: EventSink): DomainEvent[] { return scheduleTicks(today).map((e) => events.append(e)); }
export type StorageTier = "hot_db" | "object_store" | "worm_archive" | "paper_offsite" | "custodian" | "vendor_hosted";
export interface RecordsInventoryEntry { readonly id: string; readonly record_type: string; readonly storage_tier: StorageTier | null; readonly encryption_scope: string | null; readonly restore_sla_hours: number | null; readonly last_verified_at: PlainDate | null; }
export interface InventoryReview { readonly reviewed_count: number; readonly gaps: readonly { id: string; reasons: readonly string[] }[]; readonly passed: boolean; readonly event: DomainEvent; }
/** SM_RECORDS_INVENTORY_REVIEW_365 (Jan 15): every `records_inventory` row has a storage tier, an encryption scope, a restore SLA and a verification within the year; the review memo carries the schedule version and the Guide-watch rule diff. `records_inventory.reviewed` satisfies the row. */
export function reviewRecordsInventory(entries: readonly RecordsInventoryEntry[], i: { rule_set_version: string; guide_watch_diff: readonly string[] }, ctx: LifecycleContext, today: PlainDate = civilDate(ctx.now)): InventoryReview {
  const gaps: { id: string; reasons: string[] }[] = [];
  for (const e of entries) {
    const reasons: string[] = [];
    if (!e.storage_tier) reasons.push("storage_tier missing");
    if (!e.encryption_scope) reasons.push("encryption_scope missing");
    if (e.restore_sla_hours === null || !(e.restore_sla_hours > 0)) reasons.push("restore_sla_hours missing");
    if (!e.last_verified_at || addDays(e.last_verified_at, 365) < today) reasons.push(`last_verified_at ${e.last_verified_at ?? "never"} is older than 365 days`);
    if (reasons.length) gaps.push({ id: e.id, reasons });
  }
  const event = ctx.events.append({ type: "records_inventory.reviewed", aggregate: { kind: "records_inventory", id: `review-${today}` }, actor: ctx.actor, payload: { reviewed_on: today, reviewed_by: `${ctx.actor.kind}:${ctx.actor.id}`, reviewed_count: entries.length, gaps, schedule_version: RETENTION_SCHEDULE_VERSION, rule_set_version: i.rule_set_version, guide_watch_diff: [...i.guide_watch_diff], memo: "annual retention-schedule review memo" } });
  return { reviewed_count: entries.length, gaps, passed: gaps.length === 0, event };
}

// ============================================================ records requests: intake (T4, T6, T13, T14), approvals, delivery gate, FTC exceptions
export type RequesterType = "fannie_mae" | "partner" | "regulator_state" | "regulator_federal" | "transferee_servicer" | "court_subpoena" | "mi_company" | "custodian" | "auditor" | "law_enforcement";
export type ProductionFormat = "servicing_file_1024_38c2" | "full_loan_file" | "portfolio_export_mismo" | "ny_419_9_call_log" | "custom";
export const DEFAULT_PRODUCTION_BUSINESS_DAYS = 10;   // open question 4 / timer table [policy]
/** Due date of a production: the time frame the request states, else the policy default of 10 business days — Fannie Mae's calendar for Fannie Mae, the servicer's for regulators and everyone else. */
export function productionDue(requester: RequesterType, receivedOn: PlainDate, statedBusinessDays: number | null = null): PlainDate {
  return addBusinessDays(receivedOn, statedBusinessDays ?? DEFAULT_PRODUCTION_BUSINESS_DAYS, requester === "fannie_mae" ? fannieEt : servicer);
}
export interface RecordsRequestInput { readonly id: string; readonly requester_type: RequesterType | "borrower" | "third_party"; readonly requester_ref: string; readonly received_at: string; readonly format: ProductionFormat; readonly loan_ids: readonly string[]; readonly scope_description: string; readonly borrower_signed?: boolean; readonly authorization_evidence?: string | null; readonly stated_business_days?: number | null; readonly matter_ref?: string | null; readonly authority_confidence: number; readonly new_requester_identity?: boolean; readonly state?: string | null; }
export type ProductionRequirement = "attorney_approval" | "officer_sign_off" | "officer_confirmation" | "authority_escalation";
export interface RecordsRequest { readonly id: string; readonly requester_type: RequesterType; readonly requester_ref: string; readonly received_at: string; readonly received_on: PlainDate; readonly due_on: PlainDate; readonly format: ProductionFormat; readonly loan_ids: readonly string[]; readonly status: "received" | "scoped" | "compiling" | "qa_redaction" | "awaiting_certification" | "delivered" | "closed" | "refused"; readonly hold_id: string | null; readonly hold_reason: HoldReason | null; readonly redaction_required: boolean; readonly production_requires: readonly ProductionRequirement[]; readonly new_requester_identity: boolean; }
export interface RefusedRequest { readonly id: string; readonly requester_type: "borrower" | "third_party"; readonly requester_ref: string; readonly received_at: string; readonly received_on: PlainDate; readonly status: "refused"; readonly refusal_reason: string; readonly attorney_review_escalation_id: string; }
export type RequestIntake =
  | { readonly routed_to: "4.2_rfi"; readonly request_status: "rerouted"; readonly clocks: { ack_due: PlainDate; response_due: PlainDate; extendable: boolean }; readonly events: readonly DomainEvent[]; readonly timers_19_1: false }
  | { readonly routed_to: "refused"; readonly request: RefusedRequest; readonly escalations: readonly { id: string; kind: "attorney"; due_at: null; reason: string }[]; readonly events: readonly DomainEvent[]; readonly timers_19_1: false }
  | { readonly routed_to: "19.1_production"; readonly request: RecordsRequest; readonly hold: LegalHold | null; readonly escalations: readonly { id: string; kind: "attorney" | "officer"; due_at: string | null; reason: string }[]; readonly events: readonly DomainEvent[]; readonly timers_19_1: true };
const holdReasonFor = (r: RequesterType): HoldReason | null => (r === "fannie_mae" ? "fannie_mae_request" : r === "regulator_state" || r === "regulator_federal" ? "regulator_exam" : r === "court_subpoena" || r === "law_enforcement" ? "subpoena" : r === "auditor" ? "audit" : null);
/**
 * `records.request.received` → `scoped`: requester classified, authority verified (confidence < 0.85 → escalate before anything
 * is delivered), due date from the request or policy, an automatic legal hold (`fannie_mae_request` / `regulator_exam` /
 * `subpoena`), the attorney escalation within one hour for subpoenas and court orders (T14), officer confirmation queued for
 * scope > 500 loans or a new requester identity. A borrower-signed request is re-routed to 4.2 as an RFI — `case.rfi.opened`
 * with the §1024.36 clocks — and arms nothing in 19.1 (T13). A request lacking authority (an unsigned borrower request, a third
 * party without a borrower's authorization) takes the `refused` branch: `records.request.refused`, an attorney review, no hold,
 * no clock. The production events arm REGX_1024_38C2_SERVICING_FILE_5D, FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED /
 * SM_REGULATOR_RECORDS_REQUEST and SM_LEGAL_HOLD_REVIEW_180.
 */
export function intakeRecordsRequest(i: RecordsRequestInput, ctx: IncidentContext, objects: readonly RecordObject[] = []): RequestIntake & { objects: RecordObject[] } {
  const receivedMs = Date.parse(i.received_at);
  if (Number.isNaN(receivedMs)) throw new RangeError("received_at must be an ISO timestamp");
  const receivedOn = wallClock(receivedMs, "America/New_York").date;
  const loanId = i.loan_ids.length === 1 ? i.loan_ids[0] : undefined;
  if (i.requester_type === "borrower" && i.borrower_signed) {
    const clocks = itemDeadlines("standard", receivedOn, i.state ?? undefined);
    const events = [
      ctx.events.append({ type: "records.request.rerouted", ...(loanId ? { loanId } : {}), aggregate: { kind: "records_request", id: i.id }, actor: ctx.actor, payload: { request_id: i.id, to: "4.2", as: "rfi", reason: "borrower requests route to 4.2 as RFIs (§1024.36); the servicing file confers no independent borrower access right (comment 38(c)(2)-2)" } }),
      ctx.events.append({ type: "case.rfi.opened", ...(loanId ? { loanId } : {}), aggregate: { kind: "case", id: `rfi-${i.id}` }, actor: ctx.actor, payload: { case_id: `rfi-${i.id}`, kind: "rfi", item_kind: "standard", profile: "std_30", std_item: true, owner_identity_item: false, receipt_date: receivedOn, received_on: receivedOn, scope: i.scope_description, borrower_signed: true, ack_due: clocks.ack_due, response_due: clocks.response_due, origin: "19.1 records request re-routed" } }),
    ];
    return { routed_to: "4.2_rfi", request_status: "rerouted", clocks, events, timers_19_1: false, objects: [...objects] };
  }
  if (i.requester_type === "borrower" || i.requester_type === "third_party") {
    const authorized = i.requester_type === "third_party" && typeof i.authorization_evidence === "string" && i.authorization_evidence.trim().length > 0;
    if (authorized) throw new RangeError(`third-party request ${i.id} carries authorization ${i.authorization_evidence}: intake it as the authorizing borrower's RFI (4.2) or as the authorized requester type, not as a third party`);
    const reason = i.requester_type === "borrower" ? "borrower request not signed by the borrower: no authority to receive the servicing file (§1024.36 requires a written request from the borrower or agent)" : "third party without a borrower's written authorization: no authority to receive borrower records (Reg P; §1024.36(d)(3))";
    const esc = ctx.escalations.open({ kind: "attorney", ...(loanId ? { loanId } : {}), payload: { request_id: i.id, requester_type: i.requester_type, requester_ref: i.requester_ref, reason: `refused request: ${reason} — attorney review of the refusal and any privilege/authority question`, scope: i.scope_description } }, ctx.actor);
    const event = ctx.events.append({ type: "records.request.refused", ...(loanId ? { loanId } : {}), aggregate: { kind: "records_request", id: i.id }, actor: ctx.actor, payload: { request_id: i.id, requester_type: i.requester_type, requester_ref: i.requester_ref, received_at: i.received_at, reason, attorney_review_escalation_id: esc.id, hold_placed: false } });
    return { routed_to: "refused", request: { id: i.id, requester_type: i.requester_type, requester_ref: i.requester_ref, received_at: i.received_at, received_on: receivedOn, status: "refused", refusal_reason: reason, attorney_review_escalation_id: esc.id }, escalations: [{ id: esc.id, kind: "attorney", due_at: null, reason: "refused: requester lacks authority — attorney review" }], events: [event], timers_19_1: false, objects: [...objects] };
  }
  const requester = i.requester_type;
  const dueOn = productionDue(requester, receivedOn, i.stated_business_days ?? null);
  const requires: ProductionRequirement[] = [];
  if (i.authority_confidence < 0.85) requires.push("authority_escalation");
  if (requester === "court_subpoena" || requester === "law_enforcement") requires.push("attorney_approval");
  if (requester === "fannie_mae" || requester === "regulator_state" || requester === "regulator_federal") requires.push("officer_sign_off");
  if (i.loan_ids.length > 500 || i.new_requester_identity) requires.push("officer_confirmation");
  const events: DomainEvent[] = [];
  const reason = holdReasonFor(requester);
  let hold: LegalHold | null = null; let nextObjects = [...objects];
  if (reason) {
    const placed = placeHold(objects, { id: `LH-${i.id}`, scope: loanId ? "loan" : "portfolio_batch", scope_ref: loanId ?? i.loan_ids.join(","), reason, matter_ref: i.matter_ref ?? i.requester_ref, auto_placed: true }, ctx);
    hold = placed.hold; nextObjects = placed.objects; events.push(placed.event);
  }
  events.push(ctx.events.append({ type: "records.request.received", ...(loanId ? { loanId } : {}), aggregate: { kind: "records_request", id: i.id }, actor: ctx.actor, payload: { request_id: i.id, requester_type: requester, requester_ref: i.requester_ref, format: i.format, received_at: i.received_at, received_on: receivedOn, delivery_due_stated: dueOn, stated_business_days: i.stated_business_days ?? null, scope_loan_count: i.loan_ids.length, new_requester_identity: i.new_requester_identity ?? false, hold_id: hold?.id ?? null, authority_confidence: i.authority_confidence, production_requires: requires } }));
  const escalations: { id: string; kind: "attorney" | "officer"; due_at: string | null; reason: string }[] = [];
  if (requester === "court_subpoena" || requester === "law_enforcement") {
    const a = subpoenaActions();
    const dueAt = new Date(receivedMs + a.attorney_escalation_within_minutes * 60_000).toISOString();
    const e = ctx.escalations.open({ kind: "attorney", ...(loanId ? { loanId } : {}), payload: { request_id: i.id, matter_ref: i.matter_ref ?? i.requester_ref, reason: `subpoena ${i.matter_ref ?? i.requester_ref}: validity, objections, privilege`, within_minutes: a.attorney_escalation_within_minutes, due_at: dueAt, production_requires: a.production_requires, hold_id: hold?.id ?? null } }, ctx.actor);
    escalations.push({ id: e.id, kind: "attorney", due_at: dueAt, reason: "subpoena/court order: validity, objections, privilege" });
  } else if (i.authority_confidence < 0.85) {
    const e = ctx.escalations.open({ kind: "officer", ...(loanId ? { loanId } : {}), payload: { request_id: i.id, reason: `requester authority confidence ${i.authority_confidence} < 0.85`, requester_type: requester, requester_ref: i.requester_ref } }, ctx.actor);
    escalations.push({ id: e.id, kind: "officer", due_at: null, reason: "requester authority confidence < 0.85" });
  }
  if (requires.includes("officer_confirmation")) {
    const e = ctx.escalations.open({ kind: "officer", ...(loanId ? { loanId } : {}), payload: { request_id: i.id, reason: i.loan_ids.length > 500 ? `scope ${i.loan_ids.length} loans > 500: officer confirmation before delivery` : "new requester identity: officer confirmation before delivery", scope_loan_count: i.loan_ids.length } }, ctx.actor);
    escalations.push({ id: e.id, kind: "officer", due_at: null, reason: "officer confirmation before delivery" });
  }
  const request: RecordsRequest = { id: i.id, requester_type: requester, requester_ref: i.requester_ref, received_at: i.received_at, received_on: receivedOn, due_on: dueOn, format: i.format, loan_ids: [...i.loan_ids], status: "scoped", hold_id: hold?.id ?? null, hold_reason: reason, redaction_required: !(requester === "fannie_mae" || requester === "partner" || requester === "regulator_state" || requester === "regulator_federal" || requester === "court_subpoena"), production_requires: requires, new_requester_identity: i.new_requester_identity ?? false };
  return { routed_to: "19.1_production", request, hold, escalations, events, timers_19_1: true, objects: nextObjects };
}

// ---- production approvals: events by the role the spec names, never caller flags
export type ApprovalKind = "attorney_approval" | "officer_sign_off" | "officer_confirmation" | "authority_verified";
/** Who may record each approval (escalations paragraph): attorney for subpoenas/court orders; officer sign-off for Fannie Mae/regulator productions and officer confirmation for >500-loan / new-requester scopes; the authority question is closed by the officer (or the attorney on a subpoena). */
export const APPROVAL_ROLES: Readonly<Record<ApprovalKind, readonly string[]>> = { attorney_approval: ["attorney"], officer_sign_off: ["officer"], officer_confirmation: ["officer"], authority_verified: ["officer", "attorney"] };
const approvalBy = (e: DomainEvent, kind: ApprovalKind): boolean => e.type === "records.request.approved" && (e.payload as { kind?: unknown }).kind === kind && e.actor.kind === "human" && APPROVAL_ROLES[kind].includes(e.actor.role ?? "");
/** `records.request.approved{kind}`: a human act by the named role, recorded in the log the delivery gate reads; the agent (or a human without the role) is refused. */
export function approveProduction(r: Pick<RecordsRequest, "id" | "requester_type" | "loan_ids">, kind: ApprovalKind, i: { rationale: string; confidence?: number }, ctx: LifecycleContext): { allowed: boolean; code: "APPROVAL_NEEDS_HUMAN_ROLE" | null; event: DomainEvent | null } {
  if (ctx.actor.kind !== "human" || !APPROVAL_ROLES[kind].includes(ctx.actor.role ?? "")) return { allowed: false, code: "APPROVAL_NEEDS_HUMAN_ROLE", event: null };
  if (!i.rationale.trim()) throw new RangeError("an approval records its rationale");
  if (kind === "authority_verified" && !(typeof i.confidence === "number" && i.confidence >= 0 && i.confidence <= 1)) throw new RangeError("authority_verified records the verified confidence in [0, 1]");
  const loanId = r.loan_ids.length === 1 ? r.loan_ids[0] : undefined;
  const event = ctx.events.append({ type: "records.request.approved", ...(loanId ? { loanId } : {}), aggregate: { kind: "records_request", id: r.id }, actor: ctx.actor, payload: { request_id: r.id, kind, requester_type: r.requester_type, by: ctx.actor.id, by_role: ctx.actor.role, rationale: i.rationale.trim(), ...(kind === "authority_verified" ? { confidence: i.confidence } : {}), approved_at: ctx.now } });
  return { allowed: true, code: null, event };
}
export interface ProductionFacts { readonly request_id: string | null; readonly known: boolean; readonly requester_type: RequesterType | null; readonly scope_loan_count: number; readonly new_requester_identity: boolean; readonly authority_confidence: number; readonly attorney_approved: boolean; readonly officer_signed_off: boolean; readonly officer_confirmed: boolean; }
/** The delivery facts from the log: the request's own `records.request.received` (scope, requester identity, the agent's authority confidence) and the human approvals recorded since — an unknown request has no verified authority. */
export function productionFacts(log: readonly DomainEvent[], requestId: string | null): ProductionFacts {
  const received = requestId ? [...log].reverse().find((e) => e.type === "records.request.received" && (e.payload as { request_id?: unknown }).request_id === requestId) : undefined;
  if (!received) return { request_id: requestId, known: false, requester_type: null, scope_loan_count: 0, new_requester_identity: false, authority_confidence: 0, attorney_approved: false, officer_signed_off: false, officer_confirmed: false };
  const p = received.payload as { requester_type?: RequesterType; scope_loan_count?: number; new_requester_identity?: boolean; authority_confidence?: number };
  const mine = log.filter((e) => (e.payload as { request_id?: unknown }).request_id === requestId);
  const verified = [...mine].reverse().find((e) => approvalBy(e, "authority_verified"));
  return { request_id: requestId, known: true, requester_type: p.requester_type ?? null, scope_loan_count: p.scope_loan_count ?? 0, new_requester_identity: p.new_requester_identity ?? false, authority_confidence: verified ? Number((verified.payload as { confidence?: unknown }).confidence ?? 0) : (p.authority_confidence ?? 0), attorney_approved: mine.some((e) => approvalBy(e, "attorney_approval")), officer_signed_off: mine.some((e) => approvalBy(e, "officer_sign_off")), officer_confirmed: mine.some((e) => approvalBy(e, "officer_confirmation")) };
}
export type ProductionCode = "AUTHORITY_CONFIDENCE_BELOW_0_85" | "ATTORNEY_APPROVAL_REQUIRED" | "OFFICER_SIGN_OFF_REQUIRED" | "OFFICER_CONFIRMATION_REQUIRED";
export interface ProductionDecision { readonly allowed: boolean; readonly code: ProductionCode | null; readonly citation: string | null; readonly requires: readonly ProductionRequirement[]; }
/** Delivery gate for a production over the log's facts: authority confidence <0.85 → escalate first; subpoena/court → attorney approval; Fannie Mae/regulator → officer sign-off; >500 loans or a new requester identity → officer confirmation. */
export function productionDeliveryAllowed(f: ProductionFacts): ProductionDecision {
  if (!f.known || f.authority_confidence < 0.85) return { allowed: false, code: "AUTHORITY_CONFIDENCE_BELOW_0_85", citation: f.known ? `19.1 guardrails: confidence ${f.authority_confidence} < 0.85 on requester authority → escalate (officer; attorney for subpoenas) before delivery` : "19.1 guardrails: no `records.request.received` for this request — an unknown requester has no verified authority", requires: ["authority_escalation"] };
  const requires: ProductionRequirement[] = [];
  if ((f.requester_type === "court_subpoena" || f.requester_type === "law_enforcement") && !f.attorney_approved) requires.push("attorney_approval");
  if ((f.requester_type === "fannie_mae" || f.requester_type === "regulator_state" || f.requester_type === "regulator_federal") && !f.officer_signed_off) requires.push("officer_sign_off");
  if ((f.scope_loan_count > 500 || f.new_requester_identity) && !f.officer_confirmed) requires.push("officer_confirmation");
  if (!requires.length) return { allowed: true, code: null, citation: null, requires: [] };
  const code: ProductionCode = requires.includes("attorney_approval") ? "ATTORNEY_APPROVAL_REQUIRED" : requires.includes("officer_sign_off") ? "OFFICER_SIGN_OFF_REQUIRED" : "OFFICER_CONFIRMATION_REQUIRED";
  const citation = code === "ATTORNEY_APPROVAL_REQUIRED" ? "19.1 T14 / escalations: no production is delivered without attorney approval (`records.request.approved{kind=attorney_approval}` by a human attorney)" : code === "OFFICER_SIGN_OFF_REQUIRED" ? "19.1 escalations: Fannie Mae/regulator productions → officer sign-off (`records.request.approved{kind=officer_sign_off}` by a human officer)" : "19.1 guardrails: any request scope > 500 loans or any request from a new requester identity requires officer confirmation before delivery (`records.request.approved{kind=officer_confirmation}` by a human officer)";
  return { allowed: false, code, citation, requires };
}
/** The production guard the bus tools and the domain delivery command share: the same decision from the same log. */
export function productionGuards(c: { op: "deliver"; request_id: string | null; log: readonly DomainEvent[] }): ProductionDecision { return productionDeliveryAllowed(productionFacts(c.log, c.request_id)); }
/** `delivered`: only through the delivery gate over the log's approvals; the event satisfies FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED / SM_REGULATOR_RECORDS_REQUEST for the same subject. */
export function deliverProduction(r: RecordsRequest, delivery: { delivered_via: string; manifest_sha256: string }, ctx: LifecycleContext, log: readonly DomainEvent[]): { delivered: boolean; decision: ProductionDecision; facts: ProductionFacts; request: RecordsRequest; event: DomainEvent | null } {
  const facts = productionFacts(log, r.id);
  const decision = productionDeliveryAllowed(facts);
  if (!decision.allowed) return { delivered: false, decision, facts, request: r, event: null };
  if (!/^[0-9a-f]{64}$/.test(delivery.manifest_sha256)) throw new RangeError("a delivery carries its production manifest's SHA-256");
  const loanId = r.loan_ids.length === 1 ? r.loan_ids[0] : undefined;
  const event = ctx.events.append({ type: "records.request.delivered", ...(loanId ? { loanId } : {}), aggregate: { kind: "records_request", id: r.id }, actor: ctx.actor, payload: { request_id: r.id, requester_type: r.requester_type, delivered_via: delivery.delivered_via, manifest_sha256: delivery.manifest_sha256, approvals: { attorney_approved: facts.attorney_approved, officer_signed_off: facts.officer_signed_off, officer_confirmed: facts.officer_confirmed, authority_confidence: facts.authority_confidence }, delivered_at: ctx.now, hold_release_after_days: 90 } });
  return { delivered: true, decision, facts, request: { ...r, status: "delivered" }, event };
}

// ---- FTC two-year rule (rule 8, T10): disposed, or a documented exception
export type FtcExceptionKind = "legal_requirement" | "business_need" | "infeasible";
/** FTC_314_4C6 (rule 8, T10): the timer closes by `record_object.disposed`; the only other exit is a documented exception, recorded as the timer's cancellation reason. */
export function ftcExceptionReason(kind: FtcExceptionKind, detail: string): string {
  if (!["legal_requirement", "business_need", "infeasible"].includes(kind)) throw new RangeError(`FTC exception must be legal_requirement, business_need or infeasible, not ${String(kind)}`);
  if (!detail.trim()) throw new RangeError("a documented exception needs the documentation");
  return `documented_exception:${kind}: ${detail.trim()}`;
}
export const FTC_DISPOSAL_TIMER = "FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE";
/** The timer engine as the exception command sees it (kernel TimerEngine satisfies it). */
export interface TimerPort { forSubject(kind: string, id: string): readonly { readonly id: string; readonly code: string; readonly status: string }[]; cancel(id: string, reason: string, actor?: Actor): void; }
/** `disposal.except` for customer information not tied to a serviced loan: records `record_object.disposal_excepted` with the documented ground (16 CFR 314.4(c)(6): required by law, legitimate business purpose, targeted disposal not feasible) and cancels the open FTC clock with that documentation as its reason. */
export function exceptFtcDisposal(i: { subject: { kind: string; id: string }; object_id: string; kind: FtcExceptionKind; detail: string }, ctx: LifecycleContext, timers: TimerPort): { reason: string; event: DomainEvent; cancelled_timer_ids: readonly string[] } {
  const reason = ftcExceptionReason(i.kind, i.detail);
  const event = ctx.events.append({ type: "record_object.disposal_excepted", aggregate: i.subject, actor: ctx.actor, payload: { object_id: i.object_id, subject: i.subject, kind: i.kind, detail: i.detail.trim(), documented_by: `${ctx.actor.kind}:${ctx.actor.id}`, timer_code: FTC_DISPOSAL_TIMER, documented_at: ctx.now } });
  const open = timers.forSubject(i.subject.kind, i.subject.id).filter((t) => t.code === FTC_DISPOSAL_TIMER && (t.status === "armed" || t.status === "breached"));
  for (const t of open) timers.cancel(t.id, reason, ctx.actor);
  return { reason, event, cancelled_timer_ids: open.map((t) => t.id) };
}
/** A PlainDate from an ISO instant on its Eastern-time civil date (the anchor convention of the timer engine). */
export const civilDate = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
export { plainDate };
