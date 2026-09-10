/**
 * 9.8 Property inspection (delinquent) — D2-2-10 day counts, exception
 * engine, pre-sale window and reimbursement caps.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";

/** Rule 1 — day 1 = due date + 1. */
export function fnmaDaysDelinquent(earliestUnpaidDue: PlainDate | null, today: PlainDate): number {
  return earliestUnpaidDue === null ? 0 : Math.max(0, daysBetween(earliestUnpaidDue, today));
}

export interface InspectionWindow { readonly order_allowed: PlainDate; readonly complete_by: PlainDate; readonly vacancy_exception_by: PlainDate; }

/** Day 90 order, day 120 complete, day 45 vacancy exception (worked: 2026-11-01 → 01-30 / 03-01 / 12-16). */
export function inspectionWindow(earliestUnpaidDue: PlainDate): InspectionWindow {
  return { order_allowed: addDays(earliestUnpaidDue, 90), complete_by: addDays(earliestUnpaidDue, 120), vacancy_exception_by: addDays(earliestUnpaidDue, 45) };
}

export type InspectionMode = "pfpip" | "servicer";
export function inspectionMode(i: { conventional_first_lien: boolean; recourse: boolean; enrolled: boolean; fnma_rejected: boolean }): InspectionMode {
  return i.conventional_first_lien && !i.recourse && i.enrolled && !i.fnma_rejected ? "pfpip" : "servicer";
}

export interface ExceptionInput { readonly occupied: boolean; readonly last_qrpc_on: PlainDate | null; readonly last_full_payment_on: PlainDate | null; readonly performing_workout: boolean; readonly performing_bk_plan: boolean; }

/** Rule 3 — suspend = occupied AND (QRPC ≤ 30d OR full payment ≤ 30d OR performing workout/BK plan); vacancy overrides. */
export function inspectionSuspended(e: ExceptionInput, today: PlainDate): boolean {
  if (!e.occupied) return false;
  const within30 = (d: PlainDate | null) => d !== null && daysBetween(d, today) <= 30;
  return within30(e.last_qrpc_on) || within30(e.last_full_payment_on) || e.performing_workout || e.performing_bk_plan;
}

/** Recurring: next inspection due 20–35 days after the last. */
export function nextInspectionWindow(lastCompleted: PlainDate): { from: PlainDate; to: PlainDate } { return { from: addDays(lastCompleted, 20), to: addDays(lastCompleted, 35) }; }

export type InspectionType = "interior" | "exterior" | "curbside";
export function inspectionType(i: { vacant: boolean; interior_entry_allowed: boolean; legal_constraint_reason: string | null }): InspectionType {
  if (i.legal_constraint_reason) return "curbside";
  return i.vacant && i.interior_entry_allowed ? "interior" : "exterior";
}

/** Rule 6 — order at sale − 21, complete by sale − 7, window sale − 35 … sale − 1. */
export function preSaleInspection(saleDate: PlainDate): { order_by: PlainDate; complete_by: PlainDate; window_from: PlainDate; window_to: PlainDate } {
  return { order_by: addDays(saleDate, -21), complete_by: addDays(saleDate, -7), window_from: addDays(saleDate, -35), window_to: addDays(saleDate, -1) };
}

/** F-1-05 Defined Expense Reimbursement Limits (as extracted 2026-09-09): interior $45, exterior $30 (a curbside counts as exterior), insured-loss repair $60 per inspection. */
export const INSPECTION_CAPS: Readonly<Record<InspectionType, Cents>> = { curbside: 3_000n, exterior: 3_000n, interior: 4_500n };
export const INSURED_LOSS_REPAIR_INSPECTION_CAP: Cents = 6_000n;

/** Rule 7 — servicer-ordered inspections claimed at ≤ $30/$45 caps within 60 days of the milestone; program inspections not claimed. */
export function inspectionClaim(mode: InspectionMode, type: InspectionType, cost: Cents, milestoneOn: PlainDate): { claim_cents: Cents; due: PlainDate } | null {
  if (mode === "pfpip") return null;
  const cap = INSPECTION_CAPS[type];
  return { claim_cents: cost < cap ? cost : cap, due: addDays(milestoneOn, 60) };
}

/** 9.7 rule 10 / F-1-05 — insured-loss repair inspections at ≤ $60; current-loan costs claimed within one year (FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365). */
export function repairInspectionClaim(cost: Cents, incurredOn: PlainDate, delinquent: boolean): { claim_cents: Cents; due: PlainDate | null } {
  return { claim_cents: cost < INSURED_LOSS_REPAIR_INSPECTION_CAP ? cost : INSURED_LOSS_REPAIR_INSPECTION_CAP, due: delinquent ? null : addDays(incurredOn, 365) };
}

export type InspectionPurpose = "delinquency" | "vacancy_confirmation" | "occupancy_check" | "pre_sale_35" | "disaster" | "insured_loss_repair" | "disrepair" | "code_violation" | "other";
/** FNMA_D2210_INSPECT_ORDER_DAY90 — no order before day 90 except vacancy checks (D2-2-10; vacancy inspections have no day-90 floor). */
export function inspectionOrderAllowed(purpose: InspectionPurpose | string, day: number): { allowed: boolean; reason: string | null } {
  if (purpose === "vacancy_confirmation" || purpose === "occupancy_check" || purpose === "disaster" || purpose === "insured_loss_repair") return { allowed: true, reason: null };
  if (!Number.isFinite(day)) return { allowed: false, reason: "delinquency day count required (fnma_days_delinquent from the earliest unpaid due date)" };
  return day >= 90 ? { allowed: true, reason: null } : { allowed: false, reason: `day ${day}: the first inspection is ordered on or after the 90th day of delinquency (D2-2-10)` };
}

/** FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45 — the vacancy exception submission is due at delinquency day 45 (earliest unpaid due date + 45) or when vacancy is confirmed, whichever is later. */
export function pfpipExceptionSubmitOn(earliestUnpaidDue: PlainDate, vacancyConfirmedOn: PlainDate): PlainDate {
  const day45 = addDays(earliestUnpaidDue, 45);
  return day45 > vacancyConfirmedOn ? day45 : vacancyConfirmedOn;
}

/** 9.8-T5 / T3 — PFPIP submission and occupancy updates within 2 business days. */
export function pfpipTaskDue(on: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(on, 2, cal); }

/** 9.8-T8 — on PFPIP loans, order our own inspection only if Fannie Mae's data shows none by day 110. */
export function servicerBackstopOrder(mode: InspectionMode, fnmaInspectionSeen: boolean, day: number): boolean {
  return mode === "pfpip" && !fnmaInspectionSeen && day >= 110;
}

export function pfpipPermission(i: { bankruptcy_active: boolean; preserve_allowed: boolean }): string {
  if (i.bankruptcy_active) return "Do curbside inspection and no preserv.";
  return i.preserve_allowed ? "Do insp and preserv" : "Do insp only";
}
