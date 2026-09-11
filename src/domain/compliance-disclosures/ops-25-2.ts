/**
 * §25.2 operating rules — the Closing Disclosure: preparation from versioned figure sources, delivery and per-consumer
 * receipt evidence, the three-specific-business-day waiting period (§1026.19(f)(1)(ii)(A)), the mailbox presumption
 * (§1026.19(f)(1)(iii); §1026.2(a)(6) second sentence — Saturdays count, Sundays and the eleven federal legal public
 * holidays on their statutory dates do not), the consumer's emergency waiver (§1026.19(f)(1)(iv)), the three
 * redisclosure triggers (§1026.19(f)(2)(ii)(A)–(C)), the three post-consummation regimes ((f)(2)(iii) 30-day event,
 * (f)(2)(iv) 60-day clerical, (f)(2)(v) 60-day tolerance refund — 21.5 owns the refund clock), the seller's CD from the
 * settlement agent ((f)(4)), the no-fee rule ((f)(5)), the CD-to-note consistency checks 26.1 consumes, and the UCD
 * (MISMO v3.3.0299, embedded CD PDF, casefile ID) 29.3/29.4 gate delivery on.
 *
 * Built on the finished engines, never re-implemented: 21.2's `regzSpecific` calendar, `civilDate` and the LE 7-SBD gate
 * (`LoanEstimateService.assertGateOpen`, asserted before a CD is issued); 25.1's `aprAccuracyTest` (APR_1026_22_ACCURACY —
 * the accuracy verdict behind trigger (A)) and its CD-checkpoint gate run (`compliance.testrun.started{checkpoint=cd}` →
 * `compliance.gate.opened/blocked`, `blocked_channels`); 30.3's CD escrow consistency gate, which runs on the
 * `disclosure.cd.prepared{version}` event this service appends with `applicationId`.
 *
 * Events (every one carries `applicationId` and `application_id`, so the 25.2 timers arm under origination context):
 *   disclosure.cd.prepared{version, cd_version, cd_reason, figures_hash, escrow}            [30.3 gates; 25.1 CD checkpoint]
 *   disclosure.cd.delivered{cd_version, consumer_id, channel, in_person, delivered_on, presumed_receipt_date, notice_code}
 *                                                                                           [arms REGZ_1026_19F1III_CD_MAILBOX_3SBD (channel ≠ in_person); satisfies SM_O62_CD_TARGET_4SBD]
 *   disclosure.cd.received{consumer_id, evidence, received_on, effective_receipt_date, all_required}
 *                                                                                           [satisfies the mailbox row; arms REGZ_1026_19F1_CD_3SBD_GATE when all_required=true]
 *   disclosure.cd.waiting_period.computed{earliest_consummation_date}
 *   disclosure.cd.waiver.accepted{waiver_id, accepted_by, earliest_consummation_date}
 *   disclosure.cd.consummated{version, consummation_at}                                    [satisfies the 3-SBD gate; arms FNMA_UCD_ACCEPTED_GATE]
 *   disclosure.cd.correction.required{regime, info_received_on, consummation_on, due_on}    [arms REGZ_1026_19F2_CORRECTED_CD_30 / REGZ_1026_19F2_CLERICAL_CD_60]
 *   disclosure.cd.corrected{reason, new_waiting_period, triggers, post_consummation, before_purchase, delivered_on}
 *                                                                                           [satisfies the 30/60-day rows and 21.5's REGZ_1026_19F2V_TOLERANCE_REFUND_60 (reason=tolerance_refund); arms SM_O62_UCD_RESUBMIT_ON_CORRECTION]
 *   disclosure.seller_cd.received{document_id, received_on}                                [satisfies REGZ_1026_19F4_SELLER_CD_GATE]
 *   cd.figure_source.received{party, version, hash} / cd.figure_source.reconciled{party, version}   [satisfies SM_O62_SETTLEMENT_FIGURES_5SBD (party=settlement_agent)]
 *   cd.consistency.checked{result, cd_version, mismatches}                                  [26.1 reads before generateClosingDocuments]
 *   ucd.generated / ucd.submitted / ucd.accepted{casefile_id_ucd, critical_edit_failures, is_final} / ucd.rejected
 *                                                                                           [ucd.accepted{is_final=true} closes FNMA_UCD_ACCEPTED_GATE and SM_O62_UCD_RESUBMIT_ON_CORRECTION]
 *   delivery.package.incomplete{reason}                                                     [seller CD missing at consummation — 29.3 reads]
 *   disclosure.cd.delivery.refused{code, reason}
 * Consumed: `closing.scheduled{scheduled_at, transaction_type}` (26.2), `closing.consummated` (26.2), `loan.delivered` /
 * `loan.purchased` (29.4 / 30.1), 25.1's gate events, 21.5's tolerance engine through `runToleranceTest`.
 */
import { createHash } from "node:crypto";
import { type PlainDate, plainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, regzSpecific, fannieEt, creditor } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore, Clock } from "../../kernel/events/index.ts";
import type { Cents } from "../../kernel/money/index.ts";
import { aprAccuracyTest, type AprAccuracy, type TransactionShape, type EscalationOpener } from "./ops-25-1.ts";
import { AGENT, civilDate } from "../application/ops-21-2.ts";

export { AGENT };
export const RULE_SET_25_2 = "regz.trid.2017";
export const H25_TEMPLATE_VERSION = "H-25 2017";
export const UCD_SCHEMA = "MISMO v3.3.0299";
export const RETENTION_CLASS = "regz_cd_5y";

const need = (cond: boolean, msg: string): void => { if (!cond) throw new RangeError(msg); };
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).digest("hex");
const S = (c: Cents): string => c.toString();
export class CdRefused extends Error { readonly code: string; readonly citation: string; constructor(code: string, citation: string, msg: string) { super(`${code}: ${msg}`); this.name = "CdRefused"; this.code = code; this.citation = citation; } }

// ============================================================ rule 1: business-day arithmetic (regz_specific calendar)
/** `addSpecificBusinessDays(d, n)`: step one calendar day at a time, counting a day iff it is not a Sunday and not a federal legal public holiday (§1026.2(a)(6) second sentence); Saturdays count; n < 0 counts backward. */
export const addSpecificBusinessDays = (d: PlainDate, n: number): PlainDate => addBusinessDays(d, n, regzSpecific);
/** §1026.19(f)(1)(iii): mail / e-mail without confirmation → received three specific business days after delivery or mailing. */
export const presumedReceiptDate = (deliveredOn: PlainDate): PlainDate => addSpecificBusinessDays(deliveredOn, 3);
/** §1026.19(f)(1)(ii)(A): consummation no earlier than the third specific business day after receipt (consummation may occur on that day). */
export const earliestConsummationDate = (effectiveReceiptDate: PlainDate): PlainDate => addSpecificBusinessDays(effectiveReceiptDate, 3);
/** Counting backward from a scheduled consummation: the CD must be received no later than this date. */
export const latestReceiptDateFor = (consummationOn: PlainDate): PlainDate => addSpecificBusinessDays(consummationOn, -3);
/** …and placed in the mail no later than this date for the presumption to land on the latest receipt date. */
export const latestMailingDateFor = (consummationOn: PlainDate): PlainDate => addSpecificBusinessDays(latestReceiptDateFor(consummationOn), -3);
/** SM_O62_CD_TARGET_4SBD: policy target for e-delivery — four specific business days before consummation. */
export const cdTargetDeliveryDate = (consummationOn: PlainDate): PlainDate => addSpecificBusinessDays(consummationOn, -4);
/** SM_O62_SETTLEMENT_FIGURES_5SBD: settlement-agent figures due five specific business days before consummation. */
export const settlementFiguresDueDate = (consummationOn: PlainDate): PlainDate => addSpecificBusinessDays(consummationOn, -5);
export interface DeliverySchedule { readonly scheduled_consummation_date: PlainDate; readonly latest_receipt_date: PlainDate; readonly latest_mailing_date: PlainDate; readonly target_edelivery_date: PlainDate; readonly settlement_figures_due: PlainDate; readonly recommended_channel: "esign_portal" | "mail"; readonly send_no_later_than: PlainDate; }
/** Worked example 4: closing Wed Nov 18, 2026 → receipt by Sat Nov 14; mail by Tue Nov 10; e-delivery target Fri Nov 13; figures by Thu Nov 12. */
export function scheduleDelivery(consummationOn: PlainDate, channel: CdDeliveryChannel = "esign_portal"): DeliverySchedule {
  const latest_receipt_date = latestReceiptDateFor(consummationOn), latest_mailing_date = latestMailingDateFor(consummationOn), target_edelivery_date = cdTargetDeliveryDate(consummationOn);
  return { scheduled_consummation_date: consummationOn, latest_receipt_date, latest_mailing_date, target_edelivery_date, settlement_figures_due: settlementFiguresDueDate(consummationOn), recommended_channel: channel === "mail" ? "mail" : "esign_portal", send_no_later_than: channel === "mail" ? latest_mailing_date : target_edelivery_date };
}
/** §1026.19(f)(2)(iii): the event window is the 30 calendar days after consummation (day 1 = the day after). */
export const postConsummationEventWindow = (consummationOn: PlainDate): { from: PlainDate; to: PlainDate } => ({ from: addDays(consummationOn, 1), to: addDays(consummationOn, 30) });
/** REGZ_1026_19F2_CORRECTED_CD_30: corrected CD delivered or placed in the mail within 30 calendar days after receiving information sufficient to establish the event. */
export const correctedCdDueDate = (infoReceivedOn: PlainDate): PlainDate => addDays(infoReceivedOn, 30);
/** REGZ_1026_19F2_CLERICAL_CD_60: non-numeric clerical errors — 60 calendar days after consummation. */
export const clericalCdDueDate = (consummationOn: PlainDate): PlainDate => addDays(consummationOn, 60);
/** (f)(2)(v): refund and corrected CD within 60 calendar days after consummation (21.5 owns the refund clock). */
export const toleranceRefundCdDueDate = (consummationOn: PlainDate): PlainDate => addDays(consummationOn, 60);
/** SM_O62_UCD_RESUBMIT_ON_CORRECTION: a new accepted UCD within 2 `business_days_fannie_et` of a post-consummation, pre-purchase correction. */
export const ucdResubmitDueDate = (correctionDeliveredOn: PlainDate): PlainDate => addBusinessDays(correctionDeliveredOn, 2, fannieEt);
/** Escalations to the settlement agent carry an SLA of 1 `business_days_creditor`. */
export const settlementAgentSlaDue = (on: PlainDate): PlainDate => addBusinessDays(on, 1, creditor);

// ============================================================ rule 2: receipts per consumer (cd_receipts)
export type CdDeliveryChannel = "esign_portal" | "email_link" | "mail" | "courier" | "in_person";
export const CD_DELIVERY_CHANNELS: readonly CdDeliveryChannel[] = ["esign_portal", "email_link", "mail", "courier", "in_person"];
export type CdReceiptEvidence = "esign_confirmed" | "portal_acknowledged" | "in_person" | "mailbox_rule" | "courier_signed";
/** Decision 25.2-Q2: only these rebut the mailbox presumption; e-mail "opened" events and phone confirmations do not. */
export const REBUTTING_EVIDENCE: readonly CdReceiptEvidence[] = ["esign_confirmed", "portal_acknowledged", "in_person", "courier_signed"];
export const isElectronicChannel = (c: CdDeliveryChannel): boolean => c === "esign_portal" || c === "email_link";
export interface CdReceipt {
  readonly receipt_id: string; readonly disclosure_id: string; readonly consumer_id: string; readonly delivered_at: string; readonly delivery_channel: CdDeliveryChannel; readonly mailed_at: string | null;
  receipt_evidence: CdReceiptEvidence | null; actual_receipt_at: string | null; readonly presumed_receipt_date: PlainDate | null; effective_receipt_date: PlainDate | null; evidence_document_id: string | null; readonly esign_consent_id: string | null; readonly delivered_on: PlainDate;
}
/** A delivery row: in person → received that day; every other channel starts the presumption (effective date = presumed until evidence or the sweep). */
export function receiptOnDelivery(i: { receipt_id: string; disclosure_id: string; consumer_id: string; channel: CdDeliveryChannel; at: string; time_zone: string; esign_consent_id?: string | null; evidence_document_id?: string | null }): CdReceipt {
  need(CD_DELIVERY_CHANNELS.includes(i.channel), `channel ${i.channel} is not one of ${CD_DELIVERY_CHANNELS.join("/")}`);
  const delivered_on = civilDate(i.at, i.time_zone);
  if (i.channel === "in_person") {
    need(!!i.evidence_document_id, "in-person delivery is recorded from the settlement agent's signed receipt (evidence_document_id)");
    return { receipt_id: i.receipt_id, disclosure_id: i.disclosure_id, consumer_id: i.consumer_id, delivered_at: i.at, delivery_channel: "in_person", mailed_at: null, receipt_evidence: "in_person", actual_receipt_at: i.at, presumed_receipt_date: null, effective_receipt_date: delivered_on, evidence_document_id: i.evidence_document_id ?? null, esign_consent_id: null, delivered_on };
  }
  const presumed = presumedReceiptDate(delivered_on);
  return { receipt_id: i.receipt_id, disclosure_id: i.disclosure_id, consumer_id: i.consumer_id, delivered_at: i.at, delivery_channel: i.channel, mailed_at: i.channel === "mail" ? i.at : null, receipt_evidence: null, actual_receipt_at: null, presumed_receipt_date: presumed, effective_receipt_date: null, evidence_document_id: null, esign_consent_id: i.esign_consent_id ?? null, delivered_on };
}
/** Actual receipt evidence of an enumerated kind rebuts the presumption: effective = min(actual date, presumed date). Oral confirmation is never receipt. */
export function rebutPresumption(r: CdReceipt, ev: { evidence: string; at: string; time_zone: string; evidence_document_id: string | null }): CdReceipt {
  if (!REBUTTING_EVIDENCE.includes(ev.evidence as CdReceiptEvidence) || ev.evidence === "in_person") throw new CdRefused("RECEIPT_EVIDENCE_KIND", "25.2 decision Q2; guardrail 'never treat an oral confirmation as receipt'", `${ev.evidence} does not rebut the mailbox presumption — only esign_confirmed, portal_acknowledged or courier_signed evidence (or the settlement agent's signed in-person receipt) does`);
  if (!ev.evidence_document_id) throw new CdRefused("RECEIPT_EVIDENCE_DOCUMENT", "25.2 guardrail 'never record actual_receipt_at without evidence of the enumerated kinds'", "an evidence document (e-sign certificate, portal acknowledgement, courier signature) is required");
  const on = civilDate(ev.at, ev.time_zone);
  if (on < r.delivered_on) throw new RangeError(`receipt evidence ${ev.at} precedes delivery on ${r.delivered_on}`);
  const presumed = r.presumed_receipt_date;
  return { ...r, receipt_evidence: ev.evidence as CdReceiptEvidence, actual_receipt_at: ev.at, effective_receipt_date: presumed && presumed < on ? presumed : on, evidence_document_id: ev.evidence_document_id };
}
/** Mailbox sweep: on/after the presumed date with no evidence the row is deemed received (feeds the gate). */
export function deemReceipt(r: CdReceipt, today: PlainDate): CdReceipt {
  if (r.receipt_evidence || !r.presumed_receipt_date || today < r.presumed_receipt_date) return r;
  return { ...r, receipt_evidence: "mailbox_rule", effective_receipt_date: r.presumed_receipt_date };
}
export interface WaitingPeriod { readonly complete: boolean; readonly missing_consumer_ids: readonly string[]; readonly latest_effective_receipt_date: PlainDate | null; readonly earliest_consummation_date: PlainDate | null; readonly receipts: readonly { consumer_id: string; effective_receipt_date: PlainDate | null; evidence: CdReceiptEvidence | null }[]; }
/** The gate uses the LATEST `effective_receipt_date` across every required consumer (all rescinding consumers in a refinance; platform policy: every borrower); incomplete until each has one. */
export function computeEarliestConsummation(receipts: readonly CdReceipt[], requiredConsumerIds: readonly string[]): WaitingPeriod {
  need(requiredConsumerIds.length > 0, "at least one required consumer (§1026.17(d))");
  const rows = requiredConsumerIds.map((c) => { const r = [...receipts].reverse().find((x) => x.consumer_id === c); return { consumer_id: c, effective_receipt_date: r?.effective_receipt_date ?? null, evidence: r?.receipt_evidence ?? null }; });
  const missing = rows.filter((r) => !r.effective_receipt_date).map((r) => r.consumer_id);
  if (missing.length) return { complete: false, missing_consumer_ids: missing, latest_effective_receipt_date: null, earliest_consummation_date: null, receipts: rows };
  const latest = rows.map((r) => r.effective_receipt_date!).reduce((a, b) => (b > a ? b : a));
  return { complete: true, missing_consumer_ids: [], latest_effective_receipt_date: latest, earliest_consummation_date: earliestConsummationDate(latest), receipts: rows };
}

// ============================================================ rule 3: the 3-SBD gate and the waiver
export interface Cd3sbdGateFacts { readonly earliest_consummation_date?: PlainDate | string | null; readonly requested_on?: PlainDate | string; readonly waiver_accepted_on?: PlainDate | string | null; readonly receipts_complete?: boolean; }
/** REGZ_1026_19F1_CD_3SBD_GATE: open on/after `earliest_consummation_date` (consummation may occur on that day) or from an `officer`-accepted `cd_waivers` row; closed while any required consumer lacks an effective receipt. */
export function cd3sbdGate(f: Cd3sbdGateFacts): { open: boolean; reason?: string } {
  if (!f.requested_on) return { open: false, reason: "requested consummation date is required" };
  if (f.receipts_complete === false || !f.earliest_consummation_date) return { open: false, reason: "not every required consumer has received the Closing Disclosure — the three-business-day period has not started (§1026.19(f)(1)(ii)(A); §1026.17(d))" };
  if (f.waiver_accepted_on && f.waiver_accepted_on <= f.requested_on) return { open: true };
  if (f.requested_on >= f.earliest_consummation_date) return { open: true };
  return { open: false, reason: `consummation ${f.requested_on} precedes the earliest permitted date ${f.earliest_consummation_date} (third specific business day after receipt, §1026.19(f)(1)(ii)(A)); waiver only by a consumer-authored dated written emergency statement accepted by officer (§1026.19(f)(1)(iv))` };
}
export class CdGateClosed extends Error { readonly code = "REGZ_1026_19F1_CD_3SBD_GATE"; readonly reason: string; constructor(reason: string) { super(`consummate refused [REGZ_1026_19F1_CD_3SBD_GATE]: ${reason}`); this.name = "CdGateClosed"; this.reason = reason; } }
export function assertCd3sbdGateOpen(f: Cd3sbdGateFacts): void { const g = cd3sbdGate(f); if (!g.open) throw new CdGateClosed(g.reason ?? "closed"); }

export interface CdWaiverInput { readonly waiver_id: string; readonly application_id: string; readonly consumer_ids: readonly string[]; readonly statement_document_id: string; readonly statement_text: string; readonly dated_on: PlainDate; readonly signed_by: readonly string[]; readonly emergency_summary: string; readonly received_at: string; readonly template_used?: boolean; readonly printed_form?: boolean; readonly platform_supplied_text?: boolean; }
export interface CdWaiver extends CdWaiverInput { readonly accepted_by: string; readonly accepted_at: string; readonly accepted_on: PlainDate; readonly earliest_consummation_date: PlainDate; }
/** §1026.19(f)(1)(iv): a consumer-authored, dated, signed statement describing the emergency — "Printed forms for this purpose are prohibited"; every required consumer signs; only after receipt of the CD. */
export function validateWaiverStatement(w: CdWaiverInput, requiredConsumerIds: readonly string[], latestReceiptDate: PlainDate | null): void {
  if (w.printed_form || w.template_used || w.platform_supplied_text) throw new CdRefused("PRINTED_FORM", "§1026.19(f)(1)(iv); decision 25.2-Q3", "printed forms prohibited — the waiver must be the consumer's own dated, signed statement (no template, no platform-supplied wording)");
  need(!!w.statement_document_id && w.statement_text.trim().length > 0, "the consumer's dated, signed statement (document and text) is required");
  need(!!w.emergency_summary, "the statement must describe the bona fide personal financial emergency");
  const unsigned = requiredConsumerIds.filter((c) => !w.signed_by.includes(c));
  if (unsigned.length) throw new CdRefused("ALL_CONSUMERS_SIGN", "§1026.19(f)(1)(iv); rule 'Waiver'", `every consumer entitled to the disclosure signs — missing ${unsigned.join(", ")}`);
  if (!latestReceiptDate) throw new CdRefused("WAIVER_BEFORE_RECEIPT", "§1026.19(f)(1)(iv) 'after receiving the disclosures'", "the waiver may only follow receipt of the Closing Disclosure by every required consumer");
  if (w.dated_on < latestReceiptDate) throw new CdRefused("WAIVER_BEFORE_RECEIPT", "§1026.19(f)(1)(iv) 'after receiving the disclosures'", `the statement is dated ${w.dated_on}, before the CD was received on ${latestReceiptDate}`);
}
/** The earliest consummation after an accepted waiver is the acceptance date, but never before receipt of the CD. */
export const waiverEarliestConsummation = (acceptedOn: PlainDate, latestReceiptDate: PlainDate): PlainDate => (acceptedOn > latestReceiptDate ? acceptedOn : latestReceiptDate);

// ============================================================ rule 4: redisclosure (§1026.19(f)(2))
export type CdReason = "initial" | "pre_consummation_no_wait" | "pre_consummation_new_wait" | "post_consummation_event" | "clerical" | "tolerance_refund";
export const CD_REASONS: readonly CdReason[] = ["initial", "pre_consummation_no_wait", "pre_consummation_new_wait", "post_consummation_event", "clerical", "tolerance_refund"];
export type RedisclosureTrigger = "(f)(2)(ii)(A)" | "(f)(2)(ii)(B)" | "(f)(2)(ii)(C)";
export interface CdTerms { readonly apr_disclosed: string | number; readonly finance_charge_cents: Cents; readonly product: string; readonly prepayment_penalty: boolean; }
export interface RedisclosureInput { readonly prev: CdTerms; readonly next: { readonly apr_actual: string | number; readonly finance_charge_cents: Cents; readonly product: string; readonly prepayment_penalty: boolean; readonly apr_from_disclosed_finance_charge?: string | number | null }; readonly transaction?: TransactionShape; readonly apr_verdict?: AprAccuracy | null; readonly as_of?: PlainDate; }
export interface RedisclosureEvaluation { readonly new_wait: boolean; readonly triggers: readonly RedisclosureTrigger[]; readonly cd_reason: "pre_consummation_new_wait" | "pre_consummation_no_wait"; readonly apr_accuracy: AprAccuracy; readonly product_changed: boolean; readonly prepayment_penalty_added: boolean; readonly test_ids: readonly string[]; readonly rationale: string; }
/** `new_wait = APR_inaccurate ∨ product_changed ∨ prepayment_penalty_added`; APR_inaccurate is 25.1's APR_1026_22_ACCURACY verdict (1/8 regular; (a)(4)/(a)(5) finance-charge relief — an overstated-but-accurate APR needs no new wait, TRID FAQ). */
export function evaluateRedisclosure(i: RedisclosureInput): RedisclosureEvaluation {
  const apr_accuracy = i.apr_verdict ?? aprAccuracyTest({ disclosed_apr: i.prev.apr_disclosed, actual_apr: i.next.apr_actual, transaction: i.transaction ?? {}, disclosed_finance_charge_cents: i.prev.finance_charge_cents, actual_finance_charge_cents: i.next.finance_charge_cents, apr_from_disclosed_finance_charge: i.next.apr_from_disclosed_finance_charge ?? null, ...(i.as_of ? { as_of: i.as_of } : {}) });
  const product_changed = i.prev.product.trim().toLowerCase() !== i.next.product.trim().toLowerCase();
  const prepayment_penalty_added = !i.prev.prepayment_penalty && i.next.prepayment_penalty;
  const triggers: RedisclosureTrigger[] = [];
  if (apr_accuracy.result === "fail") triggers.push("(f)(2)(ii)(A)");
  if (product_changed) triggers.push("(f)(2)(ii)(B)");
  if (prepayment_penalty_added) triggers.push("(f)(2)(ii)(C)");
  const new_wait = triggers.length > 0;
  return { new_wait, triggers, cd_reason: new_wait ? "pre_consummation_new_wait" : "pre_consummation_no_wait", apr_accuracy, product_changed, prepayment_penalty_added, test_ids: ["APR_1026_22_ACCURACY", "FC_1026_38O2_ACCURACY"],
    rationale: new_wait ? `new three-business-day waiting period: ${triggers.join(", ")} — ${apr_accuracy.message}` : `no new waiting period (§1026.19(f)(2)(i)): APR ${apr_accuracy.message}; product unchanged; no prepayment penalty added — corrected CD received at or before consummation` };
}

// ============================================================ rule 5: no fee for the CD (§1026.19(f)(5)) and the H-25 content checklist
export const PROHIBITED_CD_FEE = /\b(?:cd|closing[- ]disclosure)\s+(?:preparation|prep)\s+fee\b|\bdisclosure\s+delivery\s+fee\b/i;
export interface CdFeeLine { readonly fee_code: string; readonly description: string; readonly amount_cents: Cents; readonly paid_by?: "borrower" | "seller" | "lender" | "other"; readonly section?: string; readonly tolerance_class?: string; readonly source_id?: string | null; }
/** (f)(5): "No fee may be imposed on any person … for the preparation or delivery of the disclosures". */
export function validateCdFees(fees: readonly CdFeeLine[]): string[] { return fees.filter((f) => PROHIBITED_CD_FEE.test(f.description) || PROHIBITED_CD_FEE.test(f.fee_code.replace(/_/g, " "))).map((f) => `${f.fee_code}: "${f.description}" — a fee for preparing or delivering the Closing Disclosure is prohibited (§1026.19(f)(5))`); }

export type FigureParty = "settlement_agent" | "creditor" | "mi" | "flood" | "payoff" | "escrow";
export interface CdFigureSource { readonly source_id: string; readonly application_id: string; readonly party: FigureParty; readonly version: number; readonly received_at: string; readonly payload_document_id: string | null; readonly payload: Record<string, unknown>; readonly hash: string; reconciled: boolean; variances: readonly FigureVariance[]; }
export interface FigureVariance { readonly fee_code: string; readonly settlement_agent_cents: Cents; readonly creditor_cents: Cents; readonly delta_cents: Cents; }
export const hashFigurePayload = (payload: unknown): string => sha(payload);
/** The version in force per party (the latest received); earlier versions are history and never gate the render. */
export function latestFigureSources(sources: readonly CdFigureSource[]): CdFigureSource[] { const by = new Map<FigureParty, CdFigureSource>(); for (const s of sources) { const cur = by.get(s.party); if (!cur || s.version > cur.version) by.set(s.party, s); } return [...by.values()]; }
/** Every inbound settlement version is hashed and reconciled against the creditor's fee items (same fee codes); an unreconciled variance blocks the CD gate. */
export function reconcileFigureSource(source: CdFigureSource, creditorFees: readonly CdFeeLine[], resolvedCodes: readonly string[] = []): { reconciled: boolean; variances: FigureVariance[] } {
  const saFees = (source.payload.fees as readonly { fee_code: string; amount_cents: Cents | string }[] | undefined) ?? [];
  const variances: FigureVariance[] = [];
  for (const f of saFees) { const c = creditorFees.find((x) => x.fee_code === f.fee_code); if (!c) continue; const sa = BigInt(String(f.amount_cents)); if (sa !== c.amount_cents && !resolvedCodes.includes(f.fee_code)) variances.push({ fee_code: f.fee_code, settlement_agent_cents: sa, creditor_cents: c.amount_cents, delta_cents: sa - c.amount_cents }); }
  return { reconciled: variances.length === 0, variances };
}

export interface CdEscrowFigures { readonly established: boolean; readonly monthly_escrow_cents: Cents; readonly initial_escrow_payment_cents: Cents; readonly escrowed_costs_year1_cents: Cents; readonly non_escrowed_costs_year1_cents: Cents; readonly escrow_waiver_fee_cents?: Cents; }
export interface CdRenderInput {
  readonly application_id: string; readonly disclosure_id: string; readonly cd_version: number; readonly cd_reason: CdReason; readonly transaction_type: "purchase" | "refinance"; readonly state: string;
  readonly loan: { readonly loan_amount_cents: Cents; readonly rate_pct: string; readonly term_months: number; readonly pi_cents: Cents; readonly product: string; readonly loan_type: string; readonly purpose: string; readonly prepayment_penalty: boolean; readonly balloon: boolean; readonly arm: boolean; readonly loan_id_number: string; readonly mic_number: string | null; readonly first_payment_date: PlainDate; readonly maturity_date: PlainDate };
  readonly apr: { readonly apr_calculation_id: string; readonly apr_pct: string; readonly finance_charge_cents: Cents; readonly amount_financed_cents: Cents; readonly total_of_payments_cents: Cents; readonly tip_pct: string };
  readonly fees: readonly CdFeeLine[]; readonly figure_sources: readonly CdFigureSource[]; readonly escrow: CdEscrowFigures;
  readonly parties: { readonly borrowers: readonly string[]; readonly creditor_name: string; readonly creditor_nmlsr_id: string; readonly mlo_name: string; readonly mlo_nmlsr_id: string; readonly settlement_agent_name: string; readonly settlement_agent_license_id: string; readonly seller_name?: string | null };
  readonly dates: { readonly date_issued: PlainDate; readonly closing_date: PlainDate; readonly disbursement_date: PlainDate }; readonly property_address: string;
  readonly cash_to_close_cents: Cents; readonly lender_credits_cents: Cents; readonly payoffs_and_payments_cents?: Cents; readonly rescindable?: boolean;
}
export interface ChecklistItem { readonly item: string; readonly citation: string; readonly ok: boolean; readonly note?: string; }
export interface CdRender { readonly h25: Record<string, unknown>; readonly figures_hash: string; readonly figure_source_version: string; readonly checklist: readonly ChecklistItem[]; readonly template_version: string; readonly notice_code: "NTC_REGZ_1026_38_CD" | "NTC_REGZ_1026_38_CD_CORRECTED"; }
const pct3 = (p: string): boolean => /^\d+\.\d{3}$/.test(p);
/** The H-25 content checklist the render must satisfy (every item ok or the render fails); figures come only from versioned sources — never typed. */
export function h25Checklist(i: CdRenderInput, fees: readonly CdFeeLine[]): ChecklistItem[] {
  const escrowedYear1 = i.escrow.monthly_escrow_cents * 12n;
  const items: ChecklistItem[] = [
    { item: "closing_information", citation: "§1026.38(a)(3)", ok: !!i.dates.date_issued && !!i.dates.closing_date && !!i.dates.disbursement_date && !!i.parties.settlement_agent_name && !!i.property_address },
    { item: "transaction_information", citation: "§1026.38(a)(4)–(5) incl. (a)(5)(v) Loan ID #, (a)(5)(vi) MIC #", ok: i.parties.borrowers.length > 0 && !!i.parties.creditor_name && !!i.loan.loan_id_number && (i.loan.mic_number !== undefined) },
    { item: "loan_terms", citation: "§1026.38(b)", ok: i.loan.loan_amount_cents > 0n && i.loan.pi_cents > 0n && pct3(i.loan.rate_pct) },
    { item: "projected_payments", citation: "§1026.38(c)", ok: i.loan.pi_cents > 0n && i.escrow.monthly_escrow_cents >= 0n },
    { item: "costs_at_closing", citation: "§1026.38(d)", ok: fees.length > 0 && i.cash_to_close_cents !== undefined },
    { item: "loan_costs_other_costs", citation: "§1026.38(f)–(g) with 21.5 tolerance classes and Paid by Others/Seller-Paid columns", ok: fees.every((f) => f.amount_cents >= 0n) },
    { item: "calculating_cash_to_close", citation: "§1026.38(i) reconciled against the LE", ok: i.cash_to_close_cents >= 0n },
    { item: i.transaction_type === "purchase" ? "summaries_of_transactions" : "payoffs_and_payments", citation: i.transaction_type === "purchase" ? "§1026.38(j)–(k)" : "§1026.38(t)(5)(vii)(B) alternative table for transactions without a seller", ok: i.transaction_type === "purchase" ? !!i.parties.seller_name : i.payoffs_and_payments_cents !== undefined },
    { item: "loan_disclosures_escrow", citation: "§1026.38(l)(7) — Escrowed/Non-Escrowed Property Costs over Year 1, Initial Escrow Payment, Monthly Escrow Payment (30.3 figures)", ok: !i.escrow.established || (i.escrow.escrowed_costs_year1_cents === escrowedYear1 && i.escrow.initial_escrow_payment_cents >= 0n), note: i.escrow.established ? `escrowed costs year 1 = 12 × ${S(i.escrow.monthly_escrow_cents)}` : "Property Costs over Year 1 and Escrow Waiver Fee" },
    { item: "ap_air_tables", citation: "§1026.38(m)–(n) only for ARMs / payment-change loans", ok: true, note: i.loan.arm ? "AIR table required (ARM)" : "not applicable (fixed rate)" },
    { item: "loan_calculations", citation: "§1026.38(o)(1)–(5) from apr_calculations; (t)(4) three decimals", ok: !!i.apr.apr_calculation_id && pct3(i.apr.apr_pct) && pct3(i.apr.tip_pct) && i.apr.total_of_payments_cents > 0n && i.apr.finance_charge_cents > 0n && i.apr.amount_financed_cents > 0n && i.apr.amount_financed_cents <= i.loan.loan_amount_cents },
    { item: "other_disclosures", citation: "§1026.38(p) appraisal, contract details, liability after foreclosure, refinance, tax deductions", ok: true },
    { item: "questions", citation: "§1026.38(q)", ok: true },
    { item: "contact_information", citation: "§1026.38(r); §1026.36(g)(2)(ii) creditor and mlo_of_record NMLSR IDs", ok: /^\d{3,}$/.test(i.parties.creditor_nmlsr_id) && /^\d{3,}$/.test(i.parties.mlo_nmlsr_id) && !!i.parties.mlo_name && !!i.parties.settlement_agent_license_id },
    { item: "confirm_receipt", citation: "§1026.38(s)", ok: true },
    { item: "no_cd_fee", citation: "§1026.19(f)(5)", ok: validateCdFees(fees).length === 0 },
    { item: "figures_from_versioned_sources", citation: "25.2 guardrail 'never edit a figure without a versioned source'", ok: i.figure_sources.length > 0 && latestFigureSources(i.figure_sources).every((s) => s.reconciled) },
  ];
  return items;
}
/** `renderCd`: validates (f)(5), the reconciled figure sources and the H-25 checklist, then produces the H-25 payload the notice template renders. */
export function renderCd(i: CdRenderInput): CdRender {
  const feeViolations = validateCdFees(i.fees);
  if (feeViolations.length) throw new CdRefused("F5_CD_FEE", "§1026.19(f)(5)", feeViolations.join("; "));
  const unreconciled = latestFigureSources(i.figure_sources).filter((s) => !s.reconciled);
  if (unreconciled.length) throw new CdRefused("FIGURES_UNRECONCILED", "25.2 integrations: 'unreconciled variances block the CD gate'", `figure sources not reconciled: ${unreconciled.map((s) => `${s.party} v${s.version}`).join(", ")}`);
  const checklist = h25Checklist(i, i.fees);
  const failed = checklist.filter((c) => !c.ok);
  if (failed.length) throw new CdRefused("H25_CONTENT", failed.map((c) => c.citation).join("; "), `H-25 content checklist failed: ${failed.map((c) => c.item).join(", ")}`);
  const loan_costs = i.fees.filter((f) => (f.section ?? "").startsWith("A") || (f.section ?? "").startsWith("B") || (f.section ?? "").startsWith("C")).reduce((a, f) => a + f.amount_cents, 0n);
  const other_costs = i.fees.filter((f) => !((f.section ?? "").startsWith("A") || (f.section ?? "").startsWith("B") || (f.section ?? "").startsWith("C"))).reduce((a, f) => a + f.amount_cents, 0n);
  const h25: Record<string, unknown> = {
    template_version: H25_TEMPLATE_VERSION, cd_version: i.cd_version, cd_reason: i.cd_reason, corrected: i.cd_version > 1, new_waiting_period: i.cd_reason === "pre_consummation_new_wait",
    date_issued: i.dates.date_issued, closing_date: i.dates.closing_date, disbursement_date: i.dates.disbursement_date, settlement_agent_name: i.parties.settlement_agent_name, property_address: i.property_address,
    borrowers: [...i.parties.borrowers], creditor_name: i.parties.creditor_name, loan_term_years: Math.round(i.loan.term_months / 12), purpose: i.loan.purpose, product: i.loan.product, loan_type: i.loan.loan_type, loan_id_number: i.loan.loan_id_number, mic_number: i.loan.mic_number ?? "N/A",
    loan_amount_cents: i.loan.loan_amount_cents, interest_rate_pct: i.loan.rate_pct, pi_cents: i.loan.pi_cents, prepayment_penalty: i.loan.prepayment_penalty, balloon_payment: i.loan.balloon,
    escrow: i.escrow.established, escrow_cents: i.escrow.monthly_escrow_cents, initial_escrow_payment_cents: i.escrow.initial_escrow_payment_cents, escrowed_property_costs_year1_cents: i.escrow.escrowed_costs_year1_cents, non_escrowed_property_costs_year1_cents: i.escrow.non_escrowed_costs_year1_cents,
    loan_costs_cents: loan_costs, other_costs_cents: other_costs, lender_credits_cents: i.lender_credits_cents, closing_costs_cents: loan_costs + other_costs + i.lender_credits_cents, cash_to_close_cents: i.cash_to_close_cents,
    total_of_payments_cents: i.apr.total_of_payments_cents, finance_charge_cents: i.apr.finance_charge_cents, amount_financed_cents: i.apr.amount_financed_cents, apr: i.apr.apr_pct, tip_pct: i.apr.tip_pct, apr_calculation_id: i.apr.apr_calculation_id,
    creditor_nmlsr_id: i.parties.creditor_nmlsr_id, creditor_contact_name: i.parties.mlo_name, mlo_nmlsr_id: i.parties.mlo_nmlsr_id, settlement_agent_license_id: i.parties.settlement_agent_license_id,
    fees: i.fees.map((f) => ({ fee_code: f.fee_code, description: f.description, amount_cents: f.amount_cents, paid_by: f.paid_by ?? "borrower", section: f.section ?? null, tolerance_class: f.tolerance_class ?? null })),
    figure_source_versions: i.figure_sources.map((s) => `${s.party}:${s.version}:${s.hash.slice(0, 12)}`),
  };
  return { h25, figures_hash: sha(h25), figure_source_version: i.figure_sources.map((s) => `${s.party}=${s.version}`).join(","), checklist, template_version: H25_TEMPLATE_VERSION, notice_code: i.cd_version === 1 ? "NTC_REGZ_1026_38_CD" : "NTC_REGZ_1026_38_CD_CORRECTED" };
}

// ============================================================ rule 6: CD-to-note consistency checks (feeding 26.1)
export type ConsistencyCheckCode = "CD_NOTE_LOAN_AMOUNT" | "CD_NOTE_RATE" | "CD_NOTE_TERM" | "CD_NOTE_FIRST_PAYMENT_DATE" | "CD_NOTE_MATURITY_DATE" | "CD_NOTE_PI" | "CD_NOTE_LATE_CHARGE" | "CD_NOTE_PREPAY" | "CD_NOTE_ARM_TERMS" | "CD_BORROWER_NAMES_VESTING" | "CD_PROPERTY_ADDRESS" | "CD_NMLSR_IDS" | "CD_ESCROW_VS_O11_3" | "CD_MI_VS_CERT" | "CD_PAYOFF_VS_DEMAND" | "CD_CASH_TO_CLOSE_VS_SETTLEMENT_LEDGER";
export const CONSISTENCY_CHECK_CODES: readonly ConsistencyCheckCode[] = ["CD_NOTE_LOAN_AMOUNT", "CD_NOTE_RATE", "CD_NOTE_TERM", "CD_NOTE_FIRST_PAYMENT_DATE", "CD_NOTE_MATURITY_DATE", "CD_NOTE_PI", "CD_NOTE_LATE_CHARGE", "CD_NOTE_PREPAY", "CD_NOTE_ARM_TERMS", "CD_BORROWER_NAMES_VESTING", "CD_PROPERTY_ADDRESS", "CD_NMLSR_IDS", "CD_ESCROW_VS_O11_3", "CD_MI_VS_CERT", "CD_PAYOFF_VS_DEMAND", "CD_CASH_TO_CLOSE_VS_SETTLEMENT_LEDGER"];
export type ConsistencyValue = Cents | string | number | boolean | null | readonly string[] | Record<string, unknown>;
export interface CdConsistencyCheck { readonly check_id: string; readonly application_id: string; readonly cd_version: number; readonly check_code: ConsistencyCheckCode; readonly cd_value: string | null; readonly note_or_source_value: string | null; readonly result: "match" | "mismatch" | "n/a"; readonly resolved_by: string | null; readonly created_at: string; }
const canon = (v: ConsistencyValue | undefined): string | null => (v === undefined || v === null ? null : typeof v === "bigint" ? v.toString() : typeof v === "object" ? JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : Array.isArray(x) ? [...x].sort() : x)) : String(v));
/** One row per check code: `match` / `mismatch` / `n/a` (absent on both sides). Any `mismatch` blocks 26.1's `generateClosingDocuments` until the CD is corrected. */
export function runCdConsistencyChecks(i: { application_id: string; cd_version: number; cd: Partial<Record<ConsistencyCheckCode, ConsistencyValue>>; source: Partial<Record<ConsistencyCheckCode, ConsistencyValue>>; now: string }): CdConsistencyCheck[] {
  return CONSISTENCY_CHECK_CODES.map((code) => { const a = canon(i.cd[code]), b = canon(i.source[code]); const result = a === null && b === null ? "n/a" : a === b ? "match" : "mismatch"; return { check_id: `${i.application_id}:cd${i.cd_version}:${code}`, application_id: i.application_id, cd_version: i.cd_version, check_code: code, cd_value: a, note_or_source_value: b, result, resolved_by: null, created_at: i.now }; });
}
export function closingDocumentsBlocked(checks: readonly CdConsistencyCheck[]): { blocked: boolean; mismatches: readonly CdConsistencyCheck[]; reason: string | null } {
  const mismatches = checks.filter((c) => c.result === "mismatch" && !c.resolved_by);
  return { blocked: mismatches.length > 0, mismatches, reason: mismatches.length ? `generateClosingDocuments blocked — cd_consistency_checks mismatch: ${mismatches.map((m) => `${m.check_code} (CD ${m.cd_value} vs ${m.note_or_source_value})`).join("; ")} — issue a corrected CD` : null };
}
export function assertClosingDocumentsUnblocked(checks: readonly CdConsistencyCheck[]): void { const b = closingDocumentsBlocked(checks); if (b.blocked) throw new CdRefused("CD_CONSISTENCY_MISMATCH", "25.2 rule 'CD-to-note consistency checks'; 26.1 generateClosingDocuments", b.reason!); }

// ============================================================ rule 7: post-consummation regimes (§1026.19(f)(2)(iii)–(v))
export type CorrectionRegime = "post_consummation_event" | "clerical" | "tolerance_refund";
export interface CorrectionEventInput { readonly consummation_on: PlainDate; readonly event_on: PlainDate; readonly info_received_on: PlainDate; readonly numeric: boolean; readonly amount_paid_changed: boolean; readonly in_connection_with_settlement: boolean; readonly tolerance_refund?: boolean; }
export interface CorrectionClassification { readonly regime: CorrectionRegime; readonly timer: "REGZ_1026_19F2_CORRECTED_CD_30" | "REGZ_1026_19F2_CLERICAL_CD_60" | "REGZ_1026_19F2V_TOLERANCE_REFUND_60"; readonly due_on: PlainDate; readonly window: { from: PlainDate; to: PlainDate }; readonly within_window: boolean; readonly citation: string; }
/** Which of the three regimes applies and when the corrected CD is due. */
export function classifyPostConsummationCorrection(i: CorrectionEventInput): CorrectionClassification {
  const window = postConsummationEventWindow(i.consummation_on);
  if (i.tolerance_refund) return { regime: "tolerance_refund", timer: "REGZ_1026_19F2V_TOLERANCE_REFUND_60", due_on: toleranceRefundCdDueDate(i.consummation_on), window, within_window: true, citation: "§1026.19(f)(2)(v) — 21.5 owns the refund clock; the corrected CD reflects the refund within the same 60 days" };
  if (!i.numeric) return { regime: "clerical", timer: "REGZ_1026_19F2_CLERICAL_CD_60", due_on: clericalCdDueDate(i.consummation_on), window, within_window: true, citation: "§1026.19(f)(2)(iv) — non-numeric clerical error: corrected CD no later than 60 days after consummation" };
  const within_window = i.event_on >= window.from && i.event_on <= window.to;
  need(i.in_connection_with_settlement && i.amount_paid_changed, "(f)(2)(iii) applies only to an event in connection with the settlement that changes an amount actually paid by the consumer");
  need(within_window, `the event on ${i.event_on} is outside the 30-day post-consummation window ${window.from}–${window.to} (§1026.19(f)(2)(iii))`);
  return { regime: "post_consummation_event", timer: "REGZ_1026_19F2_CORRECTED_CD_30", due_on: correctedCdDueDate(i.info_received_on), window, within_window, citation: "§1026.19(f)(2)(iii) — corrected CD not later than 30 days after receiving information sufficient to establish the event" };
}

// ============================================================ rule 8: UCD generation and the delivery gate
export type UcdVersion = "1.5" | "2.0";
export type UcdStatus = "generated" | "submitted" | "accepted" | "accepted_with_warnings" | "rejected" | "error";
export interface UcdSubmission { readonly ucd_submission_id: string; readonly application_id: string; readonly loan_id: string | null; readonly ucd_version: UcdVersion; casefile_id_ucd: string | null; readonly du_casefile_id: string; readonly xml_document_id: string; readonly xml_hash: string; readonly embedded_cd_disclosure_id: string; readonly embedded_cd_version: number; readonly channel: "di" | "ui"; submitted_at: string | null; status: UcdStatus; feedback_messages: readonly string[]; critical_edit_failures: number; is_final: boolean; readonly submitted_by: string; readonly schema: typeof UCD_SCHEMA; }
export interface UcdGenerateInput { readonly application_id: string; readonly loan_id?: string | null; readonly ucd_submission_id: string; readonly cd: { disclosure_id: string; cd_version: number; status: CdStatus; pdf_document_id: string; figures_hash: string }; readonly du_casefile_id: string; readonly ucd_version?: UcdVersion; readonly flags?: Readonly<Record<string, string>>; readonly channel?: "di" | "ui"; readonly submitted_by?: string; readonly seller_cd_separate?: boolean; }
/** `generateUcd`: v2.0 by default (v1.5 on flag `fnma.ucd.version=1.5`), embeds the final CD PDF, never a superseded version; the seller CD is not embedded when separate. */
export function generateUcd(i: UcdGenerateInput): UcdSubmission {
  need(!!i.du_casefile_id, "du_casefile_id (DU Casefile ID linkage) is required");
  need(!!i.cd.pdf_document_id, "the CD PDF document to embed is required");
  if (i.cd.status === "superseded") throw new CdRefused("SUPERSEDED_CD", "25.2 guardrail 'never embed a superseded CD in the UCD'; GSE UCD FAQ", `CD ${i.cd.disclosure_id} (v${i.cd.cd_version}) is superseded — embed the most recent version`);
  const ucd_version: UcdVersion = i.ucd_version ?? (i.flags?.["fnma.ucd.version"] === "1.5" ? "1.5" : "2.0");
  const xml = { schema: UCD_SCHEMA, ucd_version, du_casefile_id: i.du_casefile_id, embedded_pdf: i.cd.pdf_document_id, cd_version: i.cd.cd_version, figures_hash: i.cd.figures_hash, seller_cd_embedded: i.seller_cd_separate === false };
  return { ucd_submission_id: i.ucd_submission_id, application_id: i.application_id, loan_id: i.loan_id ?? null, ucd_version, casefile_id_ucd: null, du_casefile_id: i.du_casefile_id, xml_document_id: `DOC-UCD-${i.ucd_submission_id}`, xml_hash: sha(xml), embedded_cd_disclosure_id: i.cd.disclosure_id, embedded_cd_version: i.cd.cd_version, channel: i.channel ?? "di", submitted_at: null, status: "generated", feedback_messages: [], critical_edit_failures: 0, is_final: false, submitted_by: i.submitted_by ?? "agent:disclosure", schema: UCD_SCHEMA };
}
export interface UcdGateFacts { readonly final_cd_disclosure_id?: string | null; readonly submissions?: readonly Pick<UcdSubmission, "status" | "critical_edit_failures" | "embedded_cd_disclosure_id" | "is_final">[]; readonly loan_delivered?: boolean; }
/** FNMA_UCD_ACCEPTED_GATE: a UCD `accepted`/`accepted_with_warnings` with `critical_edit_failures = 0` whose embedded CD is the final version (the most recent CD before delivery). */
export function ucdAcceptedGate(f: UcdGateFacts): { open: boolean; reason?: string } {
  if (!f.final_cd_disclosure_id) return { open: false, reason: "no consummated (final) Closing Disclosure — the UCD cannot embed a final CD PDF yet" };
  const ok = (f.submissions ?? []).find((s) => (s.status === "accepted" || s.status === "accepted_with_warnings") && s.critical_edit_failures === 0 && s.embedded_cd_disclosure_id === f.final_cd_disclosure_id);
  if (ok) return { open: true };
  const latest = (f.submissions ?? []).at(-1);
  return { open: false, reason: latest ? `latest UCD ${latest.status} with ${latest.critical_edit_failures} critical-edit failure(s), embedding ${latest.embedded_cd_disclosure_id}${latest.embedded_cd_disclosure_id !== f.final_cd_disclosure_id ? ` (final CD is ${f.final_cd_disclosure_id} — resubmit)` : ""}` : "no UCD submission accepted for the final CD" };
}
export class UcdGateClosed extends Error { readonly code = "FNMA_UCD_ACCEPTED_GATE"; readonly reason: string; constructor(reason: string) { super(`submitDelivery refused [FNMA_UCD_ACCEPTED_GATE]: ${reason}`); this.name = "UcdGateClosed"; this.reason = reason; } }
export function assertUcdGateOpen(f: UcdGateFacts): void { const g = ucdAcceptedGate(f); if (!g.open) throw new UcdGateClosed(g.reason ?? "closed"); }

// ============================================================ the service (command surface; emits the process's events)
export type CdStatus = "drafting" | "gated" | "delivered" | "received" | "waiting" | "consummation_ready" | "consummated" | "final" | "superseded" | "corrected_post_consummation";
export interface CdRow {
  readonly application_id: string; readonly disclosure_id: string; readonly kind: "cd" | "corrected_cd"; readonly cd_version: number; readonly cd_reason: CdReason; status: CdStatus; readonly rendered_at: string; readonly render: CdRender; readonly input: CdRenderInput;
  readonly required_consumer_ids: readonly string[]; readonly redisclosure_triggers: readonly RedisclosureTrigger[]; readonly new_waiting_period: boolean; readonly apr_calculation_id: string; readonly figures_hash: string; readonly figure_source_version: string;
  gate_run_id: string | null; gate_open: boolean; apr_verdict: "pass" | "fail" | null; blocked_channels: readonly string[]; delivered_at: string | null; earliest_consummation_date: PlainDate | null; waiver_id: string | null; superseded_by_disclosure_id: string | null; consummated_at: string | null; pdf_document_id: string; readonly retention_class: typeof RETENTION_CLASS; readonly le_gate_asserted_on: PlainDate | null;
}
export interface LeGate { assertGateOpen(applicationId: string, requestedOn: PlainDate): void; }
export interface ToleranceEngine { runToleranceTest(input: { application_id: string; stage: "cd_initial" | "cd_corrected" | "post_consummation"; disclosure_id: string; fee_items: readonly CdFeeLine[] }): unknown; }
export interface CdServiceDeps { readonly events: EventStore; readonly clock: Clock; readonly escalations?: EscalationOpener; readonly le?: LeGate; readonly tolerance?: ToleranceEngine; readonly time_zone?: string; }
export interface ClosingFacts { scheduled_consummation_date: PlainDate | null; transaction_type: "purchase" | "refinance" | null; consummation_at: string | null; consummation_on: PlainDate | null; loan_delivered_on: PlainDate | null; loan_purchased_on: PlainDate | null; seller_cd_received_on: PlainDate | null; seller_cd_document_id: string | null; }
export interface DeliveryFacts { ucd_casefile_id: string | null; package_complete: boolean; incomplete_reasons: readonly string[]; }

export class ClosingDisclosureService {
  private readonly events: EventStore; private readonly clock: Clock; private readonly esc: EscalationOpener | null; private readonly le: LeGate | null; private readonly tolerance: ToleranceEngine | null; readonly time_zone: string;
  private readonly rows = new Map<string, CdRow>();
  private readonly receipts = new Map<string, CdReceipt[]>();
  private readonly sources = new Map<string, CdFigureSource[]>();
  private readonly checks = new Map<string, CdConsistencyCheck[]>();
  private readonly ucds = new Map<string, UcdSubmission[]>();
  private readonly waivers = new Map<string, CdWaiver>();
  private readonly closings = new Map<string, ClosingFacts>();
  private readonly deliveries = new Map<string, DeliveryFacts>();
  readonly tolerance_runs: { application_id: string; stage: string; disclosure_id: string }[] = [];
  constructor(deps: CdServiceDeps) { this.events = deps.events; this.clock = deps.clock; this.esc = deps.escalations ?? null; this.le = deps.le ?? null; this.tolerance = deps.tolerance ?? null; this.time_zone = deps.time_zone ?? "America/Phoenix"; }
  private append(type: string, applicationId: string, payload: Record<string, unknown>, occurredAt?: string, actor: Actor = AGENT): DomainEvent {
    return this.events.append({ type, applicationId, actor, payload: { application_id: applicationId, source: "origination", ...payload }, ...(occurredAt ? { occurredAt } : {}) });
  }
  get(disclosureId: string): CdRow { const r = this.rows.get(disclosureId); if (!r) throw new RangeError(`no CD ${disclosureId}`); return r; }
  versions(applicationId: string): CdRow[] { return [...this.rows.values()].filter((r) => r.application_id === applicationId).sort((a, b) => a.cd_version - b.cd_version); }
  current(applicationId: string): CdRow | undefined { return this.versions(applicationId).filter((r) => r.status !== "superseded").at(-1); }
  receiptsOf(disclosureId: string): readonly CdReceipt[] { return this.receipts.get(disclosureId) ?? []; }
  closing(applicationId: string): ClosingFacts { let c = this.closings.get(applicationId); if (!c) { c = { scheduled_consummation_date: null, transaction_type: null, consummation_at: null, consummation_on: null, loan_delivered_on: null, loan_purchased_on: null, seller_cd_received_on: null, seller_cd_document_id: null }; this.closings.set(applicationId, c); } return c; }
  delivery(applicationId: string): DeliveryFacts { let d = this.deliveries.get(applicationId); if (!d) { d = { ucd_casefile_id: null, package_complete: true, incomplete_reasons: [] }; this.deliveries.set(applicationId, d); } return d; }
  figureSources(applicationId: string): readonly CdFigureSource[] { return this.sources.get(applicationId) ?? []; }
  consistencyChecks(applicationId: string, cdVersion?: number): readonly CdConsistencyCheck[] { return (this.checks.get(applicationId) ?? []).filter((c) => cdVersion === undefined || c.cd_version === cdVersion); }
  ucdSubmissions(applicationId: string): readonly UcdSubmission[] { return this.ucds.get(applicationId) ?? []; }

  // ---- closing context (26.2's `closing.scheduled`, 29.4's delivery, 30.1's purchase) ----
  /** 26.2 emits `closing.scheduled{scheduled_at, transaction_type}`; the service keeps the scheduled date for the LE 7-SBD assertion and the delivery schedule. */
  onClosingScheduled(applicationId: string, s: { scheduled_consummation_date: PlainDate; transaction_type: "purchase" | "refinance" }): DeliverySchedule {
    const c = this.closing(applicationId); c.scheduled_consummation_date = s.scheduled_consummation_date; c.transaction_type = s.transaction_type;
    return scheduleDelivery(s.scheduled_consummation_date);
  }
  /** The latest `closing.scheduled` the platform recorded for the application (payload `scheduled_at` / `scheduled_consummation_date`, `transaction_type`). */
  scheduledClosing(applicationId: string): { scheduled_on: PlainDate; transaction_type: string | null } | null {
    const e = this.events.ofType("closing.scheduled").filter((x) => x.applicationId === applicationId || (x.payload as { application_id?: string }).application_id === applicationId).at(-1);
    if (!e) { const c = this.closing(applicationId); return c.scheduled_consummation_date ? { scheduled_on: c.scheduled_consummation_date, transaction_type: c.transaction_type } : null; }
    const p = e.payload as { scheduled_at?: string; scheduled_consummation_date?: string; transaction_type?: string };
    const on = p.scheduled_consummation_date ? plainDate(p.scheduled_consummation_date) : civilDate(p.scheduled_at ?? e.occurredAt, this.time_zone);
    return { scheduled_on: on, transaction_type: p.transaction_type ?? this.closing(applicationId).transaction_type };
  }
  onLoanDelivered(applicationId: string, on: PlainDate): void { this.closing(applicationId).loan_delivered_on = on; }
  onLoanPurchased(applicationId: string, on: PlainDate): void { this.closing(applicationId).loan_purchased_on = on; }

  // ---- figure sources ----
  recordFigureSource(i: { source_id: string; application_id: string; party: FigureParty; payload: Record<string, unknown>; payload_document_id?: string | null; received_at?: string }): CdFigureSource {
    need(!!i.source_id && !!i.party, "source_id and party are required");
    const list = this.sources.get(i.application_id) ?? []; const version = list.filter((s) => s.party === i.party).length + 1;
    const src: CdFigureSource = { source_id: i.source_id, application_id: i.application_id, party: i.party, version, received_at: i.received_at ?? this.clock.now(), payload_document_id: i.payload_document_id ?? null, payload: i.payload, hash: hashFigurePayload(i.payload), reconciled: false, variances: [] };
    list.push(src); this.sources.set(i.application_id, list);
    this.append("cd.figure_source.received", i.application_id, { source_id: src.source_id, party: src.party, version, hash: src.hash }, src.received_at);
    return src;
  }
  /** `reconcileFigureSources`: the version in force per party against the creditor's fee items (earlier versions are history); a reconciled settlement-agent version satisfies SM_O62_SETTLEMENT_FIGURES_5SBD. */
  reconcileFigureSources(applicationId: string, creditorFees: readonly CdFeeLine[], resolvedCodes: readonly string[] = []): CdFigureSource[] {
    const out: CdFigureSource[] = [];
    for (const src of latestFigureSources(this.figureSources(applicationId))) {
      const r = reconcileFigureSource(src, creditorFees, resolvedCodes); src.reconciled = r.reconciled; src.variances = r.variances;
      if (r.reconciled) this.append("cd.figure_source.reconciled", applicationId, { source_id: src.source_id, party: src.party, version: src.version, hash: src.hash, reconciled: true });
      out.push(src);
    }
    return out;
  }

  // ---- preparation ----
  /** `assembleCdFigures` + `renderCd` → a CD version row in `drafting`; emits `disclosure.cd.prepared{version}` (30.3's escrow-consistency gate runs on it). Asserts 21.2's LE 7-SBD gate for the scheduled consummation date first. */
  prepare(i: CdRenderInput & { required_consumer_ids: readonly string[]; redisclosure_triggers?: readonly RedisclosureTrigger[]; supersedes?: string | null; pdf_document_id?: string }): CdRow {
    need(i.required_consumer_ids.length > 0, "required_consumer_ids (every borrower; every rescinding consumer on a refinance)");
    if (this.rows.has(i.disclosure_id)) throw new CdRefused("DUPLICATE_VERSION", "25.2 data model: a version never changes after delivery", `CD ${i.disclosure_id} already exists`);
    const sched = this.scheduledClosing(i.application_id);
    let le_gate_asserted_on: PlainDate | null = null;
    if (this.le && sched) { this.le.assertGateOpen(i.application_id, sched.scheduled_on); le_gate_asserted_on = sched.scheduled_on; }
    const render = renderCd(i);
    const now = this.clock.now();
    const row: CdRow = { application_id: i.application_id, disclosure_id: i.disclosure_id, kind: i.cd_version === 1 ? "cd" : "corrected_cd", cd_version: i.cd_version, cd_reason: i.cd_reason, status: "drafting", rendered_at: now, render, input: i, required_consumer_ids: [...i.required_consumer_ids], redisclosure_triggers: [...(i.redisclosure_triggers ?? [])], new_waiting_period: i.cd_reason === "pre_consummation_new_wait", apr_calculation_id: i.apr.apr_calculation_id, figures_hash: render.figures_hash, figure_source_version: render.figure_source_version,
      gate_run_id: null, gate_open: false, apr_verdict: null, blocked_channels: [], delivered_at: null, earliest_consummation_date: null, waiver_id: null, superseded_by_disclosure_id: null, consummated_at: null, pdf_document_id: i.pdf_document_id ?? `DOC-CD-${i.disclosure_id}`, retention_class: RETENTION_CLASS, le_gate_asserted_on };
    this.rows.set(i.disclosure_id, row);
    if (i.supersedes) { const prev = this.get(i.supersedes); prev.superseded_by_disclosure_id = i.disclosure_id; if (prev.status !== "consummated" && prev.status !== "final") prev.status = "superseded"; }
    this.append("disclosure.cd.prepared", i.application_id, { version: `CD-${i.cd_version}`, disclosure_id: i.disclosure_id, cd_version: i.cd_version, cd_reason: i.cd_reason, kind: row.kind, figures_hash: render.figures_hash, figure_source_version: render.figure_source_version, apr_calculation_id: i.apr.apr_calculation_id, template_version: H25_TEMPLATE_VERSION,
      escrow: { established: i.escrow.established, monthly_escrow_cents: S(i.escrow.monthly_escrow_cents), initial_escrow_payment_cents: S(i.escrow.initial_escrow_payment_cents), escrowed_costs_year1_cents: S(i.escrow.escrowed_costs_year1_cents) }, notice_code: render.notice_code, retention_class: RETENTION_CLASS }, now);
    return row;
  }
  /** 25.1's CD checkpoint (`assertGateOpen(SM_O61_COMPLIANCE_PASS_CD_GATE)` → `compliance.gate.opened{gate=cd}`) recorded on the version: the run id, the APR verdict and any blocked channels (E-SIGN). */
  recordGateRun(disclosureId: string, g: { run_id: string; open: boolean; apr_verdict?: "pass" | "fail" | null; blocked_channels?: readonly string[] }): CdRow {
    const r = this.get(disclosureId); r.gate_run_id = g.run_id; r.gate_open = g.open; r.apr_verdict = g.apr_verdict ?? null; r.blocked_channels = [...(g.blocked_channels ?? [])];
    if (g.open && r.status === "drafting") r.status = "gated";
    return r;
  }
  // ---- delivery and receipt ----
  /** `deliverDisclosure` to one required consumer over the channel their consent allows; the version moves to `delivered`; the mailbox presumption starts unless in person. */
  deliver(disclosureId: string, d: { consumer_id: string; channel: CdDeliveryChannel; at?: string; esign_consent_id?: string | null; mailing_proof_id?: string | null; evidence_document_id?: string | null }): CdReceipt {
    const r = this.get(disclosureId); const at = d.at ?? this.clock.now();
    const refuse = (code: string, reason: string, citation: string): never => { this.append("disclosure.cd.delivery.refused", r.application_id, { disclosure_id: disclosureId, consumer_id: d.consumer_id, channel: d.channel, code, reason }, at); throw new CdRefused(code, citation, reason); };
    if (!r.required_consumer_ids.includes(d.consumer_id)) refuse("NOT_A_REQUIRED_CONSUMER", `${d.consumer_id} is not a required recipient of CD ${disclosureId}`, "§1026.17(d)");
    if (!r.gate_open) refuse("CD_GATE_NOT_OPEN", "25.1's SM_O61_COMPLIANCE_PASS_CD_GATE has not opened for this version (assertGateOpen first)", "25.2 integrations: assertGateOpen(SM_O61_COMPLIANCE_PASS_CD_GATE) before render/deliver");
    if (r.status === "superseded" || r.status === "consummated" || r.status === "final") refuse("VERSION_CLOSED", `CD ${disclosureId} is ${r.status}`, "25.2 state machine");
    if (isElectronicChannel(d.channel) && (r.blocked_channels.includes("electronic") || !d.esign_consent_id)) refuse("NO_ESIGN_CONSENT", "electronic delivery needs an unrevoked E-SIGN consent (25.1 ESIGN_7001C_CONSENT) — deliver by print/mail with the mailbox rule", "§1026.17(a)(1); 15 U.S.C. 7001(c)");
    if (d.channel === "mail" && !d.mailing_proof_id) refuse("NO_MAILING_PROOF", "a mailed CD needs the print vendor's USPS acceptance date as mailed_at", "25.2 integrations: print/mail");
    if (this.receiptsOf(disclosureId).some((x) => x.consumer_id === d.consumer_id)) refuse("ALREADY_DELIVERED", `CD ${disclosureId} was already delivered to ${d.consumer_id} (idempotent by disclosure_id + consumer_id)`, "25.2 integrations: e-delivery idempotency");
    const receipt = receiptOnDelivery({ receipt_id: `${disclosureId}:${d.consumer_id}`, disclosure_id: disclosureId, consumer_id: d.consumer_id, channel: d.channel, at, time_zone: this.time_zone, esign_consent_id: d.esign_consent_id ?? null, evidence_document_id: d.evidence_document_id ?? null });
    const list = this.receipts.get(disclosureId) ?? []; list.push(receipt); this.receipts.set(disclosureId, list);
    if (!r.delivered_at) r.delivered_at = at;
    if (r.status === "gated" || r.status === "drafting") r.status = r.cd_version > 1 && this.closing(r.application_id).consummation_at ? "corrected_post_consummation" : "delivered";
    this.append("disclosure.cd.delivered", r.application_id, { disclosure_id: disclosureId, cd_version: r.cd_version, cd_reason: r.cd_reason, consumer_id: d.consumer_id, channel: d.channel, in_person: d.channel === "in_person", delivered_on: receipt.delivered_on, delivered_at: at, mailed_at: receipt.mailed_at, mailing_proof_id: d.mailing_proof_id ?? null, presumed_receipt_date: receipt.presumed_receipt_date, esign_consent_id: receipt.esign_consent_id, notice_code: r.render.notice_code, template_version: H25_TEMPLATE_VERSION }, at);
    if (d.channel === "in_person") this.emitReceived(r, receipt, at);
    return receipt;
  }
  /** The version whose receipts govern the waiting period: the initial CD or the latest corrected CD that started a new one ((f)(2)(ii)); a no-wait correction ((f)(2)(i)) only has to be received at or before consummation. */
  waitVersion(applicationId: string): CdRow | undefined { return this.versions(applicationId).filter((v) => v.cd_version === 1 || v.new_waiting_period).at(-1); }
  private emitReceived(r: CdRow, receipt: CdReceipt, at: string): WaitingPeriod {
    const wp = computeEarliestConsummation(this.receiptsOf(r.disclosure_id), r.required_consumer_ids);
    const startsWait = r.cd_version === 1 || r.new_waiting_period;
    this.append("disclosure.cd.received", r.application_id, { disclosure_id: r.disclosure_id, cd_version: r.cd_version, cd_reason: r.cd_reason, starts_waiting_period: startsWait, consumer_id: receipt.consumer_id, evidence: receipt.receipt_evidence, received_on: receipt.actual_receipt_at ? civilDate(receipt.actual_receipt_at, this.time_zone) : null, effective_receipt_date: wp.complete ? wp.latest_effective_receipt_date : receipt.effective_receipt_date, consumer_effective_receipt_date: receipt.effective_receipt_date, all_required: wp.complete, missing_consumer_ids: wp.missing_consumer_ids }, at);
    if (wp.complete && r.status !== "consummated" && r.status !== "final" && r.status !== "superseded" && r.status !== "corrected_post_consummation") {
      r.status = "received";
      if (startsWait) {
        r.earliest_consummation_date = wp.earliest_consummation_date;
        this.append("disclosure.cd.waiting_period.computed", r.application_id, { disclosure_id: r.disclosure_id, cd_version: r.cd_version, earliest_consummation_date: wp.earliest_consummation_date, latest_effective_receipt_date: wp.latest_effective_receipt_date, calendar: "business_days_regz_specific", receipts: wp.receipts }, at);
      } else { const wv = this.waitVersion(r.application_id); r.earliest_consummation_date = wv?.earliest_consummation_date ?? null; }
      r.status = "waiting";
    }
    return wp;
  }
  /** `recordReceipt`: evidence of an enumerated kind tied to the consumer rebuts the presumption; when every required consumer has an effective date the version is `received` and the waiting period is published. */
  recordReceipt(disclosureId: string, ev: { consumer_id: string; evidence: string; at: string; evidence_document_id: string | null; time_zone?: string }): { receipt: CdReceipt; waiting_period: WaitingPeriod } {
    const r = this.get(disclosureId); const list = this.receipts.get(disclosureId) ?? [];
    const k = list.findIndex((x) => x.consumer_id === ev.consumer_id); if (k < 0) throw new CdRefused("NOT_DELIVERED", "25.2 'no mark received without an uploaded evidence document' / no delivery to evidence receipt of", `CD ${disclosureId} was not delivered to ${ev.consumer_id}`);
    const cur = list[k]!; if (cur.receipt_evidence && cur.receipt_evidence !== "mailbox_rule") return { receipt: cur, waiting_period: computeEarliestConsummation(list, r.required_consumer_ids) };
    const receipt = rebutPresumption(cur, { evidence: ev.evidence, at: ev.at, time_zone: ev.time_zone ?? this.time_zone, evidence_document_id: ev.evidence_document_id }); list[k] = receipt;
    return { receipt, waiting_period: this.emitReceived(r, receipt, ev.at) };
  }
  /** Mailbox sweep on/after each presumed date: consumers without evidence are deemed received; the gate then runs from the presumed date. */
  deemReceived(disclosureId: string, today: PlainDate): WaitingPeriod {
    const r = this.get(disclosureId); const list = this.receipts.get(disclosureId) ?? [];
    list.forEach((x, k) => { if (!x.receipt_evidence) { const d = deemReceipt(x, today); if (d !== x) { list[k] = d; this.emitReceived(r, d, this.clock.now()); } } });
    return computeEarliestConsummation(list, r.required_consumer_ids);
  }
  /** `computeEarliestConsummation` for a version: the waiting period from the receipts on file (incomplete while a required consumer lacks a receipt). */
  computeEarliestConsummation(disclosureId: string): WaitingPeriod { const r = this.get(disclosureId); return computeEarliestConsummation(this.receiptsOf(disclosureId), r.required_consumer_ids); }
  // ---- waiver ----
  /** §1026.19(f)(1)(iv): the consumer's own statement, accepted by `officer`; the version moves `waiting` → `consummation_ready`. */
  acceptWaiver(disclosureId: string, w: CdWaiverInput, acceptance: { by: Actor; at?: string }): CdWaiver {
    const r = this.get(disclosureId); const at = acceptance.at ?? this.clock.now();
    if (acceptance.by.kind !== "human" || acceptance.by.role !== "officer") throw new CdRefused("OFFICER_ONLY", "25.2 guardrail 'never shorten the waiting period except through a cd_waivers row accepted by officer'", `waiver acceptance is the partner officer's act, not ${acceptance.by.kind}:${acceptance.by.id}`);
    const wp = this.computeEarliestConsummation(disclosureId);
    validateWaiverStatement(w, r.required_consumer_ids, wp.latest_effective_receipt_date);
    const accepted_on = civilDate(at, this.time_zone); const earliest = waiverEarliestConsummation(accepted_on, wp.latest_effective_receipt_date!);
    const waiver: CdWaiver = { ...w, accepted_by: acceptance.by.id, accepted_at: at, accepted_on, earliest_consummation_date: earliest };
    this.waivers.set(w.waiver_id, waiver); r.waiver_id = w.waiver_id; r.earliest_consummation_date = earliest; r.status = "consummation_ready";
    this.append("disclosure.cd.waiver.accepted", r.application_id, { disclosure_id: disclosureId, cd_version: r.cd_version, waiver_id: w.waiver_id, consumer_ids: w.consumer_ids, statement_document_id: w.statement_document_id, accepted_by: acceptance.by.id, accepted_role: "officer", accepted_on, earliest_consummation_date: earliest, not_before_receipt: wp.latest_effective_receipt_date }, at, acceptance.by);
    return waiver;
  }
  waiver(waiverId: string): CdWaiver | undefined { return this.waivers.get(waiverId); }
  // ---- the gate and consummation ----
  gateFacts(applicationId: string, requestedOn: PlainDate): Cd3sbdGateFacts {
    const cur = this.current(applicationId); const wv = this.waitVersion(applicationId);
    if (!cur || !wv) return { requested_on: requestedOn, receipts_complete: false, earliest_consummation_date: null };
    const wp = computeEarliestConsummation(this.receiptsOf(wv.disclosure_id), wv.required_consumer_ids);
    let receipts_complete = wp.complete;
    // a no-wait corrected version ((f)(2)(i)) must itself be received by every required consumer at or before consummation
    if (cur !== wv) { const cp = computeEarliestConsummation(this.receiptsOf(cur.disclosure_id), cur.required_consumer_ids); receipts_complete = receipts_complete && cp.complete && cp.latest_effective_receipt_date! <= requestedOn; }
    const waiver = (cur.waiver_id ?? wv.waiver_id) ? this.waivers.get(cur.waiver_id ?? wv.waiver_id!) : undefined;
    return { requested_on: requestedOn, receipts_complete, earliest_consummation_date: wp.earliest_consummation_date, waiver_accepted_on: waiver ? waiver.earliest_consummation_date : null };
  }
  /** `assertGateOpen(REGZ_1026_19F1_CD_3SBD_GATE)` for the `consummate` command (26.x). */
  assertGateOpen(applicationId: string, requestedOn: PlainDate): void { assertCd3sbdGateOpen(this.gateFacts(applicationId, requestedOn)); }
  /** `consummate`: refused while the gate is closed; otherwise the version in force is `consummated` and `disclosure.cd.consummated{version}` is appended (26.3 / 30.2 reconcile to it; FNMA_UCD_ACCEPTED_GATE arms). */
  consummate(applicationId: string, c: { at: string; requested_on?: PlainDate }): CdRow {
    const on = c.requested_on ?? civilDate(c.at, this.time_zone); this.assertGateOpen(applicationId, on);
    const r = this.current(applicationId)!; const cl = this.closing(applicationId); cl.consummation_at = c.at; cl.consummation_on = on;
    for (const v of this.versions(applicationId)) if (v.disclosure_id !== r.disclosure_id && v.status !== "superseded") { v.status = "superseded"; v.superseded_by_disclosure_id = r.disclosure_id; }
    r.status = "consummated"; r.consummated_at = c.at;
    this.append("disclosure.cd.consummated", applicationId, { version: `CD-${r.cd_version}`, disclosure_id: r.disclosure_id, cd_version: r.cd_version, consummation_at: c.at, consummation_on: on, earliest_consummation_date: r.earliest_consummation_date, waiver_id: r.waiver_id, event_window_to: postConsummationEventWindow(on).to }, c.at);
    return r;
  }
  // ---- redisclosure and corrections ----
  evaluateRedisclosure(disclosureId: string, next: RedisclosureInput["next"], opts: { transaction?: TransactionShape; apr_verdict?: AprAccuracy | null; as_of?: PlainDate } = {}): RedisclosureEvaluation {
    const r = this.get(disclosureId);
    return evaluateRedisclosure({ prev: { apr_disclosed: r.input.apr.apr_pct, finance_charge_cents: r.input.apr.finance_charge_cents, product: r.input.loan.product, prepayment_penalty: r.input.loan.prepayment_penalty }, next, ...(opts.transaction ? { transaction: opts.transaction } : {}), apr_verdict: opts.apr_verdict ?? null, ...(opts.as_of ? { as_of: opts.as_of } : {}) });
  }
  /** A post-consummation correction event: classifies the regime, appends `disclosure.cd.correction.required{regime}` (arms the 30/60-day clock) and returns the due date. */
  recordCorrectionEvent(applicationId: string, e: Omit<CorrectionEventInput, "consummation_on"> & { description: string; info_received_at?: string }): CorrectionClassification {
    const cl = this.closing(applicationId); need(!!cl.consummation_on, "no consummation recorded — a pre-consummation change goes through evaluateRedisclosure");
    const c = classifyPostConsummationCorrection({ ...e, consummation_on: cl.consummation_on! });
    this.append("disclosure.cd.correction.required", applicationId, { regime: c.regime, timer: c.timer, due_on: c.due_on, info_received_on: e.info_received_on, event_on: e.event_on, consummation_on: cl.consummation_on, window_from: c.window.from, window_to: c.window.to, description: e.description, citation: c.citation }, e.info_received_at);
    return c;
  }
  /** `scheduleCorrectedCd`: renders and delivers the next version. Pre-consummation: `pre_consummation_new_wait` (new receipts → new waiting period) or `pre_consummation_no_wait` (receipt at or before consummation; refused when 25.1's APR verdict is `fail`). Post-consummation: `disclosure.cd.corrected{reason}` satisfies the 30/60-day rows and, before purchase, arms the UCD resubmission clock. 21.5's `runToleranceTest` runs at every version. */
  scheduleCorrectedCd(applicationId: string, i: { disclosure_id: string; cd_reason: Exclude<CdReason, "initial">; input: Omit<CdRenderInput, "application_id" | "disclosure_id" | "cd_version" | "cd_reason">; evaluation?: RedisclosureEvaluation | null; gate: { run_id: string; apr_verdict: "pass" | "fail"; blocked_channels?: readonly string[] }; deliveries: readonly { consumer_id: string; channel: CdDeliveryChannel; at: string; esign_consent_id?: string | null; mailing_proof_id?: string | null; evidence_document_id?: string | null }[]; pdf_document_id?: string }): { row: CdRow; corrected_event: DomainEvent; tolerance_test_invoked: boolean } {
    const prev = this.current(applicationId); need(!!prev, `no CD in force for ${applicationId}`);
    const cl = this.closing(applicationId); const post = !!cl.consummation_at;
    if (i.cd_reason === "pre_consummation_no_wait" && (i.gate.apr_verdict === "fail" || i.evaluation?.new_wait)) throw new CdRefused("NO_WAIT_WITH_APR_FAIL", "25.2 guardrail 'never issue a no-wait corrected CD when 25.1's APR verdict is fail'; §1026.19(f)(2)(ii)(A)", "the APR became inaccurate — a new three-business-day waiting period is required (cd_reason = pre_consummation_new_wait)");
    if ((i.cd_reason === "pre_consummation_no_wait" || i.cd_reason === "pre_consummation_new_wait") && post) throw new CdRefused("ALREADY_CONSUMMATED", "§1026.19(f)(2)(iii)–(v)", "after consummation a correction is post_consummation_event, clerical or tolerance_refund");
    const row = this.prepare({ ...i.input, application_id: applicationId, disclosure_id: i.disclosure_id, cd_version: prev!.cd_version + 1, cd_reason: i.cd_reason, required_consumer_ids: prev!.required_consumer_ids, redisclosure_triggers: i.evaluation?.triggers ?? [], supersedes: post ? null : prev!.disclosure_id, ...(i.pdf_document_id ? { pdf_document_id: i.pdf_document_id } : {}) });
    this.recordGateRun(i.disclosure_id, { run_id: i.gate.run_id, open: true, apr_verdict: i.gate.apr_verdict, blocked_channels: i.gate.blocked_channels ?? [] });
    let tolerance_test_invoked = false;
    if (this.tolerance) { this.tolerance.runToleranceTest({ application_id: applicationId, stage: post ? "post_consummation" : "cd_corrected", disclosure_id: i.disclosure_id, fee_items: i.input.fees }); tolerance_test_invoked = true; }
    this.tolerance_runs.push({ application_id: applicationId, stage: post ? "post_consummation" : "cd_corrected", disclosure_id: i.disclosure_id });
    need(i.deliveries.length > 0, "a corrected CD is delivered or placed in the mail to every required consumer");
    for (const d of i.deliveries) this.deliver(i.disclosure_id, d);
    const first = this.receiptsOf(i.disclosure_id)[0]!;
    const before_purchase = !cl.loan_purchased_on;
    const corrected_event = this.append("disclosure.cd.corrected", applicationId, { disclosure_id: i.disclosure_id, cd_version: row.cd_version, reason: i.cd_reason, new_waiting_period: i.cd_reason === "pre_consummation_new_wait", triggers: i.evaluation?.triggers ?? [], test_ids: i.evaluation?.test_ids ?? [], supersedes: prev!.disclosure_id, post_consummation: post, before_purchase, delivered_on: first.delivered_on, channel: first.delivery_channel, mailed_at: first.mailed_at, notice_code: "NTC_REGZ_1026_38_CD_CORRECTED", ucd_resubmit_due: post && before_purchase ? ucdResubmitDueDate(first.delivered_on) : null }, i.deliveries[0]!.at);
    if (post) { row.status = "final"; prev!.superseded_by_disclosure_id = i.disclosure_id; }
    return { row, corrected_event, tolerance_test_invoked };
  }
  // ---- seller CD, consistency checks, UCD, breaches ----
  /** §1026.19(f)(4)(iv): the settlement agent's copy of the seller's CD (no later than the day of consummation) — satisfies REGZ_1026_19F4_SELLER_CD_GATE. */
  recordSellerCd(applicationId: string, s: { document_id: string; received_at: string; provided_by: string }): DomainEvent {
    need(!!s.document_id, "the seller CD copy document is required"); const cl = this.closing(applicationId); const on = civilDate(s.received_at, this.time_zone);
    cl.seller_cd_received_on = on; cl.seller_cd_document_id = s.document_id;
    const d = this.delivery(applicationId); d.incomplete_reasons = d.incomplete_reasons.filter((x) => x !== "seller_cd_missing"); d.package_complete = d.incomplete_reasons.length === 0;
    return this.append("disclosure.seller_cd.received", applicationId, { document_id: s.document_id, received_on: on, provided_by: s.provided_by, notice_code: "NTC_REGZ_1026_38_SELLER_CD", retention_class: RETENTION_CLASS }, s.received_at);
  }
  /** Breach of REGZ_1026_19F4_SELLER_CD_GATE: escalation to `settlement_agent` (SLA 1 business_days_creditor); the delivery package is incomplete until the copy arrives. */
  onSellerCdGateBreached(applicationId: string, at: string): { escalation_id: string | null; package_complete: false } {
    const on = civilDate(at, this.time_zone); const d = this.delivery(applicationId); d.package_complete = false; d.incomplete_reasons = [...new Set([...d.incomplete_reasons, "seller_cd_missing"])];
    const escalation_id = this.esc ? this.esc.open({ kind: "settlement_agent", applicationId, payload: { timer: "REGZ_1026_19F4_SELLER_CD_GATE", reason: "seller CD copy not received by the day of consummation (§1026.19(f)(4)(ii), (iv))", sla_due: settlementAgentSlaDue(on), sla_unit: "business_days_creditor" } }, AGENT).id : null;
    this.append("delivery.package.incomplete", applicationId, { reason: "seller_cd_missing", timer: "REGZ_1026_19F4_SELLER_CD_GATE", escalation_id }, at);
    return { escalation_id, package_complete: false };
  }
  /** Breach of SM_O62_SETTLEMENT_FIGURES_5SBD: settlement-agent figures late — escalation with SLA 1 business_days_creditor. */
  onSettlementFiguresBreached(applicationId: string, at: string): string | null {
    const on = civilDate(at, this.time_zone);
    return this.esc ? this.esc.open({ kind: "settlement_agent", applicationId, payload: { timer: "SM_O62_SETTLEMENT_FIGURES_5SBD", reason: "settlement figures not reconciled five specific business days before consummation", sla_due: settlementAgentSlaDue(on), sla_unit: "business_days_creditor" } }, AGENT).id : null;
  }
  /** Breach of the 30/60-day correction clocks: sev 1 (30-day event) / sev 2 (clerical) to `officer`. */
  onCorrectionClockBreached(applicationId: string, code: "REGZ_1026_19F2_CORRECTED_CD_30" | "REGZ_1026_19F2_CLERICAL_CD_60"): string | null {
    return this.esc ? this.esc.open({ kind: "officer", severity: code === "REGZ_1026_19F2_CORRECTED_CD_30" ? "sev1" : "sev2", applicationId, payload: { timer: code, reason: `${code} breached — corrected Closing Disclosure not delivered or placed in the mail in time (§1026.19(f)(2)(${code.endsWith("30") ? "iii" : "iv"}))` } }, AGENT).id : null;
  }
  runCdConsistencyChecks(disclosureId: string, source: Partial<Record<ConsistencyCheckCode, ConsistencyValue>>, cdOverride: Partial<Record<ConsistencyCheckCode, ConsistencyValue>> = {}): { checks: CdConsistencyCheck[]; result: "match" | "mismatch"; blocked: ReturnType<typeof closingDocumentsBlocked> } {
    const r = this.get(disclosureId); const i = r.input;
    const cd: Partial<Record<ConsistencyCheckCode, ConsistencyValue>> = { CD_NOTE_LOAN_AMOUNT: i.loan.loan_amount_cents, CD_NOTE_RATE: i.loan.rate_pct, CD_NOTE_TERM: i.loan.term_months, CD_NOTE_FIRST_PAYMENT_DATE: i.loan.first_payment_date, CD_NOTE_MATURITY_DATE: i.loan.maturity_date, CD_NOTE_PI: i.loan.pi_cents, CD_NOTE_PREPAY: i.loan.prepayment_penalty, CD_BORROWER_NAMES_VESTING: [...i.parties.borrowers], CD_PROPERTY_ADDRESS: i.property_address, CD_NMLSR_IDS: { creditor: i.parties.creditor_nmlsr_id, mlo: i.parties.mlo_nmlsr_id }, CD_ESCROW_VS_O11_3: i.escrow.established ? { initial: i.escrow.initial_escrow_payment_cents, monthly: i.escrow.monthly_escrow_cents } : null, CD_CASH_TO_CLOSE_VS_SETTLEMENT_LEDGER: i.cash_to_close_cents, ...cdOverride };
    const now = this.clock.now(); const checks = runCdConsistencyChecks({ application_id: r.application_id, cd_version: r.cd_version, cd, source, now });
    const all = (this.checks.get(r.application_id) ?? []).filter((c) => c.cd_version !== r.cd_version); all.push(...checks); this.checks.set(r.application_id, all);
    const blocked = closingDocumentsBlocked(checks); const result = blocked.blocked ? "mismatch" : "match";
    this.append("cd.consistency.checked", r.application_id, { disclosure_id: disclosureId, cd_version: r.cd_version, result, mismatches: blocked.mismatches.map((m) => m.check_code), consumer: "26.1 generateClosingDocuments", blocked: blocked.blocked }, now);
    return { checks, result, blocked };
  }
  generateUcd(applicationId: string, i: Omit<UcdGenerateInput, "application_id" | "cd"> & { disclosure_id?: string }): UcdSubmission {
    const r = i.disclosure_id ? this.get(i.disclosure_id) : this.current(applicationId); need(!!r, `no CD for ${applicationId}`);
    const sub = generateUcd({ ...i, application_id: applicationId, loan_id: i.loan_id ?? null, cd: { disclosure_id: r!.disclosure_id, cd_version: r!.cd_version, status: r!.status, pdf_document_id: r!.pdf_document_id, figures_hash: r!.figures_hash } });
    const list = this.ucds.get(applicationId) ?? []; list.push(sub); this.ucds.set(applicationId, list);
    this.append("ucd.generated", applicationId, { ucd_submission_id: sub.ucd_submission_id, ucd_version: sub.ucd_version, schema: UCD_SCHEMA, embedded_cd_disclosure_id: sub.embedded_cd_disclosure_id, embedded_cd_version: sub.embedded_cd_version, du_casefile_id: sub.du_casefile_id, xml_hash: sub.xml_hash, channel: sub.channel });
    return sub;
  }
  /** `submitUcd` over `fnma-ucd` DI (or the UI fallback by `fnma_portal_operator`): the response's status, casefile ID and critical-edit failures are recorded; `ucd.accepted{is_final=true}` when the embedded CD is the final version and no critical edit failed. */
  submitUcd(applicationId: string, ucdSubmissionId: string, response: { status: Exclude<UcdStatus, "generated" | "submitted">; casefile_id_ucd: string | null; critical_edit_failures: number; feedback_messages?: readonly string[]; at?: string; channel?: "di" | "ui"; submitted_by?: Actor }): UcdSubmission {
    const sub = this.ucdSubmissions(applicationId).find((s) => s.ucd_submission_id === ucdSubmissionId); if (!sub) throw new RangeError(`no UCD submission ${ucdSubmissionId}`);
    const at = response.at ?? this.clock.now(); const r = this.current(applicationId); const finalCd = r && (r.status === "consummated" || r.status === "final") ? r.disclosure_id : null;
    sub.submitted_at = at; sub.status = "submitted";
    this.append("ucd.submitted", applicationId, { ucd_submission_id: ucdSubmissionId, ucd_version: sub.ucd_version, channel: response.channel ?? sub.channel, embedded_cd_disclosure_id: sub.embedded_cd_disclosure_id, xml_hash: sub.xml_hash }, at, response.submitted_by);
    sub.status = response.status; sub.casefile_id_ucd = response.casefile_id_ucd; sub.critical_edit_failures = response.critical_edit_failures; sub.feedback_messages = [...(response.feedback_messages ?? [])];
    const accepted = (response.status === "accepted" || response.status === "accepted_with_warnings") && response.critical_edit_failures === 0;
    sub.is_final = accepted && sub.embedded_cd_disclosure_id === finalCd;
    if (accepted) {
      if (sub.is_final) { for (const o of this.ucdSubmissions(applicationId)) if (o !== sub) o.is_final = false; this.delivery(applicationId).ucd_casefile_id = response.casefile_id_ucd; }
      this.append("ucd.accepted", applicationId, { ucd_submission_id: ucdSubmissionId, status: response.status, casefile_id_ucd: response.casefile_id_ucd, critical_edit_failures: 0, embedded_cd_disclosure_id: sub.embedded_cd_disclosure_id, embedded_cd_version: sub.embedded_cd_version, is_final: sub.is_final, feedback_messages: sub.feedback_messages }, at, response.submitted_by);
    } else this.append("ucd.rejected", applicationId, { ucd_submission_id: ucdSubmissionId, status: response.status, critical_edit_failures: response.critical_edit_failures, feedback_messages: sub.feedback_messages, embedded_cd_disclosure_id: sub.embedded_cd_disclosure_id, business_failure: response.status === "rejected" }, at, response.submitted_by);
    return sub;
  }
  ucdGateFacts(applicationId: string): UcdGateFacts {
    const r = this.current(applicationId);
    return { final_cd_disclosure_id: r && (r.status === "consummated" || r.status === "final") ? r.disclosure_id : null, submissions: this.ucdSubmissions(applicationId).map((s) => ({ status: s.status, critical_edit_failures: s.critical_edit_failures, embedded_cd_disclosure_id: s.embedded_cd_disclosure_id, is_final: s.is_final })), loan_delivered: !!this.closing(applicationId).loan_delivered_on };
  }
  /** `submitDelivery` (29.3) composes this: refused until FNMA_UCD_ACCEPTED_GATE is open. */
  assertUcdGateOpen(applicationId: string): void { assertUcdGateOpen(this.ucdGateFacts(applicationId)); }
  /** Decision record for the disclosure agent's run over a version. */
  decisionRecord(disclosureId: string, run: { model_version: string; prompt_version: string; rationale: string; redisclosure_evaluation?: RedisclosureEvaluation | null; ucd_submission_id?: string | null; confidence?: number }): Record<string, unknown> {
    const r = this.get(disclosureId);
    return { disclosure_id: disclosureId, cd_version: r.cd_version, figure_source_versions: r.figure_source_version, gate_run_id: r.gate_run_id, receipts: this.receiptsOf(disclosureId).map((x) => ({ consumer_id: x.consumer_id, evidence: x.receipt_evidence, effective_receipt_date: x.effective_receipt_date })), earliest_consummation_date: r.earliest_consummation_date,
      redisclosure_evaluation: run.redisclosure_evaluation ? { triggers: run.redisclosure_evaluation.triggers, new_wait: run.redisclosure_evaluation.new_wait } : null, ucd_submission_id: run.ucd_submission_id ?? null, rationale: run.rationale, rule_set_version: RULE_SET_25_2, model_version: run.model_version, prompt_version: run.prompt_version, confidence: run.confidence ?? 1 };
  }
}
