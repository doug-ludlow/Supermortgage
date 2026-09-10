/**
 * 9.9 Property preservation (vacant) — initial scope timing, allowable
 * checks with BATF/bid splits, registrations, tarps and carrier notice.
 */
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export type PreservationMode = "pfpip" | "servicer" | "suspended";
export function preservationMode(i: { pfpip: boolean; permission: string; chapter13_active: boolean }): PreservationMode {
  if (i.chapter13_active) return "suspended";
  return i.pfpip && i.permission === "Do insp and preserv" ? "pfpip" : "servicer";
}

/** Rule 2 — initial securing/services due ≤ FTV + 14. */
export function initialServicesDue(ftv: PlainDate): PlainDate { return addDays(ftv, 14); }
/** FNMA_PPM_INITIAL_SECURE_14 — a completion on/before FTV + 14 satisfies; later completions breach (sev-1) and the file must carry the documented reason. */
export function initialSecuringStatus(ftv: PlainDate, completedOn: PlainDate): { due: PlainDate; on_time: boolean; breach: "sev1" | null; reason_required: boolean } {
  const due = initialServicesDue(ftv); const late = completedOn > due;
  return { due, on_time: !late, breach: late ? "sev1" : null, reason_required: late };
}

export type ItemKind = "lock_change" | "boarding" | "yard_initial" | "debris" | "winterization" | "posting" | "grass_cut" | "roof_patch" | "other";

export interface WorkItem { readonly kind: ItemKind; readonly qty: number; readonly unit_cost_cents: Cents; readonly measure?: number; } // measure: CY for debris, inches for grass

export interface Allowable { readonly cap_cents: Cents; readonly per_unit?: boolean; }

export const ALLOWABLES: Readonly<Record<ItemKind, Allowable>> = {
  lock_change: { cap_cents: 6_000n }, boarding: { cap_cents: 18_500n, per_unit: true }, yard_initial: { cap_cents: 15_000n },
  debris: { cap_cents: 50_000n }, winterization: { cap_cents: 22_000n }, posting: { cap_cents: 5_000n },
  grass_cut: { cap_cents: 17_500n }, roof_patch: { cap_cents: 125_000n }, other: { cap_cents: 0n },
};

export type ItemDisposition = "within_allowable" | "complete_and_batf" | "stop_and_bid";

/** Rule 3 — Matrix splits: debris ≤10 CY allowable, 11–20 BATF, >20 bid; grass ≤12″ allowable, 12–36 BATF, >36 bid. */
export function itemDisposition(item: WorkItem, lifeOfLoanUsed: Cents = 0n): { disposition: ItemDisposition; cost_cents: Cents } {
  const cost = BigInt(item.qty) * item.unit_cost_cents;
  const a = ALLOWABLES[item.kind];
  const cap = a.per_unit ? a.cap_cents * BigInt(item.qty) : a.cap_cents;
  if (item.kind === "debris" && item.measure !== undefined) {
    if (item.measure > 20) return { disposition: "stop_and_bid", cost_cents: cost };
    if (item.measure > 10) return { disposition: "complete_and_batf", cost_cents: cost };
  }
  if (item.kind === "grass_cut" && item.measure !== undefined) {
    if (item.measure > 36) return { disposition: "stop_and_bid", cost_cents: cost };
    if (item.measure > 12) return { disposition: "complete_and_batf", cost_cents: cost };
  }
  if (item.kind === "other" || cost + lifeOfLoanUsed > cap) return { disposition: "stop_and_bid", cost_cents: cost };
  return { disposition: "within_allowable", cost_cents: cost };
}

export interface ScopeResult { readonly total_cents: Cents; readonly prior_approval_required: boolean; readonly items: readonly { readonly kind: ItemKind; readonly disposition: ItemDisposition; readonly cost_cents: Cents }[]; }

export function evaluateScope(items: readonly WorkItem[]): ScopeResult {
  const out = items.map((i) => ({ kind: i.kind, ...itemDisposition(i) }));
  return { total_cents: out.reduce((s, i) => s + i.cost_cents, 0n), prior_approval_required: out.some((i) => i.disposition === "stop_and_bid"), items: out };
}

/** Rule 3 — bid due 15 days from discovery; reconsideration 7 days after a denial/modification. */
export function bidDue(discoveredOn: PlainDate): PlainDate { return addDays(discoveredOn, 15); }
export function reconsiderationDue(decisionOn: PlainDate): PlainDate { return addDays(decisionOn, 7); }
export function photosFresh(takenOn: PlainDate, submittedOn: PlainDate): boolean { return addDays(takenOn, 30) >= submittedOn; }

const NO_WINTERIZATION: ReadonlySet<string> = new Set(["HI", "GU", "PR", "VI"]);
/** Rule 2 — winterization year-round except HI/GU/PR/VI. */
export function winterizationRequired(state: string): boolean { return !NO_WINTERIZATION.has(state.toUpperCase()); }

/** Rule 6 — tarp timer 60 days. */
export function tarpDeadline(installedOn: PlainDate): PlainDate { return addDays(installedOn, 60); }
export function damageDisposition(estimateCents: Cents): "patch" | "tarp_and_bid" { return estimateCents <= 125_000n ? "patch" : "tarp_and_bid"; }

/** Rule 7 — vacant-property registration from jurisdiction rules: file by trigger + ordinance days; the renewal (`JUR_VACANT_REGISTRATION_RENEWAL_<id>`) runs the ordinance period from `filed_at` — until the filing is recorded, from the filing deadline as the latest date it could run from. */
export function registrationClocks(triggerOn: PlainDate, rule: { within_days: number; renewal_months: number | null } | null, filedOn: PlainDate | null = null): { file_by: PlainDate; renew_on: PlainDate | null; renewal_anchor: "filed_at" | "filing_deadline" } | null {
  if (rule === null) return null;
  const fileBy = addDays(triggerOn, rule.within_days);
  const anchor = filedOn ?? fileBy;
  return { file_by: fileBy, renew_on: rule.renewal_months === null ? null : addMonths(anchor, rule.renewal_months), renewal_anchor: filedOn === null ? "filing_deadline" : "filed_at" };
}

/** Rule 3 — the over-allowable bid package for HomeTracker (`human_portal_task` for `fnma_portal_operator`): Form 1095 fields, itemized bid, dated photos ≤ 30 days old. */
export function bidPackage(discoveredOn: PlainDate, photosTakenOn: readonly PlainDate[], submittedOn: PlainDate): { due: PlainDate; channel: "hometracker"; human_task: "human_portal_task"; owner_role: "fnma_portal_operator"; form: "1095"; photos_fresh: boolean; stale_photos: PlainDate[] } {
  const stale = photosTakenOn.filter((p) => !photosFresh(p, submittedOn));
  return { due: bidDue(discoveredOn), channel: "hometracker", human_task: "human_portal_task", owner_role: "fnma_portal_operator", form: "1095", photos_fresh: photosTakenOn.length > 0 && stale.length === 0, stale_photos: stale };
}

/** Rule 8 — code violations within caps ($1,000 per, $3,000 life). */
export function codeViolationDisposition(amount: Cents, lifeUsed: Cents): "pay" | "bid" { return amount <= 100_000n && lifeUsed + amount <= 300_000n ? "pay" : "bid"; }

/** Rule 9 — carrier notified of vacancy within 5 business days. */
export function carrierVacancyNoticeDue(vacancyOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(vacancyOn, 5, cal); }

/** 9.9-T11 — Fannie Mae audit request: documents within 5 business days. */
export function auditDocumentsDue(requestedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(requestedOn, 5, cal); }
