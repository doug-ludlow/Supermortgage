/**
 * §5.6 Repurchase reporting — the operating rules over the calculators in ./repurchase.ts and the LAR 65 gate in
 * ./ops.ts. Every event a 5.6 registry row is armed by or satisfied with is appended to the event store here, by the
 * code path the spec names (timers-5-6.ts cites these emitters):
 *   demand intake (A1-3-02; Inputs `repurchase.demand.received`)            → `repurchase.demand.received{received_at, pay_by, first_appeal_by}`
 *   file selected for review (A1-3-02 "documentation within 30 days")       → `repurchase.file_review.selected{selected_on, documents_due_on}`
 *   documents submitted to Fannie Mae                                        → `repurchase.documents.submitted{document_ids}`
 *   officer's appeal decision (guardrail: every appeal is an officer act)    → `repurchase.appeal.decided{stage, outcome}`
 *   Fannie Mae's denial (inbound correspondence ingested into the case)      → `repurchase.appeal.denied{stage, received_at}` (+ impasse entered after the second denial)
 *   ladder stage entered / next-stage action recorded (30/30/15/15)          → `repurchase.stage.entered{stage, stage_deadline_on}` / `repurchase.stage.action_recorded{stage, action}`
 *   repurchase processed (rule 3; approval-document gate, T5)               → `repurchase.processed{processed_at}` then `investor_events.projected{action_code}` or `repurchase.lar.blocked{escalation=officer}`
 *   LAR 65/67 accepted → proceeds scheduled by remittance type (rule 4)     → `repurchase.proceeds.scheduled{remittance_due_on, crs_code}`
 *   bank match of the responsible party's funds (state machine `funded`)     → `remittances.funded{kind=repurchase}` + `repurchase.proceeds.matched{matched_on}`
 *   MERS TOB/TOS + custodian release + `investor` field (state `closed`)     → `repurchase.ownership.updated`
 * The LAR itself travels on the 5.1 adapter path (ops-5-1 recordSubmissionAck → `investor_events.submitted{event_type=removal.repurchase}`).
 * Money is bigint cents; every clock is `fannie_et`; calendar-day ladders are A1-3-02's.
 */
import { type PlainDate, addDays, endOfMonth } from "../../kernel/calendar/date.ts";
import { rollBack, fannieEt } from "../../kernel/calendar/business.ts";
import { wallClock, toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent } from "../../kernel/events/types.ts";
import type { EventStore } from "../../kernel/events/store.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { appealLadder } from "./repurchase.ts";
import { crsAaRequest } from "./remittance.ts";
import { calendarDraftDate, nextMonth, periodStart, period as periodOf } from "./period.ts";
import { ET, projectLar65, mbsExpressUnscheduledDraft } from "./ops.ts";

export interface Emitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
const isoDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
const needId = (v: unknown, what: string): string => { need(typeof v === "string" && v !== "", `${what} is required`); return v as string; };
const needDate = (v: unknown, what: string): PlainDate => { need(isoDate(v), `${what} must be YYYY-MM-DD`); return v as PlainDate; };
const officerOnly = (a: Actor, what: string): void => need(a.kind === "human" && a.role === "officer", `${what} is an officer decision (5.6 guardrail: the agent never commits the partner)`);
const agg = (repurchaseId: string) => ({ kind: "repurchase", id: repurchaseId });

// ───────────────────────────── demand intake and the A1-3-02 ladder ─────────────────────────────
export type DemandKind = "repurchase" | "indemnification" | "make_whole" | "dpo";
export interface DemandInput { readonly repurchase_id: string; readonly loan_id: string; readonly received_on: PlainDate; readonly demand_kind: DemandKind; readonly amount_cents: Cents; readonly demand_document_id: string; readonly loan_liquidated?: boolean; }
/** Fannie Mae-initiated demand (letter / Loan Quality Connect) ingested into a `qc_finding` case: pay-by and first appeal 60 calendar days from receipt (A1-3-02); a liquidated loan is a make-whole (edge case: payment only, no LAR). */
export function ingestRepurchaseDemand(em: Emitter, i: DemandInput): { readonly event: DomainEvent; readonly pay_by: PlainDate; readonly first_appeal_by: PlainDate; readonly route: "repurchase" | "make_whole"; readonly case_type: "qc_finding" } {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.demand_document_id, "demand_document_id");
  const received = needDate(i.received_on, "received_on"); need(i.amount_cents >= 0n, "amount_cents cannot be negative");
  const ladder = appealLadder(received);
  const route = i.loan_liquidated || i.demand_kind === "make_whole" ? "make_whole" : "repurchase";
  const event = em.events.append({ type: "repurchase.demand.received", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, received_at: received, demand_kind: i.demand_kind, amount_cents: i.amount_cents.toString(), demand_document_id: i.demand_document_id, pay_by: ladder.pay_by, first_appeal_by: ladder.first_appeal_by, route, case_type: "qc_finding", crs_code: route === "make_whole" ? "309" : null } });
  return { event, pay_by: ladder.pay_by, first_appeal_by: ladder.first_appeal_by, route, case_type: "qc_finding" };
}
/** A1-3-02: "documentation within 30 days of file selection" — the selection notice is the anchor. */
export function documentsDueOn(selectedOn: PlainDate): PlainDate { return addDays(selectedOn, 30); }
export function ingestFileReviewSelection(em: Emitter, i: { repurchase_id: string; loan_id: string; selected_on: PlainDate; notification_document_id: string }): { readonly event: DomainEvent; readonly documents_due_on: PlainDate } {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.notification_document_id, "notification_document_id");
  const selected = needDate(i.selected_on, "selected_on"); const due = documentsDueOn(selected);
  const event = em.events.append({ type: "repurchase.file_review.selected", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, selected_on: selected, documents_due_on: due, notification_document_id: i.notification_document_id } });
  return { event, documents_due_on: due };
}
export function submitReviewDocuments(em: Emitter, i: { repurchase_id: string; loan_id: string; document_ids: readonly string[]; submitted_at_ms?: number }): DomainEvent {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id");
  need(Array.isArray(i.document_ids) && i.document_ids.length > 0 && i.document_ids.every((d) => typeof d === "string" && d !== ""), "document_ids: at least one stored document");
  const at = i.submitted_at_ms !== undefined ? toIso(i.submitted_at_ms) : em.now;
  return em.events.append({ type: "repurchase.documents.submitted", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: at,
    payload: { repurchase_id: i.repurchase_id, document_ids: [...i.document_ids], submitted_at: at } });
}

export type AppealStage = 1 | 2;
export type AppealOutcome = "filed" | "not_appealed" | "waived";
const OUTCOMES: Record<AppealStage, readonly AppealOutcome[]> = { 1: ["filed", "not_appealed"], 2: ["filed", "waived"] };
/** The officer's decision on an appeal stage (A1-3-02: first appeal within 60 days of the demand, second within 15 days of the first denial; silence = no contest, so "not appealed"/"waived" is recorded, never inferred). */
export function recordAppealDecision(em: Emitter, i: { repurchase_id: string; loan_id: string; stage: AppealStage; outcome: AppealOutcome; decision_document_id: string; decided_on: PlainDate }): DomainEvent {
  officerOnly(em.actor, "an appeal decision"); needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.decision_document_id, "decision_document_id");
  need(i.stage === 1 || i.stage === 2, "stage must be 1 or 2"); need(OUTCOMES[i.stage].includes(i.outcome), `stage ${i.stage} outcome must be one of ${OUTCOMES[i.stage].join("/")}`);
  const on = needDate(i.decided_on, "decided_on");
  return em.events.append({ type: "repurchase.appeal.decided", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, stage: String(i.stage), outcome: i.outcome, decided_on: on, decision_document_id: i.decision_document_id } });
}

export type LadderStage = "impasse" | "escalation" | "idr_retainer" | "next_stage";
/** A1-3-02 ladder after the second denial: impasse 30, management escalation 30, IDR retainer 15, 15 to initiate each next stage — the anchor `FNMA_A1302_IMPASSE_30` is armed on (`stage_deadline_on`). */
export const STAGE_DAYS: Record<LadderStage, number> = { impasse: 30, escalation: 30, idr_retainer: 15, next_stage: 15 };
export function stageDeadline(stage: LadderStage, enteredOn: PlainDate): PlainDate { need(stage in STAGE_DAYS, `unknown ladder stage ${String(stage)}`); return addDays(enteredOn, STAGE_DAYS[stage]); }
export function enterAppealStage(em: Emitter, i: { repurchase_id: string; loan_id: string; stage: LadderStage; entered_on: PlainDate }): { readonly event: DomainEvent; readonly stage_deadline_on: PlainDate } {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id");
  const on = needDate(i.entered_on, "entered_on"); const due = stageDeadline(i.stage, on);
  const event = em.events.append({ type: "repurchase.stage.entered", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, stage: i.stage, entered_on: on, stage_deadline_on: due, days: STAGE_DAYS[i.stage] } });
  return { event, stage_deadline_on: due };
}
/** Fannie Mae's denial of an appeal, ingested from the case correspondence: a first denial opens the 15-day second-appeal window; a second denial enters `impasse` (30 days). */
export function ingestAppealDenial(em: Emitter, i: { repurchase_id: string; loan_id: string; stage: AppealStage; received_on: PlainDate; denial_document_id: string }): { readonly event: DomainEvent; readonly second_appeal_by: PlainDate | null; readonly stage_entered: DomainEvent | null } {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.denial_document_id, "denial_document_id"); need(i.stage === 1 || i.stage === 2, "stage must be 1 or 2");
  const received = needDate(i.received_on, "received_on");
  const secondBy = i.stage === 1 ? appealLadder(received, received).second_appeal_by : null;
  const event = em.events.append({ type: "repurchase.appeal.denied", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, stage: String(i.stage), received_at: received, denial_document_id: i.denial_document_id, second_appeal_by: secondBy } });
  const stage_entered = i.stage === 2 ? enterAppealStage(em, { repurchase_id: i.repurchase_id, loan_id: i.loan_id, stage: "impasse", entered_on: received }).event : null;
  return { event, second_appeal_by: secondBy, stage_entered };
}
/** The next-stage action (escalation letter sent, IDR retainer signed, stage initiated …) recorded by the officer; `next_stage` enters the following rung with its own clock. */
export function recordStageAction(em: Emitter, i: { repurchase_id: string; loan_id: string; stage: LadderStage; action: string; recorded_on: PlainDate; document_id: string; next_stage?: LadderStage | null }): { readonly event: DomainEvent; readonly next: DomainEvent | null } {
  officerOnly(em.actor, "a ladder stage action"); needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.action, "action"); needId(i.document_id, "document_id"); need(i.stage in STAGE_DAYS, `unknown ladder stage ${String(i.stage)}`);
  const on = needDate(i.recorded_on, "recorded_on");
  const event = em.events.append({ type: "repurchase.stage.action_recorded", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, stage: i.stage, action: i.action, recorded_on: on, document_id: i.document_id, next_stage: i.next_stage ?? null } });
  const next = i.next_stage ? enterAppealStage(em, { repurchase_id: i.repurchase_id, loan_id: i.loan_id, stage: i.next_stage, entered_on: on }).event : null;
  return { event, next };
}

// ───────────────────────────── rule 3: repurchase processed → LAR 65/67 on the removal clock ─────────────────────────────
export interface ProcessRepurchaseInput { readonly repurchase_id: string; readonly loan_id: string; readonly processed_at_ms: number; readonly approval_document_id: string | null; readonly arm_modification_feature: boolean; readonly effective_date: PlainDate; readonly remittance_type: "AA" | "SA" | "SS"; readonly price_cents?: Cents; }
export interface ProcessedRepurchase { readonly processed: DomainEvent; readonly replayed: boolean; readonly blocked: boolean; readonly escalation: "officer" | null; readonly action_code: "65" | "67" | null; readonly due_ms: number | null; readonly projected: DomainEvent | null; }
/**
 * The repurchase is processed once (`repurchase.processed` carries the original `processed_at`; a replay finds the row) and
 * the LAR 65/67 is projected only after the approval document is attached (T5): blocked → `repurchase.lar.blocked{escalation=officer}`;
 * attached → `investor_events.projected{event_type=removal.repurchase, action_code}` with the original processed timestamp and the
 * removal clock (`larDeadlineMs`: next `fannie_et` BD 20:00 ET, 17:00 ET on BD2 — T4).
 */
export function processRepurchase(em: Emitter, i: ProcessRepurchaseInput): ProcessedRepurchase {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); need(Number.isFinite(i.processed_at_ms), "processed_at is required"); needDate(i.effective_date, "effective_date");
  need(i.remittance_type === "AA" || i.remittance_type === "SA" || i.remittance_type === "SS", "remittance_type must be AA, SA or SS");
  const processedAt = toIso(i.processed_at_ms);
  const prior = em.events.byLoan(i.loan_id).find((e) => e.type === "repurchase.processed" && e.payload.repurchase_id === i.repurchase_id);
  const processed = prior ?? em.events.append({ type: "repurchase.processed", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: processedAt,
    payload: { repurchase_id: i.repurchase_id, processed_at: processedAt, effective_date: i.effective_date, remittance_type: i.remittance_type, activity_period: periodOf(wallClock(i.processed_at_ms, ET).date), price_cents: i.price_cents !== undefined ? i.price_cents.toString() : null } });
  const g = projectLar65({ approval_document_id: i.approval_document_id, processed_at_ms: i.processed_at_ms, arm_modification_feature: i.arm_modification_feature });
  if (!g.event) {
    em.events.append({ type: "repurchase.lar.blocked", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now, causationId: processed.id,
      payload: { repurchase_id: i.repurchase_id, reason: "approval document missing", escalation: g.escalation, processed_at: processedAt } });
    return { processed, replayed: prior !== undefined, blocked: true, escalation: g.escalation, action_code: null, due_ms: null, projected: null };
  }
  const projected = em.events.append({ type: "investor_events.projected", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now, causationId: processed.id,
    payload: { repurchase_id: i.repurchase_id, family: "removal", event_type: "removal.repurchase", action_code: g.event.action_code, approval_document_id: i.approval_document_id, effective_date: i.effective_date, processed_at: toIso(g.event.processed_at_ms), due_at: toIso(g.event.due_ms) } });
  return { processed, replayed: prior !== undefined, blocked: false, escalation: null, action_code: g.event.action_code, due_ms: g.event.due_ms, projected };
}

// ───────────────────────────── rule 4: proceeds by remittance type (F-1-20 / CRS codes) ─────────────────────────────
export type ProceedsCycle = "aa_crs_001" | "aa_month_end_sweep" | "ss_standard_cd18" | "mbs_express_bd4" | "sa_cd20" | "make_whole_crs_309" | "reo_crs_315";
export interface ProceedsDue { readonly cycle: ProceedsCycle; readonly remittance_due_on: PlainDate; readonly crs_code: "001" | "309" | "315" | null; readonly instruct_by_ms: number | null; readonly drafted: boolean; }
/**
 * F-1-20: active-loan repurchase proceeds move on the loan type's schedule — S/S standard the 18th and S/A the 20th of the month after
 * the reported activity period, MBS Express unscheduled principal BD4 of the following month, A/A immediately via CRS 001 (> $2,500,
 * entered by 16:00 ET; smaller amounts ride the month-end sweep); make-whole CRS 309 and REO repurchase CRS 315 are immediate.
 */
export function repurchaseProceedsDue(f: { remittance_type: "AA" | "SA" | "SS"; mbs_express: boolean; activity_period: string; accepted_on: PlainDate; amount_cents: Cents; kind?: "repurchase" | "make_whole" | "reo" }): ProceedsDue {
  need(/^\d{4}-\d{2}$/.test(f.activity_period), "activity_period must be YYYY-MM"); needDate(f.accepted_on, "accepted_on");
  const kind = f.kind ?? "repurchase";
  if (kind === "make_whole" || kind === "reo") return { cycle: kind === "make_whole" ? "make_whole_crs_309" : "reo_crs_315", remittance_due_on: f.accepted_on, crs_code: kind === "make_whole" ? "309" : "315", instruct_by_ms: zonedEpochMs(f.accepted_on, "16:00", ET), drafted: false };
  const following = nextMonth(periodStart(f.activity_period));
  if (f.remittance_type === "AA") {
    const eom = rollBack(endOfMonth(f.accepted_on), fannieEt);
    const r = crsAaRequest(f.amount_cents, f.accepted_on, eom === f.accepted_on);
    return r.instruct ? { cycle: "aa_crs_001", remittance_due_on: f.accepted_on, crs_code: "001", instruct_by_ms: zonedEpochMs(f.accepted_on, "16:00", ET), drafted: false }
      : { cycle: "aa_month_end_sweep", remittance_due_on: eom, crs_code: "001", instruct_by_ms: zonedEpochMs(eom, "16:00", ET), drafted: false };
  }
  if (f.remittance_type === "SS") return f.mbs_express ? { cycle: "mbs_express_bd4", remittance_due_on: mbsExpressUnscheduledDraft(periodStart(f.activity_period)), crs_code: null, instruct_by_ms: null, drafted: true }
    : { cycle: "ss_standard_cd18", remittance_due_on: calendarDraftDate(following, 18), crs_code: null, instruct_by_ms: null, drafted: true };
  return { cycle: "sa_cd20", remittance_due_on: calendarDraftDate(following, 20), crs_code: null, instruct_by_ms: null, drafted: true };
}
export interface ScheduleProceedsInput { readonly repurchase_id: string; readonly loan_id: string; readonly accepted_event_id: string; readonly accepted_on: PlainDate; readonly activity_period: string; readonly remittance_type: "AA" | "SA" | "SS"; readonly mbs_express: boolean; readonly amount_cents: Cents; readonly kind?: "repurchase" | "make_whole" | "reo"; }
/** The LAR 65/67 acceptance (5.1 feedback, `investor_events.accepted{event_type=removal.repurchase}`) schedules the proceeds: the type's draft or the CRS request, funded by the responsible party. */
export function scheduleRepurchaseProceeds(em: Emitter, i: ScheduleProceedsInput): { readonly event: DomainEvent; readonly due: ProceedsDue } {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.accepted_event_id, "accepted_event_id"); need(i.amount_cents > 0n, "amount_cents must be positive");
  const due = repurchaseProceedsDue({ remittance_type: i.remittance_type, mbs_express: i.mbs_express, activity_period: i.activity_period, accepted_on: i.accepted_on, amount_cents: i.amount_cents, ...(i.kind ? { kind: i.kind } : {}) });
  const event = em.events.append({ type: "repurchase.proceeds.scheduled", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now, causationId: i.accepted_event_id,
    payload: { repurchase_id: i.repurchase_id, accepted_event_id: i.accepted_event_id, remittance_type: i.remittance_type, cycle: due.cycle, remittance_due_on: due.remittance_due_on, crs_code: due.crs_code, instruct_by_at: due.instruct_by_ms === null ? null : toIso(due.instruct_by_ms), amount_cents: i.amount_cents.toString(), funding_source: "responsible_party" } });
  return { event, due };
}

// ───────────────────────────── state `funded` → `closed`: bank match, ownership update ─────────────────────────────
export interface MatchProceedsInput { readonly repurchase_id: string; readonly loan_id: string; readonly remittance_id: string; readonly expected_cents: Cents; readonly received_cents: Cents; readonly matched_on: PlainDate; readonly remittance_type: "AA" | "SA" | "SS"; readonly cycle: ProceedsCycle; readonly bank_reference: string; }
export interface MatchedProceeds { readonly funded: DomainEvent; readonly matched: DomainEvent; readonly ledger: readonly { account: string; side: "Dr" | "Cr"; amount_cents: Cents; rule_ref: string }[]; }
/** The responsible party's funds matched to the draft/CRS settlement: `remittances.funded{kind=repurchase}` (FNMA_A1302_REPURCHASE_PAY_60 / FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE) and the ownership-update clock's trigger; Outputs: Dr `fnma_remittance_payable` Cr corporate cash. */
export function matchRepurchaseProceeds(em: Emitter, i: MatchProceedsInput): MatchedProceeds {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.remittance_id, "remittance_id"); needId(i.bank_reference, "bank_reference");
  const on = needDate(i.matched_on, "matched_on"); need(i.expected_cents > 0n, "expected_cents must be positive");
  need(i.received_cents === i.expected_cents, `repurchase proceeds ${i.received_cents} do not match the price ${i.expected_cents}: variance goes to the officer, the remittance stays unmatched`);
  const base = { repurchase_id: i.repurchase_id, remittance_id: i.remittance_id, kind: "repurchase", remittance_type: i.remittance_type, cycle: i.cycle, amount_cents: i.received_cents.toString(), funding_source: "responsible_party", bank_reference: i.bank_reference };
  const funded = em.events.append({ type: "remittances.funded", loanId: i.loan_id, aggregate: { kind: "remittance", id: i.remittance_id }, actor: em.actor, occurredAt: em.now, payload: { ...base, funded_at: em.now, funded_on: on, initiator: "responsible_party" } });
  const matched = em.events.append({ type: "repurchase.proceeds.matched", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now, causationId: funded.id, payload: { ...base, matched_on: on, status: "funded" } });
  const rule_ref = "5.6 Outputs: repurchase price funded by the responsible party";
  return { funded, matched, ledger: [{ account: "fnma_remittance_payable", side: "Dr", amount_cents: i.received_cents, rule_ref }, { account: "corporate_cash", side: "Cr", amount_cents: i.received_cents, rule_ref }] };
}
export interface OwnershipUpdateInput { readonly repurchase_id: string; readonly loan_id: string; readonly mers_confirmation_id: string; readonly custodian_release_id: string; readonly investor: string; readonly updated_on: PlainDate; readonly quit_claim_document_id?: string | null; readonly acquired_property?: boolean; }
/** State `closed`: all three of MERS TOB/TOS, custodian release (Form 2009) and the loan's `investor` field — and the quit-claim deed for acquired property (A1-3-04) — before `repurchase.ownership.updated` is written. */
export function updateRepurchaseOwnership(em: Emitter, i: OwnershipUpdateInput): DomainEvent {
  needId(i.repurchase_id, "repurchase_id"); needId(i.loan_id, "loan_id"); needId(i.mers_confirmation_id, "mers_confirmation_id (MERS TOB/TOS confirmation)"); needId(i.custodian_release_id, "custodian_release_id (custodian release)"); needId(i.investor, "investor (the loan's new owner)");
  const on = needDate(i.updated_on, "updated_on");
  need(!i.acquired_property || !!i.quit_claim_document_id, "acquired property: the quit-claim deed is received before the repurchase closes (A1-3-04)");
  return em.events.append({ type: "repurchase.ownership.updated", loanId: i.loan_id, aggregate: agg(i.repurchase_id), actor: em.actor, occurredAt: em.now,
    payload: { repurchase_id: i.repurchase_id, mers_confirmation_id: i.mers_confirmation_id, custodian_release_id: i.custodian_release_id, investor: i.investor, updated_on: on, quit_claim_document_id: i.quit_claim_document_id ?? null, status: "closed" } });
}
