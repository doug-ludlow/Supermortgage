/**
 * §9.8 operating rules over the pure calculators in inspection.ts. Each function appends to the caller's event store
 * the events the 9.8 timer table names, so the D2-2-10 / E-3.3-03 / PFPIP clocks arm and close on what the process
 * actually does (src/domain/insurance/timers-9-8.ts aligns the registry rows to these payloads):
 * - `inspectionSweep` (build spec "Daily `inspection_sweep`": day count, occupancy, exception flags, program enrollment
 *   → create/advance the schedule) → `delinquency.day90.reached{earliest_unpaid_due, day90_on, complete_by,
 *   pfpip_eligible}` once per delinquency episode (arms FNMA_D2210_INSPECT_ORDER_DAY90 / _COMPLETE_DAY120 /
 *   FNMA_P360_PFPIP_SUBMIT_DAY90) plus the schedule state (rule 3 exception engine; T2; T8 backstop);
 * - `recordInspectionResult` — the vendor's Form 30-equivalent result (inbound: "vendor inspection results (Form 30
 *   data + photos)") validated and appended as `property.inspection.completed{type, purpose, completed_at, inspected_on,
 *   occupancy_result, certification_signed, initial, cost_cents}` (satisfies the day-120, 20–35-day, interior-monthly,
 *   vacancy-ASAP and pre-sale rows; the first completion arms the 20–35-day cadence) and, for a vacancy finding without
 *   the inspector's signed certification, `property.vacancy_suspected` (rule 5: the first vacancy needs the signed
 *   certification; the finding is an indicator until then);
 * - `suspectVacancy` — a vacancy indicator (returned mail, utility shut-off notice, neighbor call, code notice,
 *   inspection result) → `property.vacancy_suspected{suspected_on, source}` (arms FNMA_D2210_VACANCY_INSPECT_ASAP_3BD);
 * - `occupancyUpdated` — `properties.occupancy_status` changes that are not a certified vacancy →
 *   `property.occupancy.updated`, routing `vacancy_suspected` through `suspectVacancy`;
 * - `pfpipChangeReported` — a delinquency/foreclosure/BK/loss-mit/occupancy/claim/HOA change already reported to
 *   Fannie Mae elsewhere (Investor Reporting, 11.x–14.x, this process's own occupancy determination, a reconciliation
 *   delta) → `loan.status.reported_to_fnma{change, changed_on, pfpip_enrolled}` (arms FNMA_P360_PFPIP_STATUS_SYNC_2BD,
 *   closed by updatePfpip's `p360.pfpip.updated`);
 * - `inspectionClaimLines` (rule 7 / T9) — the 15.2 claim lines for servicer-ordered inspections at the F-1-05 caps,
 *   due 60 calendar days after the milestone (program inspections are Fannie Mae's cost and are never claimed).
 * Money is bigint cents; dates are PlainDate on the calendars the spec names; every inbound record is validated before
 * anything is appended (a bad record throws RangeError and appends nothing).
 */
import { type PlainDate, plainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { fnmaDaysDelinquent, inspectionWindow, inspectionSuspended, nextInspectionWindow, inspectionClaim, servicerBackstopOrder, pfpipTaskDue, INSPECTION_CAPS, type InspectionMode, type InspectionType, type InspectionPurpose, type ExceptionInput } from "./inspection.ts";
import { ET } from "./ops.ts";

/** What every 9.8 operation needs from the command: the event store, who acts, the loan and the transaction clock. */
export interface InspectionCtx { readonly events: EventStore; readonly actor: Actor; readonly loanId: string; readonly now: string; }

export const INSPECTION_TYPES: readonly InspectionType[] = ["interior", "exterior", "curbside"];
export const INSPECTION_PURPOSES: readonly InspectionPurpose[] = ["delinquency", "vacancy_confirmation", "occupancy_check", "pre_sale_35", "disaster", "insured_loss_repair", "disrepair", "code_violation", "other"];
export type OccupancyResult = "occupied_borrower" | "occupied_tenant" | "occupied_unknown" | "vacant" | "abandoned" | "unknown";
export const OCCUPANCY_RESULTS: readonly OccupancyResult[] = ["occupied_borrower", "occupied_tenant", "occupied_unknown", "vacant", "abandoned", "unknown"];
export type VacancySource = "returned_mail" | "utility_shutoff_notice" | "neighbor_call" | "code_notice" | "inspection_result" | "other";
export const VACANCY_SOURCES: readonly VacancySource[] = ["returned_mail", "utility_shutoff_notice", "neighbor_call", "code_notice", "inspection_result", "other"];
/** The status changes the PFPIP job aid says must also be updated in the program ("Any changes made in Investor Reporting also need to be updated … via Property 360"). */
export type PfpipChange = "delinquency" | "foreclosure" | "bankruptcy" | "loss_mit" | "occupancy" | "claim" | "hoa" | "reconciliation_delta";
export const PFPIP_CHANGES: readonly PfpipChange[] = ["delinquency", "foreclosure", "bankruptcy", "loss_mit", "occupancy", "claim", "hoa", "reconciliation_delta"];
/** Policy on D2-2-10's "as soon as possible": a suspected vacancy is inspected within 3 servicer business days (FNMA_D2210_VACANCY_INSPECT_ASAP_3BD). */
export const VACANCY_INSPECT_BUSINESS_DAYS = 3;

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const requireDate = (v: unknown, what: string): PlainDate => { if (!isDate(v)) throw new RangeError(`${what} must be a YYYY-MM-DD date`); return plainDate(v); };
const requireId = (v: unknown, what: string): string => { if (typeof v !== "string" || v === "") throw new RangeError(`${what} is required`); return v; };
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T => { if (!allowed.includes(v as T)) throw new RangeError(`${what} must be one of ${allowed.join(", ")}`); return v as T; };
const append = (c: InspectionCtx, type: string, payload: Record<string, unknown>): DomainEvent => c.events.append({ type, loanId: c.loanId, actor: c.actor, payload });
const loanEvents = (c: InspectionCtx, type: string): readonly DomainEvent[] => c.events.byLoan(c.loanId).filter((e) => e.type === type);
const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;

// ---------------------------------------------------------------------------
// Daily sweep — state machine "not_required → initial_due → initial_ordered → initial_completed → recurring ⇄ suspended_exception → closed"
// ---------------------------------------------------------------------------
export type ScheduleState = "not_required" | "initial_due" | "initial_ordered" | "initial_completed" | "recurring" | "suspended_exception" | "closed";
export interface SweepInput {
  readonly earliest_unpaid_due: PlainDate | null;
  readonly today: PlainDate;
  readonly mode: InspectionMode;
  readonly exception?: ExceptionInput | null;
  /** Fannie Mae's Loan Search / reports show a program inspection (PFPIP loans; rule 2 / T8). */
  readonly fnma_inspection_seen?: boolean;
  /** The loan left the population: sale, Mortgage Release, reinstatement, payoff, REO. */
  readonly closed?: boolean;
}
export interface SweepResult {
  readonly day: number;
  readonly window: ReturnType<typeof inspectionWindow> | null;
  readonly state: ScheduleState;
  readonly suspended: boolean;
  readonly last_completed: PlainDate | null;
  /** Next 20–35-day window from the last completion (null while not required / suspended / closed). */
  readonly next: { from: PlainDate; to: PlainDate } | null;
  /** Rule 2 / T8: PFPIP loan with no Fannie Mae inspection by day 110 → the servicer orders its own. */
  readonly backstop_order: boolean;
  /** The `delinquency.day90.reached` event this sweep appended (null when already emitted for this episode or day < 90). */
  readonly day90_event: DomainEvent | null;
}
/** Build spec inputs: "for each loan compute `fnma_days_delinquent`, occupancy status, exception flags, program enrollment; create/advance" the schedule. Day 90 is announced once per delinquency episode (keyed on the earliest unpaid due date) so the day-90 / day-120 / PFPIP clocks arm exactly once. */
export function inspectionSweep(c: InspectionCtx, f: SweepInput): SweepResult {
  const eu = f.earliest_unpaid_due;
  const day = fnmaDaysDelinquent(eu, f.today);
  const window = eu ? inspectionWindow(eu) : null;
  const completed = loanEvents(c, "property.inspection.completed").map((e) => (e.payload as { completed_at?: unknown }).completed_at).filter(isDate).sort();
  const last = completed.at(-1) ?? null;
  const ordered = loanEvents(c, "property.inspection.ordered").length > 0;
  const suspended = f.exception ? inspectionSuspended(f.exception, f.today) : false;
  let day90_event: DomainEvent | null = null;
  if (eu && window && day >= 90 && !f.closed && !loanEvents(c, "delinquency.day90.reached").some((e) => (e.payload as { earliest_unpaid_due?: unknown }).earliest_unpaid_due === eu)) {
    day90_event = append(c, "delinquency.day90.reached", { earliest_unpaid_due: eu, day, day90_on: window.order_allowed, complete_by: window.complete_by, pfpip_eligible: f.mode === "pfpip", mode: f.mode, on: f.today });
  }
  const state: ScheduleState = f.closed ? "closed" : !eu || day < 90 ? "not_required" : last === null ? (ordered ? "initial_ordered" : "initial_due") : suspended ? "suspended_exception" : "recurring";
  return { day, window, state, suspended, last_completed: last, next: state === "recurring" && last ? nextInspectionWindow(last) : null,
    backstop_order: !f.closed && servicerBackstopOrder(f.mode, f.fnma_inspection_seen === true || last !== null, day), day90_event };
}

// ---------------------------------------------------------------------------
// Inbound vendor result (Form 30 equivalent) → property.inspection.completed
// ---------------------------------------------------------------------------
export interface InspectionResultRecord {
  readonly inspection_id: string;
  readonly type: InspectionType;
  readonly purpose: InspectionPurpose;
  readonly completed_on: PlainDate;
  readonly occupancy_result: OccupancyResult;
  readonly certification_signed: boolean;
  readonly report_document_id: string;
  readonly photos: readonly string[];
  readonly cost_cents: Cents;
  readonly ordered_by?: "servicer" | "fnma_program";
  readonly legal_constraint_reason?: string | null;
  readonly condition?: Record<string, unknown> | null;
}
export interface InspectionRecorded {
  readonly event: DomainEvent;
  readonly initial: boolean;
  readonly next_window: { from: PlainDate; to: PlainDate };
  readonly vacancy: "confirmed_certified" | "suspected_uncertified" | null;
  readonly vacancy_suspected_event: DomainEvent | null;
  readonly reimbursable: boolean;
  readonly cap_cents: Cents;
}
/** Validate the vendor's result and append `property.inspection.completed`. The first completion for the loan is `initial` (arms the 20–35-day cadence); a vacancy finding without the signed certification is a suspicion, never a confirmation (rule 5 / guardrail). */
export function recordInspectionResult(c: InspectionCtx, r: Record<string, unknown>): InspectionRecorded {
  const inspection_id = requireId(r.inspection_id, "inspection_id");
  const type = oneOf(r.type, INSPECTION_TYPES, "type");
  const purpose = oneOf(r.purpose, INSPECTION_PURPOSES, "purpose");
  const completed_on = requireDate(r.completed_on, "completed_on");
  if (completed_on > etDate(c.now)) throw new RangeError("completed_on cannot be in the future");
  const occupancy_result = oneOf(r.occupancy_result, OCCUPANCY_RESULTS, "occupancy_result");
  const certification_signed = r.certification_signed === true;
  const report_document_id = requireId(r.report_document_id, "report_document_id (Form 30 equivalent)");
  const photos = Array.isArray(r.photos) ? (r.photos as unknown[]).filter((p): p is string => typeof p === "string" && p !== "") : [];
  if (photos.length === 0) throw new RangeError("photos are required (GPS/time-stamped)");
  const cost_cents = typeof r.cost_cents === "bigint" ? r.cost_cents : r.cost_cents === undefined || r.cost_cents === null ? 0n : BigInt(String(r.cost_cents));
  if (cost_cents < 0n) throw new RangeError("cost_cents cannot be negative");
  const legal_constraint_reason = typeof r.legal_constraint_reason === "string" && r.legal_constraint_reason !== "" ? r.legal_constraint_reason : null;
  if (type === "curbside" && !legal_constraint_reason) throw new RangeError("a curbside inspection needs the recorded legal-constraint/danger reason (rule 4)");
  const ordered_by = r.ordered_by === "fnma_program" ? "fnma_program" : "servicer";
  if (loanEvents(c, "property.inspection.completed").some((e) => (e.payload as { inspection_id?: unknown }).inspection_id === inspection_id)) throw new RangeError(`inspection ${inspection_id} is already recorded`);
  const initial = loanEvents(c, "property.inspection.completed").length === 0;
  const vacant = occupancy_result === "vacant" || occupancy_result === "abandoned";
  const reimbursable = ordered_by === "servicer" && purpose !== "insured_loss_repair";
  const event = append(c, "property.inspection.completed", { inspection_id, type, purpose, completed_at: completed_on, inspected_on: completed_on, occupancy_result, certification_signed, initial, ordered_by, cost_cents, cap_cents: INSPECTION_CAPS[type], reimbursable, report_document_id, photos, legal_constraint_reason, condition: (r.condition as Record<string, unknown> | undefined) ?? null });
  const vacancy_suspected_event = vacant && !certification_signed ? suspectVacancy(c, { suspected_on: completed_on, source: "inspection_result", detail: `inspection ${inspection_id}: ${occupancy_result} without the inspector's signed certification` }).event : null;
  return { event, initial, next_window: nextInspectionWindow(completed_on), vacancy: vacant ? (certification_signed ? "confirmed_certified" : "suspected_uncertified") : null, vacancy_suspected_event, reimbursable, cap_cents: INSPECTION_CAPS[type] };
}

// ---------------------------------------------------------------------------
// Vacancy indicators and occupancy updates
// ---------------------------------------------------------------------------
/** A possible vacancy → inspect "as soon as possible" (D2-2-10): `property.vacancy_suspected{suspected_on, source}`, confirmation inspection due within 3 servicer business days. */
export function suspectVacancy(c: InspectionCtx, f: { suspected_on: PlainDate; source: VacancySource | string; detail?: string | null }): { event: DomainEvent; confirm_by: PlainDate } {
  const source = oneOf(f.source, VACANCY_SOURCES, "source");
  const suspected_on = requireDate(f.suspected_on, "suspected_on");
  const confirm_by = addBusinessDays(suspected_on, VACANCY_INSPECT_BUSINESS_DAYS, servicer);
  const event = append(c, "property.vacancy_suspected", { suspected_on, source, detail: f.detail ?? null, confirm_by, order_floor: "none (vacancy inspections have no day-90 floor)" });
  return { event, confirm_by };
}
/** `properties.occupancy_status` changed without a certified vacancy (occupied / occupied_tenant / unknown / vacancy_suspected). */
export function occupancyUpdated(c: InspectionCtx, f: { occupancy: string; on: PlainDate; source?: VacancySource | string | null }): { event: DomainEvent; occupancy: string; confirm_by: PlainDate | null } {
  const occupancy = requireId(f.occupancy, "occupancy");
  if (occupancy === "vacant") throw new RangeError("a vacancy is recorded through the certified-vacancy path (signed inspection report), never as a plain occupancy update");
  const on = requireDate(f.on, "on");
  const event = append(c, "property.occupancy.updated", { occupancy, on });
  const s = occupancy === "vacancy_suspected" ? suspectVacancy(c, { suspected_on: on, source: f.source ?? "other" }) : null;
  return { event, occupancy, confirm_by: s ? s.confirm_by : null };
}

// ---------------------------------------------------------------------------
// PFPIP: a change reported to Fannie Mae elsewhere must reach the program record within 2 business days
// ---------------------------------------------------------------------------
/** `loan.status.reported_to_fnma{change, changed_on, pfpip_enrolled}` — the FNMA_P360_PFPIP_STATUS_SYNC_2BD trigger; `update_by` is null for loans outside the program (nothing to sync). */
export function pfpipChangeReported(c: InspectionCtx, f: { change: PfpipChange | string; changed_on: PlainDate; pfpip_enrolled: boolean; detail?: string | null }): { event: DomainEvent; update_by: PlainDate | null } {
  const change = oneOf(f.change, PFPIP_CHANGES, "change");
  const changed_on = requireDate(f.changed_on, "changed_on");
  const update_by = f.pfpip_enrolled ? pfpipTaskDue(changed_on) : null;
  const event = append(c, "loan.status.reported_to_fnma", { change, changed_on, pfpip_enrolled: f.pfpip_enrolled, update_by, detail: f.detail ?? null });
  return { event, update_by };
}

// ---------------------------------------------------------------------------
// Rule 7 / T9 — the 15.2 claim lines at the F-1-05 caps within 60 days of the milestone
// ---------------------------------------------------------------------------
export interface InspectionCostLine { readonly inspection_id: string; readonly type: InspectionType; readonly cost_cents: Cents; readonly ordered_by?: "servicer" | "fnma_program"; }
export interface InspectionClaimLines { readonly milestone_on: PlainDate; readonly file_by: PlainDate; readonly lines: readonly { inspection_id: string; type: InspectionType; cost_cents: Cents; claim_cents: Cents; cap_cents: Cents }[]; readonly total_claim_cents: Cents; readonly not_claimed: readonly string[]; }
export function inspectionClaimLines(f: { mode: InspectionMode; milestone_on: PlainDate; inspections: readonly InspectionCostLine[] }): InspectionClaimLines {
  if (f.inspections.length === 0) throw new RangeError("no inspection costs to claim");
  const lines: { inspection_id: string; type: InspectionType; cost_cents: Cents; claim_cents: Cents; cap_cents: Cents }[] = [];
  const not_claimed: string[] = [];
  for (const i of f.inspections) {
    const claim = i.ordered_by === "fnma_program" ? null : inspectionClaim(f.mode, i.type, i.cost_cents, f.milestone_on);
    if (!claim) { not_claimed.push(i.inspection_id); continue; }
    lines.push({ inspection_id: i.inspection_id, type: i.type, cost_cents: i.cost_cents, claim_cents: claim.claim_cents, cap_cents: INSPECTION_CAPS[i.type] });
  }
  return { milestone_on: f.milestone_on, file_by: addDays(f.milestone_on, 60), lines, total_claim_cents: lines.reduce((s, l) => s + l.claim_cents, 0n), not_claimed };
}
