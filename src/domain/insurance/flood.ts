/**
 * 9.6 Flood insurance / mandatory purchase — requirement, amount, RCBAP,
 * 45-day notice, placement, and NFIP effective-date rules.
 */
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export const NFIP_BUILDING_MAX: Cents = 25_000_000n;
export const NFIP_MAX_DEDUCTIBLE: Cents = 1_000_000n;

export interface FloodRequirementInput { readonly principal_structure_in_sfha: boolean; readonly detached_security_structure_in_sfha: boolean; readonly cbrs_opa: boolean; readonly participating_community: boolean; }

export function floodRequired(i: FloodRequirementInput): { required: boolean; private_only: boolean } {
  const required = i.principal_structure_in_sfha || i.detached_security_structure_in_sfha || i.cbrs_opa;
  return { required, private_only: required && !i.participating_community };
}

/** Rule 2 — min(RCV, NFIP max, UPB). */
export function floodRequiredAmount(rcv: Cents, upb: Cents): Cents {
  return [rcv, NFIP_BUILDING_MAX, upb].reduce((a, b) => (b < a ? b : a));
}

export function floodAdequate(policyAmount: Cents, rcv: Cents, upb: Cents, deductible: Cents): { ok: boolean; deficiency: "flood_insufficient" | "flood_deductible" | null } {
  if (policyAmount < floodRequiredAmount(rcv, upb)) return { ok: false, deficiency: "flood_insufficient" };
  if (deductible > NFIP_MAX_DEDUCTIBLE) return { ok: false, deficiency: "flood_deductible" };
  return { ok: true, deficiency: null };
}

export interface RcbapResult { readonly required_rcbap_cents: Cents; readonly allocation_cents: Cents; readonly unit_requirement_cents: Cents; readonly supplement_cents: Cents; }

/** Rule 3 — building = min(80% RCV, $250k × units); per-unit allocation; supplement = max(0, unit req − allocation). */
export function rcbap(units: number, rcvBuilding: Cents, rcbapAmount: Cents, rcvUnit: Cents, unitUpb: Cents): RcbapResult {
  const u = BigInt(units);
  const eighty = (rcvBuilding * 80n) / 100n;
  const required = eighty < NFIP_BUILDING_MAX * u ? eighty : NFIP_BUILDING_MAX * u;
  const allocation = rcbapAmount / u;
  const unitReq = [rcvUnit, NFIP_BUILDING_MAX, unitUpb].reduce((a, b) => (b < a ? b : a));
  const supplement = unitReq > allocation ? unitReq - allocation : 0n;
  return { required_rcbap_cents: required, allocation_cents: allocation, unit_requirement_cents: unitReq, supplement_cents: supplement };
}

export interface PrivatePolicyInput { readonly compliance_aid_statement: boolean; readonly b7_elements_verified: boolean; readonly cancellation_clause_45_days: boolean; readonly insurer_rating_ok: boolean; }

/** Rule 2 — compliance-aid statement, or the (b)(7) elements verified; discretionary acceptance not used. */
export function privatePolicyAcceptable(p: PrivatePolicyInput): { accepted: boolean; reason: string | null } {
  if (!p.insurer_rating_ok) return { accepted: false, reason: "insurer_rating" };
  if (p.compliance_aid_statement) return { accepted: true, reason: null };
  if (p.b7_elements_verified && p.cancellation_clause_45_days) return { accepted: true, reason: null };
  return { accepted: false, reason: p.cancellation_clause_45_days ? "b7_elements_unverified" : "missing_45_day_cancellation_clause" };
}

export interface FloodNoticeClocks { readonly mailed: PlainDate; readonly borrower_deadline: PlainDate; readonly fannie_120: PlainDate | null; }

/** Rule 4/5 — 45 days from the notice; Fannie Mae 120-day timer from the remap effective date. */
export function floodNoticeClocks(mailed: PlainDate, remapEffective: PlainDate | null): FloodNoticeClocks {
  return { mailed, borrower_deadline: addDays(mailed, 45), fannie_120: remapEffective === null ? null : addDays(remapEffective, 120) };
}

export function placementAllowed(c: FloodNoticeClocks, on: PlainDate, sufficientEvidence: boolean): boolean {
  return !sufficientEvidence && on >= c.borrower_deadline;
}

/** Placement effective the lapse date, or the remap effective date (9.6-Q1 default). */
export function placementEffective(lapseDate: PlainDate | null, remapEffective: PlainDate | null): PlainDate {
  return lapseDate ?? remapEffective ?? (() => { throw new Error("no lapse or remap date"); })();
}

/** NFIP waiting period: 1 day when bought within 13 months of a map revision, else 30 days. */
export function nfipEffectiveDate(purchasedOn: PlainDate, remapEffective: PlainDate | null): PlainDate {
  const within13 = remapEffective !== null && purchasedOn <= addMonths(remapEffective, 13) && purchasedOn >= remapEffective;
  return addDays(purchasedOn, within13 ? 1 : 30);
}

/** 9.6-T9 — Fannie Mae evidence request: 10 fannie_et business days. */
export function fnmaEvidenceDue(requestedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(requestedOn, 10, cal); }

/** 9.6-T8 — vendor heartbeat silent ≥ 36 days. */
export function floodVendorSeverity(lastHeartbeat: PlainDate, today: PlainDate): "ok" | "sev2" { return addDays(lastHeartbeat, 36) <= today ? "sev2" : "ok"; }
