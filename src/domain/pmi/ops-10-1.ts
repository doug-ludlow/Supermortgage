/**
 * §10.1 process ops — the code paths that turn a borrower's cancellation request into the loan events the registry
 * clocks arm on, and the breach / outage handling the acceptance tests name. Wired by src/app/tools/section10.ts
 * (`pmi.*` request / written_confirmation / cancel, `smdu.*` evaluate, the fee guardrails).
 *
 *   - `validateCancelRequest` + `openCancellationRequest` — the inbound request (portal form, `borrower-comms` call,
 *     mail classified by the `case` agent, confirmed successor in interest) is validated and appended as
 *     `mi.cancel.requested` with the fields the 10.1 timers condition on: `received_at` (anchor of
 *     HPA_4904B_DENIAL_NOTICE_30 / HPA_4902A4_EVIDENCE_DISCLOSURE_2BD / SM_MI_ORIGINAL_VALUE_DECISION_5BD /
 *     MN_47_207_RESPONSE_30), `state` and `owner_occupied` (the MN §47.207 jurisdiction override), `hpa_covered`
 *     (1 unit ∧ principal residence ∧ consummated ≥ 1999-07-29). The `pmi_cancel` case opens in `received`
 *     (`awaiting_written_confirmation` for a verbal request seeking the HPA path — 10.1-Q1).
 *   - `confirmWrittenRequest` — `mi.written_confirmation.received` perfects the HPA path (12 U.S.C. 4902(a)(1)).
 *   - `smduEvaluate` — the SMDU MI Termination Evaluation call with the integration failure policy: "On failure
 *     (5xx/timeouts) retry with backoff for 4 hours, then `human_portal_task` (SMDU UI evaluation) if the HPA clock is
 *     at day 15 or later"; the HPA clock never moves (R9; 10.1-T8).
 *   - `escalateDecisionClockBreach` — a breached decision clock opens the `officer` sev-1 escalation carrying the
 *     Compliance Sentinel report line (10.1-T3).
 *   - `cancelBasisOnRecord` — `cancellation_issued` is reached only from an `eligible` evaluation on the loan's record
 *     (state machine) or a 10.6 human-review reversal (retro-correction grant).
 *   - `tabulatedFeeFor` / `feeIsTabulated` — the F-1-02 fee table ($190 BPO / $450 restricted appraisal / $750 2–4
 *     unit appraisal) behind the order and ledger guardrails ("cannot charge any fee other than the tabulated
 *     valuation fee").
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Breach } from "../../kernel/timers/engine.ts";
import type { EscalationService } from "../../app/escalations.ts";
import type { FnmaSmduPort } from "../../infra/integrations/fnma.ts";
import { plainDate as D, type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { decisionDue } from "./cancellation.ts";
import { mnRequestOverlay, smduOutageFallback } from "./ops.ts";

export const RULE_SET_VERSION = "hpa.1998; fnma.mi.b8104.2019-05; fnma.smdu.mi_faq.2025-04; state.pmi.MN/NY/CA";

export const REQUEST_CHANNELS = ["written", "verbal", "portal", "sii"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];
export const REQUEST_BASES = ["original_value", "current_value", "current_value_improvements", "unspecified"] as const;
export type RequestBasis = (typeof REQUEST_BASES)[number];
export type Occupancy = "principal" | "second_home" | "investment";

/** Versioned documents (the entity store of src/app/tools.ts, structurally). */
export interface CaseStore {
  get(kind: string, id: string): { readonly data: Record<string, unknown> } | undefined;
  list(kind: string, where?: (d: Record<string, unknown>) => boolean): readonly { readonly id: string; readonly data: Record<string, unknown> }[];
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): { readonly id: string; readonly data: Record<string, unknown> };
}
export interface OpsDeps { readonly events: EventStore; readonly store: CaseStore; readonly actor: Actor; readonly now: string; }

/** `mi_holder_config` (per investor/partner) — defaults from the 10.1 data model / open questions Q1–Q2. */
export interface HolderConfig { readonly require_sub_lien_cert?: boolean; readonly evidence_types?: readonly string[]; readonly verbal_request_accepted?: boolean; }
export const DEFAULT_HOLDER_CONFIG: Required<HolderConfig> = { require_sub_lien_cert: false, evidence_types: ["smdu_avm", "smdu_bpo", "smdu_appraisal"], verbal_request_accepted: true };

// ---- inbound request ----------------------------------------------------------

/** `hpa_covered` = 1 unit ∧ principal residence ∧ consummated on/after 1999-07-29 (12 U.S.C. 4901; scope consequence in the verified requirement). */
export function hpaCovered(f: { units: number; occupancy: Occupancy | string; consummation: PlainDate }): boolean {
  return f.units === 1 && f.occupancy === "principal" && f.consummation >= "1999-07-29";
}

export interface CancelRequestFacts {
  readonly loan_id: string;
  /** The servicer receipt instant as received (or the date when only a date is known). */
  readonly received_at: string;
  /** Receipt date in the servicer's (Eastern) civil calendar — the clocks' anchor. */
  readonly received_on: PlainDate;
  readonly channel: RequestChannel;
  readonly basis: RequestBasis;
  readonly requester_party_id: string | null;
  readonly state: string;
  readonly owner_occupied: boolean;
  readonly hpa_covered: boolean;
  readonly units: number | null;
  readonly occupancy: Occupancy | null;
  readonly consummation: PlainDate | null;
  readonly attachments: readonly string[];
  readonly case_id: string;
}

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isInstant = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const pick = (i: Record<string, unknown>, policy: Record<string, unknown> | null, ...keys: string[]): unknown => {
  for (const k of keys) { if (i[k] !== undefined && i[k] !== null && i[k] !== "") return i[k]; }
  for (const k of keys) { if (policy && policy[k] !== undefined && policy[k] !== null && policy[k] !== "") return policy[k]; }
  return undefined;
};

/**
 * Validates the inbound request payload (loan, receipt, channel, basis, requester authority, jurisdiction and HPA scope
 * facts — from the payload or the boarded `mi_policies` row). Throws RangeError on anything the case cannot open without.
 */
export function validateCancelRequest(i: Record<string, unknown>, policy: Record<string, unknown> | null, now: string): CancelRequestFacts {
  const loanId = typeof i.loan_id === "string" ? i.loan_id : "";
  if (!loanId) throw new RangeError("loan_id is required");
  const rawReceipt = pick(i, null, "received_at", "received_on");
  const receivedAt = rawReceipt === undefined ? now : String(rawReceipt);
  let receivedOn: PlainDate;
  if (isDate(receivedAt)) receivedOn = D(receivedAt);
  else if (isInstant(receivedAt)) receivedOn = wallClock(Date.parse(receivedAt), "America/New_York").date;
  else throw new RangeError(`received_at ${receivedAt} is neither a date nor an ISO instant`);
  const channel = String(pick(i, null, "channel", "request_channel") ?? "");
  if (!(REQUEST_CHANNELS as readonly string[]).includes(channel)) throw new RangeError(`channel ${channel || "(missing)"} is not one of ${REQUEST_CHANNELS.join("/")}`);
  const basis = String(pick(i, null, "basis", "basis_requested", "stated_basis") ?? "unspecified");
  if (!(REQUEST_BASES as readonly string[]).includes(basis)) throw new RangeError(`basis ${basis} is not one of ${REQUEST_BASES.join("/")}`);
  const requester = pick(i, null, "requester_party_id", "requester");
  if (channel === "sii" && i.sii_confirmed !== true) throw new RangeError("a successor in interest must be confirmed (`sii.confirmed`, Section 1 parties) before requesting cancellation");
  const state = String(pick(i, policy, "state", "property_state") ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new RangeError("state (property state, two letters) is required for the jurisdiction overlays");
  const unitsRaw = pick(i, policy, "units"); const units = unitsRaw === undefined ? null : Number(unitsRaw);
  if (units !== null && !(Number.isInteger(units) && units >= 1 && units <= 4)) throw new RangeError("units must be 1–4");
  const occRaw = pick(i, policy, "occupancy", "occupancy_at_origination"); const occupancy = occRaw === undefined ? null : (String(occRaw) as Occupancy);
  if (occupancy !== null && !["principal", "second_home", "investment"].includes(occupancy)) throw new RangeError("occupancy must be principal/second_home/investment");
  const consRaw = pick(i, policy, "consummation", "consummation_date"); const consummation = consRaw === undefined ? null : D(String(consRaw));
  let covered: boolean;
  if (typeof i.hpa_covered === "boolean") covered = i.hpa_covered;
  else if (typeof policy?.hpa_covered === "boolean") covered = policy.hpa_covered;
  else if (units !== null && occupancy !== null && consummation !== null) covered = hpaCovered({ units, occupancy, consummation });
  else throw new RangeError("hpa_covered (or units, occupancy and consummation to derive it) is required");
  const ownerOccupied = typeof i.owner_occupied === "boolean" ? i.owner_occupied : occupancy === "principal";
  const attachments = Array.isArray(i.attachments) ? (i.attachments as unknown[]).map(String) : [];
  const caseId = typeof i.case_id === "string" && i.case_id ? i.case_id : `pmi-cancel-${loanId}-${receivedOn}`;
  return { loan_id: loanId, received_at: receivedAt, received_on: receivedOn, channel: channel as RequestChannel, basis: basis as RequestBasis, requester_party_id: requester === undefined ? null : String(requester), state, owner_occupied: ownerOccupied, hpa_covered: covered, units, occupancy, consummation, attachments, case_id: caseId };
}

export type CaseStatus = "received" | "awaiting_written_confirmation" | "evaluating_original_value" | "value_check_needed" | "awaiting_fee" | "valuation_ordered" | "valuation_received" | "evaluating" | "eligible" | "cancellation_issued" | "ineligible" | "denial_issued" | "withdrawn" | "expired" | "escalated" | "closed";

export interface OpenedCase {
  readonly case_id: string;
  readonly loan_id: string;
  readonly status: CaseStatus;
  readonly received_on: PlainDate;
  readonly hpa_covered: boolean;
  /** The HPA right is perfected (written request on an HPA-covered loan); a verbal request evaluates as a Fannie Mae case until confirmed. */
  readonly hpa_path: boolean;
  readonly written_confirmation_required: boolean;
  readonly state_overlay: "MN_47_207" | "NY_6503D" | "CA_2954_6" | null;
  readonly overlay: ReturnType<typeof mnRequestOverlay>;
  /** HPA_4902A4_EVIDENCE_DISCLOSURE_2BD — the acknowledgment/evidence letter within 2 servicer business days. */
  readonly ack_due: PlainDate;
  /** HPA_4904B_DENIAL_NOTICE_30 — 30 calendar days from receipt (re-anchored only by borrower evidence, R9). */
  readonly decision_due: PlainDate;
  /** SM_MI_ORIGINAL_VALUE_DECISION_5BD — policy target for the original-value decision. */
  readonly original_value_decision_due: PlainDate;
  readonly evidence_types: readonly string[];
  readonly sub_lien_cert_required: boolean;
  readonly event: DomainEvent;
}

/** Opens the `pmi_cancel` case and appends `mi.cancel.requested` — the trigger of the 10.1 request clocks. */
export function openCancellationRequest(f: CancelRequestFacts, deps: OpsDeps & { readonly holder?: HolderConfig }): OpenedCase {
  const holder = { ...DEFAULT_HOLDER_CONFIG, ...(deps.holder ?? {}) };
  if (f.channel === "verbal" && !holder.verbal_request_accepted) throw new RangeError("the holder does not accept verbal requests; obtain the written request (12 U.S.C. 4902(a)(1))");
  const existing = deps.store.list("mi_cases", (d) => d.loan_id === f.loan_id && !["closed", "withdrawn", "expired"].includes(String(d.status)));
  if (existing.length) throw new RangeError(`loan ${f.loan_id} already has open pmi_cancel case ${existing[0]!.id}`);
  const written = f.channel !== "verbal";
  const hpaPath = f.hpa_covered && written;
  const status: CaseStatus = f.channel === "verbal" && f.hpa_covered ? "awaiting_written_confirmation" : "received";
  const overlay = mnRequestOverlay({ state: f.state, owner_occupied: f.owner_occupied, received_on: f.received_on });
  const stateOverlay = overlay.timer ? "MN_47_207" : f.state === "NY" ? "NY_6503D" : f.state === "CA" ? "CA_2954_6" : null;
  const ackDue = addBusinessDays(f.received_on, 2, servicer);
  const decisionDueOn = decisionDue(f.received_on, null);
  const ovDecisionDue = addBusinessDays(f.received_on, 5, servicer);
  deps.store.put("cases", f.case_id, { id: f.case_id, case_type: "pmi_cancel", loan_id: f.loan_id, status, opened_on: f.received_on, requester_party_id: f.requester_party_id }, deps.actor, deps.now);
  deps.store.put("mi_cases", f.case_id, {
    case_id: f.case_id, loan_id: f.loan_id, request_channel: f.channel, received_at: f.received_at, received_on: f.received_on, written_confirmed_at: written ? f.received_at : null,
    basis_requested: f.basis, basis_evaluated: null, hpa_covered: f.hpa_covered, hpa_path: hpaPath, evidence_type_disclosed_at: null, sub_lien_cert_required: holder.require_sub_lien_cert, sub_lien_cert_received_at: null,
    fee_required_cents: 0n as Cents, fee_received_at: null, evidence_satisfied_at: null, valuation_id: null, smdu_evaluation_id: null, decision: null, decision_at: null, decision_reasons: [], cancellation_effective_date: null, denial_notice_id: null,
    state: f.state, owner_occupied: f.owner_occupied, state_overlay: stateOverlay, status, decision_due: decisionDueOn, ack_due: ackDue, rule_set_version: RULE_SET_VERSION,
  }, deps.actor, deps.now);
  const event = deps.events.append({ type: "mi.cancel.requested", loanId: f.loan_id, aggregate: { kind: "case", id: f.case_id }, actor: deps.actor, payload: {
    case_id: f.case_id, received_at: f.received_on, received_ts: f.received_at, channel: f.channel, basis: f.basis, requester_party_id: f.requester_party_id, written,
    state: f.state, owner_occupied: f.owner_occupied, hpa_covered: f.hpa_covered, hpa_path: hpaPath, units: f.units, occupancy: f.occupancy, state_overlay: stateOverlay,
    sub_lien_cert_required: holder.require_sub_lien_cert, evidence_types: holder.evidence_types, attachments: f.attachments, decision_due: decisionDueOn, ack_due: ackDue,
  } });
  return { case_id: f.case_id, loan_id: f.loan_id, status, received_on: f.received_on, hpa_covered: f.hpa_covered, hpa_path: hpaPath, written_confirmation_required: status === "awaiting_written_confirmation", state_overlay: stateOverlay, overlay, ack_due: ackDue, decision_due: decisionDueOn, original_value_decision_due: ovDecisionDue, evidence_types: holder.evidence_types, sub_lien_cert_required: holder.require_sub_lien_cert, event };
}

/** `mi.written_confirmation.received` — the e-signed (or mailed) confirmation perfects the HPA path of a verbal request. */
export function confirmWrittenRequest(f: { loan_id: string; case_id: string | null; confirmed_on: PlainDate; document_id: string | null }, deps: OpsDeps): { case_id: string; status: CaseStatus; hpa_path: boolean; event: DomainEvent } {
  if (!f.loan_id) throw new RangeError("loan_id is required");
  const row = f.case_id ? deps.store.get("mi_cases", f.case_id) : deps.store.list("mi_cases", (d) => d.loan_id === f.loan_id && !["closed", "withdrawn", "expired"].includes(String(d.status)))[0];
  if (!row) throw new RangeError(`no open pmi_cancel case on loan ${f.loan_id}`);
  const caseId = String(row.data.case_id);
  const hpaPath = row.data.hpa_covered === true;
  const status: CaseStatus = row.data.status === "awaiting_written_confirmation" ? "evaluating_original_value" : (row.data.status as CaseStatus);
  deps.store.put("mi_cases", caseId, { written_confirmed_at: f.confirmed_on, hpa_path: hpaPath, status, written_confirmation_document_id: f.document_id }, deps.actor, deps.now);
  deps.store.put("cases", caseId, { status }, deps.actor, deps.now);
  const event = deps.events.append({ type: "mi.written_confirmation.received", loanId: f.loan_id, aggregate: { kind: "case", id: caseId }, actor: deps.actor, payload: { case_id: caseId, confirmed_on: f.confirmed_on, document_id: f.document_id, hpa_path: hpaPath } });
  return { case_id: caseId, status, hpa_path: hpaPath, event };
}

/** Moves the loan's open `pmi_cancel` case (state machine) — a no-op when the case was opened outside the request tool. */
export function advanceCase(store: CaseStore, loanId: string, patch: Record<string, unknown> & { status: CaseStatus }, by: Actor, now: string): string | null {
  const open = store.list("mi_cases", (d) => d.loan_id === loanId && !["closed", "withdrawn", "expired"].includes(String(d.status)))[0];
  if (!open) return null;
  store.put("mi_cases", open.id, patch, by, now); store.put("cases", open.id, { status: patch.status }, by, now);
  return open.id;
}

// ---- cancel basis --------------------------------------------------------------

export function evaluationIdOf(i: Record<string, unknown>): string | null {
  if (typeof i.evaluation_id === "string" && i.evaluation_id) return i.evaluation_id;
  const ev = i.evaluation;
  if (ev !== null && typeof ev === "object" && typeof (ev as Record<string, unknown>).evaluation_id === "string" && (ev as Record<string, unknown>).evaluation_id) return String((ev as Record<string, unknown>).evaluation_id);
  return null;
}

export interface CancelBasis { readonly kind: "eligible_evaluation" | "human_review_reversal"; readonly evaluation_id: string | null; readonly evidence_event_id: string; }

/**
 * 10.1 state machine: `eligible` → `cancellation_issued`. The grant must rest on an `eligible` `mi.evaluation.completed`
 * recorded on this loan for the evaluation the command names — never on a caller-supplied evaluation object — or on a
 * 10.6 human-review reversal (`mi.human_review.completed{outcome=reversed}`: the retro-correction grant "effective as of
 * the date the borrower originally qualified").
 */
export function cancelBasisOnRecord(i: Record<string, unknown>, loanEvents: readonly DomainEvent[]): CancelBasis | null {
  const id = evaluationIdOf(i);
  if (id) {
    const e = loanEvents.find((x) => x.type === "mi.evaluation.completed" && x.payload.evaluation_id === id);
    if (e && e.payload.result === "eligible") return { kind: "eligible_evaluation", evaluation_id: id, evidence_event_id: e.id };
  }
  const r = [...loanEvents].reverse().find((x) => x.type === "mi.human_review.completed" && x.payload.outcome === "reversed");
  if (r) return { kind: "human_review_reversal", evaluation_id: id, evidence_event_id: r.id };
  return null;
}

// ---- F-1-02 fee table ------------------------------------------------------------

/** F-1-02 (05/13/2026): BPO $190; restricted appraisal (one-unit) $450; appraisal (two- to four-unit) $750. Both the `mi_valuations.kind` and the `valueCheck` option vocabularies are accepted. */
export const VALUATION_FEES_CENTS: Readonly<Record<string, Cents>> = { bpo: 19000n as Cents, bpo_int_ext: 19000n as Cents, restricted_appraisal: 45000n as Cents, appraisal_restricted: 45000n as Cents, appraisal_2_4_unit: 75000n as Cents, appraisal_1025: 75000n as Cents };
export function tabulatedFeeFor(kind: string): Cents | null { return VALUATION_FEES_CENTS[kind] ?? null; }
/** With a kind, the fee must be that kind's tabulated fee; without one, any tabulated fee. */
export function feeIsTabulated(fee: Cents, kind: string | null): boolean {
  if (kind) return tabulatedFeeFor(kind) === fee;
  return Object.values(VALUATION_FEES_CENTS).includes(fee);
}

// ---- withdrawal and fee-wait expiry (10.1 state machine `awaiting_fee → withdrawn | expired`; 32.9 backend delta) ------------

const OPEN_MI_CASE = (d: Record<string, unknown>, loanId: string): boolean => d.loan_id === loanId && !["closed", "withdrawn", "expired"].includes(String(d.status));
/** Events of this case's cycle: everything on the loan since the case's own `mi.cancel.requested`. */
function caseCycleEvents(events: EventStore, loanId: string, caseId: string): readonly DomainEvent[] {
  const all = events.byLoan(loanId);
  const open = all.findIndex((e) => e.type === "mi.cancel.requested" && (e.payload as { case_id?: unknown }).case_id === caseId);
  return open < 0 ? [] : all.slice(open);
}
export interface WithdrawResult { readonly case_id: string; readonly status: "withdrawn"; readonly withdrawn_on: PlainDate; readonly fee_paid_cents: Cents; readonly fee_refund_cents: Cents; readonly valuation_ordered: boolean; readonly event: DomainEvent; readonly refund_event: DomainEvent | null; }
/**
 * The borrower withdraws the open `pmi_cancel` case (10.1 state machine: any non-terminal state → `withdrawn`). The
 * valuation fee the borrower posted is refunded in full when no valuation order was placed (F-1-02: the tabulated fee
 * pays for the valuation; nothing was ordered, so nothing was earned — 32.9 §2 "refund if no order placed on
 * withdrawal"); once the order is placed the fee is earned and no refund is due. `mi.cancel.withdrawn` (and the
 * `mi.valuation_fee.refunded` leg) are the loan events the refund and the borrower's receipt hang on.
 */
export function withdrawCancellationRequest(f: { loan_id: string; case_id: string | null; withdrawn_on: PlainDate; requester_party_id?: string | null; card_instance_id?: string | null }, deps: OpsDeps): WithdrawResult {
  if (!f.loan_id) throw new RangeError("loan_id is required");
  const row = f.case_id ? deps.store.get("mi_cases", f.case_id) : deps.store.list("mi_cases", (d) => OPEN_MI_CASE(d, f.loan_id))[0];
  if (!row) throw new RangeError(`no open pmi_cancel case on loan ${f.loan_id}`);
  if (["closed", "withdrawn", "expired"].includes(String(row.data.status))) throw new RangeError(`case ${String(row.data.case_id)} is ${String(row.data.status)} — nothing to withdraw`);
  const caseId = String(row.data.case_id);
  const cycle = caseCycleEvents(deps.events, f.loan_id, caseId);
  const ordered = cycle.some((e) => e.type === "mi.valuation.ordered");
  const fee = cycle.filter((e) => e.type === "mi.evidence.received" && (e.payload as { kind?: unknown }).kind === "fee").reduce((sum, e) => sum + BigInt(String((e.payload as { amount_cents?: unknown }).amount_cents ?? 0)), 0n) as Cents;
  const refund = (ordered ? 0n : fee) as Cents;
  deps.store.put("mi_cases", caseId, { status: "withdrawn", withdrawn_on: f.withdrawn_on, withdrawn_by_party_id: f.requester_party_id ?? null, fee_refund_cents: refund, valuation_ordered_before_withdrawal: ordered }, deps.actor, deps.now);
  deps.store.put("cases", caseId, { status: "withdrawn", closed_at: deps.now }, deps.actor, deps.now);
  const event = deps.events.append({ type: "mi.cancel.withdrawn", loanId: f.loan_id, aggregate: { kind: "case", id: caseId }, actor: deps.actor, payload: { case_id: caseId, withdrawn_on: f.withdrawn_on, requester_party_id: f.requester_party_id ?? null, card_instance_id: f.card_instance_id ?? null, fee_paid_cents: fee, fee_refund_cents: refund, valuation_ordered: ordered, refund_basis: ordered ? "valuation ordered — the tabulated fee is earned (F-1-02)" : "no valuation order placed — the fee is refunded in full (10.1 awaiting_fee → withdrawn)" } });
  const refund_event = refund > 0n ? deps.events.append({ type: "mi.valuation_fee.refunded", loanId: f.loan_id, aggregate: { kind: "case", id: caseId }, actor: deps.actor, payload: { case_id: caseId, refund_cents: refund, refunded_on: f.withdrawn_on, rail: "original_payment_method", reason: "request withdrawn before a valuation order (F-1-02)" } }) : null;
  return { case_id: caseId, status: "withdrawn", withdrawn_on: f.withdrawn_on, fee_paid_cents: fee, fee_refund_cents: refund, valuation_ordered: ordered, event, refund_event };
}
export interface FeeWaitExpiryResult { readonly case_id: string; readonly status: "expired"; readonly expired_on: PlainDate; readonly closing_letter: "NTC_MI_CASE_CLOSED"; readonly event: DomainEvent; }
/**
 * SM_MI_FEE_WAIT_60 breach ("case → `expired`; closing letter"): the open case that was waiting for the borrower's
 * valuation fee closes as `expired` — only from `value_check_needed` / `awaiting_fee`, only when no fee arrived in the
 * cycle (a posted fee satisfied the clock). `mi.case.expired` is the loan event the closing letter and the borrower's
 * receipt hang on; a later request opens a new case.
 */
export function expireFeeWait(f: { loan_id: string; case_id?: string | null; expired_on: PlainDate; timer_id?: string | null }, deps: OpsDeps): FeeWaitExpiryResult | null {
  if (!f.loan_id) throw new RangeError("loan_id is required");
  const row = f.case_id ? deps.store.get("mi_cases", f.case_id) : deps.store.list("mi_cases", (d) => OPEN_MI_CASE(d, f.loan_id))[0];
  if (!row) return null;
  const caseId = String(row.data.case_id);
  if (!["value_check_needed", "awaiting_fee"].includes(String(row.data.status))) return null;
  if (caseCycleEvents(deps.events, f.loan_id, caseId).some((e) => e.type === "mi.evidence.received" && (e.payload as { kind?: unknown }).kind === "fee")) return null;
  deps.store.put("mi_cases", caseId, { status: "expired", expired_on: f.expired_on, expiry_timer: "SM_MI_FEE_WAIT_60" }, deps.actor, deps.now);
  deps.store.put("cases", caseId, { status: "expired", closed_at: deps.now }, deps.actor, deps.now);
  const event = deps.events.append({ type: "mi.case.expired", loanId: f.loan_id, aggregate: { kind: "case", id: caseId }, actor: deps.actor, payload: { case_id: caseId, expired_on: f.expired_on, timer: "SM_MI_FEE_WAIT_60", timer_id: f.timer_id ?? null, reason: "no valuation fee within 60 days of the value-check notice", closing_letter: "NTC_MI_CASE_CLOSED" } });
  return { case_id: caseId, status: "expired", expired_on: f.expired_on, closing_letter: "NTC_MI_CASE_CLOSED", event };
}

// ---- SMDU evaluation with the outage fallback --------------------------------------

export interface SmduEvaluateInput {
  readonly loan_id: string;
  readonly fnma_loan_number: string;
  readonly request_type: "original_value" | "current_value" | "current_value_improvements";
  readonly data_set: Record<string, unknown>;
  readonly overrides: readonly string[];
  /** Case receipt date for the day count (falls back to the loan's open `mi_cases` row). */
  readonly received_on: PlainDate | null;
  readonly case_id: string | null;
}
export type SmduEvaluateResult =
  | { readonly unavailable: false; readonly smdu_evaluation_id: string; readonly decision: Record<string, unknown>; readonly liability_relief: boolean }
  | { readonly unavailable: true; readonly retry: boolean; readonly outage_since: string; readonly outage_hours: number; readonly case_day: number; readonly escalation_id: string | null; readonly hpa_timer: { code: "HPA_4904B_DENIAL_NOTICE_30"; due: PlainDate; changed: false }; readonly next: string };

const isIntegrationFailure = (e: unknown): e is Error & { name: string } => e instanceof Error && (e.name === "TransientFailure" || e.name === "AdapterUnavailable");

/**
 * Calls SMDU (`fnma-smdu` MI Termination Evaluation API). On 5xx/timeouts the outage is recorded per loan and retried
 * with backoff; once it has lasted 4 hours and the case is at day 15 or later the `human_portal_task` opens for the
 * `fnma_portal_operator` with the prepared data set (loan data set, request, payment-history counts). A declared
 * adapter outage (AdapterUnavailable) counts as the 4 hours having elapsed. HPA_4904B_DENIAL_NOTICE_30 is never
 * re-anchored, cancelled or extended by the outage (R9).
 */
export async function smduEvaluate(f: SmduEvaluateInput, deps: OpsDeps & { readonly smdu: FnmaSmduPort; readonly escalations: Pick<EscalationService, "open"> }): Promise<SmduEvaluateResult> {
  if (!f.loan_id) throw new RangeError("loan_id is required");
  if (!f.fnma_loan_number) throw new RangeError("fnma_loan_number is required");
  const openCase = deps.store.list("mi_cases", (d) => d.loan_id === f.loan_id && !["closed", "withdrawn", "expired"].includes(String(d.status)))[0];
  const receivedOn = f.received_on ?? (openCase && typeof openCase.data.received_on === "string" ? D(openCase.data.received_on) : null);
  const caseId = f.case_id ?? (openCase ? openCase.id : null);
  try {
    const c = await deps.smdu.createCase(f.fnma_loan_number, "mi_termination", { request_type: f.request_type, ...f.data_set });
    const decision = await deps.smdu.decision(c.caseId);
    if (deps.store.get("smdu_outages", f.loan_id)) deps.store.put("smdu_outages", f.loan_id, { cleared_at: deps.now }, deps.actor, deps.now);
    deps.events.append({ type: "mi.smdu.evaluated", loanId: f.loan_id, actor: deps.actor, payload: { smdu_evaluation_id: c.caseId, request_type: f.request_type, servicer_overridden: f.overrides.length > 0, overrides: f.overrides, case_id: caseId } });
    return { unavailable: false, smdu_evaluation_id: c.caseId, decision, liability_relief: f.overrides.length === 0 };
  } catch (e) {
    if (!isIntegrationFailure(e)) throw e;
    const prior = deps.store.get("smdu_outages", f.loan_id)?.data;
    const since = prior && typeof prior.since === "string" && prior.cleared_at == null ? prior.since : deps.now;   // an outage already open on the loan keeps its start; a cleared one starts afresh
    if (since === deps.now) deps.store.put("smdu_outages", f.loan_id, { since, first_error: e.message, cleared_at: null }, deps.actor, deps.now);
    const today = wallClock(Date.parse(deps.now), "America/New_York").date;
    const elapsedHours = (Date.parse(deps.now) - Date.parse(since)) / 3_600_000;
    const outageHours = e.name === "AdapterUnavailable" ? Math.max(4, elapsedHours) : elapsedHours;
    const caseDay = receivedOn ? daysBetween(receivedOn, today) + 1 : 1;
    const hpaDue = receivedOn ? decisionDue(receivedOn, null) : D(today);
    const fb = smduOutageFallback({ outage_hours: outageHours, case_day: caseDay, hpa_due: hpaDue, data_set: { ...f.data_set, request_type: f.request_type, fnma_loan_number: f.fnma_loan_number, overrides: f.overrides } });
    deps.events.append({ type: "mi.smdu.unavailable", loanId: f.loan_id, actor: deps.actor, payload: { since, outage_hours: outageHours, case_day: caseDay, error: e.name, message: e.message, retry: fb.retry, hpa_due: hpaDue, hpa_timer_changed: false } });
    let escalationId: string | null = null;
    if (fb.escalation) {
      const esc = deps.escalations.open({ kind: "human_portal_task", ownerRole: fb.escalation.owner_role, loanId: f.loan_id, ...(caseId ? { caseId } : {}), payload: { task: "smdu_mi_termination_evaluation", package: fb.escalation.package, hpa_timer: fb.hpa_timer, reason: `SMDU unavailable for ${outageHours.toFixed(1)} hours at case day ${caseDay}: ${e.message}` } }, deps.actor);
      escalationId = esc.id;
      if (caseId) deps.store.put("mi_cases", caseId, { status: "escalated", escalation_id: esc.id }, deps.actor, deps.now);
    }
    return { unavailable: true, retry: fb.retry, outage_since: since, outage_hours: outageHours, case_day: caseDay, escalation_id: escalationId, hpa_timer: fb.hpa_timer, next: fb.retry ? "retry with exponential backoff until the outage reaches 4 hours; the HPA clock keeps running" : "SMDU UI evaluation by the fnma_portal_operator from the prepared data set; the HPA clock keeps running" };
  }
}

// ---- decision-clock breach -----------------------------------------------------------

const DECISION_CLOCKS = new Set(["HPA_4904B_DENIAL_NOTICE_30", "MN_47_207_RESPONSE_30", "FNMA_B8104_DENIAL_NOTICE_30"]);

/**
 * A breached decision clock (HPA_4904B_DENIAL_NOTICE_30: "`officer` sev-1; Compliance Sentinel daily report") opens the
 * officer escalation with the Sentinel report line; the breach record's severity and roles come from the registry row.
 */
export function escalateDecisionClockBreach(b: Breach, deps: { readonly escalations: Pick<EscalationService, "open">; readonly actor: Actor; readonly received_on?: PlainDate | null }): { escalation_id: string; sentinel_line: string; severity: 1 | 2 | 3 | 4 | null; owner_role: string } {
  if (!DECISION_CLOCKS.has(b.def.code)) throw new RangeError(`${b.def.code} is not a 10.1 decision clock`);
  const received = deps.received_on ?? b.instance.anchorDate;
  const due = b.instance.dueDate ?? b.instance.anchorDate;
  const line = `${b.def.code} breached: request received ${received}; no decision or notice by ${due} 23:59 servicer time (loan ${b.instance.loanId ?? b.instance.subject.id})`;
  const ownerRole = b.escalateTo[0] ?? "officer";
  const esc = deps.escalations.open({ kind: "officer", ownerRole, ...(b.instance.loanId ? { loanId: b.instance.loanId } : {}), severity: `sev${b.severity ?? 1}`, slaTimerId: b.instance.id,
    payload: { timer_id: b.instance.id, code: b.def.code, due_date: due, breach: b.breachText, sentinel_line: line, report: "Compliance Sentinel daily report" } }, deps.actor);
  return { escalation_id: esc.id, sentinel_line: line, severity: b.severity, owner_role: ownerRole };
}
