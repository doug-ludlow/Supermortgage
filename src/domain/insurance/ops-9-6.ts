/**
 * §9.6 Flood insurance / mandatory purchase — the operating cycle over the ./flood.ts, ./refund.ts and ./ops.ts
 * calculators (all read-only here): vendor life-of-loan ingestion (SFHDF determination results, map-change
 * notifications, community-status changes, LOMA/LOMR letters — the `flood` adapter, 00b N5), the coverage
 * requirement and deficiency detection (rules 1–3), the 45-day FDPA notice with its proof of mailing (rule 4),
 * placement on t0 + 45 (rule 5), borrower evidence receipt and evaluation (42 U.S.C. §4012a(e)(4); rule 2),
 * termination + refund within 30 days (§4012a(e)(3); rule 6), the LOMA release (rule 7), the vendor heartbeat
 * (edge "Vendor outage/LOL gap") and Fannie Mae evidence requests (B-3-01, 10 business days).
 *
 * Every event a §9.6 timer row names is appended here by a real code path (timers-9-6.ts cites them):
 *   `flood.lol.message.received`               receiveVendorMessage / recordDeterminationResult   (FLOOD_LOL_HEARTBEAT_35)
 *   `flood.map_change.received{direction}`     receiveVendorMessage                               (FNMA_B301_FLOOD_REMAP_COVERAGE_120, NFIP_44CFR6111_MAP_REVISION_1DAY_13M)
 *   `flood.deficiency.detected`                evaluateFloodCoverage                              (INS_FLOOD_NOTICE_SLA_3BD trigger)
 *   `flood.fpi.notice.sent{template}`          recordFloodNoticeMailed / sendFloodNotice45         (INS_FLOOD_NOTICE_SLA_3BD satisfied; FDPA_4012A_E_* triggers)
 *   `flood.lpi.bound` + `flood.coverage.verified`  bindFloodLpiPlacement / requestFloodLpi         (FDPA_4012A_E2_FLOOD_PLACE_AFTER_45, FNMA 120, NFIP 13M satisfied)
 *   `insurance.evidence.received{kind=flood, fpi_active}`  receiveFloodEvidence                    (FLOOD_EVIDENCE_EVAL_2BD, FDPA_4012A_E3 triggers)
 *   `insurance.evidence.evaluated{kind=flood, outcome}`    evaluateFloodEvidence                   (FLOOD_EVIDENCE_EVAL_2BD satisfied)
 *   `flood.lpi.terminated` → `flood.refund.paid` + `fpi.lpi.cancelled_and_refunded{track=fdpa_flood}`  terminateFloodLpi / payFloodRefund  (FDPA_4012A_E3 satisfied)
 *   `fnma.request.received{kind=flood_evidence}` / `fnma.request.responded{kind=flood_evidence}`  receiveFnmaEvidenceRequest / respondFnmaEvidenceRequest
 * bigint cents; PlainDate; calendars as the spec names them (servicer for the 3-BD/2-BD policy clocks, fannie_et for B-3-01).
 */
import { type PlainDate, addDays, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/types.ts";
import type { EventStore } from "../../kernel/events/store.ts";
import type { LpiTrackingPort, FloodDetermination } from "../../infra/integrations/property.ts";
import type { NoticeService, Notice } from "../../notices/service.ts";
import type { Recipient, ChannelContext } from "../../notices/channel.ts";
import { floodRequired, floodRequiredAmount, floodAdequate, privatePolicyAcceptable, floodNoticeClocks, bindFloodLpi, placementEffective, nfipEffectiveDate, fnmaEvidenceDue, fnmaEvidencePackage, type FloodRequirementInput } from "./flood.ts";
import { cancellation, type LpiTerm, type CancellationResult } from "./refund.ts";
import { lomaLetter, vendorHeartbeatCheck } from "./ops.ts";

const ET = "America/New_York";
export const FLOOD_NOTICE_45 = "INS_FLOOD_FPI_NOTICE_45" as const;
export const FLOOD_TRACK = "fdpa_flood" as const;
export const FLOOD_NOTICE_SLA_BD = 3;        // INS_FLOOD_NOTICE_SLA_3BD (policy; statute says "shall notify")
export const FLOOD_EVIDENCE_EVAL_BD = 2;     // FLOOD_EVIDENCE_EVAL_2BD (policy)
export const FLOOD_TERMINATE_REFUND_DAYS = 30; // 42 U.S.C. §4012a(e)(3)
export const FNMA_REMAP_COVERAGE_DAYS = 120; // B-3-01
export const FLOOD_LOL_HEARTBEAT_DAYS = 35;  // FLOOD_LOL_HEARTBEAT_35
export const NFIP_MAP_REVISION_WINDOW_MONTHS = 13; // 44 CFR 61.11
export const FLOOD_VENDOR_MESSAGE_KINDS = ["determination_result", "map_change_notification", "community_status_change", "lomr_loma_received"] as const;
export type FloodVendorMessageKind = (typeof FLOOD_VENDOR_MESSAGE_KINDS)[number];
export type MapChangeDirection = "into_sfha" | "out_of_sfha" | "zone_change_within" | "community_change";
export type ProgramStatus = "regular" | "emergency" | "suspended" | "non_participating";
export type FloodDeficiency = "flood_none" | "flood_insufficient" | "flood_deductible" | "flood_private_unacceptable";

export interface FloodEscalations { open(input: { kind: "sev1" | "sev2" | "officer"; loanId?: string; ownerRole?: string; severity?: string; payload: Record<string, unknown> }, by: Actor): unknown; }
export interface FloodDeps {
  readonly events: EventStore;
  readonly actor?: Actor;
  /** `insurance-tracking/lpi` port (MPPP / private LPI flood) — optional; the event trail is the system of record either way. */
  readonly lpi?: LpiTrackingPort;
  /** Notice Registry — required to produce the 45-day notice (rule 4: notices come from the registry only). */
  readonly notices?: NoticeService;
  readonly escalations?: FloodEscalations;
  readonly servicerCalendar?: Calendar;
  readonly fannieCalendar?: Calendar;
}
const actorOf = (d: FloodDeps): Actor => d.actor ?? SYSTEM;
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || v.trim() === "") throw new RangeError(`${what} is required`); return v; };
const isoInstant = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || Number.isNaN(Date.parse(s))) throw new RangeError(`${what} must be an ISO instant`); return s; };
const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
const payload = <T extends Record<string, unknown>>(e: DomainEvent): T => e.payload as T;
const byLoan = (d: FloodDeps, loanId: string, type: string): readonly DomainEvent[] => d.events.byLoan(loanId).filter((e) => e.type === type);

// ---- vendor life-of-loan feed (inputs: `flood` adapter) -------------------------------------------------------
export interface FloodStructure { readonly name: string; readonly in_sfha: boolean; readonly residential: boolean; readonly security: boolean; readonly principal: boolean; }
export interface FloodDeterminationData {
  readonly zone: string; readonly sfha: boolean; readonly cbrs_opa: boolean; readonly community_number: string; readonly community_name?: string;
  readonly participating: boolean; readonly program_status: ProgramStatus; readonly map_panel: string; readonly map_date: PlainDate; readonly lol: boolean;
  readonly structures: readonly FloodStructure[]; readonly determination_type: "boarding" | "reorder" | "lol_update" | "map_change" | "manual_review" | "loma_lomr"; readonly sfhdf_document_id?: string;
}
export interface FloodMapChangeData { readonly effective_date: PlainDate; readonly old_zone: string | null; readonly new_zone: string; readonly sfha_before: boolean; readonly sfha_after: boolean; readonly map_panel?: string; }
export interface FloodCommunityData { readonly community_number: string; readonly status: ProgramStatus; readonly effective_date: PlainDate; }
export interface FloodLomaData { readonly letter_type: "LOMA" | "LOMR"; readonly letter_date: PlainDate; readonly document_id: string; }
export interface FloodVendorMessage {
  readonly kind: FloodVendorMessageKind;
  readonly vendor_id: string;
  /** Vendor certificate id — the idempotency key (00b N5). */
  readonly certificate_id: string;
  readonly received_at: string;   // ISO instant
  readonly loan_id?: string; readonly property_id?: string;
  readonly determination?: FloodDeterminationData; readonly map_change?: FloodMapChangeData; readonly community?: FloodCommunityData; readonly loma?: FloodLomaData;
}
export interface VendorMessageResult {
  readonly duplicate: boolean; readonly kind: FloodVendorMessageKind; readonly heartbeat_due: PlainDate;
  readonly direction?: MapChangeDirection; readonly fnma_deadline?: PlainDate | null; readonly nfip_one_day_until?: PlainDate;
  readonly coverage_required?: boolean; readonly private_only?: boolean; readonly required_notice?: string | null;
}

/** Rule 1 (B7-3-06 table): the principal structure any part in the SFHA, or a residential detached structure serving as security; non-residential detached or non-security structures do not trigger. */
export function structuresToRequirement(structures: readonly FloodStructure[], participating: boolean, cbrsOpa: boolean): FloodRequirementInput {
  return { principal_structure_in_sfha: structures.some((s) => s.principal && s.in_sfha), detached_security_structure_in_sfha: structures.some((s) => !s.principal && s.residential && s.security && s.in_sfha), cbrs_opa: cbrsOpa, participating_community: participating };
}
export function mapChangeDirection(mc: FloodMapChangeData): MapChangeDirection {
  return !mc.sfha_before && mc.sfha_after ? "into_sfha" : mc.sfha_before && !mc.sfha_after ? "out_of_sfha" : "zone_change_within";
}

/** Idempotency by vendor certificate id (00b N5): the same (certificate, kind, instant) is ingested once. */
export function isDuplicateVendorMessage(d: FloodDeps, k: { certificate_id: string; kind: FloodVendorMessageKind; received_at: string }): boolean {
  return d.events.ofType("flood.lol.message.received").some((e) => { const p = payload<{ certificate_id?: unknown; kind?: unknown; received_at?: unknown }>(e); return p.certificate_id === k.certificate_id && p.kind === k.kind && p.received_at === k.received_at; });
}
/**
 * Ingestion handler for every inbound vendor message. Validates the record (kind, vendor, certificate id, instant),
 * de-duplicates by (certificate id, kind, instant), and appends `flood.lol.message.received` on the vendor aggregate
 * (the heartbeat FLOOD_LOL_HEARTBEAT_35 arms on and is satisfied by any vendor message) before the message-specific
 * events: `flood.determination.received` + `flood.coverage.required|not_required`, `flood.map_change.received{direction,
 * effective_date}` (+ `flood.coverage.required|not_required`), `flood.community_status.changed`, `flood.loma.received`.
 */
export function receiveVendorMessage(d: FloodDeps, m: FloodVendorMessage): VendorMessageResult {
  if (!FLOOD_VENDOR_MESSAGE_KINDS.includes(m.kind)) throw new RangeError(`unknown flood vendor message kind ${String(m.kind)}`);
  const vendorId = nonEmpty(m.vendor_id, "vendor_id"); const certificateId = nonEmpty(m.certificate_id, "certificate_id (vendor certificate id — the idempotency key)"); const receivedAt = isoInstant(m.received_at, "received_at");
  const receivedOn = etDate(receivedAt); const heartbeat_due = addDays(receivedOn, FLOOD_LOL_HEARTBEAT_DAYS); const actor = actorOf(d);
  if (isDuplicateVendorMessage(d, { certificate_id: certificateId, kind: m.kind, received_at: receivedAt })) return { duplicate: true, kind: m.kind, heartbeat_due };
  // The heartbeat is per vendor feed, never per loan: no loanId, so the engine keys the timer on the vendor aggregate.
  d.events.append({ type: "flood.lol.message.received", aggregate: { kind: "flood_vendor", id: vendorId }, actor, occurredAt: receivedAt, payload: { vendor_id: vendorId, kind: m.kind, certificate_id: certificateId, received_at: receivedAt, loan_id: m.loan_id ?? null, property_id: m.property_id ?? null, heartbeat_due } });
  switch (m.kind) {
    case "determination_result": {
      const det = m.determination; if (!det) throw new RangeError("determination_result needs determination");
      const loanId = nonEmpty(m.loan_id, "loan_id");
      const req = floodRequired(structuresToRequirement(det.structures, det.participating, det.cbrs_opa));
      d.events.append({ type: "flood.determination.received", loanId, actor, occurredAt: receivedAt, payload: { certificate_id: certificateId, vendor_id: vendorId, property_id: m.property_id ?? null, determination_date: receivedOn, zone: det.zone, sfha: det.sfha, cbrs_opa: det.cbrs_opa, community_number: det.community_number, community_name: det.community_name ?? null, participating: det.participating, program_status: det.program_status, map_panel: det.map_panel, map_date: det.map_date, lol: det.lol, multiple_structures: det.structures.length > 1, structures: det.structures, determination_type: det.determination_type, sfhdf_document_id: det.sfhdf_document_id ?? null, coverage_required: req.required, private_only: req.private_only } });
      d.events.append({ type: req.required ? "flood.coverage.required" : "flood.coverage.not_required", loanId, actor, occurredAt: receivedAt, payload: { reason: req.required ? (det.cbrs_opa ? "cbrs_opa" : "sfha_security_structure") : "no_security_structure_in_sfha", certificate_id: certificateId, private_only: req.private_only, effective: receivedOn } });
      return { duplicate: false, kind: m.kind, heartbeat_due, coverage_required: req.required, private_only: req.private_only, required_notice: null };
    }
    case "map_change_notification": {
      const mc = m.map_change; if (!mc) throw new RangeError("map_change_notification needs map_change");
      const loanId = nonEmpty(m.loan_id, "loan_id"); plainDate(mc.effective_date);
      const direction = mapChangeDirection(mc);
      const fnma_deadline = direction === "into_sfha" ? addDays(mc.effective_date, FNMA_REMAP_COVERAGE_DAYS) : null;
      const nfip_one_day_until = addMonths(mc.effective_date, NFIP_MAP_REVISION_WINDOW_MONTHS);
      d.events.append({ type: "flood.map_change.received", loanId, actor, occurredAt: receivedAt, payload: { certificate_id: certificateId, vendor_id: vendorId, direction, effective_date: mc.effective_date, old_zone: mc.old_zone, new_zone: mc.new_zone, map_panel: mc.map_panel ?? null, received_at: receivedAt, fnma_deadline, nfip_one_day_until, status: "open" } });
      const required_notice = direction === "into_sfha" ? "INS_FLOOD_MAP_CHANGE_NOTICE" : direction === "out_of_sfha" ? "INS_FLOOD_REMOVED_NOTICE" : null;
      if (direction === "into_sfha") d.events.append({ type: "flood.coverage.required", loanId, actor, occurredAt: receivedAt, payload: { reason: "remapped_into_sfha", certificate_id: certificateId, effective: mc.effective_date, deadline: fnma_deadline, notice: required_notice } });
      if (direction === "out_of_sfha") d.events.append({ type: "flood.coverage.not_required", loanId, actor, occurredAt: receivedAt, payload: { reason: "remapped_out_of_sfha", certificate_id: certificateId, effective: mc.effective_date, notice: required_notice } });
      return { duplicate: false, kind: m.kind, heartbeat_due, direction, fnma_deadline, nfip_one_day_until, required_notice };
    }
    case "community_status_change": {
      const c = m.community; if (!c) throw new RangeError("community_status_change needs community");
      const nfipAvailable = c.status === "regular" || c.status === "emergency";
      d.events.append({ type: "flood.community_status.changed", ...(m.loan_id ? { loanId: m.loan_id } : {}), actor, occurredAt: receivedAt, payload: { certificate_id: certificateId, community_number: c.community_number, status: c.status, effective_date: c.effective_date, nfip_available: nfipAvailable, private_only: !nfipAvailable, work_with_borrower_by: nfipAvailable ? null : addDays(c.effective_date, FNMA_REMAP_COVERAGE_DAYS) } });
      return { duplicate: false, kind: m.kind, heartbeat_due, private_only: !nfipAvailable, required_notice: null };
    }
    case "lomr_loma_received": {
      const l = m.loma; if (!l) throw new RangeError("lomr_loma_received needs loma");
      const loanId = nonEmpty(m.loan_id, "loan_id");
      d.events.append({ type: "flood.loma.received", loanId, actor, occurredAt: receivedAt, payload: { certificate_id: certificateId, letter_type: l.letter_type, letter_date: l.letter_date, document_id: l.document_id, source: "vendor" } });
      return { duplicate: false, kind: m.kind, heartbeat_due, required_notice: "INS_FLOOD_REMOVED_NOTICE" };
    }
  }
}

export interface DeterminationResultInput { readonly loan_id: string; readonly vendor_id: string; readonly received_at: string; readonly determination: FloodDetermination; readonly property_id?: string; readonly structures?: FloodRequirementInput; readonly participating?: boolean; readonly cbrs_opa?: boolean; readonly determination_type?: FloodDeterminationData["determination_type"]; }
/** The `orderDetermination` tool's result is the vendor's `determination_result` message: record the order and ingest the SFHDF through the same handler as the life-of-loan feed. */
export function recordDeterminationResult(d: FloodDeps, i: DeterminationResultInput): VendorMessageResult {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const det = i.determination; if (!det) throw new RangeError("determination is required");
  const s = i.structures;
  const structures: FloodStructure[] = s
    ? [{ name: "principal", in_sfha: s.principal_structure_in_sfha, residential: true, security: true, principal: true }, ...(s.detached_security_structure_in_sfha ? [{ name: "detached", in_sfha: true, residential: true, security: true, principal: false }] : [])]
    : [{ name: "principal", in_sfha: det.sfha, residential: true, security: true, principal: true }];
  const receivedAt = isoInstant(i.received_at, "received_at");
  if (!isDuplicateVendorMessage(d, { certificate_id: det.certificateId, kind: "determination_result", received_at: receivedAt }))
    d.events.append({ type: "flood.determination.ordered", loanId, actor: actorOf(d), occurredAt: receivedAt, payload: { vendor_id: i.vendor_id, property_id: i.property_id ?? det.propertyId, certificate_id: det.certificateId, source: "vendor_sfhdf" } });
  return receiveVendorMessage(d, { kind: "determination_result", vendor_id: i.vendor_id, certificate_id: det.certificateId, received_at: receivedAt, loan_id: loanId, property_id: i.property_id ?? det.propertyId,
    determination: { zone: det.zone, sfha: det.sfha, cbrs_opa: i.cbrs_opa ?? s?.cbrs_opa ?? false, community_number: det.communityNumber, participating: i.participating ?? s?.participating_community ?? true, program_status: (i.participating ?? s?.participating_community ?? true) ? "regular" : "non_participating", map_panel: det.mapPanel, map_date: plainDate(det.determinedOn), lol: det.lifeOfLoan, structures, determination_type: i.determination_type ?? "reorder", ...(det.documentSha256 ? { sfhdf_document_id: det.documentSha256 } : {}) } });
}

// ---- requirement and deficiency (rules 1–3) --------------------------------------------------------------------
export interface FloodPolicyOnFile { readonly kind: "nfip" | "private" | "rcbap"; readonly amount_cents: Cents; readonly deductible_cents: Cents; readonly policy_id?: string; readonly expiration?: PlainDate; readonly private?: { readonly compliance_aid_statement: boolean; readonly b7_elements_verified: boolean; readonly cancellation_clause_45_days: boolean; readonly insurer_rating_ok: boolean }; }
export interface FloodCoverageInput {
  readonly loan_id: string; readonly as_of: PlainDate; readonly structures: FloodRequirementInput; readonly rcv_cents: Cents; readonly upb_cents: Cents;
  readonly policy: FloodPolicyOnFile | null; readonly lapse_date?: PlainDate | null; readonly remap_effective?: PlainDate | null;
}
export type FloodCoverageResult =
  | { readonly required: false; readonly private_only: false; readonly required_cents: 0n; readonly deficiency: null }
  | { readonly required: true; readonly private_only: boolean; readonly required_cents: Cents; readonly deficiency: null; readonly verified: true }
  | { readonly required: true; readonly private_only: boolean; readonly required_cents: Cents; readonly deficiency: FloodDeficiency; readonly notice: typeof FLOOD_NOTICE_45; readonly notice_due: PlainDate; readonly track: typeof FLOOD_TRACK };
/**
 * Rules 1–2: `coverage_required = sfha_any_security_structure OR cbrs_opa`; required amount = min(100% RCV, NFIP max, UPB);
 * over-coverage is fine. An adequate policy verifies coverage (`flood.coverage.verified`); none or an inadequate one is a
 * deficiency (`flood.deficiency.detected`) that opens the fdpa_flood track — the 45-day notice is due within 3 servicer
 * business days (INS_FLOOD_NOTICE_SLA_3BD; the statute says "shall notify", §4012a(e)(1)).
 */
export function evaluateFloodCoverage(d: FloodDeps, i: FloodCoverageInput): FloodCoverageResult {
  const loanId = nonEmpty(i.loan_id, "loan_id"); plainDate(i.as_of); if (!i.structures) throw new RangeError("structures is required");
  if (i.rcv_cents <= 0n || i.upb_cents < 0n) throw new RangeError("rcv_cents must be positive and upb_cents non-negative");
  const actor = actorOf(d); const req = floodRequired(i.structures);
  if (!req.required) { d.events.append({ type: "flood.coverage.not_required", loanId, actor, payload: { reason: "no_security_structure_in_sfha", effective: i.as_of, as_of: i.as_of } }); return { required: false, private_only: false, required_cents: 0n, deficiency: null }; }
  const required_cents = floodRequiredAmount(i.rcv_cents, i.upb_cents);
  let deficiency: FloodDeficiency | null = null; let reason: string | null = null;
  if (!i.policy) deficiency = "flood_none";
  else {
    const a = floodAdequate(i.policy.amount_cents, i.rcv_cents, i.upb_cents, i.policy.deductible_cents);
    if (!a.ok) deficiency = a.deficiency;
    else if (i.policy.kind === "private") { const p = privatePolicyAcceptable(i.policy.private ?? { compliance_aid_statement: false, b7_elements_verified: false, cancellation_clause_45_days: false, insurer_rating_ok: false }); if (!p.accepted) { deficiency = "flood_private_unacceptable"; reason = p.reason; } }
  }
  if (deficiency === null) {
    d.events.append({ type: "flood.coverage.verified", loanId, actor, payload: { source: "policy", policy_id: i.policy?.policy_id ?? null, amount_cents: i.policy!.amount_cents, required_cents, as_of: i.as_of, effective: i.as_of, private_only: req.private_only } });
    return { required: true, private_only: req.private_only, required_cents, deficiency: null, verified: true };
  }
  const notice_due = addBusinessDays(i.as_of, FLOOD_NOTICE_SLA_BD, d.servicerCalendar ?? servicer);
  d.events.append({ type: "flood.deficiency.detected", loanId, actor, payload: { deficiency, reason, required_cents, policy_amount_cents: i.policy?.amount_cents ?? null, detected_at: i.as_of, lapse_date: i.lapse_date ?? null, remap_effective: i.remap_effective ?? null, private_only: req.private_only, track: FLOOD_TRACK, notice: FLOOD_NOTICE_45, notice_due } });
  return { required: true, private_only: req.private_only, required_cents, deficiency, notice: FLOOD_NOTICE_45, notice_due, track: FLOOD_TRACK };
}

// ---- 45-day notice (rule 4) ------------------------------------------------------------------------------------
export interface FloodNoticeInput { readonly loan_id: string; readonly recipients: readonly Recipient[]; readonly payload: Record<string, unknown>; readonly as_of: PlainDate; readonly channel_context?: ChannelContext; }
export interface FloodNoticeSentRecord { readonly template: typeof FLOOD_NOTICE_45; readonly notice_id: string; readonly mailed_on: PlainDate; readonly borrower_deadline: PlainDate; readonly placement_eligible: PlainDate; readonly channel: string; }
function appendNoticeSent(d: FloodDeps, loanId: string, r: { notice_id: string; mailed_on: PlainDate; mailed_at: string | null; proof_of_mailing_id: string | null; channel: string }): FloodNoticeSentRecord {
  const c = floodNoticeClocks(r.mailed_on, null);
  d.events.append({ type: "flood.fpi.notice.sent", loanId, actor: actorOf(d), aggregate: { kind: "notice", id: r.notice_id }, payload: { template: FLOOD_NOTICE_45, notice_id: r.notice_id, mailed_at: r.mailed_on, mailed_instant: r.mailed_at, proof_of_mailing_id: r.proof_of_mailing_id, channel: r.channel, borrower_deadline: c.borrower_deadline, placement_eligible: c.borrower_deadline, separate_document: true } });
  return { template: FLOOD_NOTICE_45, notice_id: r.notice_id, mailed_on: r.mailed_on, borrower_deadline: c.borrower_deadline, placement_eligible: c.borrower_deadline, channel: r.channel };
}
/**
 * Rule 4: render and send `INS_FLOOD_FPI_NOTICE_45` through the Notice Registry (its checklist carries the (e)(1)–(e)(4)
 * content; `separate_document` for a same-transmittal MS-3(A), RESPA §6(l)(4)). The 45-day clocks arm on
 * `flood.fpi.notice.sent`: for a mailed notice that is the proof of mailing (`recordFloodNoticeMailed`); for a delivery
 * the registry made electronically under an active E-SIGN consent it is the send itself — so the clocks arm whatever
 * channel the registry decided (finding: an e-delivered notice never emits `notice.mailed`).
 */
export async function sendFloodNotice45(d: FloodDeps, i: FloodNoticeInput): Promise<{ notice: Notice; sent: FloodNoticeSentRecord | null; awaiting_proof_of_mailing: boolean }> {
  const svc = d.notices; if (!svc) throw new RangeError("NoticeService is not wired: the 45-day flood notice is produced by the Notice Registry only (9.6 rule 4)");
  const loanId = nonEmpty(i.loan_id, "loan_id"); if (!i.recipients.length) throw new RangeError("recipients is required");
  const n = svc.render({ templateCode: FLOOD_NOTICE_45, loanId, recipients: i.recipients, payload: { separate_document: true, ...i.payload }, asOf: i.as_of });
  await svc.send(n.id, i.channel_context ?? {});
  const mailed = n.deliveries.some((x) => x.channel.startsWith("mail"));
  const electronic = n.deliveries.find((x) => !x.channel.startsWith("mail") && x.satisfiesTimer && x.emailStatus !== "bounced");
  if (!mailed && electronic && n.sentAt) return { notice: n, sent: appendNoticeSent(d, loanId, { notice_id: n.id, mailed_on: etDate(n.sentAt), mailed_at: n.sentAt, proof_of_mailing_id: null, channel: electronic.channel }), awaiting_proof_of_mailing: false };
  return { notice: n, sent: null, awaiting_proof_of_mailing: mailed };
}
export const FLOOD_MAP_CHANGE_NOTICE = "INS_FLOOD_MAP_CHANGE_NOTICE" as const;
export interface MapChangeNoticeInput { readonly loan_id: string; readonly certificate_id?: string | null; readonly recipients: readonly Recipient[]; readonly payload: Record<string, unknown>; readonly as_of: PlainDate; readonly channel_context?: ChannelContext; }
/**
 * Rule 7 / 9.6 outputs: `INS_FLOOD_MAP_CHANGE_NOTICE` ("remapped into an SFHA — coverage is now required", policy; may
 * accompany the 45-day notice when coverage is absent) rendered and sent through the Notice Registry, then
 * `flood.map_change.notified` on the loan (the 9.6 event list: `flood.map_change.received/notified/closed`) — the map
 * change row moves `open → borrower_notified`. 32.9 backend delta: the borrower's NoticeCard hangs on this event.
 */
export async function sendMapChangeNotice(d: FloodDeps, i: MapChangeNoticeInput): Promise<{ notice: Notice; event: DomainEvent }> {
  const svc = d.notices; if (!svc) throw new RangeError("NoticeService is not wired: the map-change notice is produced by the Notice Registry only (9.6 rule 4)");
  const loanId = nonEmpty(i.loan_id, "loan_id"); if (!i.recipients.length) throw new RangeError("recipients is required");
  const received = byLoan(d, loanId, "flood.map_change.received").filter((e) => !i.certificate_id || payload<{ certificate_id?: unknown }>(e).certificate_id === i.certificate_id).at(-1);
  if (!received) throw new RangeError(`no flood.map_change.received on loan ${loanId}${i.certificate_id ? ` for certificate ${i.certificate_id}` : ""} — the notice follows the vendor's map-change message`);
  const mc = payload<{ certificate_id?: string; direction?: string; effective_date?: string; new_zone?: string; map_panel?: string | null; fnma_deadline?: string | null }>(received);
  const coverage_required = mc.direction === "into_sfha";
  const n = svc.render({ templateCode: FLOOD_MAP_CHANGE_NOTICE, loanId, recipients: i.recipients, payload: { coverage_required, map_effective: mc.effective_date, flood_zone: mc.new_zone, map_panel: mc.map_panel ?? "", ...i.payload }, asOf: i.as_of });
  if (n.status === "held") throw new RangeError(`${FLOOD_MAP_CHANGE_NOTICE} for ${loanId} is held: ${n.heldReason ?? "checklist"}`);
  await svc.send(n.id, i.channel_context ?? {});
  const notice45 = floodNoticeOnFile(d, loanId);
  const event = d.events.append({ type: "flood.map_change.notified", loanId, actor: actorOf(d), aggregate: { kind: "notice", id: n.id }, payload: { template: FLOOD_MAP_CHANGE_NOTICE, notice_id: n.id, certificate_id: mc.certificate_id ?? null, direction: mc.direction ?? null, effective_date: mc.effective_date ?? null, new_zone: mc.new_zone ?? null, coverage_required, required_cents: i.payload.required_amount_cents ?? null, fnma_deadline: mc.fnma_deadline ?? null, notified_on: i.as_of, notice_45_id: notice45?.notice_id ?? null, borrower_deadline: notice45 ? floodNoticeClocks(notice45.mailed_on, null).borrower_deadline : null, status: "borrower_notified" } });
  return { notice: n, event };
}
export interface FloodNoticeMailedInput { readonly loan_id: string; readonly notice_id: string; readonly mailed_at: string; readonly proof_of_mailing_id: string; readonly attempt_no?: number; readonly template?: string; }
/** Print-mail manifest ingestion for the flood notice: records the proof of mailing on the registry (`notice.mailed`) and appends `flood.fpi.notice.sent` anchored on the mailed date (42 U.S.C. §4012a(e)(1)–(2): 45 days "after notification"). */
export function recordFloodNoticeMailed(d: FloodDeps, i: FloodNoticeMailedInput): FloodNoticeSentRecord {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const noticeId = nonEmpty(i.notice_id, "notice_id"); const mailedAt = isoInstant(i.mailed_at, "mailed_at"); const proof = nonEmpty(i.proof_of_mailing_id, "proof_of_mailing_id");
  let template = i.template;
  if (d.notices) template = d.notices.get(noticeId).templateCode;
  // Validate before any side effect: a proof for another template (the MS-3(A) in the same transmittal) must not be recorded on the registry as this notice's mailing.
  if (template !== FLOOD_NOTICE_45) throw new RangeError(`${String(template ?? "(no template)")} is not ${FLOOD_NOTICE_45}`);
  if (byLoan(d, loanId, "flood.fpi.notice.sent").some((e) => payload<{ notice_id?: unknown }>(e).notice_id === noticeId)) throw new RangeError(`proof of mailing for notice ${noticeId} is already on file`);
  if (d.notices) {
    const n = d.notices.get(noticeId);
    const attempt = i.attempt_no ?? n.deliveries.find((x) => x.channel.startsWith("mail") && x.satisfiesTimer)?.attemptNo;
    if (attempt === undefined) throw new RangeError(`notice ${noticeId} has no mail delivery to prove`);
    const del = n.deliveries.find((x) => x.attemptNo === attempt); if (!del) throw new RangeError(`no delivery ${attempt}`);
    if (!del.mailedAt) d.notices.recordMailed(noticeId, attempt, mailedAt, proof);
  }
  return appendNoticeSent(d, loanId, { notice_id: noticeId, mailed_on: etDate(mailedAt), mailed_at: mailedAt, proof_of_mailing_id: proof, channel: "mail_first_class" });
}
/** The latest 45-day notice on file for the loan (from the event log, never from the caller). */
export function floodNoticeOnFile(d: FloodDeps, loanId: string): { mailed_on: PlainDate; notice_id: string; occurredAt: string } | null {
  const e = byLoan(d, loanId, "flood.fpi.notice.sent").filter((x) => payload<{ template?: unknown }>(x).template === FLOOD_NOTICE_45).at(-1);
  if (!e) return null; const p = payload<{ mailed_at: string; notice_id: string }>(e); return { mailed_on: plainDate(p.mailed_at), notice_id: p.notice_id, occurredAt: e.occurredAt };
}

// ---- placement (rule 5) ----------------------------------------------------------------------------------------
export interface FloodPlacementInput {
  readonly loan_id: string; readonly on: PlainDate; readonly required_cents: Cents; readonly premium_cents: Cents; readonly binding_id: string;
  readonly lapse_date: PlainDate | null; readonly remap_effective: PlainDate | null; readonly escrowed: boolean;
  readonly amount_cents?: Cents; readonly borrower_elected?: boolean; readonly notice_mailed_on?: PlainDate | null; readonly vendor_loan_id?: string;
}
export type FloodPlacementResult =
  | { readonly bound: false; readonly reason: string; readonly timer: "FDPA_4012A_E_FLOOD_FPI_NOTICE_45" | null; readonly borrower_deadline: PlainDate }
  | { readonly bound: true; readonly binding_id: string; readonly effective: PlainDate; readonly amount_cents: Cents; readonly premium_cents: Cents; readonly charge: { readonly method: "escrow_disbursement" | "corporate_advance"; readonly disbursement_kind: "flood" | null; readonly from: PlainDate }; readonly fannie_120_satisfied: boolean | null; readonly fannie_deadline: PlainDate | null; readonly notice: "INS_FLOOD_FPI_PLACED_NOTICE" };
/** Sufficient flood evidence confirmed on or after the notice went out. */
function sufficientEvidenceOnFile(d: FloodDeps, loanId: string, sinceIso: string | null): boolean {
  return byLoan(d, loanId, "insurance.evidence.evaluated").some((e) => { const p = payload<{ kind?: unknown; outcome?: unknown }>(e); return p.kind === "flood" && p.outcome === "confirmed" && (sinceIso === null || e.occurredAt >= sinceIso); });
}
/** An LPI flood binding on the books that has not been terminated. */
export function activeFloodLpi(d: FloodDeps, loanId: string): { binding_id: string; effective: PlainDate; premium_cents: Cents; amount_cents: Cents } | null {
  const terminated = new Set(byLoan(d, loanId, "flood.lpi.terminated").map((e) => String(payload<{ binding_id: unknown }>(e).binding_id)));
  const b = byLoan(d, loanId, "flood.lpi.bound").filter((e) => !terminated.has(String(payload<{ binding_id: unknown }>(e).binding_id))).at(-1);
  if (!b) return null; const p = payload<{ binding_id: string; effective: string; premium_cents: Cents; amount_cents: Cents }>(b);
  return { binding_id: p.binding_id, effective: plainDate(p.effective), premium_cents: p.premium_cents, amount_cents: p.amount_cents };
}
/**
 * Rule 5: on t0 + 45 with no sufficient evidence, bind LPI flood for the required amount effective the lapse date or, for a
 * remap, the remap effective date (9.6-Q1 default); charge the borrower (escrowed → `disbursement_kind='flood'` via 3.7,
 * non-escrowed → advance/receivable); the binding verifies coverage for the Fannie Mae 120-day timer. The notice date is
 * read from the event log (`flood.fpi.notice.sent`); before the 45th day the placement is refused
 * (FDPA_4012A_E_FLOOD_FPI_NOTICE_45 — "placement/charge refused before"). Guardrail: the amount never exceeds the rule-2
 * minimum unless the borrower elects.
 */
export function bindFloodLpiPlacement(d: FloodDeps, i: FloodPlacementInput): FloodPlacementResult {
  const loanId = nonEmpty(i.loan_id, "loan_id"); plainDate(i.on); nonEmpty(i.binding_id, "binding_id");
  if (i.required_cents <= 0n) throw new RangeError("required_cents must be positive"); if (i.premium_cents < 0n) throw new RangeError("premium_cents must be non-negative");
  const amount = i.amount_cents ?? i.required_cents;
  if (amount > i.required_cents && !i.borrower_elected) throw new RangeError("9.6 guardrail: the placed amount never exceeds the rule-2 minimum unless the borrower elects");
  const notice = floodNoticeOnFile(d, loanId); const mailed = notice?.mailed_on ?? i.notice_mailed_on ?? null;
  if (!mailed) throw new RangeError("no INS_FLOOD_FPI_NOTICE_45 mailing on file for the loan: 42 U.S.C. §4012a(e)(1) requires the notice before any placement");
  if (activeFloodLpi(d, loanId)) throw new RangeError("an LPI flood binding is already on the books for the loan");
  const clocks = floodNoticeClocks(mailed, i.remap_effective);
  const sufficient = sufficientEvidenceOnFile(d, loanId, notice?.occurredAt ?? null);
  const r = bindFloodLpi(clocks, i.on, sufficient, placementEffective(i.lapse_date, i.remap_effective));
  const actor = actorOf(d);
  if (!r.bound) {
    d.events.append({ type: "flood.lpi.placement.refused", loanId, actor, payload: { on: i.on, reason: r.reason, timer: sufficient ? null : "FDPA_4012A_E_FLOOD_FPI_NOTICE_45", borrower_deadline: clocks.borrower_deadline } });
    return { bound: false, reason: r.reason ?? "refused", timer: sufficient ? null : "FDPA_4012A_E_FLOOD_FPI_NOTICE_45", borrower_deadline: clocks.borrower_deadline };
  }
  const effective = r.effective!;
  const charge = { method: i.escrowed ? ("escrow_disbursement" as const) : ("corporate_advance" as const), disbursement_kind: i.escrowed ? ("flood" as const) : null, from: effective };
  d.events.append({ type: "flood.lpi.bound", loanId, actor, payload: { binding_id: i.binding_id, vendor_loan_id: i.vendor_loan_id ?? loanId, bound_on: i.on, effective, amount_cents: amount, premium_cents: i.premium_cents, required_cents: i.required_cents, lapse_date: i.lapse_date, remap_effective: i.remap_effective, notice_id: notice?.notice_id ?? null, track: FLOOD_TRACK, fannie_120_satisfied: r.fannie_120_satisfied } });
  d.events.append({ type: "flood.lpi.charged", loanId, actor, payload: { binding_id: i.binding_id, premium_cents: i.premium_cents, from: effective, method: charge.method, disbursement_kind: charge.disbursement_kind, receivable: !i.escrowed, basis: "42 U.S.C. §4012a(e)(2): premiums and fees for coverage beginning on the lapse/requirement date" } });
  d.events.append({ type: "flood.coverage.verified", loanId, actor, payload: { source: "lpi_bound", binding_id: i.binding_id, effective, amount_cents: amount, required_cents: i.required_cents, remap_effective: i.remap_effective } });
  return { bound: true, binding_id: i.binding_id, effective, amount_cents: amount, premium_cents: i.premium_cents, charge, fannie_120_satisfied: r.fannie_120_satisfied, fannie_deadline: clocks.fannie_120, notice: "INS_FLOOD_FPI_PLACED_NOTICE" };
}
/** Bind through the `insurance-tracking/lpi` port, then record the placement (the port's premium is the charge). */
export async function requestFloodLpi(d: FloodDeps, i: Omit<FloodPlacementInput, "binding_id" | "premium_cents"> & { readonly now: string }): Promise<FloodPlacementResult> {
  const lpi = d.lpi; if (!lpi) throw new RangeError("integration port lpi is not wired");
  const notice = floodNoticeOnFile(d, i.loan_id); const mailed = notice?.mailed_on ?? i.notice_mailed_on ?? null;
  if (!mailed) throw new RangeError("no INS_FLOOD_FPI_NOTICE_45 mailing on file for the loan: 42 U.S.C. §4012a(e)(1) requires the notice before any placement");
  const clocks = floodNoticeClocks(mailed, i.remap_effective);
  if (i.on < clocks.borrower_deadline) return { bound: false, reason: `FDPA_4012A_E_FLOOD_FPI_NOTICE_45 open until ${clocks.borrower_deadline}`, timer: "FDPA_4012A_E_FLOOD_FPI_NOTICE_45", borrower_deadline: clocks.borrower_deadline };
  const b = await lpi.bind(i.vendor_loan_id ?? i.loan_id, i.amount_cents ?? i.required_cents, placementEffective(i.lapse_date, i.remap_effective), i.now);
  return bindFloodLpiPlacement(d, { ...i, binding_id: b.bindingId, premium_cents: b.annualPremiumCents });
}

// ---- borrower evidence (§4012a(e)(4); rule 2) -------------------------------------------------------------------
export interface FloodEvidencePolicy {
  readonly policy_number: string; readonly nfip: boolean; readonly insurer: string; readonly building_coverage_cents: Cents; readonly deductible_cents: Cents;
  readonly effective: PlainDate; readonly expiration: PlainDate; readonly insurer_contact?: string;
  readonly compliance_aid_statement?: boolean; readonly b7_elements_verified?: boolean; readonly cancellation_clause_45_days?: boolean; readonly insurer_rating_ok?: boolean;
}
export interface FloodEvidenceReceivedInput { readonly loan_id: string; readonly evidence_id: string; readonly received_on: PlainDate; readonly document: "declarations_page" | "policy" | "binder" | "other"; readonly policy: FloodEvidencePolicy; readonly fpi_active?: boolean; }
/** Evidence ingestion: appends `insurance.evidence.received{kind=flood, fpi_active}` — FLOOD_EVIDENCE_EVAL_2BD (2 servicer business days) and, with an LPI on the books, FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30 (30 calendar days) arm on it. */
export function receiveFloodEvidence(d: FloodDeps, i: FloodEvidenceReceivedInput): { evidence_id: string; fpi_active: boolean; eval_due: PlainDate; terminate_refund_by: PlainDate | null } {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const evidenceId = nonEmpty(i.evidence_id, "evidence_id"); plainDate(i.received_on); if (!i.policy) throw new RangeError("policy is required"); nonEmpty(i.policy.policy_number, "policy.policy_number");
  const fpi_active = i.fpi_active ?? activeFloodLpi(d, loanId) !== null;
  const eval_due = addBusinessDays(i.received_on, FLOOD_EVIDENCE_EVAL_BD, d.servicerCalendar ?? servicer);
  const terminate_refund_by = fpi_active ? addDays(i.received_on, FLOOD_TERMINATE_REFUND_DAYS) : null;
  // `receipt` is the registry anchor ("receipt") for FLOOD_EVIDENCE_EVAL_2BD and FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30.
  d.events.append({ type: "insurance.evidence.received", loanId, actor: actorOf(d), payload: { kind: "flood", fpi_active, evidence_id: evidenceId, receipt: i.received_on, received_at: i.received_on, document: i.document, policy_number: i.policy.policy_number, nfip: i.policy.nfip, insurer: i.policy.insurer, coverage_effective: i.policy.effective, coverage_expiration: i.policy.expiration, building_coverage_cents: i.policy.building_coverage_cents, eval_due, terminate_refund_by } });
  return { evidence_id: evidenceId, fpi_active, eval_due, terminate_refund_by };
}
export interface FloodEvidenceEvalInput { readonly loan_id: string; readonly evidence_id: string; readonly evaluated_on: PlainDate; readonly document: "declarations_page" | "policy" | "binder" | "other"; readonly policy: FloodEvidencePolicy; readonly rcv_cents: Cents; readonly upb_cents: Cents; readonly remap_effective?: PlainDate | null; readonly purchased_on?: PlainDate | null; }
export interface FloodEvidenceEvalResult { readonly outcome: "confirmed" | "rejected"; readonly reason: string | null; readonly coverage_effective: PlainDate; readonly required_cents: Cents; readonly expected_effective: PlainDate | null; readonly effective_date_consistent: boolean | null; readonly terminate_refund_by: PlainDate | null; }
/**
 * Rule 2 / T3: an NFIP policy, or a private policy carrying the compliance-aid statement (or the (b)(7) elements verified,
 * incl. the 45-day cancellation notice) from an insurer meeting B7-3-01 ratings, for at least the required amount with a
 * deductible ≤ the NFIP maximum, is confirmed; otherwise rejected with the reason. §4012a(e)(4): a declarations page with
 * the policy number and insurer contact is accepted as confirmation. Appends `insurance.evidence.evaluated{kind=flood,
 * outcome}` and, when confirmed, `flood.coverage.verified`.
 */
export function evaluateFloodEvidence(d: FloodDeps, i: FloodEvidenceEvalInput): FloodEvidenceEvalResult {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const evidenceId = nonEmpty(i.evidence_id, "evidence_id"); plainDate(i.evaluated_on); if (!i.policy) throw new RangeError("policy is required");
  const p = i.policy; const required_cents = floodRequiredAmount(i.rcv_cents, i.upb_cents);
  let reason: string | null = null;
  if (!p.nfip) { const pr = privatePolicyAcceptable({ compliance_aid_statement: p.compliance_aid_statement === true, b7_elements_verified: p.b7_elements_verified === true, cancellation_clause_45_days: p.cancellation_clause_45_days === true, insurer_rating_ok: p.insurer_rating_ok === true }); if (!pr.accepted) reason = pr.reason; }
  if (reason === null) { const a = floodAdequate(p.building_coverage_cents, i.rcv_cents, i.upb_cents, p.deductible_cents); if (!a.ok) reason = a.deficiency; }
  if (reason === null && i.document === "other") reason = "evidence_form: a declarations page, policy or binder is required (§4012a(e)(4))";
  if (reason === null && p.expiration <= i.evaluated_on) reason = "policy_expired";
  const expected_effective = p.nfip && i.purchased_on ? nfipEffectiveDate(i.purchased_on, i.remap_effective ?? null) : null;
  const effective_date_consistent = expected_effective === null ? null : p.effective >= expected_effective;
  const outcome = reason === null ? "confirmed" : "rejected";
  const received = byLoan(d, loanId, "insurance.evidence.received").filter((e) => payload<{ evidence_id?: unknown }>(e).evidence_id === evidenceId).at(-1);
  const terminate_refund_by = received ? (payload<{ terminate_refund_by?: string | null }>(received).terminate_refund_by ?? null) as PlainDate | null : null;
  const actor = actorOf(d);
  d.events.append({ type: "insurance.evidence.evaluated", loanId, actor, payload: { kind: "flood", outcome, evidence_id: evidenceId, reason, evaluated_at: i.evaluated_on, policy_number: p.policy_number, nfip: p.nfip, required_cents, building_coverage_cents: p.building_coverage_cents, coverage_effective: p.effective, expected_effective, effective_date_consistent } });
  if (outcome === "confirmed") d.events.append({ type: "flood.coverage.verified", loanId, actor, payload: { source: "borrower_evidence", evidence_id: evidenceId, policy_number: p.policy_number, effective: p.effective, amount_cents: p.building_coverage_cents, required_cents } });
  return { outcome, reason, coverage_effective: p.effective, required_cents, expected_effective, effective_date_consistent, terminate_refund_by };
}

// ---- termination and refund (§4012a(e)(3); rule 6) -------------------------------------------------------------
export interface FloodTerminationInput { readonly loan_id: string; readonly binding_id: string; readonly terms: readonly LpiTerm[]; readonly borrower_coverage_start: PlainDate; readonly borrower_coverage_end?: PlainDate | null; readonly evidence_received_on: PlainDate; readonly borrower_paid_cents: Cents; readonly reason: "borrower_evidence" | "loma" | "servicer_error"; readonly carrier_ack?: "pending" | "received"; }
export interface FloodTerminationResult extends CancellationResult { readonly binding_id: string; readonly effective: PlainDate; readonly notice: "INS_FLOOD_TERMINATION_REFUND_CONFIRM" | "INS_FLOOD_REMOVED_NOTICE"; }
/** Rule 6: overlap calculator from 9.5 with the 30-day deadline; terminates on the servicer's books at once (the carrier's ack reconciles later) — `flood.lpi.terminated` + `fpi.lpi.cancelled{track=fdpa_flood}`. */
export function terminateFloodLpi(d: FloodDeps, i: FloodTerminationInput): FloodTerminationResult {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const bindingId = nonEmpty(i.binding_id, "binding_id"); if (!i.terms.length) throw new RangeError("terms is required");
  if (byLoan(d, loanId, "flood.lpi.terminated").some((e) => payload<{ binding_id?: unknown }>(e).binding_id === bindingId)) throw new RangeError(`binding ${bindingId} is already terminated`);
  const r = cancellation({ terms: i.terms, borrower_coverage_start: i.borrower_coverage_start, borrower_coverage_end: i.borrower_coverage_end ?? null, evidence_received_on: i.evidence_received_on, borrower_paid_cents: i.borrower_paid_cents, deadline_days: FLOOD_TERMINATE_REFUND_DAYS });
  const actor = actorOf(d); const notice = i.reason === "loma" ? "INS_FLOOD_REMOVED_NOTICE" : "INS_FLOOD_TERMINATION_REFUND_CONFIRM";
  d.events.append({ type: "flood.lpi.terminated", loanId, actor, payload: { binding_id: bindingId, effective: r.cancellation_effective, overlap_days: r.overlap_days, removed_cents: r.removed_cents, retained_cents: r.retained_cents, refund_cents: r.refund_cents, still_due_cents: r.still_due_cents, deadline: r.deadline, reason: i.reason, root_cause: r.root_cause, track: FLOOD_TRACK, notice } });
  d.events.append({ type: "fpi.lpi.cancelled", loanId, actor, payload: { binding_id: bindingId, effective: r.cancellation_effective, track: FLOOD_TRACK, on_books: true, carrier_ack: i.carrier_ack ?? "pending" } });
  return { ...r, binding_id: bindingId, effective: r.cancellation_effective, notice };
}
/** Cancel through the `insurance-tracking/lpi` port, then terminate on the books. */
export async function requestFloodLpiCancel(d: FloodDeps, i: FloodTerminationInput & { readonly now: string }): Promise<FloodTerminationResult> {
  const lpi = d.lpi; if (!lpi) throw new RangeError("integration port lpi is not wired");
  const r = cancellation({ terms: i.terms, borrower_coverage_start: i.borrower_coverage_start, borrower_coverage_end: i.borrower_coverage_end ?? null, evidence_received_on: i.evidence_received_on, borrower_paid_cents: i.borrower_paid_cents, deadline_days: FLOOD_TERMINATE_REFUND_DAYS });
  await lpi.cancel(i.binding_id, r.cancellation_effective, i.now);
  return terminateFloodLpi(d, i);
}
export interface FloodRefundInput { readonly loan_id: string; readonly binding_id: string; readonly refund_cents: Cents; readonly rail: "ach" | "check" | "escrow_credit" | "account_credit"; readonly paid_on: PlainDate; }
/**
 * §4012a(e)(3): "refund to the borrower all premiums paid" for the overlap "and any related fees" — the refund is paid
 * independently of the carrier and never below the calculator's figure; the 30-day clock is satisfied only once both
 * legs are done (termination on the books AND the refund paid): `flood.refund.paid` + `fpi.refund.paid` +
 * `fpi.lpi.cancelled_and_refunded{track=fdpa_flood}`.
 */
export function payFloodRefund(d: FloodDeps, i: FloodRefundInput): { paid: true; refund_cents: Cents; deadline: PlainDate; on_time: boolean; notice: "INS_FLOOD_TERMINATION_REFUND_CONFIRM"; timer_satisfied: "FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30" } {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const bindingId = nonEmpty(i.binding_id, "binding_id"); nonEmpty(i.rail, "rail"); plainDate(i.paid_on);
  const term = byLoan(d, loanId, "flood.lpi.terminated").filter((e) => payload<{ binding_id?: unknown }>(e).binding_id === bindingId).at(-1);
  if (!term) throw new RangeError(`terminate LPI binding ${bindingId} before paying its refund (42 U.S.C. §4012a(e)(3))`);
  const t = payload<{ refund_cents: Cents; deadline: string }>(term);
  if (i.refund_cents < t.refund_cents) throw new RangeError(`9.6 guardrail: refund ${i.refund_cents} is below the calculator's ${t.refund_cents}`);
  if (byLoan(d, loanId, "flood.refund.paid").some((e) => payload<{ binding_id?: unknown }>(e).binding_id === bindingId)) throw new RangeError(`refund for binding ${bindingId} is already paid`);
  const actor = actorOf(d); const deadline = plainDate(t.deadline);
  d.events.append({ type: "flood.refund.paid", loanId, actor, payload: { binding_id: bindingId, refund_cents: i.refund_cents, rail: i.rail, paid_on: i.paid_on, deadline, on_time: i.paid_on <= deadline } });
  d.events.append({ type: "fpi.refund.paid", loanId, actor, payload: { refund_cents: i.refund_cents, rail: i.rail, track: FLOOD_TRACK, binding_id: bindingId } });
  d.events.append({ type: "fpi.lpi.cancelled_and_refunded", loanId, actor, payload: { track: FLOOD_TRACK, refund_cents: i.refund_cents, rail: i.rail, binding_id: bindingId, terminated_effective: (payload<{ effective: string }>(term)).effective, paid_on: i.paid_on } });
  return { paid: true, refund_cents: i.refund_cents, deadline, on_time: i.paid_on <= deadline, notice: "INS_FLOOD_TERMINATION_REFUND_CONFIRM", timer_satisfied: "FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30" };
}

// ---- remapped out / LOMA (rule 7) ------------------------------------------------------------------------------
export interface LomaInput { readonly loan_id: string; readonly letter_type: "LOMA" | "LOMR"; readonly letter_date: PlainDate; readonly received_on: PlainDate; readonly document_id: string; readonly lpi: { readonly binding_id: string; readonly terms: readonly LpiTerm[] } | null; readonly borrower_paid_cents: Cents; }
/** Rule 7 / T6: the FEMA letter clears the requirement (filed per B-3-01), cancels LPI flood effective the letter date with the overlap refunded, and sends `INS_FLOOD_REMOVED_NOTICE`; the borrower's own NFIP policy is theirs to keep. */
export function applyLomaLetter(d: FloodDeps, i: LomaInput): { requirement: "cleared"; cancellation_effective: PlainDate; refund: CancellationResult; termination: FloodTerminationResult | null; notice: "INS_FLOOD_REMOVED_NOTICE"; file_letter: "B-3-01" } {
  const loanId = nonEmpty(i.loan_id, "loan_id"); nonEmpty(i.document_id, "document_id"); plainDate(i.letter_date); plainDate(i.received_on);
  const actor = actorOf(d);
  const r = lomaLetter({ letter_date: i.letter_date, received_on: i.received_on, lpi: i.lpi?.terms ?? [{ effective: i.letter_date, expiration: addDays(i.letter_date, 1), premium_cents: 0n }], borrower_paid_cents: i.lpi ? i.borrower_paid_cents : 0n });
  d.events.append({ type: "flood.loma.received", loanId, actor, payload: { letter_type: i.letter_type, letter_date: i.letter_date, received_on: i.received_on, document_id: i.document_id, source: "borrower_or_fema", filed: "B-3-01" } });
  d.events.append({ type: "flood.coverage.not_required", loanId, actor, payload: { reason: "loma_lomr", effective: i.letter_date, document_id: i.document_id, notice: r.notice } });
  d.events.append({ type: "flood.map_change.closed", loanId, actor, payload: { status: "released", effective: i.letter_date, document_id: i.document_id } });
  const termination = i.lpi ? terminateFloodLpi(d, { loan_id: loanId, binding_id: i.lpi.binding_id, terms: i.lpi.terms, borrower_coverage_start: i.letter_date, evidence_received_on: i.received_on, borrower_paid_cents: i.borrower_paid_cents, reason: "loma" }) : null;
  return { requirement: r.requirement, cancellation_effective: r.cancellation_effective, refund: r.refund, termination, notice: r.notice, file_letter: r.file_letter };
}

// ---- vendor heartbeat (edge "Vendor outage/LOL gap"; T8) -------------------------------------------------------
export interface HeartbeatInput { readonly vendor_id: string; readonly today: PlainDate; readonly pending_alerts: readonly { loan_id: string; certificate_id: string }[]; readonly last_message_on?: PlainDate | null; }
/** Last vendor message from the event log; 36+ days silent → sev-2 (`flood.lol.heartbeat.missed`) and a manual re-order queue for every loan with a pending map-change alert. */
export function vendorHeartbeat(d: FloodDeps, i: HeartbeatInput): { vendor_id: string; last_message_on: PlainDate | null; days_silent: number | null; severity: "ok" | "sev2"; reorder_queue: { loan_id: string; certificate_id: string; action: "manual_reorder" }[] } {
  const vendorId = nonEmpty(i.vendor_id, "vendor_id"); plainDate(i.today);
  const last = d.events.ofType("flood.lol.message.received").filter((e) => e.aggregate?.kind === "flood_vendor" && e.aggregate.id === vendorId).map((e) => etDate(String(payload<{ received_at: string }>(e).received_at))).sort().at(-1) ?? i.last_message_on ?? null;
  if (last === null) throw new RangeError(`no vendor message on file for ${vendorId}`);
  const c = vendorHeartbeatCheck({ last_message_on: last, today: i.today, pending_alerts: i.pending_alerts });
  const days_silent = Math.round((Date.parse(i.today) - Date.parse(last)) / 86_400_000);
  if (c.severity === "sev2") {
    d.events.append({ type: "flood.lol.heartbeat.missed", aggregate: { kind: "flood_vendor", id: vendorId }, actor: actorOf(d), payload: { vendor_id: vendorId, last_message_on: last, days_silent, severity: "sev2", timer: "FLOOD_LOL_HEARTBEAT_35", reorder_queue: c.reorder_queue } });
    d.escalations?.open({ kind: "sev2", ownerRole: "ops_analyst", severity: "sev2", payload: { reason: "flood vendor life-of-loan feed silent (monitoring blind)", vendor_id: vendorId, last_message_on: last, days_silent, reorder_queue: c.reorder_queue } }, actorOf(d));
  }
  return { vendor_id: vendorId, last_message_on: last, days_silent, severity: c.severity, reorder_queue: c.reorder_queue };
}

// ---- Fannie Mae evidence requests (B-3-01; T9) ----------------------------------------------------------------
export interface FnmaEvidenceRequestInput { readonly loan_id: string; readonly request_id: string; readonly requested_on: PlainDate; readonly requested_by?: string; }
/** `fnma.request.received{kind=flood_evidence}` — FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD: 10 fannie_et business days; the agent assembles the package, `fnma_portal_operator`/`officer` sends it. */
export function receiveFnmaEvidenceRequest(d: FloodDeps, i: FnmaEvidenceRequestInput): { request_id: string; due: PlainDate; assembled_by: "insurance-property"; sent_by: "fnma_portal_operator"; escalate_to: "officer" } {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const requestId = nonEmpty(i.request_id, "request_id"); plainDate(i.requested_on);
  const due = fnmaEvidenceDue(i.requested_on, d.fannieCalendar ?? fannieEt);
  d.events.append({ type: "fnma.request.received", loanId, actor: actorOf(d), payload: { kind: "flood_evidence", request_id: requestId, request: i.requested_on, received_at: i.requested_on, due, requested_by: i.requested_by ?? "fnma", basis: "B-3-01: evidence of coverage within 10 business days of Fannie Mae's request" } });
  return { request_id: requestId, due, assembled_by: "insurance-property", sent_by: "fnma_portal_operator", escalate_to: "officer" };
}
export interface FnmaEvidenceResponseInput { readonly loan_id: string; readonly request_id: string; readonly requested_on: PlainDate; readonly sent_on: PlainDate; readonly by: Actor; readonly policy: { policy_number: string; nfip: boolean; building_coverage_cents: Cents }; }
const FNMA_RESPONDERS = new Set(["officer", "fnma_portal_operator"]);
/** `fnma.request.responded{kind=flood_evidence}` — only a human `fnma_portal_operator` or `officer` sends the response (9.6 actors: "`officer` only for Fannie Mae evidence responses"); an agent's attempt is refused. */
export function respondFnmaEvidenceRequest(d: FloodDeps, i: FnmaEvidenceResponseInput): { request_id: string; due: PlainDate; sent_on: PlainDate; on_time: boolean; documents: readonly string[]; sent_by: string } {
  const loanId = nonEmpty(i.loan_id, "loan_id"); const requestId = nonEmpty(i.request_id, "request_id"); plainDate(i.sent_on);
  if (i.by.kind !== "human" || !FNMA_RESPONDERS.has(i.by.role ?? "")) throw new RangeError("Fannie Mae evidence responses are sent by fnma_portal_operator or officer (9.6 escalations) — the agent assembles the package only");
  if (!byLoan(d, loanId, "fnma.request.received").some((e) => payload<{ request_id?: unknown }>(e).request_id === requestId)) throw new RangeError(`no Fannie Mae request ${requestId} on file for the loan`);
  const pkg = fnmaEvidencePackage(i.requested_on, i.policy, d.fannieCalendar ?? fannieEt);
  d.events.append({ type: "fnma.request.responded", loanId, actor: i.by, payload: { kind: "flood_evidence", request_id: requestId, sent_at: i.sent_on, due: pkg.due, on_time: i.sent_on <= pkg.due, documents: pkg.documents, assembled_by: pkg.assembled_by, sent_by: i.by.role ?? i.by.id } });
  return { request_id: requestId, due: pkg.due, sent_on: i.sent_on, on_time: i.sent_on <= pkg.due, documents: pkg.documents, sent_by: i.by.role ?? i.by.id };
}
