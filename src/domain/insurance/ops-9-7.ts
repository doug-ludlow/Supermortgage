/**
 * §9.7 operating rules over the pure calculators in lossdraft.ts. Each function appends to the caller's event store the
 * events the 9.7 timer table names, so the clocks arm and close on what the process actually does:
 * - `reportClaim` (rule 1; inputs "insurance.claim.reported from any channel") → `insurance.claim.reported` (arms the
 *   B-5-01 proof-of-loss clock on `loss_date`), `claim.form176.required{cause}` for an abandoned / FC-scheduled property
 *   (rule 9: "Form 176 within 5 business days" of learning of the damage or of the decision not to repair — one event
 *   both causes emit, as the registry grammar holds one trigger), `disaster.impact.determined` when the loss is tied to a
 *   disaster event (D1-3-01: 9.7 determines the damage; 13.x owns the approval) and `claim.activity.recorded` (stale clock);
 * - `fileProofOfLoss` — the borrower's or the servicer's (mortgagee-clause) filing, ingested from the portal upload or the
 *   carrier's acknowledgment → `claim.proof_of_loss.filed{filed_by}`;
 * - `depositProceeds` (rules 4/5/12) → `claim.proceeds.deposited{contents_ale_cents, repair_intent_known,
 *   reogram_confirmed, received_on}` plus the LL-2026-05 `escrow.deposit{escrow_category=loss_draft}` event due 03:00 ET
 *   the next Fannie Mae business day (T10);
 * - `releaseProceeds` (rule 2) → `claim.funds.released{kind}` (the platform's spelling of the registry's
 *   `claim.disbursement.released`; INS_CLAIM_INITIAL_RELEASE_5BD was already aligned to it);
 * - `requestDraw` / `recordRepairDecision` / `recordRepairInspection` — borrower and vendor records this process ingests
 *   (draw requests, the repair decision, inspection reports with their invoices) → `claim.draw.requested`,
 *   `claim.form176.required{cause=no_repair_decision}`, `claim.inspection.completed` and
 *   `property.inspection.cost_incurred{delinquent}` (F-1-05: the $60 repair-inspection cost is claimable within 365 days
 *   for a current loan);
 * - `sendForm176` (rules 8/9; the `fnma_portal_operator` submits) → `claim.form176.sent`;
 * - `remit332` (rule 9) → `remittances.instructed{crs_code=332}` and, for proceeds received after the REOgram,
 *   `claim.proceeds.wired` within 10 `business_days_fannie_et` of receipt (T6);
 * - `ingestShortSaleClosing` — the closing agent's settlement record (12.x liquidation) → `shortsale.closed{closed_on}`;
 * - `portalTaskCompleted` — the Fannie Mae portal-task feed: the D1-3-01 approval request must carry this process's
 *   claim date, status and expected/received disbursements → `fnma.disaster_fc_approval.submitted`;
 * - `completeClaim` (rule 5) → interest paid at completion (`claim.funds.released{kind=interest_payout}`).
 * Money is bigint cents; dates are PlainDate on the calendars the spec names; every inbound record is validated before
 * anything is appended (a bad record throws RangeError and appends nothing).
 */
import { type PlainDate, plainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { INSURED_LOSS_REPAIR_INSPECTION_CAP } from "./inspection.ts";
import { ET, lossDraftEscrowEvent } from "./ops.ts";
import { lossDraftTrack, workoutEvaluationRequired, custodialInterest, contentsReleaseDue, form176Due, reogramRemitDue, supplementalWireDue, remoteInspectionAcceptable, type LossDraftTrack, type ReleaseKind } from "./lossdraft.ts";

/** What every 9.7 operation needs from the command: the event store, who acts, the loan and the transaction clock. */
export interface LossDraftCtx { readonly events: EventStore; readonly actor: Actor; readonly loanId: string; readonly now: string; }

export type LossCause = "fire" | "wind" | "hail" | "water" | "flood" | "theft" | "vandalism" | "earthquake" | "other";
export const LOSS_CAUSES: readonly LossCause[] = ["fire", "wind", "hail", "water", "flood", "theft", "vandalism", "earthquake", "other"];
export type PropertyStatus = "occupied" | "abandoned" | "fc_scheduled";
export type Form176Cause = "damage_learned" | "no_repair_decision";
export type Form176Reason = "abandoned_intends_to_repair" | "abandoned_no_repair" | "fc_scheduled_intends_to_repair" | "fc_scheduled_no_repair" | "public_adjuster_fee" | "third_party_fee" | "non_eligible_case";
export const FORM176_REASONS: readonly Form176Reason[] = ["abandoned_intends_to_repair", "abandoned_no_repair", "fc_scheduled_intends_to_repair", "fc_scheduled_no_repair", "public_adjuster_fee", "third_party_fee", "non_eligible_case"];
export const LOSS_DRAFT_CUSTODIAL_ACCOUNT = "custodial_ti_loss_draft";
/** B-5-01 default proof-of-loss window when the policy is silent; NFIP SFIP: 60 days from the loss (44 CFR 61 App. A(1)). */
export const PROOF_OF_LOSS_DEFAULT_DAYS = 60;

const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const requireDate = (v: unknown, what: string): PlainDate => { if (!isDate(v)) throw new RangeError(`${what} must be a YYYY-MM-DD date`); return plainDate(v); };
const requireId = (v: unknown, what: string): string => { if (typeof v !== "string" || v === "") throw new RangeError(`${what} is required`); return v; };
const positive = (v: Cents, what: string): Cents => { if (v <= 0n) throw new RangeError(`${what} must be positive`); return v; };
const nonNegative = (v: Cents, what: string): Cents => { if (v < 0n) throw new RangeError(`${what} cannot be negative`); return v; };
const append = (c: LossDraftCtx, type: string, payload: Record<string, unknown>): DomainEvent => c.events.append({ type, loanId: c.loanId, actor: c.actor, payload });
/** Every claim action is "activity" for INS_CLAIM_STALE_90 (satisfied by any activity; re-armed from the activity date). */
const activity = (c: LossDraftCtx, claim_id: string | null, what: string, on: PlainDate): DomainEvent => append(c, "claim.activity.recorded", { claim_id, activity: what, activity_on: on });

export const propertyStatusOf = (abandoned: boolean, fcSaleScheduled: boolean): PropertyStatus => (abandoned ? "abandoned" : fcSaleScheduled ? "fc_scheduled" : "occupied");

// ============================================================ rule 1 / inputs: the claim report
export interface ClaimReport {
  readonly claim_id: string; readonly policy_id?: string | null; readonly loss_date?: PlainDate | null; readonly loss_cause?: string | null;
  readonly fnma_days_delinquent: number; readonly abandoned: boolean; readonly fc_sale_scheduled: boolean; readonly rebuildable: "yes" | "no" | "unknown";
  /** Known at report time only sometimes; `false` on an abandoned / FC-scheduled property is the "decision not to repair" branch of rule 9. */
  readonly intends_to_repair?: boolean | null;
  /** The date the servicer learned of the damage (rule 9 anchor); defaults to the report date. */
  readonly learned_on?: PlainDate | null; readonly reported_on?: PlainDate | null;
  /** D1-3-01: a loss tied to a declared disaster; `foreclosure_prereferral` = the loan is in the 13.4 pre-referral review. */
  readonly disaster_event_id?: string | null; readonly foreclosure_prereferral?: boolean;
}
export interface ClaimReported {
  readonly claim_id: string; readonly track: LossDraftTrack; readonly property_status: PropertyStatus; readonly uninsured: boolean; readonly workout_evaluation_required: boolean;
  readonly reported_on: PlainDate; readonly learned_on: PlainDate; readonly proof_of_loss_due: PlainDate | null; readonly form176_due: PlainDate | null; readonly form176_cause: Form176Cause | null;
  readonly disaster_fc_approval_due: PlainDate | null; readonly events: readonly string[];
}
export function reportClaim(c: LossDraftCtx, i: ClaimReport): ClaimReported {
  const claim_id = requireId(i.claim_id, "claim_id");
  if (i.loss_cause != null && !LOSS_CAUSES.includes(i.loss_cause as LossCause)) throw new RangeError(`loss_cause ${i.loss_cause} is not one of ${LOSS_CAUSES.join(", ")}`);
  if (!Number.isFinite(i.fnma_days_delinquent) || i.fnma_days_delinquent < 0) throw new RangeError("fnma_days_delinquent must be a non-negative number");
  const loss_date = i.loss_date == null ? null : requireDate(i.loss_date, "loss_date");
  const reported_on = i.reported_on == null ? etDate(c.now) : requireDate(i.reported_on, "reported_on");
  const learned_on = i.learned_on == null ? reported_on : requireDate(i.learned_on, "learned_on");
  const track = lossDraftTrack({ fnma_days_delinquent: i.fnma_days_delinquent, abandoned: i.abandoned, fc_sale_scheduled: i.fc_sale_scheduled, rebuildable: i.rebuildable });
  const property_status = propertyStatusOf(i.abandoned, i.fc_sale_scheduled);
  const uninsured = !i.policy_id;
  const proof_of_loss_due = loss_date && !uninsured ? addDays(loss_date, PROOF_OF_LOSS_DEFAULT_DAYS) : null;
  const events: string[] = [];
  const emit = (type: string, payload: Record<string, unknown>): void => { append(c, type, payload); events.push(type); };
  emit("insurance.claim.reported", { claim_id, policy_id: i.policy_id ?? null, loss_date, loss_cause: i.loss_cause ?? null, property_status, learned_on, reported_on, track, uninsured, disaster_event_id: i.disaster_event_id ?? null, proof_of_loss_due, fnma_days_delinquent: i.fnma_days_delinquent });
  if (uninsured) emit("insurance.uninsured_loss.opened", { claim_id, loss_date, loss_cause: i.loss_cause ?? null, property_status });
  // rule 9: abandoned property or scheduled foreclosure sale → Form 176 within 5 business days of learning of the damage
  // (borrower intends to repair, or intent unknown) or of the decision not to repair.
  let form176_cause: Form176Cause | null = null, form176_due: PlainDate | null = null;
  if (property_status !== "occupied") {
    form176_cause = i.intends_to_repair === false ? "no_repair_decision" : "damage_learned";
    form176_due = form176Due(learned_on);
    emit("claim.form176.required", { claim_id, cause: form176_cause, learned_on, property_status, intends_to_repair: i.intends_to_repair ?? null, due: form176_due });
  }
  // D1-3-01: the damage determination on a disaster-impacted property; the FC approval submission (13.x) is due within 5 days
  // when the loan is in pre-referral review, and must carry this claim's date/status/disbursements.
  let disaster_fc_approval_due: PlainDate | null = null;
  if (i.disaster_event_id) {
    const foreclosure_prereferral = i.foreclosure_prereferral === true;
    if (foreclosure_prereferral) disaster_fc_approval_due = addDays(reported_on, 5);
    emit("disaster.impact.determined", { claim_id, disaster_event_id: i.disaster_event_id, foreclosure_prereferral, determined_on: reported_on, damage: uninsured ? "uninsured_loss" : "insured_loss", loss_cause: i.loss_cause ?? null, claim_reported_on: reported_on });
  }
  activity(c, claim_id, "reported", reported_on); events.push("claim.activity.recorded");
  return { claim_id, track, property_status, uninsured, workout_evaluation_required: workoutEvaluationRequired(track), reported_on, learned_on, proof_of_loss_due, form176_due, form176_cause, disaster_fc_approval_due, events };
}

// ============================================================ B-5-01: proof of loss (borrower, or the servicer under the mortgagee clause)
export interface ProofOfLossRecord { readonly claim_id: string; readonly filed_by: "borrower" | "servicer"; readonly filed_on: PlainDate; readonly carrier_claim_no?: string | null; readonly document_id?: string | null; }
export function fileProofOfLoss(c: LossDraftCtx, r: ProofOfLossRecord): { readonly filed_on: PlainDate; readonly under_mortgagee_clause: boolean; readonly event: DomainEvent } {
  const claim_id = requireId(r.claim_id, "claim_id");
  if (r.filed_by !== "borrower" && r.filed_by !== "servicer") throw new RangeError("filed_by must be borrower or servicer");
  const filed_on = requireDate(r.filed_on, "filed_on");
  const event = append(c, "claim.proof_of_loss.filed", { claim_id, filed_by: r.filed_by, filed_on, carrier_claim_no: r.carrier_claim_no ?? null, document_id: r.document_id ?? null, under_mortgagee_clause: r.filed_by === "servicer" });
  activity(c, claim_id, "proof_of_loss_filed", filed_on);
  return { filed_on, under_mortgagee_clause: r.filed_by === "servicer", event };
}

// ============================================================ rule 9: the borrower's repair decision on an abandoned / FC-scheduled property
export interface RepairDecision { readonly claim_id: string; readonly property_status: PropertyStatus; readonly intends_to_repair: boolean; readonly learned_on: PlainDate; }
export function recordRepairDecision(c: LossDraftCtx, r: RepairDecision): { readonly form176_required: boolean; readonly form176_due: PlainDate | null } {
  const claim_id = requireId(r.claim_id, "claim_id");
  const learned_on = requireDate(r.learned_on, "learned_on");
  if (typeof r.intends_to_repair !== "boolean") throw new RangeError("intends_to_repair must be true or false");
  activity(c, claim_id, `repair_decision:${r.intends_to_repair ? "repair" : "no_repair"}`, learned_on);
  if (r.property_status === "occupied" || r.intends_to_repair) return { form176_required: false, form176_due: null };
  const due = form176Due(learned_on);
  append(c, "claim.form176.required", { claim_id, cause: "no_repair_decision" satisfies Form176Cause, learned_on, property_status: r.property_status, intends_to_repair: false, due });
  return { form176_required: true, form176_due: due };
}

// ============================================================ rules 4/5/12: deposit into interest-bearing T&I custody
export interface Deposit {
  readonly claim_id?: string | null; readonly instrument_id: string; readonly amount_cents: Cents;
  /** The adjuster's contents / additional-living-expense designation (rule 4) — released "without delay". */
  readonly contents_ale_cents?: Cents;
  /** Deposit + repair intent known opens the 5-BD initial-release clock. */
  readonly repair_intent_known?: boolean;
  /** Proceeds received after the REOgram was confirmed are wired to Fannie Mae within 10 fannie_et BD of receipt (rule 9). */
  readonly reogram_confirmed?: boolean; readonly received_on?: PlainDate | null;
  /** ISO instant of the custodial deposit; defaults to the transaction clock. */
  readonly deposited_at?: string | null;
}
export interface Deposited {
  readonly account: string; readonly deposited_on: PlainDate; readonly deposited_at: string; readonly received_on: PlainDate;
  readonly contents_ale_cents: Cents; readonly contents_release_due: PlainDate | null; readonly initial_release_due: PlainDate | null; readonly wire_due: PlainDate | null;
  readonly escrow_event: { readonly type: "escrow.deposit"; readonly escrow_category: "loss_draft"; readonly amount_cents: Cents; readonly submit_by: string };
}
export function depositProceeds(c: LossDraftCtx, i: Deposit): Deposited {
  const instrument_id = requireId(i.instrument_id, "instrument_id");
  const amount_cents = positive(i.amount_cents, "amount_cents");
  const contents_ale_cents = nonNegative(i.contents_ale_cents ?? 0n, "contents_ale_cents");
  if (contents_ale_cents > amount_cents) throw new RangeError("contents_ale_cents cannot exceed the instrument amount");
  const deposited_at = i.deposited_at ?? c.now;
  if (Number.isNaN(Date.parse(deposited_at))) throw new RangeError("deposited_at must be an ISO instant");
  const deposited_on = etDate(deposited_at);
  const received_on = i.received_on == null ? deposited_on : requireDate(i.received_on, "received_on");
  if (received_on > deposited_on) throw new RangeError("received_on cannot be after the deposit date");
  const repair_intent_known = i.repair_intent_known === true, reogram_confirmed = i.reogram_confirmed === true;
  const claim_id = i.claim_id ?? null;
  append(c, "claim.proceeds.deposited", { claim_id, instrument_id, amount_cents, contents_ale_cents, repair_intent_known, reogram_confirmed, received_on, deposited_on, deposited_at, account: LOSS_DRAFT_CUSTODIAL_ACCOUNT });
  // rule 12 / T10: every loss_draft_funds posting emits an escrow event with escrow_category=loss_draft (3.7 emitter; 03:00 ET next fannie_et business day).
  const esc = lossDraftEscrowEvent({ deposited_at_ms: Date.parse(deposited_at), amount_cents, loan_id: c.loanId });
  const submit_by = toIso(esc.submit_by_ms);
  append(c, "escrow.deposit", { escrow_category: esc.event.escrow_category, amount_cents, claim_id, instrument_id, source: "loss_draft_deposit", deposited_at, submit_by });
  activity(c, claim_id, "proceeds_deposited", deposited_on);
  return {
    account: LOSS_DRAFT_CUSTODIAL_ACCOUNT, deposited_on, deposited_at, received_on, contents_ale_cents,
    contents_release_due: contents_ale_cents > 0n ? contentsReleaseDue(deposited_on) : null,
    initial_release_due: repair_intent_known ? addBusinessDays(deposited_on, 5, servicer) : null,
    wire_due: reogram_confirmed ? supplementalWireDue(received_on) : null,
    escrow_event: { type: "escrow.deposit", escrow_category: "loss_draft", amount_cents, submit_by },
  };
}

// ============================================================ rule 2: releases (the formula limits are the tool's guardrails; this is the posting)
export interface Release { readonly claim_id?: string | null; readonly kind: ReleaseKind; readonly amount_cents: Cents; readonly payee_kind?: string; readonly basis?: string | null; readonly inspection_id?: string | null; readonly released_on?: PlainDate | null; }
export function releaseProceeds(c: LossDraftCtx, i: Release): { readonly released_cents: Cents; readonly kind: ReleaseKind; readonly released_on: PlainDate; readonly event: DomainEvent } {
  const amount_cents = positive(i.amount_cents, "amount_cents");
  if (typeof i.kind !== "string" || (i.kind as string) === "") throw new RangeError("kind is required");
  const released_on = i.released_on == null ? etDate(c.now) : requireDate(i.released_on, "released_on");
  const claim_id = i.claim_id ?? null;
  const event = append(c, "claim.funds.released", { claim_id, kind: i.kind, amount_cents, payee_kind: i.payee_kind ?? "borrower", basis: i.basis ?? null, inspection_id: i.inspection_id ?? null, released_on });
  activity(c, claim_id, `released:${i.kind}`, released_on);
  return { released_cents: amount_cents, kind: i.kind, released_on, event };
}

// ============================================================ rule 10 / open question 1: draw requests and repair inspections
export interface DrawRequest { readonly claim_id: string; readonly requested_on: PlainDate; readonly amount_cents?: Cents | null; readonly source: "portal" | "call" | "contractor_invoice" | "progress_check_due"; }
export function requestDraw(c: LossDraftCtx, r: DrawRequest): { readonly inspection_order_due: PlainDate; readonly event: DomainEvent } {
  const claim_id = requireId(r.claim_id, "claim_id");
  const requested_on = requireDate(r.requested_on, "requested_on");
  if (!["portal", "call", "contractor_invoice", "progress_check_due"].includes(r.source)) throw new RangeError(`source ${String(r.source)} is not a draw-request source`);
  if (r.amount_cents != null) positive(r.amount_cents, "amount_cents");
  const event = append(c, "claim.draw.requested", { claim_id, requested_on, amount_cents: r.amount_cents ?? null, source: r.source });
  activity(c, claim_id, "draw_requested", requested_on);
  return { inspection_order_due: addBusinessDays(requested_on, 3, servicer), event };
}

export interface RepairInspectionRecord {
  readonly claim_id: string; readonly inspection_id: string; readonly type: "progress" | "final" | "remote_photo" | "remote_video";
  /** "0.70" = 70% complete. */
  readonly pct_complete: string; readonly inspected_on: PlainDate; readonly cost_cents: Cents;
  /** F-1-05: the loan's delinquency status when the cost was incurred (current-loan costs are claimable within 365 days). */
  readonly delinquent: boolean;
  /** Reimbursable only when the inspection was required to release additional funds or to complete a final inspection. */
  readonly required_for_release: boolean;
  readonly authenticity?: { app_captured: boolean; gps: boolean; timestamp: boolean; hash: boolean } | null;
}
export interface RepairInspectionResult { readonly accepted: boolean; readonly reason: string | null; readonly reimbursable: boolean; readonly claim_cents: Cents; readonly claim_by: PlainDate | null; }
export function recordRepairInspection(c: LossDraftCtx, r: RepairInspectionRecord): RepairInspectionResult {
  const claim_id = requireId(r.claim_id, "claim_id"), inspection_id = requireId(r.inspection_id, "inspection_id");
  const inspected_on = requireDate(r.inspected_on, "inspected_on");
  const pct = Number(r.pct_complete);
  if (!/^\d+(\.\d+)?$/.test(r.pct_complete) || pct < 0 || pct > 1) throw new RangeError("pct_complete must be a decimal fraction between 0 and 1");
  const cost_cents = nonNegative(r.cost_cents, "cost_cents");
  if (r.type === "remote_photo" || r.type === "remote_video") {
    // rule 10: authenticated app-captured media only; otherwise reject and order a vendor inspection (edge case: fraud indicators).
    if (!r.authenticity || !remoteInspectionAcceptable(r.authenticity)) {
      append(c, "claim.inspection.rejected", { claim_id, inspection_id, type: r.type, reason: "remote media not authenticated (GPS/timestamp/hash/app-captured)", fallback: "order a vendor inspection" });
      return { accepted: false, reason: "remote media not authenticated; order a vendor inspection", reimbursable: false, claim_cents: 0n, claim_by: null };
    }
  }
  const reimbursable = cost_cents > 0n && r.required_for_release && !r.delinquent;
  const claim_cents = cost_cents < INSURED_LOSS_REPAIR_INSPECTION_CAP ? cost_cents : INSURED_LOSS_REPAIR_INSPECTION_CAP;
  const claim_by = reimbursable ? addDays(inspected_on, 365) : null;
  append(c, "claim.inspection.completed", { claim_id, inspection_id, type: r.type, pct_complete: r.pct_complete, inspected_on, cost_cents, reimbursable });
  if (cost_cents > 0n) append(c, "property.inspection.cost_incurred", { claim_id, inspection_id, kind: "repair", cost_cents, claim_cents, incurred_on: inspected_on, delinquent: r.delinquent, reimbursable, claim_by });
  activity(c, claim_id, `inspection:${r.type}`, inspected_on);
  return { accepted: true, reason: null, reimbursable, claim_cents, claim_by };
}

// ============================================================ rules 8/9: Form 176 (prepared by the agent, sent by the fnma_portal_operator)
export interface Form176Send { readonly claim_id?: string | null; readonly package_id: string; readonly reason: string; readonly sent_on?: PlainDate | null; }
export function sendForm176(c: LossDraftCtx, i: Form176Send): { readonly sent_on: PlainDate; readonly reason: Form176Reason; readonly event: DomainEvent } {
  const package_id = requireId(i.package_id, "package_id");
  if (!FORM176_REASONS.includes(i.reason as Form176Reason)) throw new RangeError(`reason ${i.reason} is not one of ${FORM176_REASONS.join(", ")}`);
  const sent_on = i.sent_on == null ? etDate(c.now) : requireDate(i.sent_on, "sent_on");
  const claim_id = i.claim_id ?? null;
  const event = append(c, "claim.form176.sent", { claim_id, package_id, reason: i.reason, sent_on, sent_by: `${c.actor.kind}:${c.actor.id}${c.actor.role ? `:${c.actor.role}` : ""}`, destination: "SF CPM Division" });
  activity(c, claim_id, "form176_sent", sent_on);
  return { sent_on, reason: i.reason as Form176Reason, event };
}

// ============================================================ rule 9: remitting at resolution (CRS code 332; post-REOgram wires)
export interface Remit332 {
  readonly claim_id?: string | null; readonly amount_cents: Cents;
  readonly reogram_confirmed_on?: PlainDate | null; readonly shortsale_closed_on?: PlainDate | null;
  /** Set for an instrument received after the REOgram confirmation: the remittance is a wire due 10 fannie_et BD from receipt. */
  readonly received_on?: PlainDate | null; readonly net_servicer_fees?: boolean;
}
export interface Remitted332 { readonly crs_code: "332"; readonly amount_cents: Cents; readonly method: "crs_draft" | "wire"; readonly basis: string; readonly due: PlainDate; readonly remitted_on: PlainDate; }
export function remit332(c: LossDraftCtx, i: Remit332): Remitted332 {
  const amount_cents = positive(i.amount_cents, "amount_cents");
  if (i.net_servicer_fees) throw new RangeError("servicer fees and expenses are never netted from remitted proceeds (B-5-01)");
  const remitted_on = etDate(c.now);
  const reogram = i.reogram_confirmed_on == null ? null : requireDate(i.reogram_confirmed_on, "reogram_confirmed_on");
  const closing = i.shortsale_closed_on == null ? null : requireDate(i.shortsale_closed_on, "shortsale_closed_on");
  const received = i.received_on == null ? null : requireDate(i.received_on, "received_on");
  let due: PlainDate, method: Remitted332["method"], basis: string;
  if (reogram && received && received > reogram) { method = "wire"; due = supplementalWireDue(received); basis = "B-5-01: proceeds received after REOgram confirmation wired within 10 business days of receipt"; }
  else if (reogram) { method = "crs_draft"; due = reogramRemitDue(reogram); basis = "B-5-01: balance remitted within 30 days of confirming the REOgram (CRS 332)"; }
  else if (closing) { method = "crs_draft"; due = closing; basis = "B-5-01: short sale — remaining proceeds remitted at closing (CRS 332)"; }
  else throw new RangeError("reogram_confirmed_on or shortsale_closed_on is required");
  const claim_id = i.claim_id ?? null;
  append(c, "remittances.instructed", { claim_id, crs_code: "332", amount_cents, method, due, basis, remitted_on, net_servicer_fees: false });
  if (method === "wire") append(c, "claim.proceeds.wired", { claim_id, amount_cents, received_on: received, wired_on: remitted_on, due, crs_code: "332" });
  activity(c, claim_id, `remitted_332:${method}`, remitted_on);
  return { crs_code: "332", amount_cents, method, basis, due, remitted_on };
}

// ============================================================ inbound loan-status feeds this process consumes (spec "Inputs and triggers")
export interface ShortSaleClosing { readonly claim_id?: string | null; readonly closed_on: PlainDate; readonly held_proceeds_cents: Cents; readonly settlement_statement_id: string; }
export function ingestShortSaleClosing(c: LossDraftCtx, r: ShortSaleClosing): { readonly remit_due: PlainDate; readonly event: DomainEvent } {
  const closed_on = requireDate(r.closed_on, "closed_on");
  const settlement_statement_id = requireId(r.settlement_statement_id, "settlement_statement_id");
  const held = nonNegative(r.held_proceeds_cents, "held_proceeds_cents");
  const event = append(c, "shortsale.closed", { claim_id: r.claim_id ?? null, closed_on, held_proceeds_cents: held, settlement_statement_id, remit_crs_code: "332" });
  return { remit_due: closed_on, event };
}

/** D1-3-01: what the Fannie Mae foreclosure-approval submission must carry from this process. */
export interface DisasterClaimData { readonly claim_id: string; readonly claim_reported_on: PlainDate; readonly claim_status: string; readonly expected_cents: Cents; readonly received_cents: Cents; readonly disbursed_cents: Cents; }
export interface PortalTaskCompletion { readonly task: "disaster_fc_approval" | "form176"; readonly submission_id: string; readonly completed_on: PlainDate; readonly claim: DisasterClaimData; readonly reason?: string | null; }
export function portalTaskCompleted(c: LossDraftCtx, r: PortalTaskCompletion): { readonly event: DomainEvent } {
  const submission_id = requireId(r.submission_id, "submission_id");
  const completed_on = requireDate(r.completed_on, "completed_on");
  const claim_id = requireId(r.claim?.claim_id, "claim.claim_id");
  if (r.task === "form176") return { event: sendForm176(c, { claim_id, package_id: submission_id, reason: r.reason ?? "abandoned_intends_to_repair", sent_on: completed_on }).event };
  if (r.task !== "disaster_fc_approval") throw new RangeError(`task ${String(r.task)} is not a 9.7 portal task`);
  const claim_reported_on = requireDate(r.claim.claim_reported_on, "claim.claim_reported_on");
  if (typeof r.claim.claim_status !== "string" || r.claim.claim_status === "") throw new RangeError("claim.claim_status is required (D1-3-01 submission contents)");
  const expected = nonNegative(r.claim.expected_cents, "claim.expected_cents"), received = nonNegative(r.claim.received_cents, "claim.received_cents"), disbursed = nonNegative(r.claim.disbursed_cents, "claim.disbursed_cents");
  if (disbursed > received) throw new RangeError("claim.disbursed_cents cannot exceed claim.received_cents");
  const event = append(c, "fnma.disaster_fc_approval.submitted", { claim_id, submission_id, submitted_on: completed_on, claim_reported_on, claim_status: r.claim.claim_status, expected_cents: expected, received_cents: received, disbursed_cents: disbursed, submitted_by: `${c.actor.kind}:${c.actor.id}` });
  activity(c, claim_id, "disaster_fc_approval_submitted", completed_on);
  return { event };
}

// ============================================================ rule 5: completion — interest always paid
export interface Completion { readonly claim_id: string; readonly held_cents: Cents; readonly rate_pct: string; readonly days_held: number; readonly surplus_cents?: Cents; }
export function completeClaim(c: LossDraftCtx, i: Completion): { readonly interest_cents: Cents; readonly surplus_cents: Cents; readonly completed_on: PlainDate } {
  const claim_id = requireId(i.claim_id, "claim_id");
  nonNegative(i.held_cents, "held_cents");
  if (!Number.isInteger(i.days_held) || i.days_held < 0) throw new RangeError("days_held must be a non-negative integer");
  const interest_cents = custodialInterest(i.held_cents, i.rate_pct, i.days_held);
  const surplus_cents = nonNegative(i.surplus_cents ?? 0n, "surplus_cents");
  const completed_on = etDate(c.now);
  if (interest_cents > 0n) releaseProceeds(c, { claim_id, kind: "interest_payout", amount_cents: interest_cents, basis: `rule 5: ${i.held_cents} × ${i.rate_pct}% × ${i.days_held}/365`, released_on: completed_on });
  if (surplus_cents > 0n) releaseProceeds(c, { claim_id, kind: "refund_to_borrower", amount_cents: surplus_cents, basis: "surplus after completion (current track)", released_on: completed_on });
  append(c, "insurance.claim.completed", { claim_id, interest_paid_cents: interest_cents, surplus_cents, completed_on });
  return { interest_cents, surplus_cents, completed_on };
}
