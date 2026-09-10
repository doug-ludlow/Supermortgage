/**
 * §9.9 operating rules over the pure calculators in preservation.ts. Each function validates an inbound record (the
 * field-services vendor's work-order feed, the agent's own scope decisions) and appends to the caller's event store the
 * events the 9.9 timer table names, so the Property Preservation Matrix clocks arm and close on what the process actually
 * does (src/domain/insurance/timers-9-9.ts aligns the registry rows to these payloads):
 * - `postingPlaced` — the vendor reports the vacancy notice posted (build spec: "`posted` (optional vacancy posting;
 *   expiry ≤ FTV + 7)"; Matrix: "the notice must show clear contact information and a projected securing date ≤ 14 days
 *   from FTV") → `preservation.posting.placed{posted_on, expires_on, ftv_date, projected_securing_date, secure_by}`
 *   (arms FNMA_PPM_POST_NOTICE_SECURE_7 on `expires_on`);
 * - `conditionDiscovered` — a condition flagged by an inspection (9.8), the vendor's field report, a code notice or a
 *   disaster event → `preservation.condition.discovered{item, discovered_on, after_initial_securing, over_allowable,
 *   disposition, measure, bid_due, repair_due}` (arms FNMA_PPM_WINDOW_DOOR_REPAIR_3, FNMA_PPM_YARD_REBID_15 and
 *   FNMA_PPM_OVER_ALLOWABLE_BID_15 on `discovered_on`);
 * - `workCompleted` — the vendor's completion report (dated before/during/after photos, haul-away evidence, invoice)
 *   validated by the photo QC the spec's `reviewCompletion` tool describes → `preservation.work.completed{kind, item,
 *   completed_on, cost_cents, batf}` (satisfies the window/door and tarp rows; `item=roof_tarp` arms FNMA_PPM_ROOF_TARP_60
 *   on `completed_on`) and, for `kind=initial_services` (securing + initial services), `preservation.initial.completed
 *   {completed_on, ftv_date, due, on_time, late, reason}` (satisfies FNMA_PPM_INITIAL_SECURE_14 and
 *   FNMA_PPM_POST_NOTICE_SECURE_7; a completion after FTV + 14 breaches sev-1 and "reason documented" is required — T1).
 * Money is bigint cents; dates are PlainDate; every inbound record is validated before anything is appended (a bad record
 * throws RangeError and appends nothing).
 */
import { type PlainDate, plainDate, addDays } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { initialSecuringStatus, bidDue, photosFresh, itemDisposition, tarpDeadline, type ItemDisposition, type WorkItem } from "./preservation.ts";

/** What every 9.9 operation needs from the command: the event store, who acts, the loan and the transaction clock. */
export interface PreservationCtx { readonly events: EventStore; readonly actor: Actor; readonly loanId: string; readonly now: string; }

/** Work-order kinds (`preservation_work_orders.kind`). `initial_services` is the securing + initial-services order the 14-day clock waits for. */
export type WorkKind = "initial_secure" | "initial_services" | "ongoing" | "emergency" | "damage" | "code_violation" | "registration" | "utility" | "specialty";
export const WORK_KINDS: readonly WorkKind[] = ["initial_secure", "initial_services", "ongoing", "emergency", "damage", "code_violation", "registration", "utility", "specialty"];
/** Condition flags the inspection / vendor report can raise (inputs: "broken window/door, roof damage, standing water, grass > 12″, debris, pool"). */
export type ConditionItem = "unsecured_opening" | "grass_over_12in" | "roof_damage" | "debris" | "pool" | "standing_water" | "code_violation" | "snow_over_3in" | "winterization_compromised" | "other";
export const CONDITION_ITEMS: readonly ConditionItem[] = ["unsecured_opening", "grass_over_12in", "roof_damage", "debris", "pool", "standing_water", "code_violation", "snow_over_3in", "winterization_compromised", "other"];
/** Work items the completion report names (`preservation_work_orders.items[].allowable_code`); `roof_tarp` arms the 60-day tarp clock, `roof_repair` closes it. */
export type CompletedItem = "initial_services" | "posting" | "lock_change" | "boarding" | "unsecured_opening" | "yard_initial" | "grass_cut" | "debris" | "winterization" | "roof_patch" | "roof_tarp" | "roof_repair" | "pool_cover" | "snow_removal" | "code_violation" | "other";
export const COMPLETED_ITEMS: readonly CompletedItem[] = ["initial_services", "posting", "lock_change", "boarding", "unsecured_opening", "yard_initial", "grass_cut", "debris", "winterization", "roof_patch", "roof_tarp", "roof_repair", "pool_cover", "snow_removal", "code_violation", "other"];
export const PHOTO_STAGES = ["before", "during", "after"] as const;
export type PhotoStage = (typeof PHOTO_STAGES)[number];
export interface Photo { readonly stage: PhotoStage; readonly taken_on: PlainDate; readonly document_id?: string; }

/** Matrix: "with a posted vacancy notice, within 7 calendar days of the notice's expiration and still within 14 days of FTV" — so the posting may not expire after FTV + 7. */
export const POSTING_MAX_DAYS_AFTER_FTV = 7;
export const UNSECURED_OPENING_REPAIR_DAYS = 3;
export const REBID_DAYS = 15;

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const requireDate = (v: unknown, what: string): PlainDate => { if (!isDate(v)) throw new RangeError(`${what} must be a YYYY-MM-DD date`); return plainDate(v); };
const optDate = (v: unknown, what: string): PlainDate | null => (v === undefined || v === null || v === "" ? null : requireDate(v, what));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T => { if (!allowed.includes(v as T)) throw new RangeError(`${what} must be one of ${allowed.join(", ")}`); return v as T; };
const requireCents = (v: unknown, what: string): Cents => { if (typeof v !== "bigint" || v < 0n) throw new RangeError(`${what} must be non-negative bigint cents`); return v; };
const append = (c: PreservationCtx, type: string, payload: Record<string, unknown>): DomainEvent => c.events.append({ type, loanId: c.loanId, actor: c.actor, payload });
/** Guardrail "neutral postings": the notice carries contact information only — no debt, delinquency or foreclosure language (Fair Housing / UDAAP). */
export const NON_NEUTRAL_POSTING = /debt|delinquen|foreclos|owe|default/i;

// ---------------------------------------------------------------------------
// Vacancy posting — state `posted`
export interface PostingInput {
  readonly posted_on: unknown; readonly expires_on: unknown; readonly ftv_date: unknown; readonly projected_securing_date: unknown;
  readonly servicer_contact?: unknown; readonly vendor_contact?: unknown; readonly text?: unknown; readonly photo_document_id?: unknown;
}
export interface PostingPlaced { readonly posted_on: PlainDate; readonly expires_on: PlainDate; readonly ftv_date: PlainDate; readonly initial_due: PlainDate; readonly secure_by: PlainDate; readonly projected_securing_date: PlainDate; readonly event: DomainEvent; }
/** Vendor reports the vacancy notice posted (rule 2 "posting with servicer + vendor contacts"). Securing is then due 7 days after the expiry and still ≤ FTV + 14 (FNMA_PPM_POST_NOTICE_SECURE_7). */
export function postingPlaced(c: PreservationCtx, i: PostingInput): PostingPlaced {
  const postedOn = requireDate(i.posted_on, "posted_on"); const expiresOn = requireDate(i.expires_on, "expires_on"); const ftv = requireDate(i.ftv_date, "ftv_date");
  const projected = requireDate(i.projected_securing_date, "projected_securing_date");
  const initialDue = addDays(ftv, 14);
  if (expiresOn < postedOn) throw new RangeError("posting expires_on precedes posted_on");
  if (expiresOn > addDays(ftv, POSTING_MAX_DAYS_AFTER_FTV)) throw new RangeError(`posting expiry ${expiresOn} is after FTV + ${POSTING_MAX_DAYS_AFTER_FTV} (${addDays(ftv, POSTING_MAX_DAYS_AFTER_FTV)}) — securing 7 days after expiry would fall outside the 14-day initial window (PPM §4)`);
  if (projected > initialDue) throw new RangeError(`projected securing date ${projected} is after FTV + 14 (${initialDue}) — the posting must show a projected securing date ≤ 14 days from FTV (PPM §4)`);
  if (typeof i.servicer_contact !== "string" || i.servicer_contact === "" || typeof i.vendor_contact !== "string" || i.vendor_contact === "") throw new RangeError("posting needs clear servicer and vendor contact information (PPM §4)");
  if (typeof i.text === "string" && NON_NEUTRAL_POSTING.test(i.text)) throw new RangeError("posting text must be neutral — contact information only (9.9 guardrail)");
  const secureBy = addDays(expiresOn, 7) < initialDue ? addDays(expiresOn, 7) : initialDue;
  const event = append(c, "preservation.posting.placed", { posted_on: postedOn, expires_on: expiresOn, ftv_date: ftv, initial_due: initialDue, projected_securing_date: projected, secure_by: secureBy, servicer_contact: i.servicer_contact, vendor_contact: i.vendor_contact, photo_document_id: typeof i.photo_document_id === "string" ? i.photo_document_id : null });
  return { posted_on: postedOn, expires_on: expiresOn, ftv_date: ftv, initial_due: initialDue, secure_by: secureBy, projected_securing_date: projected, event };
}

// ---------------------------------------------------------------------------
// Condition discovered — the trigger of the window/door, yard re-bid and over-allowable bid clocks
export interface ConditionInput {
  readonly item: unknown; readonly discovered_on: unknown;
  /** The 14-day initial window covers openings found before securing; the 3-day repair clock runs for openings found after it (PPM §4: "then within 3 days of discovery"). */
  readonly after_initial_securing?: unknown;
  /** Grass height (inches) / debris volume (CY) / cost estimate — what decides allowable vs BATF vs bid (rule 3). */
  readonly measure?: unknown; readonly estimate_cents?: unknown; readonly source?: unknown; readonly photo_document_ids?: unknown;
  /** Specialty / unmapped work already priced above the allowable (rule 3 "specialty work" → stop and bid). */
  readonly over_allowable?: unknown;
}
export interface ConditionDiscovered { readonly item: ConditionItem; readonly discovered_on: PlainDate; readonly after_initial_securing: boolean; readonly disposition: ItemDisposition; readonly over_allowable: boolean; readonly bid_due: PlainDate | null; readonly repair_due: PlainDate | null; readonly event: DomainEvent; }
const scopeItemFor = (item: ConditionItem, measure: number | null, estimate: Cents | null): WorkItem | null => {
  if (item === "grass_over_12in") return { kind: "grass_cut", qty: 1, unit_cost_cents: estimate ?? 0n, ...(measure !== null ? { measure } : {}) };
  if (item === "debris") return { kind: "debris", qty: measure ?? 1, unit_cost_cents: 5_000n, ...(measure !== null ? { measure } : {}) };
  if (item === "roof_damage") return { kind: "roof_patch", qty: 1, unit_cost_cents: estimate ?? 0n };
  return null;
};
/** Rule 3: a discovered condition is within the allowable, complete-and-BATF (debris 11–20 CY, grass 12–36″) or stop-and-bid (debris > 20 CY, grass > 36″, roof beyond patch) — a bid is due 15 days from discovery, an unsecured opening after initial securing is repaired within 3 days. */
export function conditionDiscovered(c: PreservationCtx, i: ConditionInput): ConditionDiscovered {
  const item = oneOf(i.item, CONDITION_ITEMS, "item"); const on = requireDate(i.discovered_on, "discovered_on");
  const measure = i.measure === undefined || i.measure === null ? null : Number(i.measure);
  if (measure !== null && !(Number.isFinite(measure) && measure >= 0)) throw new RangeError("measure must be a non-negative number (inches / cubic yards)");
  if (item === "grass_over_12in" && (measure === null || measure <= 12)) throw new RangeError("grass_over_12in needs a measured height above 12 inches");
  const estimate = i.estimate_cents === undefined || i.estimate_cents === null ? null : requireCents(i.estimate_cents, "estimate_cents");
  const afterInitial = i.after_initial_securing === true;
  const scope = scopeItemFor(item, measure, estimate);
  const disposition: ItemDisposition = scope ? itemDisposition(scope).disposition : i.over_allowable === true ? "stop_and_bid" : "within_allowable";
  const overAllowable = disposition === "stop_and_bid";
  const bidDueOn = disposition === "within_allowable" ? null : bidDue(on);   // BATF (12–36″ grass, 11–20 CY debris) is filed on the same 15-day clock
  const repairDue = item === "unsecured_opening" && afterInitial ? addDays(on, UNSECURED_OPENING_REPAIR_DAYS) : null;
  const event = append(c, "preservation.condition.discovered", { item, discovered_on: on, after_initial_securing: afterInitial, disposition, over_allowable: overAllowable, measure, estimate_cents: estimate, bid_due: bidDueOn, repair_due: repairDue, source: typeof i.source === "string" ? i.source : null, photo_document_ids: Array.isArray(i.photo_document_ids) ? i.photo_document_ids : [], portal: overAllowable ? "HomeTracker" : null });
  return { item, discovered_on: on, after_initial_securing: afterInitial, disposition, over_allowable: overAllowable, bid_due: bidDueOn, repair_due: repairDue, event };
}

// ---------------------------------------------------------------------------
// Work completed — the vendor's completion report after photo QC
export interface CompletionInput {
  readonly kind: unknown; readonly item?: unknown; readonly completed_on: unknown; readonly photos?: unknown; readonly haul_away_evidence?: unknown;
  readonly cost_cents?: unknown; readonly batf?: unknown; readonly invoice_document_id?: unknown; readonly work_order_id?: unknown;
  /** Required for `kind=initial_services` — FTV anchors the 14-day clock. */
  readonly ftv_date?: unknown;
  /** Required when the initial completion is after FTV + 14 (breach action "reason documented"). */
  readonly reason?: unknown;
  /** Submission date for photo freshness (defaults to the transaction date). */
  readonly submitted_on?: unknown;
}
export interface PhotoReview { readonly complete: boolean; readonly missing: PhotoStage[]; readonly fresh: boolean; }
export interface WorkCompleted extends PhotoReview {
  readonly kind: WorkKind; readonly item: CompletedItem; readonly completed_on: PlainDate; readonly cost_cents: Cents; readonly batf: boolean;
  readonly initial: { due: PlainDate; on_time: boolean; breach: "sev1" | null; reason: string | null } | null;
  /** `item=roof_tarp`: permanent repair or re-bid by this date (FNMA_PPM_ROOF_TARP_60). */
  readonly tarp_repair_due: PlainDate | null;
  readonly events: readonly DomainEvent[];
}
export const parsePhotos = (v: unknown): Photo[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RangeError("photos must be an array of {stage, taken_on}");
  return v.map((p, n) => { const r = p as { stage?: unknown; taken_on?: unknown; document_id?: unknown }; return { stage: oneOf(r?.stage, PHOTO_STAGES, `photos[${n}].stage`), taken_on: requireDate(r?.taken_on, `photos[${n}].taken_on`), ...(typeof r?.document_id === "string" ? { document_id: r.document_id } : {}) }; });
};
/** Photo QC (tool `reviewCompletion`): before/during/after stages present, haul-away evidence for removals, every date stamp ≤ 30 days old at submission. */
export function reviewPhotos(photos: readonly Photo[], haulAwayEvidence: boolean, submittedOn: PlainDate): PhotoReview {
  const stages = new Set(photos.map((p) => p.stage));
  const missing = PHOTO_STAGES.filter((s) => !stages.has(s));
  return { complete: missing.length === 0 && haulAwayEvidence, missing, fresh: photos.every((p) => photosFresh(p.taken_on, submittedOn)) };
}
/** The vendor's completion report: QC'd photos → `preservation.work.completed`; the initial securing/services completion also closes the case-level 14-day milestone (`preservation.initial.completed`), late only with a documented reason. */
export function workCompleted(c: PreservationCtx, i: CompletionInput): WorkCompleted {
  const kind = oneOf(i.kind, WORK_KINDS, "kind");
  const item = i.item === undefined || i.item === null ? (kind === "initial_services" ? "initial_services" : "other") : oneOf(i.item, COMPLETED_ITEMS, "item");
  const on = requireDate(i.completed_on, "completed_on");
  const submittedOn = optDate(i.submitted_on, "submitted_on") ?? plainDate(c.now.slice(0, 10));
  const photos = parsePhotos(i.photos);
  const review = reviewPhotos(photos, i.haul_away_evidence === true, submittedOn);
  if (!review.complete) throw new RangeError(`completion report incomplete: ${[...review.missing.map((m) => `${m} photo missing`), ...(i.haul_away_evidence === true ? [] : ["haul-away evidence missing"])].join("; ")} (PPM §12 completion)`);
  if (!review.fresh) throw new RangeError("completion photos must be date-stamped within 30 days of submission (PPM §12)");
  if (photos.some((p) => p.taken_on > submittedOn)) throw new RangeError("photo date stamps must not follow the submission date (vendor fraud indicator: impossible timestamps)");
  const cost = i.cost_cents === undefined || i.cost_cents === null ? 0n : requireCents(i.cost_cents, "cost_cents");
  const batf = i.batf === true;
  let initial: WorkCompleted["initial"] = null;
  if (kind === "initial_services") {
    const ftv = requireDate(i.ftv_date, "ftv_date");
    const s = initialSecuringStatus(ftv, on);
    const reason = typeof i.reason === "string" && i.reason !== "" ? i.reason : null;
    if (!s.on_time && reason === null) throw new RangeError(`initial securing/services completed ${on}, after FTV + 14 (${s.due}) — the breach must carry a documented reason (FNMA_PPM_INITIAL_SECURE_14)`);
    initial = { due: s.due, on_time: s.on_time, breach: s.breach, reason };
  }
  const events: DomainEvent[] = [append(c, "preservation.work.completed", { kind, item, completed_on: on, cost_cents: cost, batf, photos: photos.map((p) => ({ stage: p.stage, taken_on: p.taken_on, document_id: p.document_id ?? null })), haul_away_evidence: i.haul_away_evidence === true, invoice_document_id: typeof i.invoice_document_id === "string" ? i.invoice_document_id : null, work_order_id: typeof i.work_order_id === "string" ? i.work_order_id : null, ...(item === "roof_tarp" ? { tarp_repair_due: tarpDeadline(on) } : {}) })];
  if (initial) events.push(append(c, "preservation.initial.completed", { completed_on: on, ftv_date: requireDate(i.ftv_date, "ftv_date"), due: initial.due, on_time: initial.on_time, late: !initial.on_time, breach: initial.breach, reason: initial.reason, cost_cents: cost }));
  return { ...review, kind, item, completed_on: on, cost_cents: cost, batf, initial, tarp_repair_due: item === "roof_tarp" ? tarpDeadline(on) : null, events };
}
