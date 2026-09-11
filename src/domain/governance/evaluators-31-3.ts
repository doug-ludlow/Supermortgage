/**
 * §31.3 gate evaluators, keyed "31.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-31-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 * Every 31.3 not-before gate is condition-shaped ("gate opens; disposal blocked" / "gate open; order refused"): the
 * disposal command or the vendor adapter asserts it over the facts and the timer row never carries a due instant, so a
 * lawfully opened gate is never a breach. Facts are PlainDate strings (`today`, the anchors), `funded`, `loan_active`
 * and `hold_count` — a missing `hold_count` or `loan_active` fact closes a Fannie Mae gate ("permanent while active"
 * and "never while held" are not defaults the caller may omit). The vendor gates read the executed `contract_clauses`
 * map and the §1016.4 privacy-notice fact; nothing is inferred.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator, type Facts } from "../../app/evaluator-kit.ts";
import { timerGate, glbaServiceProviderGate, vendorFlowdownGate, type OrigFacts, type ClauseStatus } from "./ops-31-3.ts";
import type { GateOutcome } from "../data-security/ops-19-1.ts";

const d = (f: Facts, k: string): PlainDate | null => (typeof f[k] === "string" && (f[k] as string).length > 0 ? (f[k] as PlainDate) : null);
const today = (f: Facts): PlainDate => d(f, "today") ?? (String(f.now ?? new Date().toISOString()).slice(0, 10) as PlainDate);
const hold = (f: Facts): number | null => (typeof f.hold_count === "number" && Number.isFinite(f.hold_count) ? f.hold_count : typeof f.hold_count === "string" && /^\d+$/.test(f.hold_count) ? Number(f.hold_count) : null);
const tri = (f: Facts, k: string): boolean | null => (typeof f[k] === "boolean" ? (f[k] as boolean) : null);
const out = (g: GateOutcome) => (g.open ? ok : no(g.reason ?? "closed"));
/** The typed facts bag the origination gates read, from the untyped one the timer engine / command carries. */
export function origGateFacts(f: Facts): OrigFacts {
  return {
    today: today(f), hold_count: hold(f), funded: b(f, "funded") || b(f, "fnma_property"), loan_active: tri(f, "loan_active"), state: s(f, "state") || null, jurisdiction_years: Number.isFinite(n(f, "jurisdiction_years")) ? n(f, "jurisdiction_years") : null,
    consummation_date: d(f, "consummation_date") ?? d(f, "consummation_on"), disclosure_required_at: d(f, "disclosure_required_at"), action_required_at: d(f, "action_required_at"), lo_comp_paid_on: d(f, "lo_comp_paid_on") ?? d(f, "paid_on"),
    regb_action_notified_at: d(f, "regb_action_notified_at") ?? d(f, "notified_on"), enforcement_notice_received_on: d(f, "enforcement_notice_received_on"), investigation_closed_on: d(f, "investigation_closed_on"),
    self_test_completed_on: d(f, "self_test_completed_on"), prescreen_on: d(f, "prescreen_on"), lar_signed_on: d(f, "lar_signed_on") ?? d(f, "signed_at"), afba_executed_on: d(f, "afba_executed_on") ?? d(f, "executed_on"), document_date: d(f, "document_date"),
    sar_filed_on: d(f, "sar_filed_on") ?? d(f, "filed_on"), ofac_transaction_on: d(f, "ofac_transaction_on") ?? d(f, "transaction_date"), ofac_blocked: b(f, "ofac_blocked"), ofac_unblocked_on: d(f, "ofac_unblocked_on"),
    notarial_act_on: d(f, "notarial_act_on"), liquidated_on: d(f, "liquidated_on"), transferred_out_on: d(f, "transferred_out_on"),
    revoked_on: d(f, "revoked_on"), last_reliance_on: d(f, "last_reliance_on"), relationship_ended_on: d(f, "relationship_ended_on"), co_decided_on: d(f, "co_decided_on"), esign_consent_on: d(f, "esign_consent_on"),
  };
}
const gate = (timerCode: string): Evaluator => (f: Facts) => out(timerGate(timerCode, origGateFacts(f)));
const clauses = (f: Facts): Readonly<Record<string, ClauseStatus>> => (f.clauses && typeof f.clauses === "object" ? (f.clauses as Record<string, ClauseStatus>) : {});
const vendorFacts = (f: Facts) => ({ vendor_class: s(f, "vendor_class"), clauses: clauses(f), privacy_notice_delivered_or_scheduled: tri(f, "privacy_notice_delivered_or_scheduled"), attorney_signed_off_deviations: arr<string>(f, "attorney_signed_off_deviations"), state: s(f, "state") || null });

/**
 * One evaluator per gate row of the timer table — the twelve retention gates (Reg Z LE/CD/LO-comp/ATR, Reg B 25 months with
 * the (b)(4) extension, HMDA 3y, RESPA AfBA/Section 8 5y, OFAC 10y with the blocked-property anchor, BSA SAR 5y, eNote signing
 * records life + 7, E-SIGN consent life) and the two vendor gates (§1016.13 service-provider condition; class flow-down).
 * The predicates live in ops-31-3.ts (`origClassGate` / `glbaServiceProviderGate` / `vendorFlowdownGate`), shared with the disposal command and the vendor adapter.
 */
export const EVALUATORS_31_3: Record<string, Evaluator> = {
  "31.3.regZLeGateOpen": gate("REGZ_1026_25C1I_LE_RETENTION_3Y"),
  "31.3.regZCdGateOpen": gate("REGZ_1026_25C1II_CD_RETENTION_5Y"),
  "31.3.regZLoCompGateOpen": gate("REGZ_1026_25C2_LOCOMP_RETENTION_3Y"),
  "31.3.regZAtrGateOpen": gate("REGZ_1026_25C3_ATR_RETENTION_3Y"),
  "31.3.regBApplicationGateOpen": gate("REGB_1002_12B_APPLICATION_RETENTION_25M"),
  "31.3.hmdaLarGateOpen": gate("HMDA_1003_5_LAR_RETENTION_3Y"),
  "31.3.respaAfbaGateOpen": gate("RESPA_1024_15D_AFBA_RETENTION_5Y"),
  "31.3.respaS8GateOpen": gate("RESPA_1024_14H_S8_RETENTION_5Y"),
  "31.3.ofacGateOpen": gate("OFAC_501_601_RETENTION_10Y"),
  "31.3.sarGateOpen": gate("BSA_1029_320C_SAR_RETENTION_5Y"),
  "31.3.enoteSigningRecordsGateOpen": gate("FNMA_B8_8_02_ENOTE_SIGNING_RECORDS_LIFE_PLUS_7Y"),
  "31.3.esignConsentGateOpen": gate("ESIGN_7001_CONSENT_EVIDENCE_LIFE"),
  "31.3.glbaServiceProviderContractGateOpen": (f) => out(glbaServiceProviderGate(vendorFacts(f))),
  "31.3.vendorFlowdownGateOpen": (f) => { try { return out(vendorFlowdownGate(vendorFacts(f))); } catch (e) { return no((e as Error).message); } },
};
export const kit_31_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
