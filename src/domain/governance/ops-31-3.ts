/**
 * §31.3 Records, retention, privacy, data ownership and security for origination — pure rules over the servicing
 * retention engine (19.1), the incident runbook (19.2) and the vendor registry (19.3). One retention engine for the
 * platform: this file adds the origination rows of `retention_classes` / `record_types` (data model, version 1.0,
 * effective 2026-10-01), the origination anchors (`records.anchor`: every anchor event of the Inputs paragraph maps
 * to the facts the gates read), the disposal gates of the timer table (condition-shaped, asserted through
 * `assertOriginationGateOpen`, never a clock that breaches — 19.1's pattern), the record-object state machine with the
 * origination pre-states (`pre_funding` → `active{fnma_property=true}` on `loan.funded` | `unfunded_running` on
 * `regb_action_notified_at`), the monthly unfunded-file purge sweep (rule 5), auto legal holds within one hour
 * (`SM_O123_LEGAL_HOLD_ON_TRIGGER_1H`), the §1016.13 / vendor flow-down gates evaluated at order time (rules 7–9),
 * restricted-table access logging and anomalies (rule 8), the data-use CI check and weekly scan (rule 7), the incident
 * alignment with 19.2's clocks (rule 10), RON retention by state (Verified requirement F), Fannie Mae productions from
 * the A2-4.1-01 list (rule 6), and the CCPA/GLBA answer (edge cases). Money never appears here; every date is a
 * PlainDate with 19.1 rule-1 anniversary arithmetic (same month/day N years later; Feb 29 → Mar 1; months calendar).
 *
 * Shared-code notes: 19.1's `regBRetentionGate`, `fnmaRetentionGate`, `tcpaConsentGate`, `jurisdictionYears` and
 * `productionDue` are reused unchanged; 19.2's `triageIncident` / `scopeIncident` / `nydfsClocks` drive every incident
 * clock (31.3 adds only the origination scoping and the holds). 30.2's RETENTION_BY_KIND spells the LO-comp class
 * `regz_loc_comp_3y` (0061 CHECK) where the spec and this registry say `regz_locomp_3y` — reported, not redefined.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, dayOfWeek, parts, plainDate } from "../../kernel/calendar/date.ts";
import { wallClock, zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventInput } from "../../kernel/events/index.ts";
import { anniversary, nextDisposalRun, holdReleaseAllowed } from "../data-security/retention.ts";
import { regBRetentionGate, fnmaRetentionGate, tcpaConsentGate, jurisdictionYears, productionDue, type GateOutcome } from "../data-security/ops-19-1.ts";
import { triageIncident, scopeIncident, type TriageInput, type AffectedPerson } from "../data-security/ops-19-2.ts";
import { nydfsClocks, STATE_BREACH_MATRIX, type StateRule } from "../data-security/incident.ts";

const ET = "America/New_York";
const H = 3_600_000, MIN = 60_000;
export const civilDate = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
const later = (...ds: readonly (PlainDate | null | undefined)[]): PlainDate | null => ds.reduce<PlainDate | null>((a, b) => (b ? (a && a > b ? a : b) : a), null);
const closed = (reason: string, opens_on: PlainDate | null = null): GateOutcome => ({ open: false, opens_on, reason });
const onOrAfter = (today: PlainDate, opens: PlainDate): GateOutcome => (today >= opens ? { open: true, opens_on: opens, reason: null } : closed(`retention runs to ${opens}`, opens));
/** Rule 1: every gate is indefinitely extended while `hold_count > 0`; a missing hold fact is not "no hold". */
const withHold = (g: GateOutcome, hold: number | null | undefined): GateOutcome => (hold === undefined ? g : hold === null ? closed("hold_count fact required", g.opens_on) : hold > 0 ? closed("legal_hold", g.opens_on) : g);
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// ============================================================ data model: origination retention classes (v1.0, effective 2026-10-01)
export const ORIG_SCHEDULE_VERSION = "1.0";
export const ORIG_SCHEDULE_EFFECTIVE_FROM: PlainDate = plainDate("2026-10-01");
export type OrigAnchorRule =
  | "later_of_consummation_or_disclosure_required" | "consummation" | "lo_comp_paid" | "disclosure_or_action_required" | "regb_action_notified" | "self_test_completed"
  | "prescreen_solicitation" | "lar_signed" | "afba_executed" | "document_date" | "funded_then_fnma_else_regb" | "later_of_liquidation_or_transfer_out" | "notarial_act"
  | "sar_filed" | "ofac_transaction_or_unblocking" | "revocation_or_last_reliance" | "relationship_end" | "co_decided" | "unfunded_policy_max";
export interface OrigRetentionClass {
  readonly code: string; readonly citation: string; readonly basis: "law" | "guide" | "contract" | "policy"; readonly owner: string;
  readonly anchor_event: string; readonly anchor_rule: OrigAnchorRule; readonly offset_value: number; readonly offset_unit: "months" | "years" | "none";
  readonly permanent_while_active: boolean; readonly may_shorten: false; readonly disposal_method: "crypto_shred" | "object_delete" | "none";
  /** The timer-table row that carries the class's gate; null for a class another process's row or the file's own class gates. */
  readonly timer_code: string | null;
  /** Who holds the record: the platform's WORM store or the RON provider (the platform keeps the access right). */
  readonly holder: "platform" | "ron_provider";
  readonly version: string; readonly effective_from: PlainDate;
}
const cls = (code: string, citation: string, basis: OrigRetentionClass["basis"], owner: string, anchor_event: string, anchor_rule: OrigAnchorRule, offset_value: number, offset_unit: OrigRetentionClass["offset_unit"], permanent_while_active: boolean, timer_code: string | null, extra: Partial<Pick<OrigRetentionClass, "disposal_method" | "holder">> = {}): OrigRetentionClass =>
  ({ code, citation, basis, owner, anchor_event, anchor_rule, offset_value, offset_unit, permanent_while_active, may_shorten: false, disposal_method: extra.disposal_method ?? "crypto_shred", timer_code, holder: extra.holder ?? "platform", version: ORIG_SCHEDULE_VERSION, effective_from: ORIG_SCHEDULE_EFFECTIVE_FROM });
/** The data-model table, row for row (class code, citation, anchor and offset). `may_shorten=false` for every row: Fannie Mae classes may never be shortened and the federal periods are floors. */
export const ORIG_RETENTION_CLASSES: readonly OrigRetentionClass[] = [
  cls("regz_le_3y", "12 CFR 1026.25(c)(1)(i)", "law", "31.3", "disclosure.le.delivered", "later_of_consummation_or_disclosure_required", 3, "years", false, "REGZ_1026_25C1I_LE_RETENTION_3Y"),
  cls("regz_cd_5y", "12 CFR 1026.25(c)(1)(ii)", "law", "31.3", "closing.consummated", "consummation", 5, "years", false, "REGZ_1026_25C1II_CD_RETENTION_5Y"),
  cls("regz_atr_3y", "12 CFR 1026.25(c)(3)", "law", "31.3", "closing.consummated", "consummation", 3, "years", false, "REGZ_1026_25C3_ATR_RETENTION_3Y"),
  cls("regz_locomp_3y", "12 CFR 1026.25(c)(2)", "law", "31.3", "lo_comp.paid", "lo_comp_paid", 3, "years", false, "REGZ_1026_25C2_LOCOMP_RETENTION_3Y"),
  cls("regz_general_2y", "12 CFR 1026.25(a)", "law", "19.1", "disclosure.le.delivered", "disclosure_or_action_required", 2, "years", false, "REGZ_1026_25A_RETENTION_2Y"),
  cls("regb_25m", "12 CFR 1002.12(b)(1), (b)(4)", "law", "31.3", "notice.adverse_action.sent | noia.sent | application.withdrawn | decision.issued{kind=approved_not_accepted} | loan.funded", "regb_action_notified", 25, "months", false, "REGB_1002_12B_APPLICATION_RETENTION_25M"),
  cls("regb_selftest_25m", "12 CFR 1002.12(b)(6)", "law", "31.3", "self_test.completed", "self_test_completed", 25, "months", false, null),
  cls("regb_prescreen_25m", "12 CFR 1002.12(b)(7)", "law", "31.3", "prescreen.solicitation.sent", "prescreen_solicitation", 25, "months", false, null),
  cls("hmda_3y", "12 CFR 1003.5(a)(1)(i)", "law", "31.3", "hmda.lar.accepted", "lar_signed", 3, "years", false, "HMDA_1003_5_LAR_RETENTION_3Y"),
  cls("respa_afba_5y", "12 CFR 1024.15(d)", "law", "31.3", "afba.executed", "afba_executed", 5, "years", false, "RESPA_1024_15D_AFBA_RETENTION_5Y"),
  cls("respa_s8_5y", "12 CFR 1024.14(h)", "law", "31.3", "record.enrolled{record_type∈{msa_agreement, referral_fee_record}}", "document_date", 5, "years", false, "RESPA_1024_14H_S8_RETENTION_5Y"),
  cls("fdpa_life_of_loan", "12 CFR 22.6(b) via Selling Guide B7-3-06 / A2-4.1-01", "guide", "31.3", "loan.funded", "funded_then_fnma_else_regb", 0, "none", true, null),
  cls("fnma_loan_file_life_plus_4y", "Selling Guide A2-4.1-01 / A2-4.1-02 / A2-4.1-03", "guide", "31.3", "loan.liquidated | servicing.transferred_out", "later_of_liquidation_or_transfer_out", 4, "years", true, "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION"),
  cls("fnma_enote_signing_life_plus_7y", "Selling Guide B8-8-02", "guide", "31.3", "enote.signed → loan.liquidated | servicing.transferred_out", "later_of_liquidation_or_transfer_out", 7, "years", true, "FNMA_B8_8_02_ENOTE_SIGNING_RECORDS_LIFE_PLUS_7Y"),
  cls("ron_recording_state_10y", "Fla. Stat. §117.245; Ohio R.C. 147.65", "law", "31.3", "closing.consummated{closing_type=ron}", "notarial_act", 10, "years", false, null, { holder: "ron_provider", disposal_method: "none" }),
  cls("ron_recording_state_5y", "Ariz. Admin. Code R2-12-1308", "law", "31.3", "closing.consummated{closing_type=ron}", "notarial_act", 5, "years", false, null, { holder: "ron_provider", disposal_method: "none" }),
  cls("bsa_sar_5y", "31 CFR 1029.320(c)", "law", "31.3", "sar.filed", "sar_filed", 5, "years", false, "BSA_1029_320C_SAR_RETENTION_5Y"),
  cls("ofac_10y", "31 CFR 501.601", "law", "31.3", "party.screened | ofac.property.blocked | ofac.transaction.rejected", "ofac_transaction_or_unblocking", 10, "years", false, "OFAC_501_601_RETENTION_10Y"),
  cls("tcpa_consent_4y", "28 U.S.C. 1658(a) (servicing 7.4)", "law", "7.4", "consent.revoked | last reliance", "revocation_or_last_reliance", 4, "years", false, "TCPA_CONSENT_EVIDENCE_4Y"),
  cls("esign_consent_life", "15 U.S.C. 7001(c), (d)", "law", "31.3", "consent.granted{kind=esign}", "relationship_end", 0, "none", false, "ESIGN_7001_CONSENT_EVIDENCE_LIFE"),
  cls("co_admt_3y", "C.R.S. 6-1-1703 (21.6)", "law", "21.6", "decision.issued{CO consumer}", "co_decided", 3, "years", false, "CO_SB26_189_1703_RECORDS_3Y"),
  cls("orig_unfunded_policy_25m", "policy: max(regb_25m, hmda_3y, ofac_10y, co_admt_3y, tcpa_consent_4y) for files that never fund", "policy", "31.3", "notice.adverse_action.sent | noia.sent | application.withdrawn | decision.issued{kind=approved_not_accepted}", "unfunded_policy_max", 25, "months", false, "SM_O123_UNFUNDED_FILE_PURGE_SWEEP_MONTHLY"),
];
export const origRetentionClass = (code: string): OrigRetentionClass => { const c = ORIG_RETENTION_CLASSES.find((x) => x.code === code); if (!c) throw new RangeError(`unknown origination retention class ${code}`); return c; };

// ============================================================ data model: origination record types
export type PiiLevel = "none" | "low" | "high" | "restricted";
export type ServicingFileCategory = "ii_security_instrument" | "iv_data_fields" | "none";
export type DataClass = "fcra_consumer_report" | "fnma_data" | "npi" | "none";
export interface OrigRecordType { readonly code: string; readonly retention_class_codes: readonly string[]; readonly pii_level: PiiLevel; readonly servicing_file_category: ServicingFileCategory; readonly data_class: DataClass; }
const rt = (code: string, retention_class_codes: readonly string[], pii_level: PiiLevel = "high", servicing_file_category: ServicingFileCategory = "none", data_class: DataClass = "npi"): OrigRecordType => ({ code, retention_class_codes, pii_level, servicing_file_category, data_class });
/** `record_types` (origination codes). Each carries its own federal/state classes; `classifyOriginationRecord` adds the Fannie Mae class once `loan.funded` and the Reg B policy class for files that never fund (rule 1). */
export const ORIG_RECORD_TYPES: readonly OrigRecordType[] = [
  rt("urla_1003", ["regb_25m"], "high", "iv_data_fields"), rt("scif_1103", ["regb_25m"]),
  rt("credit_report", ["regb_25m"], "high", "none", "fcra_consumer_report"), rt("credit_refresh", ["regb_25m"], "high", "none", "fcra_consumer_report"),
  rt("verification_report", ["regb_25m"], "high", "none", "fcra_consumer_report"), rt("tax_transcript", ["regb_25m"]), rt("ssa_89", ["regb_25m"]), rt("bank_statement", ["regb_25m"]), rt("paystub", ["regb_25m"]), rt("w2_1099", ["regb_25m"]), rt("tax_return", ["regb_25m"]),
  rt("loan_estimate", ["regz_le_3y", "regz_general_2y"], "low"), rt("le_delivery_evidence", ["regz_le_3y", "regz_general_2y"], "low"), rt("changed_circumstance", ["regz_le_3y", "regz_general_2y"], "low"), rt("tolerance_test", ["regz_le_3y", "regz_general_2y"], "low"),
  rt("closing_disclosure", ["regz_cd_5y", "regz_general_2y"], "low"), rt("cd_delivery_evidence", ["regz_cd_5y", "regz_general_2y"], "low"), rt("companion_notice", ["regz_general_2y"], "low"),
  rt("privacy_notice_evidence", ["regb_25m"], "low"), rt("afba_disclosure", ["respa_afba_5y"], "low"),
  rt("adverse_action_notice", ["regb_25m"]), rt("noia", ["regb_25m"]), rt("counteroffer", ["regb_25m"]), rt("statement_of_reasons", ["regb_25m"]), rt("co_admt_notice", ["co_admt_3y", "regb_25m"]),
  rt("du_findings", ["regb_25m"], "high", "none", "fnma_data"), rt("du_submission_xml", ["regb_25m"], "high", "none", "fnma_data"),
  rt("appraisal_uad", ["regb_25m"], "low"), rt("ssr", ["regb_25m"], "low", "none", "fnma_data"), rt("cu_findings", ["regb_25m"], "low", "none", "fnma_data"), rt("property_data_collection", ["regb_25m"], "low"), rt("rov_file", ["regb_25m"], "low"), rt("project_review", ["regb_25m"], "none"),
  rt("title_commitment", ["regb_25m"], "low"), rt("title_policy", ["regb_25m"], "low"), rt("cpl", ["regb_25m"], "low"), rt("payoff_demand", ["regb_25m"], "low"),
  rt("sfhdf", ["fdpa_life_of_loan"], "none"), rt("flood_notice", ["fdpa_life_of_loan"], "low"), rt("insurance_evidence", ["regb_25m"], "low"), rt("mi_certificate", ["regb_25m"], "low"), rt("hpa_disclosure", ["regb_25m"], "low"),
  rt("qm_determination", ["regz_atr_3y"]), rt("atr_evidence", ["regz_atr_3y"]), rt("apr_calculation", ["regz_general_2y"], "low"), rt("compliance_test_run", ["regz_general_2y"], "low"),
  rt("note_image", ["regb_25m"], "high", "ii_security_instrument"), rt("enote_smartdoc", ["regb_25m"], "high", "ii_security_instrument"), rt("enote_signing_record", ["fnma_enote_signing_life_plus_7y"], "high", "ii_security_instrument"),
  rt("security_instrument", ["regb_25m"], "high", "ii_security_instrument"), rt("rider", ["regb_25m"], "low", "ii_security_instrument"), rt("assignment", ["regb_25m"], "low", "ii_security_instrument"), rt("closing_package", ["regb_25m"], "high"),
  rt("ron_session_audit", ["regb_25m"], "high"), rt("wire_evidence", ["regb_25m"], "high"), rt("funding_record", ["regb_25m"], "low"), rt("warehouse_advance", ["regb_25m"], "low"), rt("bailee_letter", ["regb_25m"], "low"),
  rt("uldd_file", ["regb_25m"], "high", "none", "fnma_data"), rt("earlycheck_result", ["regb_25m"], "low", "none", "fnma_data"), rt("ucd_file", ["regb_25m"], "high", "none", "fnma_data"), rt("purchase_advice", ["regb_25m"], "low", "none", "fnma_data"),
  rt("hmda_lar_row", ["hmda_3y"], "restricted", "iv_data_fields"), rt("sar", ["bsa_sar_5y"], "high"), rt("ofac_screen", ["ofac_10y"], "high"), rt("fraud_report", ["regb_25m"], "high"), rt("qc_review", ["regb_25m"], "high"),
  rt("agent_decision", ["regb_25m", "co_admt_3y"], "low"), rt("consent_esign", ["esign_consent_life"], "low"), rt("consent_tcpa", ["tcpa_consent_4y"], "low"), rt("consent_ai_disclosure", ["regb_25m"], "low"),
  rt("lo_comp_record", ["regz_locomp_3y"], "low"), rt("lock_confirmation", ["regb_25m"], "low"), rt("pricing_exception", ["regb_25m"], "low"), rt("fl_demographics", ["regb_25m"], "restricted"),
  rt("msa_agreement", ["respa_s8_5y"], "none"), rt("referral_fee_record", ["respa_s8_5y"], "none"), rt("self_test_record", ["regb_selftest_25m"], "restricted"), rt("prescreen_solicitation", ["regb_prescreen_25m"], "low"),
];
export const origRecordType = (code: string): OrigRecordType => { const r = ORIG_RECORD_TYPES.find((x) => x.code === code); if (!r) throw new RangeError(`unknown origination record_type ${code}: default is the longest known class — classify by hand`); return r; };
export const FNMA_FILE_CLASS = "fnma_loan_file_life_plus_4y";
export const UNFUNDED_POLICY_CLASS = "orig_unfunded_policy_25m";

export interface OrigClassification {
  readonly record_type: string; readonly retention_class_codes: readonly string[]; readonly timer_codes: readonly string[]; readonly effective_rule: "max_over_all_classes";
  readonly fnma_property: boolean; readonly file_class: string; readonly pii_level: PiiLevel; readonly data_class: DataClass; readonly servicing_file_category: ServicingFileCategory; readonly may_shorten: false; readonly schedule_version: string;
}
/**
 * `records.classify` (rule 1): the type's own classes plus — for a funded loan — `fnma_loan_file_life_plus_4y` (every
 * origination object is Fannie Mae property; `permanent_while_active` dominates) or — for a file that never funds — the
 * Reg B policy class where the type has no clock of its own (the file's other artifacts purge at the Reg B date).
 * Colorado's class applies only to Colorado consumers; the RON provider's class is carried on the session audit for RON closings.
 */
export function classifyOriginationRecord(recordType: string, i: { funded: boolean; state?: string | null; closing_type?: string | null }): OrigClassification {
  const r = origRecordType(recordType);
  let codes = [...r.retention_class_codes];
  if (i.state !== "CO") codes = codes.filter((c) => c !== "co_admt_3y");
  if (i.funded) { if (!codes.includes(FNMA_FILE_CLASS)) codes.push(FNMA_FILE_CLASS); }
  else if (codes.length === 0) codes.push("regb_25m");
  if (recordType === "ron_session_audit" && i.closing_type === "ron") codes.push(ronRetentionClassCode(i.state ?? null));
  return { record_type: r.code, retention_class_codes: codes, timer_codes: codes.map((c) => origRetentionClass(c).timer_code).filter((t): t is string => t !== null), effective_rule: "max_over_all_classes",
    fnma_property: i.funded, file_class: i.funded ? FNMA_FILE_CLASS : UNFUNDED_POLICY_CLASS, pii_level: r.pii_level, data_class: r.data_class, servicing_file_category: r.servicing_file_category, may_shorten: false, schedule_version: ORIG_SCHEDULE_VERSION };
}

// ============================================================ RON retention by state (Verified requirement F; `jurisdiction_rules.ron.retention`)
export interface RonRetentionRule { readonly years: number; readonly holder: "ron_provider" | "notary" | "repository"; readonly citation: string; readonly verification_status: "verified" | "partially_verified" | "unverified"; }
/** Provider-held periods: FL 10 (§117.245), AZ 5 (R2-12-1308), OH 10 (R.C. 147.65 journal; recording PARTIALLY VERIFIED). Every other RON state is `unverified` → fail-closed: treat as 10 years. */
export const RON_RETENTION: Readonly<Record<string, RonRetentionRule>> = {
  FL: { years: 10, holder: "ron_provider", citation: "Fla. Stat. §117.245: journal and recordings 'maintained for at least 10 years after the date of the notarial act'", verification_status: "verified" },
  AZ: { years: 5, holder: "ron_provider", citation: "Ariz. Admin. Code R2-12-1308: recording 'retained for at least five years after the' notarization; journal five years after the last entry", verification_status: "verified" },
  OH: { years: 10, holder: "repository", citation: "Ohio R.C. 147.65: Secretary of State or repository 'shall maintain the electronic journal for a period of ten years' (recording rule PARTIALLY VERIFIED)", verification_status: "partially_verified" },
};
export const RON_UNVERIFIED_DEFAULT_YEARS = 10;
export function ronRetentionRule(state: string | null): RonRetentionRule {
  return (state ? RON_RETENTION[state] : undefined) ?? { years: RON_UNVERIFIED_DEFAULT_YEARS, holder: "ron_provider", citation: `jurisdiction_rules.ron.retention has no verified row for ${state ?? "?"}: fail-closed to ${RON_UNVERIFIED_DEFAULT_YEARS} years`, verification_status: "unverified" };
}
export const ronRetentionClassCode = (state: string | null): string => `ron_recording_state_${ronRetentionRule(state).years}y`;
export interface RonRecordingAccess { readonly timer_code: string; readonly state: string; readonly notarial_act_on: PlainDate; readonly retained_until: PlainDate; readonly years: number; readonly holder: RonRetentionRule["holder"]; readonly citation: string; readonly verification_status: RonRetentionRule["verification_status"]; readonly platform_retains: readonly string[]; readonly platform_class: string; }
/** `RON_RECORDING_ACCESS_<ST>`: the recording is held by the RON provider to the state period; the platform retains the access right, session audit trail and hash under the Fannie Mae class (nuance 4). */
export function ronRecordingAccess(i: { state: string; notarial_act_on: PlainDate }): RonRecordingAccess {
  const r = ronRetentionRule(i.state);
  return { timer_code: `RON_RECORDING_ACCESS_${i.state}`, state: i.state, notarial_act_on: i.notarial_act_on, retained_until: anniversary(i.notarial_act_on, r.years), years: r.years, holder: r.holder, citation: r.citation, verification_status: r.verification_status, platform_retains: ["access_right", "session_audit_trail", "recording_hash"], platform_class: FNMA_FILE_CLASS };
}

// ============================================================ facts and gates (timer table — condition-shaped, never clocks)
/** The facts a disposal command carries to the origination gates: PlainDates (null = the anchor event has not fired), `funded`, `loan_active`, `hold_count` (null = unknown → closed). */
export interface OrigFacts {
  readonly today: PlainDate; readonly hold_count: number | null; readonly funded: boolean; readonly loan_active?: boolean | null; readonly state?: string | null; readonly jurisdiction_years?: number | null;
  readonly consummation_date?: PlainDate | null; readonly disclosure_required_at?: PlainDate | null; readonly action_required_at?: PlainDate | null; readonly lo_comp_paid_on?: PlainDate | null;
  readonly regb_action_notified_at?: PlainDate | null; readonly enforcement_notice_received_on?: PlainDate | null; readonly investigation_closed_on?: PlainDate | null;
  readonly self_test_completed_on?: PlainDate | null; readonly prescreen_on?: PlainDate | null; readonly lar_signed_on?: PlainDate | null; readonly afba_executed_on?: PlainDate | null; readonly document_date?: PlainDate | null;
  readonly sar_filed_on?: PlainDate | null; readonly ofac_transaction_on?: PlainDate | null; readonly ofac_blocked?: boolean; readonly ofac_unblocked_on?: PlainDate | null;
  readonly notarial_act_on?: PlainDate | null; readonly liquidated_on?: PlainDate | null; readonly transferred_out_on?: PlainDate | null;
  readonly revoked_on?: PlainDate | null; readonly last_reliance_on?: PlainDate | null; readonly relationship_ended_on?: PlainDate | null; readonly co_decided_on?: PlainDate | null; readonly esign_consent_on?: PlainDate | null;
}
export type OrigObjectFacts = Omit<OrigFacts, "today" | "hold_count">;
const fnmaGate = (f: OrigFacts, years: 4 | 7): GateOutcome => {
  if (!f.funded) return closed("not_fnma_property_until_loan_funded");
  if (f.loan_active === undefined || f.loan_active === null) return closed("loan_active fact required (permanent while active)");
  const jy = Math.max(f.jurisdiction_years ?? 0, jurisdictionYears(f.state ?? null).years);
  const g = fnmaRetentionGate({ today: f.today, liquidated_on: f.liquidated_on ?? null, transferred_out_on: f.transferred_out_on ?? null, loan_active: f.loan_active, hold_count: f.hold_count, jurisdiction_years: Math.max(4, jy) });
  if (years === 4 || !g.opens_on) return g;
  const anchor = later(f.liquidated_on, f.transferred_out_on)!;
  return withHold(onOrAfter(f.today, anniversary(anchor, Math.max(7, jy))), f.hold_count);
};
const single = (f: OrigFacts, anchor: PlainDate | null | undefined, c: OrigRetentionClass): GateOutcome => (!anchor ? closed("no_anchor_event") : withHold(onOrAfter(f.today, c.offset_unit === "years" ? anniversary(anchor, c.offset_value) : addMonths(anchor, c.offset_value)), f.hold_count));
/**
 * One gate per class of the data-model table. Reg Z (c)(1)(i) runs from the later of consummation, the LE-required date and
 * the action-required date; Reg B reuses 19.1's gate with the §1002.12(b)(4) extension to `investigation.closed`; OFAC blocked
 * property keeps the anchor unset (gate closed) until 28.4 records `ofac.report.submitted{unblocking}`; the Fannie Mae classes
 * are permanent while the loan is active; E-SIGN consent evidence opens with the loan file once the customer relationship ends.
 */
export function origClassGate(code: string, f: OrigFacts): GateOutcome {
  const c = origRetentionClass(code);
  switch (c.anchor_rule) {
    case "later_of_consummation_or_disclosure_required": return single(f, later(f.consummation_date, f.disclosure_required_at, f.action_required_at), c);
    case "consummation": return single(f, f.consummation_date, c);
    case "lo_comp_paid": return single(f, f.lo_comp_paid_on, c);
    case "disclosure_or_action_required": return single(f, later(f.disclosure_required_at, f.action_required_at), c);
    case "regb_action_notified": { const g = regBRetentionGate({ today: f.today, notified_on: f.regb_action_notified_at ?? null, enforcement_notice_received_on: f.enforcement_notice_received_on ?? null, investigation_closed_on: f.investigation_closed_on ?? null, hold_count: f.hold_count }); return { open: g.open, opens_on: g.opens_on, reason: g.reason }; }
    case "self_test_completed": return single(f, f.self_test_completed_on, c);
    case "prescreen_solicitation": return single(f, f.prescreen_on, c);
    case "lar_signed": return single(f, f.lar_signed_on, c);
    case "afba_executed": return single(f, f.afba_executed_on, c);
    case "document_date": return single(f, f.document_date, c);
    case "funded_then_fnma_else_regb": return f.funded ? fnmaGate(f, 4) : origClassGate("regb_25m", f);
    case "later_of_liquidation_or_transfer_out": return fnmaGate(f, c.offset_value === 7 ? 7 : 4);
    case "notarial_act": return single(f, f.notarial_act_on, c);
    case "sar_filed": return single(f, f.sar_filed_on, c);
    case "ofac_transaction_or_unblocking": {
      if (f.ofac_blocked && !f.ofac_unblocked_on) return withHold(closed("blocked_property: anchor unset until ofac.report.submitted{unblocking} (31 CFR 501.601)"), f.hold_count);
      return single(f, f.ofac_blocked ? f.ofac_unblocked_on : f.ofac_transaction_on, c);
    }
    case "revocation_or_last_reliance": return tcpaConsentGate({ today: f.today, revoked_on: f.revoked_on ?? null, last_reliance_on: f.last_reliance_on ?? null, hold_count: f.hold_count });
    case "relationship_end": { if (!f.relationship_ended_on) return withHold(closed("customer_relationship_active"), f.hold_count); return f.funded ? fnmaGate(f, 4) : origClassGate("regb_25m", f); }
    case "co_decided": return single(f, f.co_decided_on, c);
    case "unfunded_policy_max": {
      const parts_ = [origClassGate("regb_25m", f), ...(f.lar_signed_on ? [origClassGate("hmda_3y", f)] : []), ...(f.ofac_transaction_on ? [origClassGate("ofac_10y", f)] : []), ...(f.state === "CO" && f.co_decided_on ? [origClassGate("co_admt_3y", f)] : []), ...(f.revoked_on || f.last_reliance_on ? [origClassGate("tcpa_consent_4y", f)] : [])];
      const opens = parts_.map((g) => g.opens_on);
      const max = opens.every((d): d is PlainDate => d !== null) ? opens.reduce((a, b) => (b > a ? b : a)) : null;
      const blocked = parts_.find((g) => !g.open);
      return blocked ? closed(blocked.reason ?? "closed", max) : { open: true, opens_on: max, reason: null };
    }
  }
}
export interface OrigGateRow { readonly class_code: string; readonly timer_code: string | null; readonly open: boolean; readonly opens_on: PlainDate | null; readonly reason: string | null; readonly holder: OrigRetentionClass["holder"]; }
export type OrigRecordStatus = "pre_funding" | "active" | "unfunded_running" | "retention_running" | "eligible" | "held" | "disposed";
export interface OrigEligibility { readonly record_type: string; readonly status: OrigRecordStatus; readonly gates: readonly OrigGateRow[]; readonly eligible_for_disposal_at: PlainDate | null; readonly effective_class_code: string | null; readonly file_class: string; readonly disposable: boolean; readonly blocking: readonly string[]; readonly fnma_property: boolean; }
/**
 * Rule 1 for one origination object: every applicable class must be open — effective eligibility is the max over the classes'
 * opening dates, the effective class the one that opens last (the Fannie Mae class for every funded loan; the Reg B policy
 * class for the unfunded file). State machine: `pre_funding` (file open, no notice), `active{fnma_property}` once funded,
 * `unfunded_running` on `regb_action_notified_at`, `eligible` when every class has expired and `hold_count = 0`, `held` overlay.
 */
export function originationObjectEligibility(recordType: string, facts: OrigFacts): OrigEligibility {
  const c = classifyOriginationRecord(recordType, { funded: facts.funded, state: facts.state ?? null });
  const gates: OrigGateRow[] = c.retention_class_codes.map((code) => { const k = origRetentionClass(code); const g = origClassGate(code, facts); return { class_code: code, timer_code: k.timer_code, open: g.open, opens_on: g.opens_on, reason: g.reason, holder: k.holder }; });
  const opens = gates.map((g) => g.opens_on);
  const eligible = opens.length && opens.every((d): d is PlainDate => d !== null) ? opens.reduce((a, b) => (b > a ? b : a)) : null;
  const permanent = gates.some((g) => g.reason === "permanent_while_active");
  const effective = permanent ? gates.find((g) => g.reason === "permanent_while_active")!.class_code : eligible ? (gates.find((g) => g.opens_on === eligible)?.class_code ?? null) : null;
  const disposable = gates.every((g) => g.open);
  const status: OrigRecordStatus = (facts.hold_count ?? 0) > 0 ? "held" : facts.funded ? (permanent ? "active" : disposable ? "eligible" : "retention_running") : !facts.regb_action_notified_at ? "pre_funding" : disposable ? "eligible" : "unfunded_running";
  return { record_type: recordType, status, gates, eligible_for_disposal_at: eligible, effective_class_code: effective, file_class: c.file_class, disposable, blocking: gates.filter((g) => !g.open).map((g) => `${g.timer_code ?? g.class_code}: ${g.reason}`), fnma_property: facts.funded };
}
export class OrigGateClosed extends Error {
  readonly gate: string; readonly reason: string; readonly opens_on: PlainDate | null;
  constructor(gate: string, reason: string, opens_on: PlainDate | null) { super(`${gate} closed: ${reason}${opens_on ? ` (opens ${opens_on})` : ""}`); this.name = "GateClosed"; this.gate = gate; this.reason = reason; this.opens_on = opens_on; }
}
/** `assertGateOpen` for a disposal command over one origination object — identical on the AI path and the 19.1 ops-console human path (T13); throws on the first closed gate. */
export function assertOriginationGatesOpen(recordType: string, facts: OrigFacts): OrigEligibility {
  const e = originationObjectEligibility(recordType, facts);
  for (const g of e.gates) if (!g.open) throw new OrigGateClosed(g.timer_code ?? g.class_code, g.reason ?? "closed", g.opens_on);
  return e;
}
/** The gate one timer row asserts (evaluators-31-3.ts): the class the row carries, over the same facts. */
export const TIMER_CLASS: Readonly<Record<string, string>> = Object.fromEntries(ORIG_RETENTION_CLASSES.filter((c) => c.timer_code && c.owner === "31.3").map((c) => [c.timer_code!, c.code]));
export function timerGate(timerCode: string, f: OrigFacts): GateOutcome { const code = TIMER_CLASS[timerCode]; if (!code) throw new RangeError(`no 31.3 disposal gate ${timerCode}`); return origClassGate(code, f); }

/** Worked example 1 / 2 (rule 2): the refinance fixture's clocks as `records.anchor` leaves them. */
export const REFI_FIXTURE_FACTS: OrigObjectFacts = { funded: true, loan_active: true, state: "AZ", consummation_date: plainDate("2026-11-06"), disclosure_required_at: plainDate("2026-10-08"), action_required_at: null, lo_comp_paid_on: plainDate("2026-12-15"), regb_action_notified_at: plainDate("2026-11-06"), afba_executed_on: plainDate("2026-10-05"), lar_signed_on: plainDate("2027-02-15"), ofac_transaction_on: plainDate("2026-10-05"), notarial_act_on: plainDate("2026-11-06"), esign_consent_on: plainDate("2026-10-06"), liquidated_on: null, transferred_out_on: null };
/** Worked example 2 (rule 3): the denied Ohio application. */
export const DENIED_FIXTURE_FACTS: OrigObjectFacts = { funded: false, state: "OH", regb_action_notified_at: plainDate("2026-11-04"), lar_signed_on: plainDate("2027-02-15"), ofac_transaction_on: plainDate("2026-10-19") };
export interface FileClocks { readonly clocks: Readonly<Record<string, PlainDate | null>>; readonly effective_class: string; readonly status: OrigRecordStatus; readonly eligible_for_disposal_at: PlainDate | null; readonly first_disposal_run: PlainDate | null; }
/** Rule 2/3: the file's clocks by class, the effective class and the first first-Sunday disposal run on/after eligibility (19.1 runs are the first Sunday of each month). */
export function fileClocks(facts: OrigObjectFacts, today: PlainDate, hold_count = 0): FileClocks {
  const f: OrigFacts = { ...facts, today, hold_count };
  const codes = ["regz_le_3y", "regz_cd_5y", "regz_atr_3y", "regz_locomp_3y", "regb_25m", "respa_afba_5y", "hmda_3y", "ofac_10y", "bsa_sar_5y", "fnma_enote_signing_life_plus_7y", "fnma_loan_file_life_plus_4y", "esign_consent_life"];
  const clocks = Object.fromEntries(codes.map((c) => [c, origClassGate(c, f).opens_on]));
  const file = originationObjectEligibility("urla_1003", f);
  const eligible = file.eligible_for_disposal_at;
  return { clocks, effective_class: file.effective_class_code ?? file.file_class, status: file.status, eligible_for_disposal_at: eligible, first_disposal_run: eligible ? firstDisposalRunOnOrAfter(eligible) : null };
}
/** The first first-Sunday run on or after a date (a run on the eligibility date itself includes the object; 19.1 `nextDisposalRun` gives the following month's). */
export function firstDisposalRunOnOrAfter(eligible: PlainDate): PlainDate {
  const { y, m } = parts(eligible);
  let d = plainDate(`${y}-${String(m).padStart(2, "0")}-01`);
  while (dayOfWeek(d) !== 0) d = addDays(d, 1);
  return d >= eligible ? d : nextDisposalRun(eligible);
}

// ============================================================ record objects, enrolment and anchoring (records.classify / records.anchor)
export type EventSink = { append<P extends Record<string, unknown>>(input: EventInput<P>): DomainEvent<P> };
export interface OrigEscalationPort { open(input: { kind: string; ownerRole?: string; applicationId?: string; loanId?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
export interface OrigContext { readonly events: EventSink; readonly actor: Actor; readonly now: string; readonly escalations?: OrigEscalationPort; }
export interface OrigRecordObject {
  readonly id: string; readonly record_type: string; readonly application_id: string; readonly loan_id: string | null; readonly state: string | null; readonly facts: OrigObjectFacts; readonly sha256: string;
  readonly status: OrigRecordStatus; readonly hold_count: number; readonly hold_ids: readonly string[]; readonly eligible_for_disposal_at: PlainDate | null; readonly effective_class_code: string | null; readonly gates: readonly OrigGateRow[];
  readonly disposed_at: string | null; readonly disposal_run_id: string | null; readonly data_class: DataClass; readonly pii_level: PiiLevel;
}
const emit = (ctx: OrigContext, type: string, applicationId: string | null, payload: Record<string, unknown>, extra: { aggregate?: { kind: string; id: string }; loanId?: string | null; occurredAt?: string } = {}): DomainEvent =>
  ctx.events.append({ type, ...(applicationId ? { applicationId, aggregate: extra.aggregate ?? { kind: "application", id: applicationId } } : extra.aggregate ? { aggregate: extra.aggregate } : {}), ...(extra.loanId ? { loanId: extra.loanId } : {}), ...(extra.occurredAt ? { occurredAt: extra.occurredAt } : {}), actor: ctx.actor, payload: { source: "origination", ...(applicationId ? { application_id: applicationId } : {}), ...payload } });
/** Every `documents`/`notices`/`consents`/`agent_decisions`… write is enrolled synchronously: the object with its classes and `record.enrolled{record_type}`. */
export function enrollRecord(i: { id: string; record_type: string; application_id: string; loan_id?: string | null; state?: string | null; sha256: string; facts?: OrigObjectFacts; document_date?: PlainDate | null; closing_type?: string | null }, ctx: OrigContext): { object: OrigRecordObject; event: DomainEvent } {
  const funded = i.facts?.funded ?? false;
  const c = classifyOriginationRecord(i.record_type, { funded, state: i.state ?? null, closing_type: i.closing_type ?? null });
  const facts: OrigObjectFacts = { ...(i.facts ?? { funded }), funded, state: i.state ?? null, ...(i.document_date ? { document_date: i.document_date } : {}) };
  const object: OrigRecordObject = { id: i.id, record_type: i.record_type, application_id: i.application_id, loan_id: i.loan_id ?? null, state: i.state ?? null, facts, sha256: i.sha256, status: funded ? "active" : "pre_funding", hold_count: 0, hold_ids: [], eligible_for_disposal_at: null, effective_class_code: null, gates: [], disposed_at: null, disposal_run_id: null, data_class: c.data_class, pii_level: c.pii_level };
  const event = emit(ctx, "record.enrolled", i.application_id, { object_id: i.id, record_type: i.record_type, retention_class_codes: c.retention_class_codes, timer_codes: c.timer_codes, file_class: c.file_class, fnma_property: c.fnma_property, pii_level: c.pii_level, data_class: c.data_class, schedule_version: c.schedule_version, document_date: i.document_date ?? null, sha256: i.sha256 }, { loanId: i.loan_id ?? null });
  return { object: sweepOne(object, civilDate(ctx.now)), event };
}
const sweepOne = (o: OrigRecordObject, today: PlainDate): OrigRecordObject => {
  if (o.status === "disposed") return o;
  const e = originationObjectEligibility(o.record_type, { ...o.facts, today, hold_count: o.hold_count });
  return { ...o, status: e.status, eligible_for_disposal_at: e.eligible_for_disposal_at, effective_class_code: e.effective_class_code, gates: e.gates };
};
/** `retention-sweep` (daily, 19.1) over the origination objects: every class of every object, statuses per the state machine. */
export function sweepOrigination(objects: readonly OrigRecordObject[], today: PlainDate): OrigRecordObject[] { return objects.map((o) => sweepOne(o, today)); }

type P = Record<string, unknown>;
const pd = (p: P, ...keys: string[]): PlainDate | null => { for (const k of keys) { const v = p[k]; if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v as PlainDate; if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return civilDate(v); } return null; };
export interface AnchorRule { readonly classes: readonly string[]; readonly patch: (p: P, on: PlainDate) => Partial<OrigObjectFacts>; readonly note: string; }
/**
 * `records.anchor`: the Inputs paragraph's anchor events → the facts the gates read (the platform's event names; 21.6's action
 * names for Reg B, 26.2's consummation, 22.6's screening, 28.3's `hmda.lar.accepted{signed_at}`, 28.4's `sar.filed`, 19.1's
 * servicing anchors). `application.received` opens the file (`pre_funding`); `loan.funded` makes every object Fannie Mae
 * property and is the approval's Reg B notification (worked example 1: "approval notified at consummation; use Nov 6, 2026").
 */
export const ANCHOR_EVENTS: Readonly<Record<string, AnchorRule>> = {
  "application.received": { classes: [], patch: () => ({}), note: "file opens (pre_funding); Reg B prescreen/self-test clocks run on their own records" },
  "disclosure.le.delivered": { classes: ["regz_le_3y", "regz_general_2y"], patch: (p, on) => ({ disclosure_required_at: pd(p, "disclosure_required_at", "required_by", "le_required_by", "due_on") ?? on }), note: "§1026.25(c)(1)(i): the date disclosures are required to be made (per LE version)" },
  "disclosure.le.required_at": { classes: ["regz_le_3y", "regz_general_2y"], patch: (p, on) => ({ disclosure_required_at: pd(p, "disclosure_required_at", "required_by") ?? on }), note: "§1026.25(c)(1)(i)" },
  "notice.adverse_action.sent": { classes: ["regb_25m", UNFUNDED_POLICY_CLASS], patch: (p, on) => ({ regb_action_notified_at: pd(p, "regb_action_notified_at", "sent_on") ?? on }), note: "§1002.12(b)(1): notification of action taken (21.6)" },
  "noia.sent": { classes: ["regb_25m", UNFUNDED_POLICY_CLASS], patch: (p, on) => ({ regb_action_notified_at: pd(p, "regb_action_notified_at", "sent_on") ?? on }), note: "§1002.12(b)(1): notice of incompleteness (21.6)" },
  "application.withdrawn": { classes: ["regb_25m", UNFUNDED_POLICY_CLASS], patch: (p, on) => ({ regb_action_notified_at: pd(p, "regb_action_notified_at", "received_on", "withdrawn_on") ?? on }), note: "edge case: the date the creditor records the withdrawal (§1002.9(e))" },
  "decision.issued": { classes: ["regb_25m", "co_admt_3y", UNFUNDED_POLICY_CLASS], patch: (p, on) => ({ ...(p.kind === "approved_not_accepted" ? { regb_action_notified_at: pd(p, "regb_action_notified_at", "approval_expires_on", "notified_on") ?? on } : {}), ...(p.state === "CO" || p.co_consumer === true ? { co_decided_on: pd(p, "decided_on", "decided_at") ?? on } : {}) }), note: "21.6 approved-not-accepted (Reg B); Colorado consequential decision (C.R.S. 6-1-1703)" },
  "loan.funded": { classes: ["regb_25m", FNMA_FILE_CLASS, "fdpa_life_of_loan"], patch: (p, on) => ({ funded: true, loan_active: true, regb_action_notified_at: pd(p, "regb_action_notified_at", "consummation_date", "approval_notified_on") ?? on }), note: "approval notified; the Fannie Mae class begins (every object becomes Fannie Mae property)" },
  "closing.consummated": { classes: ["regz_cd_5y", "regz_atr_3y", "regz_le_3y"], patch: (p, on) => ({ consummation_date: pd(p, "consummation_date", "consummation_on", "consummation_date_local") ?? on, ...(p.closing_type === "ron" || p.remote_notarization_indicator === true ? { notarial_act_on: pd(p, "notarial_act_on", "consummation_date", "consummation_on") ?? on } : {}) }), note: "§1026.25(c)(1)(ii), (c)(3); RON notarial act (26.2)" },
  "lo_comp.paid": { classes: ["regz_locomp_3y"], patch: (p, on) => ({ lo_comp_paid_on: pd(p, "paid_on", "received_on") ?? on }), note: "§1026.25(c)(2): date of receipt or payment" },
  "afba.executed": { classes: ["respa_afba_5y"], patch: (p, on) => ({ afba_executed_on: pd(p, "executed_on") ?? on }), note: "§1024.15(d): date of execution" },
  "hmda.lar.accepted": { classes: ["hmda_3y"], patch: (p, on) => ({ lar_signed_on: pd(p, "signed_at", "submitted_on") ?? on }), note: "§1003.5(a)(1)(i): the officer's signed_at completes the submission (28.3)" },
  "party.screened": { classes: ["ofac_10y"], patch: (p, on) => ({ ofac_transaction_on: pd(p, "screened_on", "transaction_date") ?? on }), note: "31 CFR 501.601: transaction date (22.6)" },
  "ofac.transaction.rejected": { classes: ["ofac_10y"], patch: (p, on) => ({ ofac_transaction_on: pd(p, "rejected_on", "transaction_date") ?? on }), note: "31 CFR 501.601 (28.4)" },
  "ofac.property.blocked": { classes: ["ofac_10y"], patch: (p, on) => ({ ofac_blocked: true, ofac_transaction_on: pd(p, "blocked_on", "blocked_date") ?? on }), note: "31 CFR 501.601: anchor unset (gate closed) until unblocking (28.4)" },
  "ofac.report.submitted": { classes: ["ofac_10y"], patch: (p, on) => (p.kind === "unblocking" ? { ofac_unblocked_on: pd(p, "unblocked_on", "submitted_on") ?? on } : {}), note: "28.4 `ofac.report.submitted{unblocking}` sets the blocked-property anchor" },
  "sar.filed": { classes: ["bsa_sar_5y"], patch: (p, on) => ({ sar_filed_on: pd(p, "filed_on", "filed_at") ?? on }), note: "31 CFR 1029.320(c): five years from filing (28.4)" },
  "enote.signed": { classes: ["fnma_enote_signing_life_plus_7y"], patch: () => ({}), note: "B8-8-02: signing records anchored on the loan's liquidation/transfer-out (26.2)" },
  "consent.granted": { classes: ["esign_consent_life", "tcpa_consent_4y"], patch: (p, on) => ({ ...(p.kind === "esign" ? { esign_consent_on: pd(p, "granted_on") ?? on } : {}), ...(p.kind === "tcpa" ? { last_reliance_on: pd(p, "last_reliance_on", "granted_on") ?? on } : {}) }), note: "15 U.S.C. 7001(c) consent evidence (20.2/20.3); TCPA consent last reliance" },
  "consent.revoked": { classes: ["tcpa_consent_4y"], patch: (p, on) => ({ revoked_on: pd(p, "revoked_on") ?? on }), note: "servicing 7.4 `tcpa_consent_4y`" },
  "enforcement_notice.received": { classes: ["regb_25m"], patch: (p, on) => ({ enforcement_notice_received_on: pd(p, "received_on") ?? on }), note: "§1002.12(b)(4): extended until final disposition" },
  "investigation.closed": { classes: ["regb_25m"], patch: (p, on) => ({ investigation_closed_on: pd(p, "closed_on") ?? on }), note: "§1002.12(b)(4): final disposition" },
  "loan.liquidated": { classes: [FNMA_FILE_CLASS, "fnma_enote_signing_life_plus_7y"], patch: (p, on) => ({ loan_active: false, liquidated_on: pd(p, "liquidated_on", "payoff_date") ?? on }), note: "19.1 servicing anchor (A2-4.1-02 four years after liquidation)" },
  "servicing.transferred_out": { classes: [FNMA_FILE_CLASS, "fnma_enote_signing_life_plus_7y"], patch: (p, on) => ({ loan_active: false, transferred_out_on: pd(p, "transferred_out_on", "effective_on") ?? on }), note: "19.1 servicing anchor" },
  "relationship.ended": { classes: ["esign_consent_life"], patch: (p, on) => ({ relationship_ended_on: pd(p, "ended_on") ?? on }), note: "E-SIGN consent evidence: end of the customer relationship, then the loan-file class" },
  "record.enrolled": { classes: ["respa_s8_5y"], patch: (p, on) => (p.record_type === "msa_agreement" || p.record_type === "referral_fee_record" ? { document_date: pd(p, "document_date") ?? on } : {}), note: "§1024.14(h): Section 8 records five years from the document date" },
};
export interface AnchorResult { readonly anchored: boolean; readonly classes: readonly string[]; readonly patch: Partial<OrigObjectFacts>; readonly anchor_at: PlainDate; readonly note: string | null; }
/** Read one platform event as an anchor: which classes it anchors and the facts patch (`record_objects.anchors`). Unknown types anchor nothing. */
export function anchorFromEvent(e: Pick<DomainEvent, "type" | "payload" | "occurredAt">): AnchorResult {
  const on = civilDate(e.occurredAt);
  const r = ANCHOR_EVENTS[e.type];
  if (!r) return { anchored: false, classes: [], patch: {}, anchor_at: on, note: null };
  const patch = r.patch(e.payload as P, on);
  return { anchored: Object.keys(patch).length > 0 || r.classes.length > 0, classes: r.classes, patch, anchor_at: on, note: r.note };
}
/** `records.anchor` for the objects of one application: apply the event's anchor to every object, re-sweep, and emit `record.anchored{class, anchor_at}` per class the object carries. */
export function anchorObjects(objects: readonly OrigRecordObject[], e: Pick<DomainEvent, "type" | "payload" | "occurredAt" | "applicationId" | "id">, ctx: OrigContext): { objects: OrigRecordObject[]; anchored: readonly { object_id: string; classes: readonly string[] }[]; events: DomainEvent[]; result: AnchorResult } {
  const result = anchorFromEvent(e);
  const appId = e.applicationId ?? (typeof (e.payload as P).application_id === "string" ? String((e.payload as P).application_id) : null);
  const today = civilDate(ctx.now);
  const anchored: { object_id: string; classes: readonly string[] }[] = []; const events: DomainEvent[] = [];
  const next = objects.map((o) => {
    if (!result.anchored || o.status === "disposed" || (appId !== null && o.application_id !== appId)) return o;
    const swept = sweepOne({ ...o, facts: { ...o.facts, ...result.patch } }, today);
    const classes = swept.gates.map((g) => g.class_code).filter((c) => result.classes.includes(c) || Object.keys(result.patch).some((k) => k === "funded" || k === "loan_active"));
    if (classes.length) { anchored.push({ object_id: o.id, classes }); for (const c of classes) events.push(emit(ctx, "record.anchored", o.application_id, { object_id: o.id, record_type: o.record_type, class: c, anchor_at: result.anchor_at, anchor_event: e.type, anchor_event_id: e.id, opens_on: swept.gates.find((g) => g.class_code === c)?.opens_on ?? null, status: swept.status }, { loanId: o.loan_id })); }
    return swept;
  });
  return { objects: next, anchored, events, result };
}
/** The LO-compensation record (`lo_comp_record`) is the 31.3 write that carries §1026.25(c)(2)'s anchor: `lo_comp.paid{paid_on}`. */
export function recordLoCompPaid(i: { application_id: string; loan_id?: string | null; mlo_nmlsr_id: string; paid_on: PlainDate; kind: "paid" | "received"; record_id: string; sha256: string }, ctx: OrigContext): { event: DomainEvent; object: OrigRecordObject } {
  const event = emit(ctx, "lo_comp.paid", i.application_id, { record_id: i.record_id, mlo_nmlsr_id: i.mlo_nmlsr_id, paid_on: i.paid_on, receipt_or_payment: i.kind }, { loanId: i.loan_id ?? null, occurredAt: toIso(zonedEpochMs(i.paid_on, "12:00", ET)) });
  const { object } = enrollRecord({ id: i.record_id, record_type: "lo_comp_record", application_id: i.application_id, loan_id: i.loan_id ?? null, sha256: i.sha256, facts: { funded: true, loan_active: true, lo_comp_paid_on: i.paid_on } }, ctx);
  return { event, object };
}
/** The AfBA disclosure record (`afba_disclosure`) carries §1024.15(d)'s anchor: `afba.executed{executed_on}`. */
export function recordAfbaExecuted(i: { application_id: string; executed_on: PlainDate; record_id: string; sha256: string; provider: string }, ctx: OrigContext): { event: DomainEvent; object: OrigRecordObject } {
  const event = emit(ctx, "afba.executed", i.application_id, { record_id: i.record_id, executed_on: i.executed_on, provider: i.provider }, { occurredAt: toIso(zonedEpochMs(i.executed_on, "12:00", ET)) });
  const { object } = enrollRecord({ id: i.record_id, record_type: "afba_disclosure", application_id: i.application_id, sha256: i.sha256, facts: { funded: false, afba_executed_on: i.executed_on } }, ctx);
  return { event, object };
}

// ============================================================ schedules (origination additions to 19.1's) and the unfunded-file purge sweep (rule 5)
export type OrigScheduleJob = "denied_withdrawn_purge_sweep" | "pii_access_review" | "vendor_manifest_reconciliation" | "fannie_data_use_scan";
const quarterEnd = (d: PlainDate): boolean => { const { m, d: day } = parts(d); return (m === 3 && day === 31) || (m === 6 && day === 30) || (m === 9 && day === 30) || (m === 12 && day === 31); };
/** `schedule.tick{job}` with origination context: the purge sweep on the first Sunday (with 19.1's disposal run), the PII access review at quarter-end, the manifest reconciliation and the Fannie Mae data-use scan every Monday. */
export function originationScheduleTicks(today: PlainDate): EventInput[] {
  // global subject (no aggregate), like 19.1's ticks: the satisfying run/review/scan events close the row whatever aggregate they carry
  const tick = (job: OrigScheduleJob, cadence: string, extra: Record<string, unknown> = {}): EventInput => ({ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, payload: { source: "origination", job, cadence, date: today, tz: ET, ...extra } });
  const out: EventInput[] = [];
  const { d } = parts(today);
  if (dayOfWeek(today) === 0 && d <= 7) out.push(tick("denied_withdrawn_purge_sweep", "monthly", { weekday: "sunday", ordinal: 1, at: "02:00" }));
  if (quarterEnd(today)) out.push(tick("pii_access_review", "quarterly", { period: `${parts(today).y}-Q${Math.ceil(parts(today).m / 3)}` }));
  if (dayOfWeek(today) === 1) { out.push(tick("vendor_manifest_reconciliation", "weekly")); out.push(tick("fannie_data_use_scan", "weekly")); }
  return out;
}
export function emitOriginationScheduleTicks(today: PlainDate, events: EventSink): DomainEvent[] { return originationScheduleTicks(today).map((e) => events.append(e)); }

export interface UnfundedPurgeRun {
  readonly id: string; readonly run_on: PlainDate; readonly class_code: typeof UNFUNDED_POLICY_CLASS; readonly object_ids: readonly string[]; readonly application_ids: readonly string[];
  readonly excluded: readonly { object_id: string; reason: string }[]; readonly retained_under_own_class: readonly { object_id: string; class_code: string; opens_on: PlainDate | null }[];
  readonly tombstone: { readonly applications: readonly string[]; readonly retained_columns: readonly string[]; readonly shredded: readonly string[]; readonly agent_decisions: "hashes_and_versions_only"; readonly credit_reports: "crypto_shred" };
  readonly status: "planned" | "awaiting_attestation" | "executed"; readonly attested_by: string | null; readonly attested_at: string | null; readonly manifest_sha256: string; readonly gates_checked: readonly string[]; readonly holds_checked: true;
}
/**
 * Rule 5 — the monthly sweep selects `record_objects{funded=false}` whose every class has expired and `hold_count = 0`; the
 * `applications` row is tombstoned (id, dates, action taken, HMDA-derived fields retained per `hmda_3y`; PII columns
 * crypto-shredded); `agent_decisions` keep hashes and versions; the LAR row and OFAC log survive under their own classes.
 */
export function planUnfundedPurgeRun(i: { run_on: PlainDate; objects: readonly OrigRecordObject[] }): UnfundedPurgeRun {
  const swept = sweepOrigination(i.objects, i.run_on);
  const ids: string[] = []; const excluded: { object_id: string; reason: string }[] = []; const retained: { object_id: string; class_code: string; opens_on: PlainDate | null }[] = []; const gates = new Set<string>(); const apps = new Set<string>();
  for (const o of swept) {
    if (o.status === "disposed") continue;
    if (o.facts.funded) { excluded.push({ object_id: o.id, reason: "fnma_property: funded loans follow the Fannie Mae class (19.1 disposal run)" }); continue; }
    const blocking = o.gates.filter((g) => !g.open);
    if (o.status === "held") { excluded.push({ object_id: o.id, reason: "legal_hold" }); continue; }
    if (o.status === "pre_funding") { excluded.push({ object_id: o.id, reason: "no_anchor_event: file open (pre_funding)" }); continue; }
    if (blocking.length) {
      const own = blocking.find((g) => g.class_code !== "regb_25m");
      if (own) retained.push({ object_id: o.id, class_code: own.class_code, opens_on: own.opens_on });
      excluded.push({ object_id: o.id, reason: blocking.map((g) => `${g.timer_code ?? g.class_code}: ${g.reason}`).join("; ") }); continue;
    }
    ids.push(o.id); apps.add(o.application_id); for (const g of o.gates) gates.add(g.timer_code ?? g.class_code);
  }
  const manifest_sha256 = sha(swept.filter((o) => ids.includes(o.id)).map((o) => [o.id, o.sha256]));
  return { id: `DR-${i.run_on}-${UNFUNDED_POLICY_CLASS}`, run_on: i.run_on, class_code: UNFUNDED_POLICY_CLASS, object_ids: ids, application_ids: [...apps], excluded, retained_under_own_class: retained,
    tombstone: { applications: [...apps], retained_columns: ["id", "application_date", "action_taken", "action_taken_date", "hmda_derived_fields"], shredded: ["pii_columns", "six_items", "application_borrowers.pii"], agent_decisions: "hashes_and_versions_only", credit_reports: "crypto_shred" },
    status: ids.length ? "awaiting_attestation" : "planned", attested_by: null, attested_at: null, manifest_sha256, gates_checked: [...gates], holds_checked: true };
}
/** Rule 5 / 19.1 rule 7: the run is attested by an `officer` — a human act; the agent never disposes without it. */
export function attestUnfundedPurgeRun(run: UnfundedPurgeRun, ctx: OrigContext): { allowed: boolean; code: "OFFICER_ATTESTATION_REQUIRED" | null; run: UnfundedPurgeRun; event: DomainEvent | null } {
  if (ctx.actor.kind !== "human" || ctx.actor.role !== "officer") return { allowed: false, code: "OFFICER_ATTESTATION_REQUIRED", run, event: null };
  const event = ctx.events.append({ type: "disposal_run.attested", aggregate: { kind: "disposal_run", id: run.id }, actor: ctx.actor, payload: { source: "origination", run_id: run.id, class_code: run.class_code, object_count: run.object_ids.length, manifest_sha256: run.manifest_sha256, attested_by: ctx.actor.id, attested_by_role: "officer" } });
  return { allowed: true, code: null, run: { ...run, status: "awaiting_attestation", attested_by: ctx.actor.id, attested_at: ctx.now }, event };
}
/** Executes an attested run: every object's gates re-asserted today (identical for the agent and the ops-console operator), `record_object.disposed` per object and `disposal_run.executed{origination_unfunded=true}` — the event that satisfies SM_O123_UNFUNDED_FILE_PURGE_SWEEP_MONTHLY. */
export function executeUnfundedPurgeRun(run: UnfundedPurgeRun, objects: readonly OrigRecordObject[], ctx: OrigContext): { executed: boolean; refusal: { code: string; citation: string } | null; objects: OrigRecordObject[]; events: DomainEvent[] } {
  if (run.attested_by === null) return { executed: false, refusal: { code: "OFFICER_ATTESTATION_REQUIRED", citation: "31.3 rule 5 / 19.1 rule 7: the run is attested by an officer before execution" }, objects: [...objects], events: [] };
  const today = civilDate(ctx.now); const next = [...objects]; const events: DomainEvent[] = [];
  for (const id of run.object_ids) {
    const idx = next.findIndex((o) => o.id === id); const o = next[idx];
    if (!o) return { executed: false, refusal: { code: "DISPOSAL_ONLY_VIA_ATTESTED_RUN", citation: `object ${id} is not in the run's objects` }, objects: [...objects], events: [] };
    try { assertOriginationGatesOpen(o.record_type, { ...o.facts, today, hold_count: o.hold_count }); }
    catch (err) { return { executed: false, refusal: { code: "GATE_CLOSED", citation: `object ${id}: ${(err as Error).message} — assertGateOpen (timer table: disposal blocked)` }, objects: [...objects], events: [] }; }
    events.push(emit(ctx, "record_object.disposed", o.application_id, { object_id: o.id, record_type: o.record_type, class_code: run.class_code, run_id: run.id, method: origRetentionClass(o.effective_class_code ?? "regb_25m").disposal_method }, { aggregate: { kind: "record_object", id: o.id } }));
    next[idx] = { ...o, status: "disposed", disposed_at: ctx.now, disposal_run_id: run.id };
  }
  events.push(ctx.events.append({ type: "disposal_run.executed", aggregate: { kind: "disposal_run", id: run.id }, actor: ctx.actor, payload: { source: "origination", origination_unfunded: true, run_id: run.id, class_code: run.class_code, object_count: run.object_ids.length, application_ids: run.application_ids, tombstone: run.tombstone, gates_checked: run.gates_checked, holds_checked: run.holds_checked, manifest_sha256: run.manifest_sha256, attested_by: run.attested_by } }));
  return { executed: true, refusal: null, objects: next, events };
}

// ============================================================ legal holds (origination auto-holds; SM_O123_LEGAL_HOLD_ON_TRIGGER_1H)
export type HoldTriggerReason = "complaint_discrimination" | "complaint_udaap" | "regulator_inquiry" | "co_ag_notice" | "litigation" | "qc_self_report" | "security_incident";
export const HOLD_TRIGGER_REASONS: readonly HoldTriggerReason[] = ["complaint_discrimination", "complaint_udaap", "regulator_inquiry", "co_ag_notice", "litigation", "qc_self_report", "security_incident"];
export const HOLD_WITHIN_MINUTES = 60;
export interface OrigLegalHold { readonly id: string; readonly reason: `origination_${HoldTriggerReason}`; readonly application_ids: readonly string[]; readonly matter_ref: string; readonly placed_by: string; readonly placed_at: string; readonly next_review_at: string; readonly auto_placed: boolean; readonly released_at: string | null; readonly release_approvals: readonly string[]; readonly incident_id: string | null; }
const scopeOf = (i: { application_ids: readonly string[]; incident_id?: string | null }): { aggregate: { kind: string; id: string } | undefined; applicationId: string | null } =>
  i.incident_id ? { aggregate: { kind: "security_incident", id: i.incident_id }, applicationId: null } : i.application_ids.length === 1 ? { aggregate: undefined, applicationId: i.application_ids[0]! } : { aggregate: { kind: "legal_hold_batch", id: sha(i.application_ids).slice(0, 16) }, applicationId: null };
/** A hold trigger (complaint alleging discrimination/UDAAP, regulator inquiry, Colorado AG notice, litigation, QC self-report, incident touching the application): `legal_hold.trigger.detected{reason}` arms the one-hour clock. */
export function detectHoldTrigger(i: { reason: HoldTriggerReason; application_ids: readonly string[]; matter_ref: string; incident_id?: string | null; detected_at?: string }, ctx: OrigContext): { event: DomainEvent; due_by: string } {
  const at = i.detected_at ?? ctx.now;
  const due_by = toIso(Date.parse(at) + HOLD_WITHIN_MINUTES * MIN);
  const s = scopeOf(i);
  const event = emit(ctx, "legal_hold.trigger.detected", s.applicationId, { reason: i.reason, application_ids: i.application_ids, matter_ref: i.matter_ref, incident_id: i.incident_id ?? null, detected_at: at, due_by, timer_code: "SM_O123_LEGAL_HOLD_ON_TRIGGER_1H" }, { ...(s.aggregate ? { aggregate: s.aggregate } : {}), occurredAt: at });
  return { event, due_by };
}
/** `holds.place` (agent-allowed): every object of the applications becomes `held`; `legal_hold.placed{reason=origination_*}` satisfies the one-hour row and arms 19.1's SM_LEGAL_HOLD_REVIEW_180. Release is a human act (officer + attorney). */
export function placeOriginationHold(objects: readonly OrigRecordObject[], i: { id: string; reason: HoldTriggerReason; application_ids: readonly string[]; matter_ref: string; incident_id?: string | null; auto_placed?: boolean }, ctx: OrigContext): { hold: OrigLegalHold; objects: OrigRecordObject[]; event: DomainEvent } {
  const placedMs = Date.parse(ctx.now);
  if (Number.isNaN(placedMs)) throw new RangeError("now must be an ISO timestamp");
  const hold: OrigLegalHold = { id: i.id, reason: `origination_${i.reason}`, application_ids: i.application_ids, matter_ref: i.matter_ref, placed_by: `${ctx.actor.kind}:${ctx.actor.id}`, placed_at: ctx.now, next_review_at: toIso(placedMs + 180 * 86_400_000), auto_placed: i.auto_placed ?? true, released_at: null, release_approvals: [], incident_id: i.incident_id ?? null };
  const apps = new Set(i.application_ids);
  const next = objects.map((o) => (o.status !== "disposed" && apps.has(o.application_id) ? { ...o, hold_count: o.hold_count + 1, hold_ids: [...o.hold_ids, hold.id], status: "held" as const } : o));
  const s = scopeOf(i);
  const event = emit(ctx, "legal_hold.placed", s.applicationId, { hold_id: hold.id, scope: "application", scope_ref: i.application_ids.join(","), reason: hold.reason, matter_ref: hold.matter_ref, placed_at: hold.placed_at, next_review_at: hold.next_review_at, auto_placed: hold.auto_placed, application_ids: i.application_ids, incident_id: hold.incident_id, object_ids: next.filter((o) => o.hold_ids.includes(hold.id)).map((o) => o.id) }, s.aggregate ? { aggregate: s.aggregate } : {});
  return { hold, objects: next, event };
}
/** Hold release: officer + attorney jointly (19.1 POL-REC-02); the agent never releases. */
export function releaseOriginationHold(objects: readonly OrigRecordObject[], hold: OrigLegalHold, approvals: readonly ("officer" | "attorney")[], ctx: OrigContext): { allowed: boolean; code: "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY" | null; hold: OrigLegalHold; objects: OrigRecordObject[]; event: DomainEvent | null } {
  if (ctx.actor.kind !== "human" || !holdReleaseAllowed(approvals)) return { allowed: false, code: "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY", hold, objects: [...objects], event: null };
  const next = objects.map((o) => (o.hold_ids.includes(hold.id) ? sweepOne({ ...o, hold_count: o.hold_count - 1, hold_ids: o.hold_ids.filter((h) => h !== hold.id) }, civilDate(ctx.now)) : o));
  const released: OrigLegalHold = { ...hold, released_at: ctx.now, release_approvals: approvals };
  const s = scopeOf(hold);
  return { allowed: true, code: null, hold: released, objects: next, event: emit(ctx, "legal_hold.released", s.applicationId, { hold_id: hold.id, reason: hold.reason, released_at: ctx.now, release_approvals: approvals }, s.aggregate ? { aggregate: s.aggregate } : {}) };
}
/** Worked example 2 / T4: a written allegation of an ECOA violation → `enforcement_notice.received` (§1002.12(b)(4)), the Reg B gate extended to `investigation.closed`, the file held. */
export function recordEcoaAllegation(objects: readonly OrigRecordObject[], i: { application_id: string; received_on: PlainDate; matter_ref: string; hold_id: string }, ctx: OrigContext): { objects: OrigRecordObject[]; events: DomainEvent[]; hold: OrigLegalHold; reg_b: ReturnType<typeof regBRetentionGate> } {
  const at = toIso(zonedEpochMs(i.received_on, "09:00", ET));
  const notice = emit(ctx, "enforcement_notice.received", i.application_id, { basis: "written_allegation_ecoa", received_on: i.received_on, matter_ref: i.matter_ref, citation: "12 CFR 1002.12(b)(4)" }, { occurredAt: at });
  const anchored = anchorObjects(objects, { ...notice, applicationId: i.application_id }, ctx);
  const trig = detectHoldTrigger({ reason: "complaint_discrimination", application_ids: [i.application_id], matter_ref: i.matter_ref, detected_at: at }, ctx);
  const held = placeOriginationHold(anchored.objects, { id: i.hold_id, reason: "complaint_discrimination", application_ids: [i.application_id], matter_ref: i.matter_ref }, ctx);
  const file = held.objects.find((o) => o.application_id === i.application_id);
  const reg_b = regBRetentionGate({ today: civilDate(ctx.now), notified_on: file?.facts.regb_action_notified_at ?? null, enforcement_notice_received_on: i.received_on, investigation_closed_on: null, hold_count: file?.hold_count ?? null });
  return { objects: held.objects, events: [notice, ...anchored.events, trig.event, held.event], hold: held.hold, reg_b };
}
export function recordInvestigationClosed(objects: readonly OrigRecordObject[], i: { application_id: string; closed_on: PlainDate; matter_ref: string }, ctx: OrigContext): { objects: OrigRecordObject[]; event: DomainEvent } {
  const event = emit(ctx, "investigation.closed", i.application_id, { closed_on: i.closed_on, matter_ref: i.matter_ref }, { occurredAt: toIso(zonedEpochMs(i.closed_on, "17:00", ET)) });
  return { objects: anchorObjects(objects, { ...event, applicationId: i.application_id }, ctx).objects, event };
}

// ============================================================ vendor flow-down gates (rules 7–9; GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE / SM_O123_VENDOR_FLOWDOWN_GATE)
export type VendorClass = "amc_appraiser" | "pdc" | "credit_reseller" | "verification_income_asset" | "ives_transcript" | "cbsv" | "identity_fraud" | "flood" | "title_settlement" | "wire_verification" | "eclosing_ron" | "evault" | "erecording" | "mi_company" | "print_mail" | "e_delivery" | "telephony_voice" | "model_provider" | "custodian" | "warehouse_bank";
export const VENDOR_CLASSES: readonly VendorClass[] = ["amc_appraiser", "pdc", "credit_reseller", "verification_income_asset", "ives_transcript", "cbsv", "identity_fraud", "flood", "title_settlement", "wire_verification", "eclosing_ron", "evault", "erecording", "mi_company", "print_mail", "e_delivery", "telephony_voice", "model_provider", "custodian", "warehouse_bank"];
export type ClauseStatus = "present" | "deviation" | "missing" | "n_a";
export const GLBA_USE_LIMIT_CLAUSE = "GLBA_1016_13_USE_LIMIT";
/** Rule 9: every class row requires these. */
export const COMMON_FLOWDOWN_CLAUSES: readonly string[] = ["DATA_RETURN_DESTROY_CERT", "INCIDENT_NOTICE_24H", "AUDIT_RIGHTS_FNMA", "US_PROCESSING", "SUBPROCESSOR_NOTICE"];
export interface VendorFlowdownRequirement { readonly vendor_class: VendorClass; readonly required_clause_codes: readonly string[]; readonly data_classes_permitted: readonly string[]; readonly state_overlays: Readonly<Record<string, readonly string[]>>; }
const req = (vendor_class: VendorClass, own: readonly string[], data: readonly string[], overlays: Record<string, readonly string[]> = {}): VendorFlowdownRequirement => ({ vendor_class, required_clause_codes: [...own, ...COMMON_FLOWDOWN_CLAUSES], data_classes_permitted: data, state_overlays: overlays });
/** `vendor_flowdown_requirements` — rule 9 by vendor class (executed before the first order). */
export const VENDOR_FLOWDOWN_REQUIREMENTS: readonly VendorFlowdownRequirement[] = [
  req("amc_appraiser", ["AIR_1026_42_INDEPENDENCE", "UCDP_LENDER_AGENT_TERMS", "FNMA_DATA_NO_REDISCLOSURE", GLBA_USE_LIMIT_CLAUSE, "NPI_MINIMUM_NECESSARY"], ["property", "borrower_name_address"]),
  req("pdc", ["FNMA_DATA_NO_REDISCLOSURE", GLBA_USE_LIMIT_CLAUSE, "NPI_MINIMUM_NECESSARY"], ["property"]),
  req("credit_reseller", ["FCRA_END_USER_CERT", "FCRA_PERMISSIBLE_PURPOSE_PER_PULL", GLBA_USE_LIMIT_CLAUSE, "US_IP_ALLOW_LIST"], ["npi", "fcra_consumer_report"]),
  req("verification_income_asset", ["FCRA_END_USER_CERT", "BORROWER_AUTHORIZATION_SCOPE", "NO_RETENTION_BEYOND_TRANSACTION", "NO_TRAINING_ON_DATA", GLBA_USE_LIMIT_CLAUSE], ["npi", "fcra_consumer_report"]),
  req("ives_transcript", ["IRS_IVES_AUDIT_LOG", "BORROWER_AUTHORIZATION_SCOPE", "NO_RETENTION_BEYOND_TRANSACTION", GLBA_USE_LIMIT_CLAUSE], ["tax_data"]),
  req("cbsv", ["BORROWER_AUTHORIZATION_SCOPE", "NO_RETENTION_BEYOND_TRANSACTION", GLBA_USE_LIMIT_CLAUSE], ["ssn", "npi"]),
  req("identity_fraud", [GLBA_USE_LIMIT_CLAUSE, "BIOMETRIC_STATE_LAW_COMPLIANCE", "RETENTION_LIMITS"], ["npi", "id_number"]),
  req("flood", [GLBA_USE_LIMIT_CLAUSE], ["property"]),
  req("title_settlement", ["ALTA_BEST_PRACTICES", "WIRE_FRAUD_CONTROLS", GLBA_USE_LIMIT_CLAUSE], ["npi", "property"]),
  req("wire_verification", [GLBA_USE_LIMIT_CLAUSE, "WIRE_FRAUD_CONTROLS"], ["account_number"]),
  req("eclosing_ron", ["RON_RECORDING_ACCESS_RIGHT", "MISMO_RON_AUDIT_TRAIL", GLBA_USE_LIMIT_CLAUSE, "BREACH_NOTICE_24H"], ["npi", "id_number", "recording"], { FL: ["RON_STATE_RETENTION_FL"], AZ: ["RON_STATE_RETENTION_AZ"], OH: ["RON_STATE_RETENTION_OH"] }),
  req("evault", ["MERS_ERegistry_PARTICIPANT", "SMART_DOC_INTEGRITY", "TRANSFER_OF_CONTROL_COOPERATION", "RETURN_EXPORT_ON_TERMINATION", GLBA_USE_LIMIT_CLAUSE], ["enote"]),
  req("erecording", ["PRIA_STANDARDS", GLBA_USE_LIMIT_CLAUSE], ["security_instrument"]),
  req("mi_company", ["MI_MASTER_POLICY_DATA_TERMS", "NPI_LIMITED_TO_CERTIFICATE", GLBA_USE_LIMIT_CLAUSE], ["npi"]),
  req("print_mail", [GLBA_USE_LIMIT_CLAUSE, "PROOF_RETENTION_19_1"], ["npi"]),
  req("e_delivery", [GLBA_USE_LIMIT_CLAUSE, "PROOF_RETENTION_19_1"], ["npi"]),
  req("telephony_voice", [GLBA_USE_LIMIT_CLAUSE, "CALL_RECORDING_CONSENT_STATES", "RETENTION_TCPA_OR_LOAN_FILE"], ["voice", "npi"]),
  req("model_provider", ["NO_TRAINING_ON_DATA", "ZERO_RETENTION", "NO_HUMAN_REVIEW_WITHOUT_NOTICE", "MODEL_VERSION_CHANGE_NOTICE", "ASSURANCE_REPORTS", GLBA_USE_LIMIT_CLAUSE], ["npi"]),
  req("custodian", ["FNMA_DATA_NO_REDISCLOSURE", GLBA_USE_LIMIT_CLAUSE], ["note", "npi"]),
  req("warehouse_bank", ["BAILEE_TERMS", GLBA_USE_LIMIT_CLAUSE], ["note", "npi"]),
];
export const vendorFlowdownRequirement = (vendor_class: string): VendorFlowdownRequirement => { const r = VENDOR_FLOWDOWN_REQUIREMENTS.find((x) => x.vendor_class === vendor_class); if (!r) throw new RangeError(`no vendor_flowdown_requirements row for class ${vendor_class}: fail closed`); return r; };
export interface VendorGateFacts { readonly vendor_class: string; readonly clauses: Readonly<Record<string, ClauseStatus>>; readonly privacy_notice_delivered_or_scheduled?: boolean | null; readonly attorney_signed_off_deviations?: readonly string[]; readonly state?: string | null; }
/** §1016.13(a)(1): the executed `GLBA_1016_13_USE_LIMIT` clause present for the vendor **and** the partner's initial privacy notice delivered or scheduled per §1016.4 (21.3/25.4). */
export function glbaServiceProviderGate(f: VendorGateFacts): GateOutcome & { readonly missing: readonly string[] } {
  const st = f.clauses[GLBA_USE_LIMIT_CLAUSE] ?? "missing";
  const missing: string[] = [];
  if (st !== "present") missing.push(`${GLBA_USE_LIMIT_CLAUSE}=${st}`);
  if (f.privacy_notice_delivered_or_scheduled !== true) missing.push("partner initial privacy notice (§1016.4) not delivered or scheduled");
  return missing.length ? { ...closed(`§1016.13 service-provider condition unmet: ${missing.join("; ")}`), missing } : { open: true, opens_on: null, reason: null, missing };
}
/** SM_O123_VENDOR_FLOWDOWN_GATE: every `required_clause_codes` for the class `present` (or `deviation` with attorney sign-off); state overlays added for the order's state. */
export function vendorFlowdownGate(f: VendorGateFacts): GateOutcome & { readonly missing: readonly string[]; readonly required: readonly string[] } {
  const r = vendorFlowdownRequirement(f.vendor_class);
  const required = [...r.required_clause_codes, ...((f.state && r.state_overlays[f.state]) ?? [])];
  const signed = new Set(f.attorney_signed_off_deviations ?? []);
  const missing = required.filter((c) => { const st = f.clauses[c] ?? "missing"; return !(st === "present" || (st === "deviation" && signed.has(c))); });
  return missing.length ? { ...closed(`flow-down clauses not executed for ${f.vendor_class}: ${missing.join(", ")}`), missing, required } : { open: true, opens_on: null, reason: null, missing, required };
}
export interface VendorOrderResult { readonly allowed: boolean; readonly gate: "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE" | "SM_O123_VENDOR_FLOWDOWN_GATE" | null; readonly missing: readonly string[]; readonly events: readonly DomainEvent[]; readonly escalation: { id: string; kind: "sev1"; owner_role: "officer" } | null; readonly order_status: "flowdown_checked" | "refused"; }
/**
 * `vendors.checkFlowdown(vendor_id, class)` inside the adapter layer — every `integrations/*` adapter calls it on
 * `vendor.order.requested{vendor_class}`: the §1016.13 gate first, then the class flow-down; fails closed (`vendor.flowdown.blocked`,
 * order refused, sev-1 → `officer`); `vendor.flowdown.verified` lets the order proceed. Never opened on inference — only executed clauses count.
 */
export function checkVendorOrder(i: { order_id: string; vendor_id: string; application_id: string; facts: VendorGateFacts; inferred?: boolean }, ctx: OrigContext): VendorOrderResult {
  if (i.inferred) throw new RangeError("31.3 guardrails: never opens a vendor gate on inference — clause status comes from executed contract_clauses");
  const requested = emit(ctx, "vendor.order.requested", i.application_id, { order_id: i.order_id, vendor_id: i.vendor_id, vendor_class: i.facts.vendor_class, state: i.facts.state ?? null });
  const glba = glbaServiceProviderGate(i.facts);
  const flow = glba.open ? vendorFlowdownGate(i.facts) : null;
  const blockedBy = !glba.open ? "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE" as const : flow && !flow.open ? "SM_O123_VENDOR_FLOWDOWN_GATE" as const : null;
  if (blockedBy) {
    const missing = blockedBy === "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE" ? glba.missing : flow!.missing;
    const blocked = emit(ctx, "vendor.flowdown.blocked", i.application_id, { order_id: i.order_id, vendor_id: i.vendor_id, vendor_class: i.facts.vendor_class, gate: blockedBy, missing, reason: (blockedBy === "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE" ? glba : flow!).reason });
    const esc = ctx.escalations?.open({ kind: "sev1", ownerRole: "officer", applicationId: i.application_id, severity: "sev1", payload: { gate: blockedBy, vendor_id: i.vendor_id, vendor_class: i.facts.vendor_class, missing, order_id: i.order_id, citation: "12 CFR 1016.13(a)(1); 31.3 rule 9" } }, ctx.actor) ?? null;
    return { allowed: false, gate: blockedBy, missing, events: [requested, blocked], escalation: esc ? { id: esc.id, kind: "sev1", owner_role: "officer" } : null, order_status: "refused" };
  }
  const verified = emit(ctx, "vendor.flowdown.verified", i.application_id, { order_id: i.order_id, vendor_id: i.vendor_id, vendor_class: i.facts.vendor_class, gates: ["GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE", "SM_O123_VENDOR_FLOWDOWN_GATE"], required: flow!.required });
  return { allowed: true, gate: null, missing: [], events: [requested, verified], escalation: null, order_status: "flowdown_checked" };
}

// ============================================================ restricted-table access (rule 8; pii_access_log; SM_O123_PII_ACCESS_ANOMALY_1H / _REVIEW_90)
export type PiiTable = "applicant_demographics" | "credit_reports" | "documents_pii" | "du_findings" | "verification_raw";
export type PiiPurpose = "intake_write" | "hmda_export" | "boarding_export_19_4" | "monitoring_run" | "bias_test" | "qc_review" | "regulator_query" | "fnma_query" | "incident_scoping" | "borrower_request" | "access_review";
export const PII_PURPOSES: readonly PiiPurpose[] = ["intake_write", "hmda_export", "boarding_export_19_4", "monitoring_run", "bias_test", "qc_review", "regulator_query", "fnma_query", "incident_scoping", "borrower_request", "access_review"];
/** Rule 8: the only writers/readers of `applicant_demographics` — 21.1's intake path, 28.3 (LAR build), 30.2 (19.4 boarding export), 31.2's enclave jobs and `security-records` custody tools. */
export const DEMOGRAPHICS_ROSTER: Readonly<Record<PiiTable, readonly string[]>> = {
  applicant_demographics: ["svc:21.1-intake", "svc:28.3-lar-build", "svc:30.2-boarding-export", "svc:31.2-enclave", "agent:security-records"],
  credit_reports: ["svc:22.2-credit", "svc:23.x-underwriting", "agent:security-records"],
  documents_pii: ["svc:22.1-documents", "agent:security-records"], du_findings: ["svc:23.1-du", "agent:security-records"], verification_raw: ["svc:22.x-verification", "agent:security-records"],
};
export const SIEM_ALERT_MINUTES = 5;
export const BULK_READ_ROWS = 1000;
export interface PiiAccessInput { readonly principal: string; readonly role: string; readonly table: PiiTable; readonly application_id: string | null; readonly purpose_code: string; readonly request_id: string; readonly query_hash: string; readonly row_count: number; readonly roster?: Readonly<Record<string, readonly string[]>>; readonly at?: string; readonly include_content?: boolean; }
export interface PiiAccessLog { readonly at: string; readonly principal: string; readonly role: string; readonly table: PiiTable; readonly application_id: string | null; readonly purpose_code: string; readonly request_id: string; readonly query_hash: string; readonly row_count: number; readonly decision: "allowed" | "denied"; readonly anomaly: readonly string[]; readonly retention: "security_logs_5y"; }
export interface PiiAccessResult { readonly log: PiiAccessLog; readonly denied: boolean; readonly anomaly: readonly string[]; readonly siem_alert_due_at: string | null; readonly anomaly_id: string | null; readonly events: readonly DomainEvent[]; readonly escalation: { id: string; kind: "sev1" } | null; readonly auto_revoke: string | null; }
/** Every read of a restricted table is logged with a purpose code; a principal outside the roster, an off-list purpose or a bulk read is denied, alerts the SIEM within 5 minutes and opens `SM_O123_PII_ACCESS_ANOMALY_1H` (`pii.access.anomaly{detected_at}`). Content never enters a prompt. */
export function logPiiAccess(i: PiiAccessInput, ctx: OrigContext): PiiAccessResult {
  if (i.include_content) throw new RangeError("31.3 guardrails: never reads applicant_demographics content into a prompt — the custody tools operate on ids and hashes");
  const at = i.at ?? ctx.now;
  const roster = (i.roster ?? DEMOGRAPHICS_ROSTER)[i.table] ?? [];
  const anomaly: string[] = [];
  if (!roster.includes(i.principal)) anomaly.push("unexpected_principal");
  if (!(PII_PURPOSES as readonly string[]).includes(i.purpose_code)) anomaly.push("off_purpose_code");
  if (i.row_count > BULK_READ_ROWS) anomaly.push("bulk_read");
  const denied = anomaly.length > 0;
  const log: PiiAccessLog = { at, principal: i.principal, role: i.role, table: i.table, application_id: i.application_id, purpose_code: i.purpose_code, request_id: i.request_id, query_hash: i.query_hash, row_count: i.row_count, decision: denied ? "denied" : "allowed", anomaly, retention: "security_logs_5y" };
  const events: DomainEvent[] = [emit(ctx, "pii.access.logged", i.application_id, { ...log }, { occurredAt: at, aggregate: { kind: "pii_access", id: i.request_id } })];
  if (!denied) return { log, denied, anomaly, siem_alert_due_at: null, anomaly_id: null, events, escalation: null, auto_revoke: null };
  const siem = toIso(Date.parse(at) + SIEM_ALERT_MINUTES * MIN);
  const anomaly_id = `PIA-${i.request_id}`;
  events.push(emit(ctx, "pii.access.anomaly", i.application_id, { anomaly_id, kinds: anomaly, principal: i.principal, table: i.table, purpose_code: i.purpose_code, detected_at: at, siem_alert_due_at: siem, siem_rule: "19.4-T5 unexpected principal", timer_code: "SM_O123_PII_ACCESS_ANOMALY_1H", disposition_due_at: toIso(Date.parse(at) + H) }, { occurredAt: at, aggregate: { kind: "pii_access_anomaly", id: anomaly_id } }));
  const esc = ctx.escalations?.open({ kind: "sev1", ownerRole: "officer", ...(i.application_id ? { applicationId: i.application_id } : {}), severity: "sev1", payload: { anomaly_id, kinds: anomaly, principal: i.principal, table: i.table, siem_alert_due_at: siem } }, ctx.actor) ?? null;
  return { log, denied, anomaly, siem_alert_due_at: siem, anomaly_id, events, escalation: esc ? { id: esc.id, kind: "sev1" } : null, auto_revoke: i.principal };
}
/** The disposition that closes the one-hour row: benign, or an incident opened (`security.incident.opened{domain=origination}` in 19.2's tables); at breach the principal is auto-revoked. */
export function dispositionPiiAnomaly(i: { anomaly_id: string; disposition: "benign" | "incident_opened"; rationale: string; incident_id?: string | null; application_id?: string | null }, ctx: OrigContext): { events: readonly DomainEvent[] } {
  const events: DomainEvent[] = [];
  if (i.disposition === "incident_opened") events.push(emit(ctx, "security.incident.opened", i.application_id ?? null, { domain: "origination", incident_id: i.incident_id ?? `INC-${i.anomaly_id}`, category: "insider", basis: "pii.access.anomaly", anomaly_id: i.anomaly_id, severity: "S1" }, { aggregate: { kind: "security_incident", id: i.incident_id ?? `INC-${i.anomaly_id}` } }));
  events.push(emit(ctx, "pii.access.anomaly.dispositioned", i.application_id ?? null, { anomaly_id: i.anomaly_id, disposition: i.disposition, rationale: i.rationale, incident_id: i.incident_id ?? (i.disposition === "incident_opened" ? `INC-${i.anomaly_id}` : null) }, { aggregate: { kind: "pii_access_anomaly", id: i.anomaly_id } }));
  return { events };
}
/** Quarterly certification of every principal with `applicant_demographics` / `credit_reports.raw` access: `access_review.completed{scope=orig_pii}`; uncertified access is revoked. */
export function completePiiAccessReview(i: { period: string; principals: readonly { principal: string; certified: boolean; certified_by: string }[]; reviewer: string }, ctx: OrigContext): { event: DomainEvent; revoked: readonly string[]; certified: readonly string[] } {
  const revoked = i.principals.filter((p) => !p.certified).map((p) => p.principal);
  const certified = i.principals.filter((p) => p.certified).map((p) => p.principal);
  const event = ctx.events.append({ type: "access_review.completed", aggregate: { kind: "access_review", id: `orig_pii-${i.period}` }, actor: ctx.actor, payload: { source: "origination", scope: "orig_pii", period: i.period, reviewer: i.reviewer, certified, revoked, tables: ["applicant_demographics", "credit_reports.raw"], report: "RPT_PII_ACCESS_REVIEW_QUARTERLY" } });
  return { event, revoked, certified };
}
/** CI check: a build referencing `applicant_demographics` outside the roster packages fails. */
export function ciRestrictedTableCheck(build: { package: string; references: readonly string[] }): { passed: boolean; violations: readonly string[] } {
  const allowed = ["21.1", "28.3", "30.2", "31.2", "security-records", "31.3"];
  const hits = build.references.filter((r) => r.startsWith("applicant_demographics") || r.startsWith("restricted_fl.applicant_demographics"));
  const ok = allowed.some((a) => build.package.startsWith(a) || build.package.includes(a));
  return { passed: hits.length === 0 || ok, violations: ok ? [] : hits.map((h) => `${build.package} references ${h} outside the 21.1/28.3/30.2/31.2/security-records packages (31.3 rule 8)`) };
}

// ============================================================ data-use limits (rule 7; SM_O123_FANNIE_DATA_USE_SCAN_WEEKLY)
/** `data_class` by source: credit-report data (FCRA §604(f) — transaction use only) and Fannie Mae Data (Technology Guide — internal mortgage-related purposes only). */
export const DATA_CLASS_BY_SOURCE: readonly { readonly prefix: string; readonly data_class: "fcra_consumer_report" | "fnma_data"; readonly citation: string }[] = [
  { prefix: "credit_reports.", data_class: "fcra_consumer_report", citation: "15 U.S.C. 1681b(f); §1681b(a)(3)(A)" }, { prefix: "verifications.raw", data_class: "fcra_consumer_report", citation: "15 U.S.C. 1681b(f)" },
  { prefix: "undisclosed_debt", data_class: "fcra_consumer_report", citation: "15 U.S.C. 1681b(f) (22.2 feed)" },
  { prefix: "du_submissions.findings", data_class: "fnma_data", citation: "Consolidated Technology Guide (Apr 21, 2026): Fannie Mae Data" }, { prefix: "du_findings", data_class: "fnma_data", citation: "Consolidated Technology Guide" },
  { prefix: "appraisals.ucdp", data_class: "fnma_data", citation: "Consolidated Technology Guide (UCDP/CU outputs)" }, { prefix: "appraisals.cu", data_class: "fnma_data", citation: "Consolidated Technology Guide (CU scores)" },
  { prefix: "earlycheck_runs", data_class: "fnma_data", citation: "Consolidated Technology Guide" }, { prefix: "purchase_advices", data_class: "fnma_data", citation: "Consolidated Technology Guide" },
];
export type RestrictedPipeline = "analytics" | "marketing" | "model_training";
export const RESTRICTED_PIPELINES: readonly RestrictedPipeline[] = ["analytics", "marketing", "model_training"];
export interface DataUseViolation { readonly reference: string; readonly data_class: "fcra_consumer_report" | "fnma_data"; readonly citation: string; }
export const dataClassOf = (reference: string): DataUseViolation | null => { const m = DATA_CLASS_BY_SOURCE.find((s) => reference.startsWith(s.prefix)); return m ? { reference, data_class: m.data_class, citation: m.citation } : null; };
/** The CI check: an analytics/marketing/model-training dataset build that references credit data or Fannie Mae Data fails. */
export function ciDataUseCheck(build: { dataset: string; pipeline: string; references: readonly string[] }): { passed: boolean; violations: readonly DataUseViolation[] } {
  if (!(RESTRICTED_PIPELINES as readonly string[]).includes(build.pipeline)) return { passed: true, violations: [] };
  const violations = build.references.map(dataClassOf).filter((v): v is DataUseViolation => v !== null);
  return { passed: violations.length === 0, violations };
}
/** `scan.fannieDataUse` (weekly): every dataset of the restricted pipelines; any hit → `fannie_data.use.violation_detected` and a sev-1 incident (Technology Guide / FCRA) in 19.2's tables. */
export function scanFannieDataUse(i: { datasets: readonly { dataset: string; pipeline: string; references: readonly string[] }[]; scan_id: string }, ctx: OrigContext): { hits: readonly { dataset: string; pipeline: string; violations: readonly DataUseViolation[] }[]; events: readonly DomainEvent[]; incident_id: string | null; escalation: { id: string; kind: "sev1" } | null } {
  const hits = i.datasets.map((d) => ({ dataset: d.dataset, pipeline: d.pipeline, violations: ciDataUseCheck(d).violations })).filter((h) => h.violations.length > 0);
  const events: DomainEvent[] = [];
  let incident_id: string | null = null; let esc: { id: string } | null = null;
  if (hits.length) {
    incident_id = `INC-${i.scan_id}`;
    events.push(emit(ctx, "fannie_data.use.violation_detected", null, { scan_id: i.scan_id, hits, incident_id, severity: "S1", citation: "Consolidated Technology Guide (Apr 21, 2026); 15 U.S.C. 1681b(f)" }, { aggregate: { kind: "security_incident", id: incident_id } }));
    events.push(emit(ctx, "security.incident.opened", null, { domain: "origination", incident_id, category: "misdirected_disclosure", severity: "S1", basis: "fannie_data.use.violation_detected", datasets: hits.map((h) => h.dataset) }, { aggregate: { kind: "security_incident", id: incident_id } }));
    esc = ctx.escalations?.open({ kind: "sev1", ownerRole: "officer", severity: "sev1", payload: { incident_id, scan_id: i.scan_id, hits: hits.map((h) => h.dataset), citation: "Technology Guide / FCRA §604(f)" } }, ctx.actor) ?? null;
  }
  events.push(ctx.events.append({ type: "fannie_data_use.scan.completed", aggregate: { kind: "data_use_scan", id: i.scan_id }, actor: ctx.actor, payload: { source: "origination", scan_id: i.scan_id, datasets_scanned: i.datasets.length, hits: hits.length, incident_id, report: "RPT_FANNIE_DATA_USE_SCAN" } }));
  return { hits, events, incident_id, escalation: esc ? { id: esc.id, kind: "sev1" } : null };
}

// ============================================================ incident alignment (rule 10; 19.2's tables and timers reused)
export interface OrigIncidentInput {
  readonly incident_id: string; readonly identified_at: string; readonly category: TriageInput["category"]; readonly confirmed_exposure: boolean; readonly fnma_application_data: boolean;
  readonly consumers: readonly { id: string; application_id: string; mailing_state: string; encrypted: boolean }[]; readonly vendor_id?: string | null; readonly determined_at?: string | null; readonly matrix?: Readonly<Record<string, StateRule>>;
  readonly assets?: readonly string[];
}
export interface OrigIncidentScope {
  readonly severity: "S1" | "S2" | "S3" | "S4"; readonly identified_at: string; readonly consumer_count: number; readonly residents_by_state: Readonly<Record<string, number>>; readonly ny_residents: number;
  readonly due: { readonly fnma_supplement_at: string | null; readonly form101_at: string | null; readonly partner_at: string | null; readonly nydfs_determination_at: string | null; readonly ftc_on: PlainDate | null; readonly ftc_internal_target_on: PlainDate | null; readonly nydfs_notice_at: string | null; readonly ny_consumer_on: PlainDate | null; readonly holds_by: string };
  readonly state_clocks: readonly { state: string; residents: number; consumer_due: PlainDate; ag_due: PlainDate | null }[]; readonly refused_states: readonly string[];
  readonly holds: { readonly hold_id: string; readonly application_ids: readonly string[]; readonly placed_at: string; readonly within_hour: boolean }; readonly escalations: readonly { id: string; kind: string; owner_role: string; within_minutes: number | null; reason: string }[];
  readonly vendor_incident: { vendor_id: string; security_incident_id: string; reported_at: string; reassessment: "19.3" } | null; readonly events: readonly DomainEvent[]; readonly objects: OrigRecordObject[];
}
/**
 * Origination scoping over 19.2's runbook: `identified_at` is the SOC's confirmation (never postponed), so `triageIncident`
 * arms the Supplement/Form 101 36-hour and partner 24-hour clocks; consumers are distinct individuals whose unencrypted
 * information was acquired, counted by applicant mailing state (applicants who never became customers count — 16 CFR
 * 314.1(b)); FTC ≥ 500 → 30 days from discovery; NYDFS 72 hours from `determined_at`; every affected application is held
 * within one hour; states without a `jurisdiction_rules.breach_notice` row are refused → `attorney` within 1 hour (T9).
 */
export function scopeOriginationIncident(objects: readonly OrigRecordObject[], i: OrigIncidentInput, ctx: OrigContext): OrigIncidentScope {
  const identifiedMs = Date.parse(i.identified_at);
  if (Number.isNaN(identifiedMs)) throw new RangeError("identified_at must be an ISO instant");
  const triage = triageIncident({ category: i.category, confirmed_exposure: i.confirmed_exposure, ransomware_deployed: false, material_ops_harm: false, reasonable_conclusion: true, data_impact: true, contained_event: true, confirmed_ms: identifiedMs, fnma_application_data: i.fnma_application_data, incident_id: i.incident_id });
  const events: DomainEvent[] = [];
  if (triage.event) events.push(ctx.events.append({ type: triage.event.type, aggregate: triage.event.aggregate, actor: ctx.actor, occurredAt: triage.event.occurredAt, payload: { ...triage.event.payload, source: "origination", domain: "origination" } }));
  const persons: AffectedPerson[] = i.consumers.map((c) => ({ id: c.id, state: c.mailing_state, encrypted: c.encrypted, key_compromised_or_presumed: false }));
  const discoveredOn = civilDate(i.identified_at);
  const scope = scopeIncident({ discovered_on: discoveredOn, persons, ...(i.matrix ? { matrix: i.matrix } : {}), scoped_ms: identifiedMs, incident_id: i.incident_id });
  events.push(ctx.events.append({ type: scope.event.type, aggregate: scope.event.aggregate, actor: ctx.actor, occurredAt: scope.event.occurredAt, payload: { ...scope.event.payload, source: "origination", domain: "origination", assets: i.assets ?? [], scoping: "applications by application_borrowers.mailing_state; vendor manifests; RON sessions; eVault objects" } }));
  const due = (code: string): string | null => { const t = triage.timers.find((x) => x.code === code); return t ? toIso(t.due_ms) : null; };
  const nydfs = i.determined_at ? toIso(nydfsClocks(identifiedMs, Date.parse(i.determined_at)).notice_due_ms!) : null;
  if (i.determined_at) events.push(ctx.events.append({ type: "security.incident.determined", aggregate: { kind: "security_incident", id: i.incident_id }, actor: ctx.actor, occurredAt: i.determined_at, payload: { source: "origination", incident_id: i.incident_id, determined_at: i.determined_at, cybersecurity_incident: true, prong_1_basis: scope.ftc.required ? "FTC notice required" : "state regulator notice required", ny_residents: scope.residents_by_state.NY ?? 0 } }));
  // holds on every affected application within one hour of identification
  const appIds = [...new Set(i.consumers.map((c) => c.application_id))];
  const trig = detectHoldTrigger({ reason: "security_incident", application_ids: appIds, matter_ref: i.incident_id, incident_id: i.incident_id, detected_at: i.identified_at }, ctx);
  const held = placeOriginationHold(objects, { id: `LH-${i.incident_id}`, reason: "security_incident", application_ids: appIds, matter_ref: i.incident_id, incident_id: i.incident_id }, ctx);
  events.push(trig.event, held.event);
  const escalations: { id: string; kind: string; owner_role: string; within_minutes: number | null; reason: string }[] = [];
  for (const e of [...triage.escalations, ...scope.escalations]) {
    const kind = e.kind; const owner = e.owner_role ?? (kind === "attorney" ? "attorney" : "officer");
    const opened = ctx.escalations?.open({ kind, ownerRole: owner, severity: kind.startsWith("sev") ? kind : "sev1", payload: { incident_id: i.incident_id, reason: e.reason, ...(e.within_minutes !== undefined ? { within_minutes: e.within_minutes, due_by: toIso(identifiedMs + e.within_minutes * MIN) } : {}) } }, ctx.actor);
    escalations.push({ id: opened?.id ?? `esc-${escalations.length}`, kind, owner_role: owner, within_minutes: e.within_minutes ?? null, reason: e.reason });
  }
  return {
    severity: triage.severity, identified_at: i.identified_at, consumer_count: scope.consumer_count, residents_by_state: scope.residents_by_state, ny_residents: scope.residents_by_state.NY ?? 0,
    due: { fnma_supplement_at: due("FNMA_SUPP_INCIDENT_NOTICE_36H"), form101_at: due("FNMA_FORM101_DATA_INCIDENT_NOTICE_36H"), partner_at: due("SM_PARTNER_INCIDENT_NOTICE_24H"), nydfs_determination_at: due("SM_NYDFS_DETERMINATION_48H"), ftc_on: scope.ftc.due, ftc_internal_target_on: scope.ftc.internal_target, nydfs_notice_at: nydfs, ny_consumer_on: scope.states.find((s) => s.state === "NY")?.consumer_due ?? null, holds_by: trig.due_by },
    state_clocks: scope.states.map((s) => ({ state: s.state, residents: s.residents, consumer_due: s.consumer_due, ag_due: s.ag_due })), refused_states: scope.refused_states,
    holds: { hold_id: held.hold.id, application_ids: appIds, placed_at: held.hold.placed_at, within_hour: Date.parse(held.hold.placed_at) <= identifiedMs + H },
    escalations, vendor_incident: i.vendor_id ? { vendor_id: i.vendor_id, security_incident_id: i.incident_id, reported_at: i.identified_at, reassessment: "19.3" } : null, events, objects: held.objects,
  };
}
/** T9: a consumer-notice clock for a state without a `breach_notice` matrix row is refused; `attorney` within 1 hour (19.2 fail-closed). */
export function stateConsumerNoticeClock(i: { state: string; discovered_on: PlainDate; residents: number; matrix?: Readonly<Record<string, StateRule>>; scoped_at: string }, ctx: OrigContext): { refused: boolean; consumer_due: PlainDate | null; escalation: { id: string; kind: "attorney"; due_by: string } | null } {
  const r = stateBreachClocksSafe(i.state, i.discovered_on, i.residents, i.matrix ?? STATE_BREACH_MATRIX);
  if ("refused" in r) {
    const due_by = toIso(Date.parse(i.scoped_at) + r.within_minutes * MIN);
    const esc = ctx.escalations?.open({ kind: "attorney", ownerRole: "attorney", payload: { state: i.state, reason: `no jurisdiction_rules.breach_notice row for ${i.state}: clock computation refused (31.3 open question 5)`, within_minutes: r.within_minutes, due_by } }, ctx.actor);
    return { refused: true, consumer_due: null, escalation: { id: esc?.id ?? "esc-attorney", kind: "attorney", due_by } };
  }
  return { refused: false, consumer_due: r.consumer_due, escalation: null };
}
function stateBreachClocksSafe(state: string, discoveredOn: PlainDate, residents: number, matrix: Readonly<Record<string, StateRule>>): { consumer_due: PlainDate; ag_due: PlainDate | null } | { refused: true; escalate: "attorney"; within_minutes: 60 } {
  const r = matrix[state];
  if (!r) return { refused: true, escalate: "attorney", within_minutes: 60 };
  return { consumer_due: addDays(discoveredOn, r.consumer_days), ag_due: r.ag_days !== null && residents >= r.ag_threshold ? addDays(discoveredOn, r.ag_days) : null };
}

// ============================================================ RON / eVault access tests (integrations)
export function ronAccessTest(i: { vendor_id: string; session_id: string; state: string; application_id: string; retrieved: boolean; journal_entry_hash?: string | null; period: string }, ctx: OrigContext): { passed: boolean; events: readonly DomainEvent[]; reassessment: { process: "19.3"; vendor_id: string; timer_code: "FNMA_SUPP_VENDOR_REASSESSMENT" } | null; escalation: { id: string; kind: "sev2"; owner_role: "officer" } | null } {
  const events: DomainEvent[] = [emit(ctx, "ron.access_test.completed", i.application_id, { vendor_id: i.vendor_id, session_id: i.session_id, state: i.state, period: i.period, passed: i.retrieved, journal_entry_hash: i.journal_entry_hash ?? null, retention: ronRecordingAccess({ state: i.state, notarial_act_on: civilDate(ctx.now) }).timer_code })];
  if (i.retrieved) return { passed: true, events, reassessment: null, escalation: null };
  events.push(emit(ctx, "vendor.access_test.failed", i.application_id, { vendor_id: i.vendor_id, session_id: i.session_id, state: i.state, reassessment_process: "19.3", timer_code: "FNMA_SUPP_VENDOR_REASSESSMENT" }));
  const esc = ctx.escalations?.open({ kind: "sev2", ownerRole: "officer", applicationId: i.application_id, severity: "sev2", payload: { vendor_id: i.vendor_id, session_id: i.session_id, reason: "RON provider failed the quarterly access test: 19.3 reassessment" } }, ctx.actor) ?? null;
  return { passed: false, events, reassessment: { process: "19.3", vendor_id: i.vendor_id, timer_code: "FNMA_SUPP_VENDOR_REASSESSMENT" }, escalation: esc ? { id: esc.id, kind: "sev2", owner_role: "officer" } : null };
}

// ============================================================ ownership and productions (rule 6; A2-4.1-01)
export interface ChecklistItem { readonly item: string; readonly record_types: readonly string[]; readonly required: (f: { funded: boolean; mi_required: boolean; flood_required: boolean; enote: boolean; purchased: boolean }) => boolean; }
/** A2-4.1-01 (09/04/2024): what the individual loan file must contain. */
export const A2_4_1_01_CHECKLIST: readonly ChecklistItem[] = [
  { item: "application (URLA 1003) and supplemental consumer information (1103)", record_types: ["urla_1003", "scif_1103"], required: () => true },
  { item: "all documents, records and reports used to support the underwriting decision (credit report, verifications)", record_types: ["credit_report", "verification_report"], required: () => true },
  { item: "underwriting documents, including any DU reports", record_types: ["du_findings"], required: () => true },
  { item: "property appraisal and inspection orders and reports", record_types: ["appraisal_uad", "property_data_collection"], required: () => true },
  { item: "title policy or an attorney title opinion letter", record_types: ["title_policy"], required: (f) => f.funded },
  { item: "property insurance policy", record_types: ["insurance_evidence"], required: (f) => f.funded },
  { item: "flood insurance policy (if required)", record_types: ["flood_notice", "sfhdf"], required: (f) => f.funded && f.flood_required },
  { item: "the note and any related addenda", record_types: ["note_image", "enote_smartdoc"], required: (f) => f.funded },
  { item: "the recorded mortgage or deed of trust, any applicable recorded rider or recorded modification", record_types: ["security_instrument", "rider"], required: (f) => f.funded },
  { item: "mortgage insurance certificate, if applicable", record_types: ["mi_certificate"], required: (f) => f.funded && f.mi_required },
  { item: "third-party asset verification report, in human-readable format", record_types: ["verification_report", "bank_statement"], required: () => true },
  { item: "final settlement statement evidencing all settlement costs paid by the borrower and seller (if applicable)", record_types: ["closing_package"], required: (f) => f.funded },
  { item: "the final version of the Closing Disclosure", record_types: ["closing_disclosure"], required: (f) => f.funded },
  { item: "all required intervening assignments", record_types: ["assignment"], required: (f) => f.funded && f.purchased },
  { item: "eNote signing records (signer, date, method, attribution evidence — B8-8-02)", record_types: ["enote_signing_record"], required: (f) => f.funded && f.enote },
];
export interface OriginationFile { readonly application_id: string; readonly items: readonly { item: string; required: boolean; present: boolean; object_ids: readonly string[] }[]; readonly complete: boolean; readonly missing: readonly string[]; readonly object_count: number; readonly manifest_sha256: string; readonly fnma_loan_number: string | null; }
/** `records.compileOriginationFile(application_id)`: the A2-4.1-01 completeness checklist over the file's objects and the hashed manifest (id + sha256 per object). Never redacted for Fannie Mae/partner; ids and hashes only. */
export function compileOriginationFile(i: { application_id: string; objects: readonly OrigRecordObject[]; funded: boolean; mi_required?: boolean; flood_required?: boolean; enote?: boolean; purchased?: boolean; fnma_loan_number?: string | null }): OriginationFile {
  const objs = i.objects.filter((o) => o.application_id === i.application_id && o.status !== "disposed");
  const f = { funded: i.funded, mi_required: i.mi_required ?? false, flood_required: i.flood_required ?? false, enote: i.enote ?? false, purchased: i.purchased ?? false };
  const items = A2_4_1_01_CHECKLIST.map((c) => { const ids = objs.filter((o) => c.record_types.includes(o.record_type)).map((o) => o.id); const required = c.required(f); return { item: c.item, required, present: ids.length > 0, object_ids: ids }; });
  const missing = items.filter((x) => x.required && !x.present).map((x) => x.item);
  return { application_id: i.application_id, items, complete: missing.length === 0, missing, object_count: objs.length, manifest_sha256: sha(objs.map((o) => [o.id, o.record_type, o.sha256]).sort()), fnma_loan_number: i.fnma_loan_number ?? null };
}
export interface FnmaFileRequest { readonly request_id: string; readonly requester_type: "fannie_mae"; readonly received_on: PlainDate; readonly due_on: PlainDate; readonly stated_business_days: number | null; readonly calendar: "business_days_fannie_et"; readonly file: OriginationFile; readonly task: { id: string; kind: "human_portal_task"; owner_role: "fnma_portal_operator"; portal: "fannie_mae_file_transfer_portal" }; readonly hold_reason: "fannie_mae_request"; readonly events: readonly DomainEvent[]; readonly timer_code: "FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED"; }
/** Rule 6: a Fannie Mae written request → 19.1's `records_requests` flow (`FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED`, the stated time frame or 10 `business_days_fannie_et`), the file compiled from the A2-4.1-01 list, uploaded by a `fnma_portal_operator` (portal-only). */
export function fnmaOriginationFileRequest(i: { request_id: string; application_id: string; received_on: PlainDate; stated_business_days?: number | null; objects: readonly OrigRecordObject[]; funded: boolean; mi_required?: boolean; flood_required?: boolean; enote?: boolean; purchased?: boolean; fnma_loan_number?: string | null }, ctx: OrigContext): FnmaFileRequest {
  const stated = i.stated_business_days ?? null;
  const due_on = productionDue("fannie_mae", i.received_on, stated);
  const file = compileOriginationFile(i);
  const events: DomainEvent[] = [emit(ctx, "records.request.received", i.application_id, { request_id: i.request_id, requester_type: "fannie_mae", received_on: i.received_on, received_at: toIso(zonedEpochMs(i.received_on, "09:00", ET)), due_on, delivery_due_stated: due_on, stated_business_days: stated, format: "full_loan_file", scope: { application_ids: [i.application_id], checklist: "A2-4.1-01" }, hold_reason: "fannie_mae_request" }, { occurredAt: toIso(zonedEpochMs(i.received_on, "09:00", ET)), aggregate: { kind: "records_request", id: i.request_id } })];
  events.push(emit(ctx, "origination_file.compiled", i.application_id, { request_id: i.request_id, complete: file.complete, missing: file.missing, object_count: file.object_count, manifest_sha256: file.manifest_sha256 }));
  const task = ctx.escalations?.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: i.application_id, payload: { request_id: i.request_id, portal: "fannie_mae_file_transfer_portal", due_on, manifest_sha256: file.manifest_sha256, checklist_complete: file.complete, missing: file.missing } }, ctx.actor);
  return { request_id: i.request_id, requester_type: "fannie_mae", received_on: i.received_on, due_on, stated_business_days: stated, calendar: "business_days_fannie_et", file, task: { id: task?.id ?? `task-${i.request_id}`, kind: "human_portal_task", owner_role: "fnma_portal_operator", portal: "fannie_mae_file_transfer_portal" }, hold_reason: "fannie_mae_request", events, timer_code: "FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED" };
}

// ============================================================ privacy requests (edge case: CCPA and the GLBA exemption)
export interface PrivacyRequestResult { readonly request_id: string; readonly kind: "ccpa_deletion" | "ccpa_access" | "co_correction"; readonly disposition: "glba_exempt" | "routed_21_6" | "answered"; readonly citation: string; readonly deletion_allowed: false; readonly earliest_disposal: PlainDate | null; readonly response_basis: string; readonly event: DomainEvent; }
/** GLBA-covered data is exempt from CCPA deletion (Cal. Civ. Code §1798.145(e)); the response cites the basis; nothing is deleted before the file's own retention date; Colorado corrections go to 21.6. */
export function privacyRequest(i: { request_id: string; application_id: string; kind: PrivacyRequestResult["kind"]; state: string; received_on: PlainDate; file_facts: OrigObjectFacts }, ctx: OrigContext): PrivacyRequestResult {
  const clocks = fileClocks(i.file_facts, i.received_on);
  const disposition: PrivacyRequestResult["disposition"] = i.kind === "co_correction" ? "routed_21_6" : i.kind === "ccpa_deletion" ? "glba_exempt" : "answered";
  const citation = i.kind === "co_correction" ? "C.R.S. 6-1-1703 (21.6 data-correction path)" : "Cal. Civ. Code §1798.145(e): personal information collected pursuant to the GLBA is exempt; 12 CFR 1002.12(b)(1) retention";
  const basis = i.kind === "ccpa_deletion" ? `deletion declined under the GLBA exemption; the file's own Reg B/policy retention runs to ${clocks.eligible_for_disposal_at ?? "(anchor pending)"}; disposal only through the attested run` : i.kind === "co_correction" ? "correction request routed to 21.6 (not deletion)" : "access answered under Reg B §1002.14 / TRID copies (24.2 / 25.2) and state law";
  const event = emit(ctx, "privacy.request.received", i.application_id, { request_id: i.request_id, kind: i.kind, state: i.state, received_on: i.received_on, disposition, citation, earliest_disposal: clocks.eligible_for_disposal_at, logged: true }, { occurredAt: toIso(zonedEpochMs(i.received_on, "10:00", ET)) });
  return { request_id: i.request_id, kind: i.kind, disposition, citation, deletion_allowed: false, earliest_disposal: clocks.eligible_for_disposal_at, response_basis: basis, event };
}

// ============================================================ human path (AI off) — the same gates through the 19.1/19.2 workspaces
export interface OperatorPath { readonly ai_first: boolean; readonly executor: "security-records" | "human_operator"; readonly workspaces: readonly ["19.1", "19.2"]; readonly gates: readonly string[]; readonly guardrails_identical: true; }
export function operatorPath(aiFirst: boolean): OperatorPath {
  return { ai_first: aiFirst, executor: aiFirst ? "security-records" : "human_operator", workspaces: ["19.1", "19.2"], gates: [...Object.keys(TIMER_CLASS), "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE", "SM_O123_VENDOR_FLOWDOWN_GATE"], guardrails_identical: true };
}
/** The 31.3 guardrails as commands see them, whoever the actor is (agent or ops-console human). */
export type OrigCommand = { readonly op: "delete" } | { readonly op: "release_hold"; readonly approvals: readonly string[] } | { readonly op: "open_vendor_gate"; readonly inferred: boolean } | { readonly op: "send_notice"; readonly recipient: string } | { readonly op: "prompt"; readonly includes_demographics_content: boolean } | { readonly op: "dataset_build"; readonly pipeline: string; readonly references: readonly string[] };
export function originationGuards(c: OrigCommand, actor: Actor): { allowed: boolean; code: string | null; citation: string } {
  const g = "31.3 guardrails";
  switch (c.op) {
    case "delete": return { allowed: false, code: "NO_DELETE", citation: `${g}: never deletes (disposal only through the attested run)` };
    case "release_hold": return actor.kind === "human" && holdReleaseAllowed(c.approvals as ("officer" | "attorney")[]) ? { allowed: true, code: null, citation: "19.1 POL-REC-02: officer + attorney" } : { allowed: false, code: "NO_HOLD_RELEASE", citation: `${g}: never releases a hold (officer + attorney)` };
    case "open_vendor_gate": return c.inferred ? { allowed: false, code: "NO_GATE_ON_INFERENCE", citation: `${g}: never opens a vendor gate on inference` } : { allowed: true, code: null, citation: "executed contract_clauses" };
    case "send_notice": return /fannie|fnma|regulator|ftc|nydfs|state_ag|dfs/i.test(c.recipient) && actor.kind !== "human" ? { allowed: false, code: "DRAFTS_ONLY", citation: `${g}: never sends a regulatory or Fannie Mae notice (drafts only; officer sends)` } : { allowed: true, code: null, citation: "officer send" };
    case "prompt": return c.includes_demographics_content ? { allowed: false, code: "NO_DEMOGRAPHICS_IN_PROMPT", citation: `${g}: never reads applicant_demographics content into a prompt` } : { allowed: true, code: null, citation: "ids and hashes only" };
    case "dataset_build": { const r = ciDataUseCheck({ dataset: "cmd", pipeline: c.pipeline, references: c.references }); return r.passed ? { allowed: true, code: null, citation: "no credit or Fannie Mae data" } : { allowed: false, code: "NO_REPURPOSE_CREDIT_OR_FNMA_DATA", citation: `${g}: never re-purposes credit or Fannie Mae data (${r.violations.map((v) => v.reference).join(", ")})` }; }
  }
}
export { plainDate };
