/**
 * §30.4 operating rules — the first-90-days servicing hand-off of a newly originated loan. One small function per
 * rule / T-id over the servicing calculators this process reuses (7.1 statement cycle, 8.1 Metro 2 snapshot, 2.7
 * grace end / late charge, 10.x MI schedule + midpoint, 19.1 servicing-file compile). Nothing here re-implements an
 * obligation another process owns: HO items *mirror* the owner's event, the checklist records evidence ids.
 *
 * Events (timer subject in brackets — src/kernel/timers/engine.ts arms on `loanId` / `applicationId`; every event
 * carries `application_id` during the hand-off so the 30.4 clocks arm under `isOriginationContext`):
 *   servicing_handoff.opened{handoff_id, opened_at, first_payment_date, item_count, source=origination}     [loan]
 *   handoff_item.satisfied{item_code, evidence_event_id, evidence_document_id}   (HO-006 closes SM_FIRST_STATEMENT_RECONCILE_1BD)
 *   handoff_item.breached{item_code, timer_code, timer_id}
 *   servicing_handoff.completed / servicing_handoff.closed{close_basis, exception_count, exceptions[]}  (closes SM_ORIG_HANDOFF_CLOSE_90)
 *   vendor.activation.requested / .confirmed{vendor_kind, activation_id, contract_ref} / .rejected{vendor_kind, reject_reason, attempt}
 *   epd.flag.raised{definition, installment_no, days_past_due_at_flag, basis} / epd.flag.cleared{flag_id, clear_reason, ledger_event_id} / epd.watch.closed{basis}
 *   servicing_file.requested{kind, request_id, requested_at} / servicing_file.compiled{kind, request_id, within_five_days, elapsed_seconds, items}
 *   documents.retention.classified{classified_count, unclassified_count, unclassified[]} / retention.schedule.computed{rule_version}
 *   timer.seed.repaired{code, anchor_date, created_by=O11.4_repair} / timers.seeding.verified{missing, misanchored, repaired}
 *   ownership_transfer.notice.evidenced{document_id, kind=fnma_loan_purchase_letter}   (25.4's satisfier for SM_O64_FNMA_1026_39_EVIDENCE_45)
 *   portal.explainer.primed{topic=fnma_loan_purchase_letter}
 *   credit.cycle.held{reason, held_to_as_of}   (8.1's hold instruction for a loan still in `warnings_open` with an identity OW rule)
 *   mi.schedule.updated{bpmi, rule_78_applies, scheduled_78_date, midpoint_termination_date}   (10.2/10.3's HPA clocks arm on it)
 *   schedule.tick{cadence=daily, job=cs_boarded_originations_daily} / compliance_report.published{kind=boarded_originations_daily}
 */
import { createHash, randomUUID } from "node:crypto";
import { type PlainDate, plainDate as D, addDays, addMonths, addYears, daysBetween, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollForward, servicer, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { cycle as statementCycle, reminderPanel } from "../notices/statement.ts";
import { graceEnd, lateChargeAmount } from "../cashiering/latecharges.ts";
import { buildSnapshot, renderBase, snapshotDate, type CreditLoanState, type Metro2Snapshot } from "../credit-reporting/index.ts";
import { compileServicingFile, type ServicingFileInput, type ServicingFileBundle, type Row } from "../data-security/ops-19-1.ts";
import { servicingFileDue } from "../data-security/retention.ts";
import { buildSchedule, scheduledDateForPct, midpoint } from "../pmi/schedule.ts";

export const BOARDING_AGENT: Actor = { kind: "agent", id: "boarding" };
export const SENTINEL_AGENT: Actor = { kind: "agent", id: "compliance-sentinel" };
export const RULE_SET_30_4 = "30.4@rules.v1";
export const RETENTION_RULE_VERSION = "rules.retention.v1";
export const REPAIR_PROVENANCE = "O11.4_repair";
export const DAILY_REPORT_JOB = "cs_boarded_originations_daily";
export const DAILY_REPORT_KIND = "boarded_originations_daily";
export const HANDOFF_WINDOW_DAYS = 90;

const need = (ok: unknown, msg: string): void => { if (!ok) throw new RangeError(msg); };
const nonEmpty = (v: unknown, what: string): string => { need(typeof v === "string" && v.trim(), `${what} is required`); return v as string; };
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dateOf = (v: string): PlainDate => (isDate(v) ? v : wallClock(Date.parse(v), "America/New_York").date);

/** Loan + application context every hand-off event carries (both ids during the hand-off; addendum §3). */
export interface HandoffCtx { readonly loan_id: string; readonly application_id: string; }
const ids = (c: HandoffCtx): { loanId: string; applicationId: string } => ({ loanId: nonEmpty(c.loan_id, "loan_id"), applicationId: nonEmpty(c.application_id, "application_id") });
const append = (events: EventStore, c: HandoffCtx, type: string, payload: Record<string, unknown>, actor: Actor = BOARDING_AGENT, causationId?: string): DomainEvent =>
  events.append({ type, ...ids(c), actor, payload: { application_id: c.application_id, ...payload }, ...(causationId ? { causationId } : {}) });

// ============================================================ rule 1 — the hand-off checklist (HO-001…HO-022)
export type HandoffItemStatus = "pending" | "satisfied" | "not_applicable" | "breached" | "waived";
export interface HandoffItemDef {
  readonly code: string; readonly title: string; readonly owner_process: string; readonly timer_code: string | null; readonly satisfying_event: string | null;
  /** HO-010…HO-014 become due only at `loan.purchased` (30.1's investor items). */
  readonly purchase_dependent: boolean;
  /** Statutory items: a breach cannot be closed over without an `officer` override (agent guardrail). */
  readonly statutory: boolean;
}
const item = (code: string, title: string, owner_process: string, timer_code: string | null, satisfying_event: string | null, o: { purchase_dependent?: boolean; statutory?: boolean } = {}): HandoffItemDef =>
  ({ code, title, owner_process, timer_code, satisfying_event, purchase_dependent: o.purchase_dependent ?? false, statutory: o.statutory ?? false });
/** Rule 1: owner, governing timer (referenced, never redefined) and satisfying event per item. */
export const HANDOFF_ITEM_DEFS: readonly HandoffItemDef[] = [
  item("HO-001", "boarding complete", "30.2", "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE", "loan.active"),
  item("HO-002", "opening ledger reconciled to funding", "30.2", null, "ledger.opening_posted"),
  item("HO-003", "first-payment letter sent", "25.4", "SM_O64_FIRST_PAYMENT_LETTER_5BD", "notice.sent{template=NTC_SM_FIRST_PAYMENT_LETTER}"),
  item("HO-004", "initial escrow statement delivered", "30.3", "REGX_1024_17G_INITIAL_STMT_45", "escrow.statement.sent{statement_type=initial}", { statutory: true }),
  item("HO-005", "escrow account active with projected escrow_bills", "30.3", null, "escrow.line.projected"),
  item("HO-006", "first periodic statement sent and reconciled", "7.1", "SM_FIRST_STATEMENT_RECONCILE_1BD", "handoff_item.satisfied{item_code=HO-006}"),
  item("HO-007", "first Metro 2 cycle transmitted and acknowledged", "8.1", "SM_METRO2_TRANSMIT_ALL4_BD3", "metro2.ack.received{reject_count=0}"),
  item("HO-008", "1098 seeds handed off", "25.4", "SM_O64_1098_SEEDS_AT_BOARDING_GATE", "tax_reporting.seeds.handed_off"),
  item("HO-009", "§1026.39 status resolved", "25.4", "SM_O64_FNMA_1026_39_EVIDENCE_45", "ownership_transfer.notice.evidenced", { purchase_dependent: false, statutory: true }),
  item("HO-010", "Fannie Mae loan number and servicer number recorded", "30.1", "SM_FNMA_ESTABLISHMENT_VERIFY_1BD", "loan.fnma_established", { purchase_dependent: true }),
  item("HO-011", "first LAR accepted", "30.1", "FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2", "investor.first_lar.accepted", { purchase_dependent: true }),
  item("HO-012", "Escrow Setup event accepted", "30.1", "LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1", "investor_events.acked{type=EscrowSetup}", { purchase_dependent: true }),
  item("HO-013", "pre-purchase custodial funds transferred", "30.1", "FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD", "custodial.prepurchase_funds.transferred", { purchase_dependent: true }),
  item("HO-014", "MERS investor = Fannie Mae verified and Interim Funder removed", "30.1", "SM_MERS_INVESTOR_FNMA_VERIFY_10BD", "mers.investor.fnma_verified", { purchase_dependent: true }),
  item("HO-015", "tax service activated", "30.4", "SM_TAX_SERVICE_ACTIVATE_2BD", "vendor.activation.confirmed{vendor_kind=tax_service}"),
  item("HO-016", "flood LOL servicing link confirmed", "30.4", "SM_FLOOD_LOL_SERVICING_LINK_2BD", "vendor.activation.confirmed{vendor_kind=flood_lol}"),
  item("HO-017", "insurance tracking activated", "30.4", "SM_INSURANCE_TRACKING_ACTIVATE_2BD", "insurance.policy.verified"),
  item("HO-018", "MI activation confirmed", "30.4", "SM_MI_ACTIVATION_CONFIRM_2BD", "mi_policy.activated"),
  item("HO-019", "servicing-file compile test passed", "30.4", "SM_SERVICING_FILE_COMPILE_TEST_1BD", "servicing_file.compiled{kind=boarding_test}", { statutory: true }),
  item("HO-020", "retention classes assigned", "30.4", "SM_ORIG_RETENTION_CLASSIFY_GATE", "documents.retention.classified"),
  item("HO-021", "timer seeding verified", "30.4", null, "timers.seeding.verified"),
  item("HO-022", "QC selection outcome recorded", "28.2", "FNMA_D1_3_01_QC_SELECT_MONTHLY", "qc.selection.recorded"),
];
export const PURCHASE_DEPENDENT_ITEMS: readonly string[] = HANDOFF_ITEM_DEFS.filter((d) => d.purchase_dependent).map((d) => d.code);

export interface HandoffItemRow {
  readonly item_id: string; readonly handoff_id: string; readonly item_code: string; readonly owner_process: string; readonly timer_code: string | null;
  readonly due_at: PlainDate | null; readonly satisfying_event: string | null; readonly status: HandoffItemStatus; readonly satisfied_at: string | null;
  readonly evidence_document_id: string | null; readonly evidence_event_id: string | null; readonly na_reason: string | null; readonly timer_instance_id: string | null;
  readonly note: string | null;
}
export type HandoffStatus = "open" | "complete" | "complete_with_exceptions" | "closed" | "reopened";
export type CloseBasis = "all_items_satisfied" | "officer_override" | "loan_paid_off" | "loan_transferred";
export interface ServicingHandoffRow {
  readonly handoff_id: string; readonly loan_id: string; readonly application_id: string; readonly opened_at: PlainDate; readonly first_payment_date: PlainDate;
  readonly purchase_date: PlainDate | null; readonly status: HandoffStatus; readonly closed_at: PlainDate | null; readonly close_basis: CloseBasis | null;
  readonly exception_count: number; readonly agent_decision_id: string | null; readonly close_by: PlainDate;
}
export interface HandoffState { readonly handoff: ServicingHandoffRow; readonly items: readonly HandoffItemRow[]; }

/** Due dates of this process's boarding-day clocks, from the registry's offsets (+2 BD vendors, +1 BD compile test, +90 CD close). */
export function boardingDueDates(boardedOn: PlainDate, cal: Calendar = servicer): Record<"SM_TAX_SERVICE_ACTIVATE_2BD" | "SM_FLOOD_LOL_SERVICING_LINK_2BD" | "SM_INSURANCE_TRACKING_ACTIVATE_2BD" | "SM_MI_ACTIVATION_CONFIRM_2BD" | "SM_SERVICING_FILE_COMPILE_TEST_1BD" | "SM_ORIG_HANDOFF_CLOSE_90", PlainDate> {
  const bd2 = addBusinessDays(boardedOn, 2, cal);
  return { SM_TAX_SERVICE_ACTIVATE_2BD: bd2, SM_FLOOD_LOL_SERVICING_LINK_2BD: bd2, SM_INSURANCE_TRACKING_ACTIVATE_2BD: bd2, SM_MI_ACTIVATION_CONFIRM_2BD: bd2,
    SM_SERVICING_FILE_COMPILE_TEST_1BD: addBusinessDays(boardedOn, 1, cal), SM_ORIG_HANDOFF_CLOSE_90: addDays(boardedOn, HANDOFF_WINDOW_DAYS) };
}

export interface OpenHandoffInput extends HandoffCtx {
  readonly boarded_at: string;                  // ISO instant or PlainDate (30.2 `loan.boarded{boarded_at}`)
  readonly first_payment_date: PlainDate;
  /** `mi_certificates` present on the boarded loan (purchase fixture) — HO-018 is `not_applicable{no_mi}` otherwise. */
  readonly mi_certificates_present: boolean;
  readonly escrowed?: boolean;
  readonly purchase_date?: PlainDate | null;
}
/** Timer handle (src/app/commands.ts CommandContext.timers): the no-MI branch retires the registry's MI clock, which arms on every `loan.boarded`. */
export interface TimerHandle { byCode(code: string): readonly { id: string; code: string; status: string; loanId?: string }[]; cancel(id: string, reason: string, actor?: Actor): void; }
export type VendorKind = "tax_service" | "flood_lol" | "insurance_tracking" | "mi_activation";
export const VENDOR_KINDS: readonly VendorKind[] = ["tax_service", "flood_lol", "insurance_tracking", "mi_activation"];

/**
 * Rule 1 / T1: `loan.boarded` opens the hand-off — 22 items with owner, governing timer and satisfying event; HO-018 is
 * `not_applicable{no_mi}` without `mi_certificates`; HO-010…HO-014 stay `pending` with `due_at` null until `loan.purchased`;
 * the boarding-day vendor/compile/close clocks are due per `boardingDueDates`. Emits `servicing_handoff.opened` and one
 * `vendor.activation.requested` per applicable vendor.
 */
export function openHandoff(events: EventStore, i: OpenHandoffInput, timers?: TimerHandle, cal: Calendar = servicer): HandoffState & { event: DomainEvent; vendor_requests: readonly VendorActivationRow[]; retired_mi_timer_id: string | null } {
  need(isDate(i.first_payment_date), "first_payment_date must be a PlainDate");
  const opened_at = dateOf(nonEmpty(i.boarded_at, "boarded_at"));
  const due = boardingDueDates(opened_at, cal);
  const handoff_id = `HO-${i.loan_id}`;
  const items: HandoffItemRow[] = HANDOFF_ITEM_DEFS.map((d) => {
    const noMi = d.code === "HO-018" && !i.mi_certificates_present;
    const dueAt = d.purchase_dependent ? null : d.timer_code && d.timer_code in due ? due[d.timer_code as keyof typeof due] : null;
    return { item_id: `${handoff_id}:${d.code}`, handoff_id, item_code: d.code, owner_process: d.owner_process, timer_code: d.timer_code, due_at: noMi ? null : dueAt, satisfying_event: d.satisfying_event,
      status: noMi ? "not_applicable" : "pending", satisfied_at: null, evidence_document_id: null, evidence_event_id: null, na_reason: noMi ? "no_mi" : null, timer_instance_id: null, note: null };
  });
  const handoff: ServicingHandoffRow = { handoff_id, loan_id: i.loan_id, application_id: i.application_id, opened_at, first_payment_date: i.first_payment_date, purchase_date: i.purchase_date ?? null, status: "open",
    closed_at: null, close_basis: null, exception_count: 0, agent_decision_id: null, close_by: due.SM_ORIG_HANDOFF_CLOSE_90 };
  const event = append(events, i, "servicing_handoff.opened", { handoff_id, opened_at, boarded_at: i.boarded_at, first_payment_date: i.first_payment_date, item_count: items.length, mi_certificates_present: i.mi_certificates_present, close_by: handoff.close_by, source: "origination" });
  const kinds: VendorKind[] = ["tax_service", "flood_lol", "insurance_tracking", ...(i.mi_certificates_present ? (["mi_activation"] as VendorKind[]) : [])];
  const vendor_requests = kinds.map((vendor_kind) => requestVendorActivation(events, { ...i, vendor_kind, requested_at: i.boarded_at, escrowed: i.escrowed ?? true }).activation);
  let retired: string | null = null;
  if (!i.mi_certificates_present && timers) for (const t of timers.byCode("SM_MI_ACTIVATION_CONFIRM_2BD")) if (t.status === "armed" && t.loanId === i.loan_id) { timers.cancel(t.id, "not_applicable: no mi_certificates on the boarded loan (HO-018 no_mi)", BOARDING_AGENT); retired = t.id; }
  return { handoff, items, event, vendor_requests, retired_mi_timer_id: retired };
}

const withItem = (s: HandoffState, code: string, patch: Partial<HandoffItemRow>): HandoffState => {
  need(s.items.some((x) => x.item_code === code), `no hand-off item ${code}`);
  return { ...s, items: s.items.map((x) => (x.item_code === code ? { ...x, ...patch } : x)) };
};
export function handoffItem(s: HandoffState, code: string): HandoffItemRow { const x = s.items.find((r) => r.item_code === code); need(x, `no hand-off item ${code}`); return x!; }

/** An item's owner event arrived: `handoff_item.satisfied{item_code}` with the evidence ids (HO-006's is SM_FIRST_STATEMENT_RECONCILE_1BD's satisfier). */
export function satisfyItem(events: EventStore, s: HandoffState, code: string, ev: { at: string; evidence_event_id?: string | null; evidence_document_id?: string | null; note?: string | null }): HandoffState & { event: DomainEvent } {
  const cur = handoffItem(s, code);
  need(cur.status !== "not_applicable" || code === "HO-018", `${code} is not_applicable (${cur.na_reason})`);
  const event = append(events, s.handoff, "handoff_item.satisfied", { item_code: code, handoff_id: s.handoff.handoff_id, satisfied_at: ev.at, evidence_event_id: ev.evidence_event_id ?? null, evidence_document_id: ev.evidence_document_id ?? null, note: ev.note ?? null });
  return { ...withItem(s, code, { status: "satisfied", satisfied_at: ev.at, evidence_event_id: ev.evidence_event_id ?? null, evidence_document_id: ev.evidence_document_id ?? null, note: ev.note ?? null, na_reason: null }), event };
}
/** The governing timer breached: the item carries the timer instance id (rule 1). */
export function breachItem(events: EventStore, s: HandoffState, code: string, b: { timer_id: string; at: string }): HandoffState & { event: DomainEvent } {
  const cur = handoffItem(s, code);
  const event = append(events, s.handoff, "handoff_item.breached", { item_code: code, handoff_id: s.handoff.handoff_id, timer_code: cur.timer_code, timer_id: b.timer_id, breached_at: b.at });
  return { ...withItem(s, code, { status: "breached", timer_instance_id: b.timer_id }), event };
}
/** `loan.purchased`: HO-010…HO-014 become due from the purchase date (30.1's clocks); the hand-off records the purchase date. */
export function recordPurchase(s: HandoffState, purchaseOn: PlainDate, dueFor: (code: string) => PlainDate | null = () => null): HandoffState {
  need(isDate(purchaseOn), "purchase_date must be a PlainDate");
  return { handoff: { ...s.handoff, purchase_date: purchaseOn }, items: s.items.map((x) => (PURCHASE_DEPENDENT_ITEMS.includes(x.item_code) ? { ...x, due_at: dueFor(x.item_code) ?? addDays(purchaseOn, 1) } : x)) };
}
/** Loan not sold / repurchased inside the window: the investor items are `not_applicable{not_purchased}` (edge cases). */
export function markNotPurchased(s: HandoffState): HandoffState {
  return { ...s, items: s.items.map((x) => (PURCHASE_DEPENDENT_ITEMS.includes(x.item_code) && x.status === "pending" ? { ...x, status: "not_applicable", na_reason: "not_purchased" } : x)) };
}

// ============================================================ rule 2 — §1026.39 handling (HO-009 mirrors 25.4)
export const FNMA_LETTER_EXPLAINER = {
  topic: "fnma_loan_purchase_letter",
  headline: "Fannie Mae bought your loan; nothing changes; keep paying Supermortgage.",
  points: [
    "Fannie Mae has notified you that it purchased your loan. It is a legal requirement for Fannie Mae to notify you of the purchase.",
    "The letter identifies Fannie Mae as the owner/investor for your loan and identifies your mortgage servicer, who provides customer service.",
    "It does not change the terms or conditions of your mortgage loan, deed of trust, or note.",
    "Send all payments to your mortgage servicer, Supermortgage. Fannie Mae is not your mortgage servicer and does not service mortgage loans.",
  ],
  channel: "borrower_portal",
  consumer_notice: false,
} as const;
export type OwnershipNoticeStatus = "not_applicable" | "expected" | "sent" | "evidenced" | "overdue_unconfirmed" | "sent_by_sm";
export interface OwnershipMirrorInput extends HandoffCtx { readonly purchase_date: PlainDate; readonly covered_person: "fannie_mae" | "sm_warehouse_assignee" | "other"; readonly written_fnma_instruction_on_file?: boolean; }
export interface OwnershipMirror { readonly status: OwnershipNoticeStatus; readonly due_date: PlainDate; readonly evidence_due: PlainDate; readonly sender: "covered_person_direct" | "servicer_on_behalf"; readonly render_notice: false; readonly hard_deadline_owner: "25.4"; readonly explainer_primed_on: PlainDate; readonly explainer_event: DomainEvent; }
/**
 * Rule 2 / T2: on `loan.purchased` 25.4 sets `ownership_transfer_notices.status='expected'` (Fannie Mae is the covered person and
 * sends its own letter; due = purchase + 30 calendar days). 30.4 only mirrors the status, never renders
 * NTC_REGZ_1026_39_OWNERSHIP_TRANSFER while `expected`, and primes the portal explainer the same day.
 */
export function mirrorOwnershipNotice(events: EventStore, i: OwnershipMirrorInput): OwnershipMirror {
  need(isDate(i.purchase_date), "purchase_date must be a PlainDate");
  const sender = i.covered_person === "fannie_mae" && !i.written_fnma_instruction_on_file ? "covered_person_direct" : "servicer_on_behalf";
  const status: OwnershipNoticeStatus = sender === "covered_person_direct" ? "expected" : "sent_by_sm";
  const explainer_event = append(events, i, "portal.explainer.primed", { topic: FNMA_LETTER_EXPLAINER.topic, primed_on: i.purchase_date, headline: FNMA_LETTER_EXPLAINER.headline, consumer_notice: false });
  return { status, due_date: addDays(i.purchase_date, 30), evidence_due: addDays(i.purchase_date, 45), sender, render_notice: false, hard_deadline_owner: "25.4", explainer_primed_on: i.purchase_date, explainer_event };
}
/** Never send the fallback template while 25.4's row is `expected` (duplicate notices contradict Fannie Mae's letter). */
export function ownershipNoticeMayRender(status: OwnershipNoticeStatus, sender: "covered_person_direct" | "servicer_on_behalf"): boolean { return status !== "expected" && sender === "servicer_on_behalf"; }
/** A borrower-supplied copy of the Fannie Mae letter: indexed as `documents{kind='fnma_loan_purchase_letter'}`, it satisfies HO-009 (`evidenced`) and 25.4's evidence timer through 25.4's own event. */
export function fnmaLetterEvidenced(events: EventStore, s: HandoffState, ev: { document_id: string; received_on: PlainDate; source: "borrower_upload" | "fnma_copy" | "borrower_reported" }): HandoffState & { evidence_event: DomainEvent; item_event: DomainEvent; status: "evidenced" } {
  nonEmpty(ev.document_id, "document_id"); need(isDate(ev.received_on), "received_on must be a PlainDate");
  const evidence_event = append(events, s.handoff, "ownership_transfer.notice.evidenced", { document_id: ev.document_id, kind: "fnma_loan_purchase_letter", evidenced_on: ev.received_on, source: ev.source, status: "evidenced" });
  const r = satisfyItem(events, s, "HO-009", { at: ev.received_on, evidence_event_id: evidence_event.id, evidence_document_id: ev.document_id, note: "evidenced" });
  return { handoff: r.handoff, items: r.items, evidence_event, item_event: r.event, status: "evidenced" };
}

// ============================================================ rule 3 — statement timing (cycle 1 policy lead; cycle 2 = 7.1's clock)
export interface CycleClocks { readonly first_statement_by: PlainDate; readonly courtesy_period_end: PlainDate; readonly second_statement_by: PlainDate; readonly reminder_due: PlainDate | null; readonly reminder_instance: boolean; readonly late_charge_grace_end: PlainDate; readonly late_charge_gate_opens: PlainDate; }
/**
 * Rule 3 / T4: cycle 1 = 30.2's `SM_ORIG_FIRST_STATEMENT_LEAD_15` (first due − 15); cycle 2 = 7.1's `REGZ_1026_41B_STATEMENT_PROMPT_4`
 * from the courtesy-period end (no business-day roll); `FNMA_D2_2_03_PAYMENT_REMINDER_20` only if the installment is unpaid on
 * the 17th; the late-charge gate (2.7 `NOTE_6A_LATE_CHARGE_GRACE_GATE`) opens the next servicer business day after a weekend/holiday grace end.
 */
export function cycleClocks(f: { first_payment_date: PlainDate; late_charge_grace_days: number; paid_on: PlainDate | null; as_of: PlainDate }, cal: Calendar = servicer): CycleClocks {
  need(isDate(f.first_payment_date), "first_payment_date must be a PlainDate");
  const c = statementCycle(f.first_payment_date, f.late_charge_grace_days);
  const day17 = addDays(f.first_payment_date, 16);
  const unpaidOn17 = f.as_of >= day17 && (f.paid_on === null || f.paid_on > day17);
  const rp = reminderPanel(day17, unpaidOn17, false);
  const graceEndCal = addDays(f.first_payment_date, f.late_charge_grace_days);
  return { first_statement_by: addDays(f.first_payment_date, -15), courtesy_period_end: c.courtesy_period_end, second_statement_by: c.statement_due_by, reminder_due: rp.standalone_by, reminder_instance: rp.standalone_by !== null,
    late_charge_grace_end: graceEndCal, late_charge_gate_opens: graceEnd(f.first_payment_date, f.late_charge_grace_days, true, cal) };
}

// ============================================================ rule 4 — first-statement reconciliation (HO-006)
export interface BoardedFigures { readonly pi_cents: Cents; readonly escrow_payment_cents: Cents; readonly mi_cents?: Cents; readonly first_payment_date: PlainDate; readonly original_amount_cents: Cents; readonly escrow_deposit_cents: Cents; readonly escrow_disbursed_cents?: Cents; readonly late_charge_pct: string; readonly late_charge_grace_days: number; readonly late_charge_cap_cents?: Cents | null; }
export interface RenderedStatement { readonly amount_due_cents: Cents; readonly due_date: PlainDate; readonly late_fee_cents: Cents; readonly late_fee_after: PlainDate; readonly upb_cents: Cents; readonly escrow_balance_cents: Cents; readonly transactions: readonly { kind: string; amount_cents: Cents }[]; readonly fcra_negative_info_notice: boolean; readonly partial_payment_policy_present: boolean; readonly contact_information_present: boolean; }
export interface ExpectedStatement { readonly amount_due_cents: Cents; readonly due_date: PlainDate; readonly late_fee_cents: Cents; readonly late_fee_after: PlainDate; readonly upb_cents: Cents; readonly escrow_balance_cents: Cents; }
export interface Reconciliation { readonly passed: boolean; readonly expected: ExpectedStatement; readonly mismatches: readonly { field: string; expected: string; actual: string; severity: "sev2" | "sev3" }[]; readonly amount_due_discrepancy_cents: Cents; readonly corrected_statement_required: boolean; readonly corrected_by: "7.1" | null; }
/** The cycle-1 figures from 30.2's frozen boarding record: amount due = P&I + escrow (+ MI); late fee = note % of P&I after the grace period; UPB = original amount; escrow balance = deposit − disbursements. */
export function expectedFirstStatement(b: BoardedFigures): ExpectedStatement {
  need(typeof b.pi_cents === "bigint" && typeof b.escrow_payment_cents === "bigint", "pi_cents and escrow_payment_cents must be bigint cents");
  return { amount_due_cents: b.pi_cents + b.escrow_payment_cents + (b.mi_cents ?? 0n), due_date: b.first_payment_date, late_fee_cents: lateChargeAmount(b.pi_cents, b.late_charge_pct, b.late_charge_cap_cents ?? null),
    late_fee_after: addDays(b.first_payment_date, b.late_charge_grace_days), upb_cents: b.original_amount_cents, escrow_balance_cents: b.escrow_deposit_cents - (b.escrow_disbursed_cents ?? 0n) };
}
export const AMOUNT_DUE_SEV2_THRESHOLD_CENTS = 1n;   // "discrepancies of ≥ $0.01 in the amount due are sev-2"
/**
 * Rule 4 / T3: compare the rendered statement to the boarded figures. Any mismatch → SM_FIRST_STATEMENT_RECONCILE_1BD is left
 * unsatisfied (breach → 7.1 corrected statement); a match emits `handoff_item.satisfied{item_code=HO-006}`.
 */
export function reconcileFirstStatement(events: EventStore, s: HandoffState, r: { statement: RenderedStatement; boarded: BoardedFigures; statement_event_id: string; at: string }): Reconciliation & { state: HandoffState; event: DomainEvent | null } {
  const expected = expectedFirstStatement(r.boarded);
  const st = r.statement;
  const mismatches: { field: string; expected: string; actual: string; severity: "sev2" | "sev3" }[] = [];
  const diff = st.amount_due_cents - expected.amount_due_cents;
  const abs = diff < 0n ? -diff : diff;
  if (abs >= AMOUNT_DUE_SEV2_THRESHOLD_CENTS) mismatches.push({ field: "amount_due_cents", expected: String(expected.amount_due_cents), actual: String(st.amount_due_cents), severity: "sev2" });
  if (st.due_date !== expected.due_date) mismatches.push({ field: "due_date", expected: expected.due_date, actual: st.due_date, severity: "sev2" });
  if (st.late_fee_cents !== expected.late_fee_cents) mismatches.push({ field: "late_fee_cents", expected: String(expected.late_fee_cents), actual: String(st.late_fee_cents), severity: "sev3" });
  if (st.late_fee_after !== expected.late_fee_after) mismatches.push({ field: "late_fee_after", expected: expected.late_fee_after, actual: st.late_fee_after, severity: "sev3" });
  if (st.upb_cents !== expected.upb_cents) mismatches.push({ field: "upb_cents", expected: String(expected.upb_cents), actual: String(st.upb_cents), severity: "sev2" });
  if (st.escrow_balance_cents !== expected.escrow_balance_cents) mismatches.push({ field: "escrow_balance_cents", expected: String(expected.escrow_balance_cents), actual: String(st.escrow_balance_cents), severity: "sev3" });
  if (st.transactions.some((t) => /prepaid_interest/i.test(t.kind))) mismatches.push({ field: "transactions", expected: "opening entries only (prepaid interest is an origination charge, not a loan-account transaction)", actual: "prepaid interest shown", severity: "sev3" });
  if (st.fcra_negative_info_notice) mismatches.push({ field: "fcra_negative_info_notice", expected: "not repeated (in the first-payment letter — 30.2 rule 9)", actual: "repeated", severity: "sev3" });
  if (!st.partial_payment_policy_present) mismatches.push({ field: "partial_payment_policy", expected: "present", actual: "missing", severity: "sev3" });
  if (!st.contact_information_present) mismatches.push({ field: "contact_information", expected: "present", actual: "missing", severity: "sev3" });
  const passed = mismatches.length === 0;
  if (passed) {
    const ok = satisfyItem(events, s, "HO-006", { at: r.at, evidence_event_id: r.statement_event_id, note: "cycle-1 statement reconciled to the boarded figures" });
    return { passed, expected, mismatches, amount_due_discrepancy_cents: abs, corrected_statement_required: false, corrected_by: null, state: { handoff: ok.handoff, items: ok.items }, event: ok.event };
  }
  const event = append(events, s.handoff, "first_statement.discrepancy", { item_code: "HO-006", statement_event_id: r.statement_event_id, mismatches, amount_due_discrepancy_cents: String(abs), severity: mismatches.some((m) => m.severity === "sev2") ? "sev2" : "sev3", corrected_statement_by: "7.1" });
  return { passed, expected, mismatches, amount_due_discrepancy_cents: abs, corrected_statement_required: true, corrected_by: "7.1", state: s, event };
}

// ============================================================ rule 5 — first credit-reporting cycle (8.1's engine; new-origination specifics)
/** 30.2 OW rules that concern borrower identity: a loan held on one of them is reported the next cycle (rule 5). */
export const IDENTITY_OW_RULES: ReadonlySet<string> = new Set(["OW-001", "OW-002", "OW-003"]);
export interface FirstCreditCycleInput extends HandoffCtx { readonly boarded_on: PlainDate; readonly active_on: PlainDate | null; readonly warnings_open: readonly string[]; readonly as_of: PlainDate; readonly state: Omit<CreditLoanState, "as_of" | "loan_id">; }
export interface FirstCreditCycle { readonly held: boolean; readonly reason: string | null; readonly as_of: PlainDate; readonly held_to_as_of: PlainDate | null; readonly snapshot: Metro2Snapshot | null; readonly base: Record<string, string> | null; readonly event: DomainEvent | null; }
export function firstCreditCycle(events: EventStore, i: FirstCreditCycleInput): FirstCreditCycle {
  const as_of = snapshotDate(i.as_of);
  need(as_of >= i.boarded_on, "the first snapshot is the first month-end after boarding");
  const identity = i.warnings_open.filter((w) => IDENTITY_OW_RULES.has(w));
  const reason = i.active_on === null || i.active_on > as_of ? `loan not active by the ${as_of} snapshot (30.2 DQ gate)` : identity.length ? `warnings_open: identity OW rule(s) ${identity.join(", ")} (identity fields unvalidated)` : null;
  if (reason) {
    const held_to_as_of = endOfMonth(addMonths(as_of, 1));
    const event = append(events, i, "credit.cycle.held", { reason, as_of, held_to_as_of, rules: identity, release_requires: "warnings resolved" }, BOARDING_AGENT);
    return { held: true, reason, as_of, held_to_as_of, snapshot: null, base: null, event };
  }
  const snapshot = buildSnapshot({ ...i.state, loan_id: i.loan_id, as_of, prior: null });
  return { held: false, reason: null, as_of, held_to_as_of: null, snapshot, base: renderBase(snapshot), event: null };
}
/** HO-007: 8.1's acknowledgment with zero rejects for the loan (or `SM_METRO2_REJECT_RESOLVE_BD5` closure) satisfies the item. */
export function ackFirstCreditCycle(events: EventStore, s: HandoffState, ack: { event_id: string; received_at: string; items: readonly { loan_id: string; status: string }[]; reject_resolve_closed?: boolean }): HandoffState & { satisfied: boolean; event: DomainEvent | null } {
  const rejects = ack.items.filter((x) => x.loan_id === s.handoff.loan_id && x.status !== "resolved" && x.status !== "accepted");
  if (rejects.length && !ack.reject_resolve_closed) return { ...s, satisfied: false, event: null };
  const r = satisfyItem(events, s, "HO-007", { at: ack.received_at, evidence_event_id: ack.event_id, note: rejects.length ? "SM_METRO2_REJECT_RESOLVE_BD5 closure" : "acknowledged with zero rejects" });
  return { handoff: r.handoff, items: r.items, satisfied: true, event: r.event };
}

// ============================================================ rule 7 — EPD monitoring (daily inside SM_ORIG_EPD_WATCH_P6_60)
export type EpdDefinition = "fnma_e205_p1_3_60" | "sm_qc_p1_6_60" | "sm_watch_p1_6_30";
export const EPD_DEFINITIONS: readonly { definition: EpdDefinition; installments: readonly number[]; days: number; consumer: string }[] = [
  { definition: "sm_watch_p1_6_30", installments: [1, 2, 3, 4, 5, 6], days: 30, consumer: "11.x early intervention + boarding-defect check" },
  { definition: "fnma_e205_p1_3_60", installments: [1, 2, 3], days: 60, consumer: "seller (E-2-05 usage flag; informational)" },
  { definition: "sm_qc_p1_6_60", installments: [1, 2, 3, 4, 5, 6], days: 60, consumer: "28.2 immediate discretionary selection (qc_reviews{kind='epd'})" },
];
export interface EpdInstallment { readonly n: number; readonly due_date: PlainDate; readonly paid_on: PlainDate | null; }
export interface EpdFlagRow { readonly flag_id: string; readonly loan_id: string; readonly definition: EpdDefinition; readonly installment_no: number; readonly installment_due_date: PlainDate; readonly flagged_at: PlainDate; readonly days_past_due_at_flag: number; readonly basis: "calendar_days_past_due"; readonly fnma_month_bucket: string | null; readonly cleared_at: PlainDate | null; readonly clear_reason: string | null; readonly qc_review_id: string | null; readonly fraud_case_id: string | null; }
/** `loans.epd_watch_until` = sixth scheduled due date + 60 calendar days. */
export function epdWatchUntil(firstPaymentDate: PlainDate): PlainDate { need(isDate(firstPaymentDate), "first_payment_date must be a PlainDate"); return addDays(addMonths(firstPaymentDate, 5), 60); }
/** Fannie Mae's month-bucket delinquency status (5.1) recorded alongside the calendar count for reconciliation. */
export function fnmaMonthBucket(dpd: number): string { return dpd < 30 ? "current" : dpd < 60 ? "30" : dpd < 90 ? "60" : dpd < 120 ? "90" : "120+"; }
/** Earliest date each definition can fire for a scheduled installment (rule 7 fixture: Jan 1 → sm_watch Jan 31; 60-day flags Mar 2). */
export function epdEarliestDates(installmentDue: PlainDate): Record<EpdDefinition, PlainDate> { return { sm_watch_p1_6_30: addDays(installmentDue, 30), fnma_e205_p1_3_60: addDays(installmentDue, 60), sm_qc_p1_6_60: addDays(installmentDue, 60) }; }
export interface EpdRunInput extends HandoffCtx { readonly as_of: PlainDate; readonly installments: readonly EpdInstallment[]; readonly flags: readonly EpdFlagRow[]; }
/**
 * Rule 7 / T6–T7: the daily job raises, per definition, the first time an installment 1–6 (1–3 for E-2-05) reaches the threshold in
 * calendar days past due; `epd.flag.raised` is the window's output (28.2 consumes `sm_qc_p1_6_60` as an immediate discretionary
 * selection). Flags are rows: raising never deletes or re-raises an open flag.
 */
export function runEpdDaily(events: EventStore, i: EpdRunInput): { flags: readonly EpdFlagRow[]; raised: readonly EpdFlagRow[]; events: readonly DomainEvent[] } {
  need(isDate(i.as_of), "as_of must be a PlainDate");
  const flags = [...i.flags]; const raised: EpdFlagRow[] = []; const out: DomainEvent[] = [];
  for (const inst of [...i.installments].sort((a, b) => a.n - b.n)) {
    if (inst.n < 1 || inst.n > 6 || inst.due_date > i.as_of) continue;
    const unpaid = inst.paid_on === null || inst.paid_on > i.as_of;
    if (!unpaid) continue;
    const dpd = daysBetween(inst.due_date, i.as_of);
    for (const d of EPD_DEFINITIONS) {
      if (!d.installments.includes(inst.n) || dpd < d.days) continue;
      if (flags.some((f) => f.definition === d.definition && f.installment_no === inst.n && f.cleared_at === null)) continue;
      const row: EpdFlagRow = { flag_id: `epd-${i.loan_id}-${d.definition}-${inst.n}-${i.as_of}`, loan_id: i.loan_id, definition: d.definition, installment_no: inst.n, installment_due_date: inst.due_date, flagged_at: i.as_of, days_past_due_at_flag: dpd, basis: "calendar_days_past_due", fnma_month_bucket: fnmaMonthBucket(dpd), cleared_at: null, clear_reason: null, qc_review_id: null, fraud_case_id: null };
      flags.push(row); raised.push(row);
      out.push(append(events, i, "epd.flag.raised", { flag_id: row.flag_id, definition: d.definition, installment_no: inst.n, installment_due_date: inst.due_date, days_past_due_at_flag: dpd, basis: row.basis, fnma_month_bucket: row.fnma_month_bucket, flagged_at: i.as_of, consumer: d.consumer, qc_selection: d.definition === "sm_qc_p1_6_60" ? "immediate_discretionary" : null }));
    }
  }
  return { flags, raised, events: out };
}
/** 28.2's consumption of `epd.flag.raised{definition=sm_qc_p1_6_60}`: an immediate discretionary review outside the monthly draw. */
export function qcSelectionFromEpd(e: DomainEvent): { kind: "epd"; selection: "discretionary_immediate"; flag_id: string; installment_no: number } | null {
  if (e.type !== "epd.flag.raised" || e.payload.definition !== "sm_qc_p1_6_60") return null;
  return { kind: "epd", selection: "discretionary_immediate", flag_id: String(e.payload.flag_id), installment_no: Number(e.payload.installment_no) };
}
export type EpdClearReason = "payment" | "reversal" | "posting_error";
export interface EpdClearInput extends HandoffCtx { readonly as_of: PlainDate; readonly installments: readonly EpdInstallment[]; readonly flags: readonly EpdFlagRow[]; readonly clear_reason: EpdClearReason; readonly ledger_event_id: string; }
/** Rule 7 clearing: a payment/reversal that drops days past due below the threshold clears the flag (`clear_reason`); a posting error clears with `posting_error` (28.2 withdraws an unstarted selection). Guardrail: never without a ledger event. History rows remain. */
export function clearEpdFlags(events: EventStore, i: EpdClearInput): { flags: readonly EpdFlagRow[]; cleared: readonly EpdFlagRow[]; events: readonly DomainEvent[]; qc_withdraw: boolean } {
  nonEmpty(i.ledger_event_id, "ledger_event_id (the agent cannot clear an epd_flags row without a ledger event)");
  const cleared: EpdFlagRow[] = []; const out: DomainEvent[] = [];
  const flags = i.flags.map((f) => {
    if (f.cleared_at !== null) return f;
    const inst = i.installments.find((x) => x.n === f.installment_no);
    const threshold = EPD_DEFINITIONS.find((d) => d.definition === f.definition)!.days;
    const dpd = !inst || (inst.paid_on !== null && inst.paid_on <= i.as_of) ? 0 : daysBetween(inst.due_date, i.as_of);
    if (i.clear_reason !== "posting_error" && dpd >= threshold) return f;
    const row: EpdFlagRow = { ...f, cleared_at: i.as_of, clear_reason: i.clear_reason };
    cleared.push(row);
    out.push(append(events, i, "epd.flag.cleared", { flag_id: f.flag_id, definition: f.definition, installment_no: f.installment_no, cleared_at: i.as_of, clear_reason: i.clear_reason, ledger_event_id: i.ledger_event_id, days_past_due_after: dpd }));
    return row;
  });
  return { flags, cleared, events: out, qc_withdraw: i.clear_reason === "posting_error" && cleared.some((c) => c.definition === "sm_qc_p1_6_60") };
}
/** The watch closes at `epd_watch_until` (or on payoff/transfer): `epd.watch.closed` — SM_ORIG_EPD_WATCH_P6_60's satisfier. */
export function closeEpdWatch(events: EventStore, i: HandoffCtx & { as_of: PlainDate; epd_watch_until: PlainDate; paid_off_on?: PlainDate | null; transferred_on?: PlainDate | null }): { closed: boolean; closed_on: PlainDate | null; basis: "window_end" | "payoff" | "transfer" | null; event: DomainEvent | null } {
  const basis = i.paid_off_on && i.paid_off_on <= i.as_of ? "payoff" : i.transferred_on && i.transferred_on <= i.as_of ? "transfer" : i.as_of >= i.epd_watch_until ? "window_end" : null;
  if (!basis) return { closed: false, closed_on: null, basis: null, event: null };
  const closed_on = basis === "payoff" ? i.paid_off_on! : basis === "transfer" ? i.transferred_on! : i.epd_watch_until;
  const event = append(events, i, "epd.watch.closed", { closed_on, basis, epd_watch_until: i.epd_watch_until });
  return { closed: true, closed_on, basis, event };
}

// ============================================================ rule 8 — vendor activations
export type VendorActivationStatus = "requested" | "confirmed" | "rejected" | "not_applicable";
export interface VendorActivationRow { readonly activation_id: string; readonly loan_id: string; readonly vendor_kind: VendorKind; readonly vendor_party_id: string | null; readonly contract_ref: string | null; readonly requested_at: string; readonly confirmed_at: string | null; readonly status: VendorActivationStatus; readonly reject_reason: string | null; readonly evidence_document_id: string | null; readonly cost_cents: Cents | null; readonly attempt: number; readonly payload: Record<string, unknown>; }
export interface VendorRequestInput extends HandoffCtx { readonly vendor_kind: VendorKind; readonly requested_at: string; readonly attempt?: number; readonly apns?: readonly string[]; readonly escrowed?: boolean; readonly lol_certificate_id?: string | null; readonly policies?: readonly string[]; readonly mi_certificate_number?: string | null; readonly vendor_party_id?: string | null; readonly cost_cents?: Cents | null; readonly correction?: Record<string, unknown> | null; }
/** Rule 8: one request per vendor kind at boarding (tax service per parcel; LOL certificate re-keyed to the servicing loan number; policies to the tracking vendor with the mortgagee clause; MI insurer confirmation). */
export function requestVendorActivation(events: EventStore, i: VendorRequestInput): { activation: VendorActivationRow; event: DomainEvent } {
  need(VENDOR_KINDS.includes(i.vendor_kind), `vendor_kind must be one of ${VENDOR_KINDS.join("/")}`);
  const attempt = i.attempt ?? 1;
  const activation_id = `va-${i.loan_id}-${i.vendor_kind}-${attempt}`;
  const payload: Record<string, unknown> = { servicing_loan_id: i.loan_id, ...(i.apns ? { apns: [...i.apns], contracts: i.apns.length } : {}), ...(i.escrowed !== undefined ? { escrowed: i.escrowed } : {}), ...(i.lol_certificate_id ? { lol_certificate_id: i.lol_certificate_id, notification_endpoint: "9.6" } : {}),
    ...(i.policies ? { policies: [...i.policies], mortgagee_clause: "[Partner] ISAOA/ATIMA c/o Supermortgage" } : {}), ...(i.mi_certificate_number ? { mi_certificate_number: i.mi_certificate_number } : {}), ...(i.correction ? { correction: i.correction } : {}) };
  const activation: VendorActivationRow = { activation_id, loan_id: i.loan_id, vendor_kind: i.vendor_kind, vendor_party_id: i.vendor_party_id ?? null, contract_ref: null, requested_at: i.requested_at, confirmed_at: null, status: "requested", reject_reason: null, evidence_document_id: null, cost_cents: i.cost_cents ?? null, attempt, payload };
  const event = append(events, i, "vendor.activation.requested", { activation_id, vendor_kind: i.vendor_kind, attempt, requested_at: i.requested_at, ...payload });
  return { activation, event };
}
export interface VendorConfirmInput extends HandoffCtx { readonly activation: VendorActivationRow; readonly contract_ref: string; readonly confirmed_at: string; readonly parcels_confirmed?: readonly string[]; readonly expected_apns?: readonly string[]; readonly installments?: readonly { due_on: PlainDate; amount_cents: Cents }[]; readonly projected_bills?: readonly { due_on: PlainDate; amount_cents: Cents }[]; readonly evidence_document_id?: string | null; }
/** Rule 8 confirmation: the tax-service contract must confirm the 24.4 APN(s) and its installments must match 30.3's `escrow_bills` projection (variance → 30.3/3.2 interim review). Emits `vendor.activation.confirmed{vendor_kind}` — the satisfier of the tax/flood clocks — and satisfies HO-015/HO-016. */
export function confirmVendorActivation(events: EventStore, s: HandoffState | null, i: VendorConfirmInput): { activation: VendorActivationRow; event: DomainEvent; state: HandoffState | null; item_event: DomainEvent | null; variance: readonly { due_on: PlainDate; projected_cents: Cents; vendor_cents: Cents }[] } {
  nonEmpty(i.contract_ref, "contract_ref");
  const a = i.activation;
  if (i.expected_apns && i.expected_apns.length) {
    const got = new Set(i.parcels_confirmed ?? []);
    const missing = i.expected_apns.filter((p) => !got.has(p));
    need(missing.length === 0, `parcels confirmed do not match the 24.4 APN(s): ${missing.join(", ")}`);
  }
  const variance = (i.projected_bills ?? []).flatMap((b) => { const v = (i.installments ?? []).find((x) => x.due_on === b.due_on); return v && v.amount_cents !== b.amount_cents ? [{ due_on: b.due_on, projected_cents: b.amount_cents, vendor_cents: v.amount_cents }] : []; });
  const activation: VendorActivationRow = { ...a, contract_ref: i.contract_ref, confirmed_at: i.confirmed_at, status: "confirmed", reject_reason: null, evidence_document_id: i.evidence_document_id ?? null };
  const event = append(events, i, "vendor.activation.confirmed", { activation_id: a.activation_id, vendor_kind: a.vendor_kind, contract_ref: i.contract_ref, confirmed_at: i.confirmed_at, parcels_confirmed: [...(i.parcels_confirmed ?? [])], attempt: a.attempt, variance, interim_review: variance.length ? "30.3/3.2" : null });
  const code = a.vendor_kind === "tax_service" ? "HO-015" : a.vendor_kind === "flood_lol" ? "HO-016" : a.vendor_kind === "insurance_tracking" ? "HO-017" : "HO-018";
  if (!s) return { activation, event, state: null, item_event: null, variance };
  const r = satisfyItem(events, s, code, { at: i.confirmed_at, evidence_event_id: event.id, evidence_document_id: i.evidence_document_id ?? null, note: `${a.vendor_kind} ${i.contract_ref}` });
  return { activation, event, state: { handoff: r.handoff, items: r.items }, item_event: r.event, variance };
}
export interface VendorRejectPlan { readonly activation: VendorActivationRow; readonly event: DomainEvent; readonly retry: { attempt: number; resubmit_by: PlainDate; corrected_from: "30.2 canonical data (24.4 APN)"; requires_boarding_correction: boolean } | null; readonly escalation: { severity: "sev2"; at: PlainDate; informed: readonly string[]; fallback: { owner: "3.7"; method: "direct_tax_authority_lookup"; installment_due: PlainDate | null } } | null; }
/** Rule 8 / T11: a reject is retried with corrected data the same business day; a second rejection escalates sev-2 at boarded + 5 BD (`officer{sm}` informed) and 3.7 falls back to a direct authority lookup for the next installment. */
export function rejectVendorActivation(events: EventStore, i: HandoffCtx & { activation: VendorActivationRow; reject_reason: string; rejected_at: string; boarded_on: PlainDate; next_installment_due?: PlainDate | null; origination_record_wrong?: boolean }, cal: Calendar = servicer): VendorRejectPlan {
  nonEmpty(i.reject_reason, "reject_reason");
  const a = i.activation;
  const activation: VendorActivationRow = { ...a, status: "rejected", reject_reason: i.reject_reason };
  const rejectedOn = dateOf(i.rejected_at);
  const second = a.attempt >= 2;
  const event = append(events, i, "vendor.activation.rejected", { activation_id: a.activation_id, vendor_kind: a.vendor_kind, reject_reason: i.reject_reason, attempt: a.attempt, rejected_at: i.rejected_at, second_rejection: second });
  const retry = second ? null : { attempt: a.attempt + 1, resubmit_by: rollForward(rejectedOn, cal), corrected_from: "30.2 canonical data (24.4 APN)" as const, requires_boarding_correction: i.origination_record_wrong === true };
  const escalation = second ? { severity: "sev2" as const, at: addBusinessDays(i.boarded_on, 5, cal), informed: ["boarding", "officer"], fallback: { owner: "3.7" as const, method: "direct_tax_authority_lookup" as const, installment_due: i.next_installment_due ?? null } } : null;
  return { activation, event, retry, escalation };
}
/** Rule 8(d) / T12: no insurer confirmation by boarded + 2 BD → sev-1 to the `pmi` agent and the partner `officer`; premium remittance is held; HO-018 `breached`. */
export function miActivationCheck(f: { boarded_on: PlainDate; confirmed_on: PlainDate | null; as_of: PlainDate }, cal: Calendar = servicer): { due: PlainDate; breached: boolean; severity: "sev1" | null; escalate_to: readonly string[]; premium_remittance_held: boolean; item_status: HandoffItemStatus } {
  const due = addBusinessDays(f.boarded_on, 2, cal);
  const confirmed = f.confirmed_on !== null && f.confirmed_on <= due;
  const breached = !confirmed && f.as_of > due;
  return { due, breached, severity: breached ? "sev1" : null, escalate_to: breached ? ["pmi", "officer"] : [], premium_remittance_held: !confirmed, item_status: breached ? "breached" : confirmed ? "satisfied" : "pending" };
}
export interface MiScheduleSeed { readonly certificate_number: string; readonly first_premium_due: PlainDate; readonly premium_plan: "bpmi_monthly" | "lpmi" | "bpmi_single"; readonly upb_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_date: PlainDate; readonly original_value_cents: Cents; }
/** MI confirmation → `mi_schedules` seeded with 10.x's calculators: 78% auto-termination date (4902(b)), midpoint (4902(c)), 80% cancellation-request eligibility; emits `mi.schedule.updated` so 10.2/10.3's HPA clocks arm. */
export function seedMiSchedule(events: EventStore, c: HandoffCtx, m: MiScheduleSeed): { scheduled_78_date: PlainDate; midpoint_termination_date: PlainDate; cancellation_eligibility_date: PlainDate; first_premium_due: PlainDate; premium_remittance_released: true; event: DomainEvent } {
  nonEmpty(m.certificate_number, "certificate_number"); need(isDate(m.first_premium_due), "first_premium_due must be a PlainDate");
  const v = buildSchedule({ upb_cents: m.upb_cents, annual_rate: ratePercent(m.note_rate_pct), term_months: m.term_months, first_due: m.first_payment_date });
  const d78 = scheduledDateForPct(v, m.original_value_cents, 78); const d80 = scheduledDateForPct(v, m.original_value_cents, 80);
  need(d78 && d80, "the amortization schedule never reaches the HPA thresholds");
  const mid = midpoint(m.first_payment_date, m.term_months);
  const bpmi = m.premium_plan !== "lpmi";
  const event = append(events, c, "mi.schedule.updated", { certificate_number: m.certificate_number, bpmi, rule_78_applies: bpmi, scheduled_78_date: d78!.due_date, midpoint_termination_date: mid.midpoint_termination_date, cancellation_eligibility_date: d80!.due_date, first_premium_due: m.first_premium_due, premium_plan: m.premium_plan, source: "origination" });
  return { scheduled_78_date: d78!.due_date, midpoint_termination_date: mid.midpoint_termination_date, cancellation_eligibility_date: d80!.due_date, first_premium_due: m.first_premium_due, premium_remittance_released: true, event };
}

// ============================================================ rule 9 — servicing file (§1024.38(c)(2))
export type ServicingFileKind = "boarding_test" | "borrower_request" | "regx_35_36" | "exam" | "litigation" | "fnma_lqc";
export const SERVICING_FILE_KINDS: readonly ServicingFileKind[] = ["boarding_test", "borrower_request", "regx_35_36", "exam", "litigation", "fnma_lqc"];
/** `servicing_file.requested{kind}` — REGX_1024_38C2_SERVICING_FILE_5's trigger (any kind other than the boarding test); five calendar days from receipt. */
export function requestServicingFile(events: EventStore, i: HandoffCtx & { kind: ServicingFileKind; requested_at: string; requester?: string | null; scope?: string | null }): { request_id: string; due_on: PlainDate; event: DomainEvent } {
  need(SERVICING_FILE_KINDS.includes(i.kind), `kind must be one of ${SERVICING_FILE_KINDS.join("/")}`);
  const request_id = `sfr-${i.loan_id}-${i.kind}-${randomUUID().slice(0, 8)}`;
  const due_on = servicingFileDue(dateOf(nonEmpty(i.requested_at, "requested_at")));
  const event = append(events, i, "servicing_file.requested", { request_id, kind: i.kind, requested_at: i.requested_at, due_on, requester: i.requester ?? null, scope: i.scope ?? null, five_day_basis: "calendar_days" });
  return { request_id, due_on, event };
}
export interface CompileInput extends HandoffCtx {
  readonly kind: ServicingFileKind; readonly request_id: string | null; readonly requested_at: string; readonly compiled_at: string; readonly elapsed_ms: number;
  readonly ledger_entries: readonly Row[]; readonly security_instrument: { document_id: string; recorded: boolean; recording_reference?: string | null } | null;
  readonly interaction_notes: readonly Row[]; readonly agent_decisions?: readonly Row[]; readonly data_fields: ServicingFileInput["data_fields"]; readonly borrower_documents: readonly Row[];
}
export interface CompilationRow { readonly compilation_id: string; readonly loan_id: string; readonly kind: ServicingFileKind; readonly request_id: string | null; readonly requested_at: string; readonly completed_at: string; readonly elapsed_seconds: number; readonly items: Record<"i" | "ii" | "iii" | "iv" | "v", { included: boolean | "not_applicable"; count: number; status?: string; document_ids?: readonly string[] }>; readonly package_document_id: string; readonly package_sha256: string; readonly within_five_days: boolean; readonly due_on: PlainDate; }
/**
 * Rule 9 / T8: assemble (i)–(v) with 19.1's compile function — the opening-ledger schedule (prepaid interest is an origination
 * charge, not a loan-account transaction: 30.2 never posts it to the loan's sub-accounts), the executed security instrument
 * marked `pending_recorded_copy` until 26.4 delivers the recorded copy, interaction notes, the data-field report and the (v)
 * container (empty at boarding). `within_five_days` measures completion against receipt + 5 calendar days.
 */
export function compileHandoffServicingFile(events: EventStore, s: HandoffState | null, i: CompileInput): { compilation: CompilationRow; bundle: ServicingFileBundle; event: DomainEvent; state: HandoffState | null; item_event: DomainEvent | null } {
  need(SERVICING_FILE_KINDS.includes(i.kind), `kind must be one of ${SERVICING_FILE_KINDS.join("/")}`);
  need(i.kind === "boarding_test" || i.request_id, "request_id is required for a real request");
  need(!i.ledger_entries.some((r) => /prepaid_interest/i.test(String(r.account ?? r.bucket ?? r.description ?? ""))), "prepaid interest is an origination charge — it is not a loan-account transaction (rule 9 (i))");
  const instrument: Row | null = i.security_instrument ? { document_id: i.security_instrument.document_id, kind: "security_instrument", status: i.security_instrument.recorded ? "recorded" : "pending_recorded_copy", recording_reference: i.security_instrument.recording_reference ?? null } : null;
  const bundle = compileServicingFile({ loan_id: i.loan_id, transactions: { ledger_entries: i.ledger_entries }, security_instrument: instrument, personnel_notes: { contacts: i.interaction_notes, agent_decisions: i.agent_decisions ?? [] }, data_fields: i.data_fields, documents: i.borrower_documents,
    borrower_submitted_not_applicable_reason: i.borrower_documents.length ? null : "no §1024.35/§1024.41 submissions at boarding (container exists)", compile_ms: i.elapsed_ms, compiled_at: i.compiled_at, requested_by: i.kind });
  const due_on = servicingFileDue(dateOf(i.requested_at));
  const completed_on = dateOf(i.compiled_at);
  const items: CompilationRow["items"] = {
    i: { included: true, count: bundle.sections.i_transactions },
    ii: { included: instrument !== null, count: bundle.sections.ii_security_instrument, ...(instrument ? { status: String(instrument.status), document_ids: [String(instrument.document_id)] } : {}) },
    iii: { included: true, count: bundle.sections.iii_personnel_notes },
    iv: { included: true, count: bundle.sections.iv_data_fields },
    v: { included: bundle.sections.v_borrower_submitted === "not_applicable" ? "not_applicable" : true, count: bundle.sections.v_borrower_submitted === "not_applicable" ? 0 : bundle.sections.v_borrower_submitted },
  };
  const compilation: CompilationRow = { compilation_id: `sfc-${i.loan_id}-${i.kind}-${completed_on}`, loan_id: i.loan_id, kind: i.kind, request_id: i.request_id, requested_at: i.requested_at, completed_at: i.compiled_at, elapsed_seconds: Math.round(i.elapsed_ms / 1000 * 1000) / 1000,
    items, package_document_id: `doc-sfp-${i.loan_id}-${completed_on}-${bundle.sha256.slice(0, 8)}`, package_sha256: bundle.sha256, within_five_days: completed_on <= due_on, due_on };
  const event = append(events, i, "servicing_file.compiled", { compilation_id: compilation.compilation_id, kind: i.kind, request_id: i.request_id, within_five_days: compilation.within_five_days, elapsed_seconds: compilation.elapsed_seconds, items, package_document_id: compilation.package_document_id, sha256: bundle.sha256, security_instrument_status: instrument ? instrument.status : "missing", gaps: bundle.gaps });
  if (i.kind !== "boarding_test" || !s) return { compilation, bundle, event, state: s, item_event: null };
  const missingInstrument = instrument === null;
  if (missingInstrument) return { compilation, bundle, event, state: s, item_event: null };   // (ii) missing is sev-2; HO-019 stays open
  const r = satisfyItem(events, s, "HO-019", { at: i.compiled_at, evidence_event_id: event.id, evidence_document_id: compilation.package_document_id, note: `boarding test compiled in ${compilation.elapsed_seconds}s` });
  return { compilation, bundle, event, state: { handoff: r.handoff, items: r.items }, item_event: r.event };
}

// ============================================================ rule 11 — origination record retention
export type RetentionClass = "regz_le_3y" | "regz_cd_5y" | "regz_atr_3y" | "regz_loc_comp_3y" | "regz_general_2y" | "regb_25m" | "hmda_3y" | "respa_afba_5y" | "respa_s8_5y" | "fdpa_life_of_loan" | "fnma_loan_file_life_plus_4y" | "respa_servicing_1y_post" | "bsa_sar_5y" | "ofac_10y" | "esign_consent_life" | "fnma_accounting_report_18m" | `ron_recording_state_${number}y`;
export type RetentionAnchorEvent = "consummation" | "action_taken_notice" | "hmda_submission" | "afba_execution" | "sar_filing" | "liquidation" | "servicing_transfer" | "discharge" | "compensation_payment" | "ofac_screening" | "ron_session" | "report_filing";
export interface RetentionAnchors { readonly consummation: PlainDate; readonly action_taken_notice?: PlainDate | null; readonly hmda_submission?: PlainDate | null; readonly afba_execution?: PlainDate | null; readonly sar_filing?: PlainDate | null; readonly compensation_payment?: PlainDate | null; readonly ofac_screening?: PlainDate | null; readonly ron_session?: PlainDate | null; readonly ron_state_years?: number | null; readonly liquidation?: PlainDate | null; readonly servicing_transfer?: PlainDate | null; readonly claim_proceeds?: PlainDate | null; }
export interface RetentionRow { readonly document_id: string; readonly kind: string; readonly retention_class: RetentionClass | null; readonly anchor_event: RetentionAnchorEvent | null; readonly anchor_date: PlainDate | null; readonly class_until: PlainDate | null; readonly retention_until: PlainDate | null; readonly governing_class: RetentionClass | null; readonly legal_hold: boolean; readonly jurisdiction_extension_days: number; readonly computed_at: string; readonly rule_version: string; readonly unclassified_reason: string | null; }
/** Document kinds that are part of Fannie Mae's loan file (A2-4.1-02): the later Fannie Mae class governs their `retention_until`. */
export const FNMA_LOAN_FILE_KINDS: ReadonlySet<string> = new Set(["cd", "closing_disclosure", "note", "security_instrument", "deed_of_trust", "mortgage", "title_policy", "appraisal", "1003", "urla", "du_findings", "mi_certificate", "servicing_file_package"]);
interface ClassRule { readonly cls: RetentionClass; readonly anchor: RetentionAnchorEvent; readonly until: (a: PlainDate, x: RetentionAnchors) => PlainDate | null; }
const yrs = (n: number) => (a: PlainDate) => addYears(a, n);
const KIND_RULES: readonly { match: RegExp; rule: (x: RetentionAnchors) => ClassRule }[] = [
  { match: /^(le|loan_estimate|1026_19e_evidence|le_evidence)$/, rule: () => ({ cls: "regz_le_3y", anchor: "consummation", until: yrs(3) }) },
  { match: /^(cd|closing_disclosure)$/, rule: () => ({ cls: "regz_cd_5y", anchor: "consummation", until: yrs(5) }) },
  { match: /^(atr|atr_worksheet|qm_worksheet|du_findings|income_evidence|asset_evidence)$/, rule: () => ({ cls: "regz_atr_3y", anchor: "consummation", until: yrs(3) }) },
  { match: /^(lo_comp|originator_compensation)$/, rule: () => ({ cls: "regz_loc_comp_3y", anchor: "compensation_payment", until: yrs(3) }) },
  { match: /^(regb_|adverse_action|action_taken|reg_b_)/, rule: () => ({ cls: "regb_25m", anchor: "action_taken_notice", until: (a) => addMonths(a, 25) }) },
  { match: /^(hmda|lar_entry)$/, rule: () => ({ cls: "hmda_3y", anchor: "hmda_submission", until: yrs(3) }) },
  { match: /^(afba|affiliated_business)$/, rule: () => ({ cls: "respa_afba_5y", anchor: "afba_execution", until: yrs(5) }) },
  { match: /^(sfhdf|flood_determination)$/, rule: () => ({ cls: "fdpa_life_of_loan", anchor: "consummation", until: () => null }) },
  { match: /^(sar|sar_support)$/, rule: () => ({ cls: "bsa_sar_5y", anchor: "sar_filing", until: yrs(5) }) },
  { match: /^(ofac|ofac_screening)$/, rule: () => ({ cls: "ofac_10y", anchor: "ofac_screening", until: yrs(10) }) },
  { match: /^(esign_consent|e_sign_consent)$/, rule: () => ({ cls: "esign_consent_life", anchor: "consummation", until: () => null }) },
  { match: /^(ron_recording|ron_session_recording)$/, rule: (x) => ({ cls: `ron_recording_state_${x.ron_state_years ?? 0}y` as RetentionClass, anchor: "ron_session", until: (a, y) => (y.ron_state_years ? addYears(a, y.ron_state_years) : null) }) },
  { match: /^(fnma_accounting_report)$/, rule: () => ({ cls: "fnma_accounting_report_18m", anchor: "report_filing", until: (a) => addMonths(a, 18) }) },
  { match: /^(note|security_instrument|deed_of_trust|mortgage|title_policy|appraisal|1003|urla|mi_certificate|servicing_file_package|fnma_loan_purchase_letter)$/, rule: () => ({ cls: "fnma_loan_file_life_plus_4y", anchor: "consummation", until: () => null }) },
];
const anchorDateFor = (ev: RetentionAnchorEvent, x: RetentionAnchors): PlainDate | null => {
  switch (ev) {
    case "consummation": return x.consummation;
    case "action_taken_notice": return x.action_taken_notice ?? null;
    case "hmda_submission": return x.hmda_submission ?? null;
    case "afba_execution": return x.afba_execution ?? null;
    case "sar_filing": return x.sar_filing ?? null;
    case "compensation_payment": return x.compensation_payment ?? null;
    case "ofac_screening": return x.ofac_screening ?? null;
    case "ron_session": return x.ron_session ?? null;
    case "liquidation": return x.liquidation ?? null;
    case "servicing_transfer": return x.servicing_transfer ?? null;
    case "discharge": return x.liquidation ?? null;
    case "report_filing": return null;
  }
};
/** Fannie Mae class value: life of servicing, then four years after the later of payoff and claim proceeds (A2-4.1-02) — null until a liquidation anchor exists. */
export function fnmaLoanFileUntil(x: RetentionAnchors): PlainDate | null { const liq = x.liquidation ?? null; const claim = x.claim_proceeds ?? null; const later = liq && claim ? (claim > liq ? claim : liq) : liq ?? claim; return later ? addYears(later, 4) : null; }
/** §1024.38(c)(1): one year after discharge/transfer — always earlier than the Fannie Mae class. */
export function respaServicingUntil(x: RetentionAnchors): PlainDate | null { const a = x.liquidation ?? x.servicing_transfer ?? null; return a ? addYears(a, 1) : null; }
/** Nothing is purged automatically before Jan 1 of consummation year + 5 (2026 → Jan 1, 2031). */
export function purgeFloor(consummation: PlainDate): PlainDate { return ymd(parts(consummation).y + 5, 1, 1); }
/** Rule 11 / T9: class + anchor per indexed origination document; the longest applicable class governs `retention_until`. */
export function classifyDocument(doc: { document_id: string; kind: string; legal_hold?: boolean; jurisdiction_extension_days?: number }, x: RetentionAnchors, computed_at: string): RetentionRow {
  const hit = KIND_RULES.find((k) => k.match.test(doc.kind));
  const base = { document_id: doc.document_id, kind: doc.kind, legal_hold: doc.legal_hold ?? false, jurisdiction_extension_days: doc.jurisdiction_extension_days ?? 0, computed_at, rule_version: RETENTION_RULE_VERSION };
  if (!hit) return { ...base, retention_class: null, anchor_event: null, anchor_date: null, class_until: null, retention_until: null, governing_class: null, unclassified_reason: `no retention rule for document kind ${JSON.stringify(doc.kind)}` };
  const rule = hit.rule(x);
  const anchor_date = anchorDateFor(rule.anchor, x);
  if (!anchor_date) return { ...base, retention_class: rule.cls, anchor_event: rule.anchor, anchor_date: null, class_until: null, retention_until: null, governing_class: rule.cls, unclassified_reason: `anchor ${rule.anchor} date not yet known` };
  const class_until = rule.until(anchor_date, x);
  const inFnmaFile = FNMA_LOAN_FILE_KINDS.has(doc.kind) || rule.cls === "fnma_loan_file_life_plus_4y";
  const fnma = inFnmaFile ? fnmaLoanFileUntil(x) : null;
  const life = class_until === null || (inFnmaFile && fnma === null);
  const until0 = life ? null : fnma && class_until && fnma > class_until ? fnma : class_until;
  const retention_until = until0 && base.jurisdiction_extension_days ? addDays(until0, base.jurisdiction_extension_days) : until0;
  return { ...base, retention_class: rule.cls, anchor_event: rule.anchor, anchor_date, class_until, retention_until, governing_class: inFnmaFile ? "fnma_loan_file_life_plus_4y" : rule.cls, unclassified_reason: null };
}
export function classifyRetention(events: EventStore, c: HandoffCtx, i: { documents: readonly { document_id: string; kind: string; legal_hold?: boolean; jurisdiction_extension_days?: number }[]; anchors: RetentionAnchors; computed_at: string }): { rows: readonly RetentionRow[]; classified_count: number; unclassified: readonly string[]; gate_open: boolean; purge_floor: PlainDate; events: readonly DomainEvent[] } {
  need(isDate(i.anchors.consummation), "anchors.consummation must be a PlainDate");
  const rows = i.documents.map((d) => classifyDocument(d, i.anchors, i.computed_at));
  const unclassified = rows.filter((r) => r.retention_class === null || r.anchor_date === null).map((r) => r.document_id);
  const classified_count = rows.length - unclassified.length;
  const e1 = append(events, c, "documents.retention.classified", { classified_count, unclassified_count: unclassified.length, unclassified, rule_version: RETENTION_RULE_VERSION, computed_at: i.computed_at });
  const e2 = append(events, c, "retention.schedule.computed", { rows: rows.length, rule_version: RETENTION_RULE_VERSION, purge_floor: purgeFloor(i.anchors.consummation), computed_at: i.computed_at });
  return { rows, classified_count, unclassified, gate_open: unclassified.length === 0, purge_floor: purgeFloor(i.anchors.consummation), events: [e1, e2] };
}
/** Retention rule change: recompute; a shorter period never shortens an existing `retention_until` without compliance sign-off. */
export function recomputeRetention(prev: RetentionRow, next: RetentionRow, complianceSignOff: boolean): RetentionRow {
  if (prev.retention_until && next.retention_until && next.retention_until < prev.retention_until && !complianceSignOff) return { ...next, retention_until: prev.retention_until };
  return next;
}

// ============================================================ rule 10 — timer seeding verification set
export interface SeedFixture { readonly boarded_on: PlainDate; readonly funding_date: PlainDate; readonly consummation_date: PlainDate; readonly first_payment_date: PlainDate; readonly fnma_established_on?: PlainDate | null; readonly purchase_date?: PlainDate | null; readonly late_charge_grace_days: number; readonly policy_expiration?: PlainDate | null; readonly tax_installments: readonly PlainDate[]; readonly hazard_renewal_by?: PlainDate | null; readonly rescission_extended_until?: PlainDate | null; readonly mi?: { scheduled_78_date: PlainDate; midpoint_termination_date: PlainDate; first_annual_disclosure_by: PlainDate } | null; readonly hpml_escrow_min_cancel_date?: PlainDate | null; }
export interface ExpectedSeed { readonly owner: string; readonly code: string; readonly anchor: PlainDate; readonly note: string; }
/** Rule 10: the verification set with the fixture anchors (calendar-correct: Dec 24 skips the Dec 25 holiday; Jan 31, 2027 is a Sunday → Feb 1). */
export function expectedSeedSet(f: SeedFixture, cal: Calendar = servicer): ExpectedSeed[] {
  const yEnd = ymd(parts(f.first_payment_date).y, 12, 31);
  const c = statementCycle(f.first_payment_date, f.late_charge_grace_days);
  const out: ExpectedSeed[] = [
    { owner: "30.2", code: "SM_ORIG_FIRST_STATEMENT_LEAD_15", anchor: addDays(f.first_payment_date, -15), note: "first_payment_date − 15" },
    { owner: "30.2", code: "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE", anchor: addBusinessDays(f.first_payment_date, -5, cal), note: "first_payment_date − 5 business_days_servicer" },
    { owner: "25.4", code: "SM_O64_FIRST_PAYMENT_LETTER_5BD", anchor: addBusinessDays(f.funding_date, 5, cal), note: "funding + 5 BD" },
    { owner: "25.4", code: "SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20", anchor: addDays(f.first_payment_date, -20), note: "first due − 20" },
    { owner: "25.4", code: "SM_O64_1098_SEEDS_AT_BOARDING_GATE", anchor: f.boarded_on, note: "boarding" },
    { owner: "3.1", code: "REGX_1024_17G_INITIAL_STMT_45", anchor: addDays(f.consummation_date, 45), note: "consummation + 45 (satisfied at settlement)" },
    { owner: "3.2", code: "REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45", anchor: addDays(yEnd, -45), note: "computation year end − 45" },
    { owner: "3.2", code: "REGX_1024_17C3_ANNUAL_ANALYSIS_0", anchor: yEnd, note: "computation year end" },
    { owner: "3.3", code: "REGX_1024_17I_ANNUAL_STMT_30", anchor: addDays(yEnd, 30), note: "computation year end + 30" },
    { owner: "3.2", code: "REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL", anchor: ymd(parts(f.first_payment_date).y, 1, 1), note: "computation year start" },
    ...f.tax_installments.map((d, k) => ({ owner: "3.7", code: `ESCROW_BILL_TAX_${k + 1}`, anchor: d, note: "projected escrow_bills pay-by" })),
    ...(f.hazard_renewal_by ? [{ owner: "3.7", code: "ESCROW_BILL_HAZARD_RENEWAL", anchor: f.hazard_renewal_by, note: "hazard renewal paid ≥ 10 days before expiration" }] : []),
    ...(f.fnma_established_on ? [{ owner: "5.1", code: "FNMA_IRM_PERIOD_CLOSE_BD2_1700", anchor: f.fnma_established_on, note: "from loan.fnma_established" }, { owner: "5.1", code: "FNMA_LL202605_EVENT_NEXTBD_0300", anchor: f.fnma_established_on, note: "from loan.fnma_established" }] : []),
    { owner: "7.1", code: "REGZ_1026_41B_STATEMENT_PROMPT_4", anchor: c.statement_due_by, note: "first courtesy end + 4 (no roll)" },
    { owner: "7.1", code: "FNMA_D2_2_03_PAYMENT_REMINDER_20", anchor: ymd(parts(f.first_payment_date).y, parts(f.first_payment_date).m, 20), note: "conditional: first cycle unpaid on the 17th" },
    { owner: "7.1-A", code: "FORM_1098_FURNISH", anchor: rollForward(ymd(parts(f.first_payment_date).y, 1, 31), cal), note: "tax year furnishing (Jan 31 rolled to the next business day)" },
    { owner: "2.x", code: "NOTE_6A_LATE_CHARGE_GRACE_GATE", anchor: addDays(f.first_payment_date, f.late_charge_grace_days), note: "first due + grace (rolls per 2.x)" },
    { owner: "8.1", code: "FNMA_C41_01_METRO2_SNAPSHOT_EOM", anchor: endOfMonth(f.boarded_on), note: "first as_of_date" },
    { owner: "9.1", code: "FNMA_B201_ANNUAL_INSURANCE_REMINDER_365", anchor: addDays(f.boarded_on, 365), note: "loan.boarded + 365" },
    ...(f.policy_expiration ? [{ owner: "9.1", code: "FNMA_B202_POLICY_ANNUAL_VERIFY_365", anchor: addDays(f.boarded_on, 365), note: "policy verified at boarding + 365" }, { owner: "9.1", code: "INS_EXPIRATION_WATCH_60", anchor: addDays(f.policy_expiration, -60), note: "expiration − 60" }, { owner: "9.1", code: "INS_EXPIRATION_LAPSE_1", anchor: f.policy_expiration, note: "expiration" }] : []),
    ...(f.mi ? [{ owner: "10.2", code: "HPA_4902B_AUTO_TERMINATE_0", anchor: f.mi.scheduled_78_date, note: "78% scheduled" }, { owner: "10.3", code: "HPA_4902C_MIDPOINT_TERMINATE_0", anchor: f.mi.midpoint_termination_date, note: "midpoint" }, { owner: "10.4", code: "HPA_4903A3_ANNUAL_DISCLOSURE_12M", anchor: f.mi.first_annual_disclosure_by, note: "first annual from consummation disclosure" }] : []),
    ...(f.hpml_escrow_min_cancel_date ? [{ owner: "23.4", code: "REGZ_1026_35_HPML_ESCROW_5Y", anchor: f.hpml_escrow_min_cancel_date, note: "hpml_escrow_min_cancel_date" }] : []),
    { owner: "25.3", code: "RESCISSION_EXTENDED_WATCH", anchor: f.rescission_extended_until ?? addYears(f.consummation_date, 3), note: "loans.rescission_extended_until" },
    { owner: "28.2", code: "FNMA_D1_3_QC_CYCLE_90", anchor: addDays(endOfMonth(f.funding_date), 90), note: "disbursement-month cohort cycle end" },
    ...(f.purchase_date ? [{ owner: "30.1", code: "SM_FNMA_ESTABLISHMENT_VERIFY_1BD", anchor: f.purchase_date, note: "from loan.purchased" }] : []),
    { owner: "30.4", code: "SM_ORIG_HANDOFF_CLOSE_90", anchor: addDays(f.boarded_on, HANDOFF_WINDOW_DAYS), note: "boarding + 90" },
  ];
  return out;
}
export interface SeededInstance { readonly code: string; readonly anchor_date: PlainDate; readonly created_by?: string | null; }
export interface SeedVerification { readonly ok: boolean; readonly missing: readonly ExpectedSeed[]; readonly misanchored: readonly { expected: ExpectedSeed; actual: PlainDate }[]; readonly matched: number; }
/** HO-021: count and anchors match the expected set (a code seeded on a different anchor is `misanchored`). */
export function verifyTimerSeeding(expected: readonly ExpectedSeed[], seeded: readonly SeededInstance[]): SeedVerification {
  const missing: ExpectedSeed[] = []; const misanchored: { expected: ExpectedSeed; actual: PlainDate }[] = []; let matched = 0;
  for (const e of expected) {
    const rows = seeded.filter((s) => s.code === e.code);
    if (!rows.length) { missing.push(e); continue; }
    if (rows.some((r) => r.anchor_date === e.anchor)) matched++; else misanchored.push({ expected: e, actual: rows[0]!.anchor_date });
  }
  return { ok: missing.length === 0 && misanchored.length === 0, missing, misanchored, matched };
}
/** A missing/mis-anchored instance is created by the agent with `created_by='O11.4_repair'` (provenance on the timer row). */
export function repairTimer(events: EventStore, c: HandoffCtx, r: { code: string; anchor_date: PlainDate; owner: string; reason: string; at: string }): { instance: SeededInstance & { created_by: string; repaired_at: string; owner: string }; event: DomainEvent } {
  nonEmpty(r.code, "code"); need(isDate(r.anchor_date), "anchor_date must be a PlainDate"); nonEmpty(r.reason, "reason");
  const instance = { code: r.code, anchor_date: r.anchor_date, created_by: REPAIR_PROVENANCE, repaired_at: r.at, owner: r.owner };
  const event = append(events, c, "timer.seed.repaired", { code: r.code, anchor_date: r.anchor_date, created_by: REPAIR_PROVENANCE, owner: r.owner, reason: r.reason, repaired_at: r.at });
  return { instance, event };
}
/** HO-021 after verification (and any repairs): `timers.seeding.verified` with the repair list; the item records the repairs. */
export function recordSeedingVerified(events: EventStore, s: HandoffState, v: SeedVerification, repairs: readonly { code: string; anchor_date: PlainDate; created_by: string }[], at: string): HandoffState & { event: DomainEvent; item_event: DomainEvent } {
  need(v.ok || repairs.length >= v.missing.length + v.misanchored.length, "seeding is not verified until every missing/mis-anchored instance is repaired");
  const event = append(events, s.handoff, "timers.seeding.verified", { matched: v.matched, missing: v.missing.map((m) => m.code), misanchored: v.misanchored.map((m) => m.expected.code), repaired: repairs, verified_at: at });
  const r = satisfyItem(events, s, "HO-021", { at, evidence_event_id: event.id, note: repairs.length ? `repairs: ${repairs.map((x) => `${x.code}@${x.anchor_date} (${x.created_by})`).join("; ")}` : "expected set present with fixture anchors" });
  return { handoff: r.handoff, items: r.items, event, item_event: r.event };
}

// ============================================================ rule 12 — closure
export interface CloseInput { readonly as_of: PlainDate; readonly third_statement_sent_on: PlainDate | null; readonly retention_gate_open: boolean; readonly paid_off_on?: PlainDate | null; readonly transferred_on?: PlainDate | null; readonly override?: { officer_decision_id: string; officer_actor: Actor; exceptions: readonly { item_code: string; follow_on_owner: string; note?: string }[] } | null; readonly agent_decision_id?: string | null; }
export type CloseRefusal = "OFFICER_OVERRIDE_REQUIRED" | "RETENTION_GATE_CLOSED" | "NOT_YET_CLOSABLE" | "OVERRIDE_MUST_LIST_OPEN_ITEMS" | "OVERRIDE_REQUIRES_OFFICER";
export interface CloseResult { readonly closed: boolean; readonly refused: CloseRefusal | null; readonly status: HandoffStatus; readonly close_basis: CloseBasis | null; readonly closed_at: PlainDate | null; readonly open_items: readonly string[]; readonly statutory_breaches: readonly string[]; readonly exception_count: number; readonly state: HandoffState; readonly events: readonly DomainEvent[]; readonly timers_kept_running: readonly string[]; }
/** `complete` when every item is satisfied/not_applicable; `complete_with_exceptions` with ≥ 1 breached/waived (rule 12; SM_ORIG_RETENTION_CLASSIFY_GATE refuses `complete`). */
export function handoffCompletion(s: HandoffState, retentionGateOpen: boolean): { status: HandoffStatus; open_items: readonly string[]; exceptions: readonly string[] } {
  const open = s.items.filter((x) => x.status === "pending").map((x) => x.item_code);
  const exceptions = s.items.filter((x) => x.status === "breached" || x.status === "waived").map((x) => x.item_code);
  if (open.length || !retentionGateOpen) return { status: s.handoff.status === "closed" ? "closed" : "open", open_items: [...open, ...(retentionGateOpen ? [] : ["HO-020"])], exceptions };
  return { status: exceptions.length ? "complete_with_exceptions" : "complete", open_items: [], exceptions };
}
/**
 * Rule 12 / T13: close at the earlier of (a) completion + the third statement cycle sent and (b) SM_ORIG_HANDOFF_CLOSE_90; closure
 * with open items needs `close_basis='officer_override'` listing every open item with its follow-on owner (the owner's timer keeps
 * running); payoff/transfer inside the window closes with that basis and marks open items `not_applicable{loan_terminated}`.
 */
export function closeHandoff(events: EventStore, s: HandoffState, i: CloseInput): CloseResult {
  need(isDate(i.as_of), "as_of must be a PlainDate");
  const comp = handoffCompletion(s, i.retention_gate_open);
  const statutory = s.items.filter((x) => x.status === "breached" && HANDOFF_ITEM_DEFS.find((d) => d.code === x.item_code)!.statutory).map((x) => x.item_code);
  const base = (refused: CloseRefusal): CloseResult => ({ closed: false, refused, status: comp.status, close_basis: null, closed_at: null, open_items: comp.open_items, statutory_breaches: statutory, exception_count: comp.exceptions.length, state: { ...s, handoff: { ...s.handoff, status: comp.status } }, events: [], timers_kept_running: [] });
  const terminated = i.paid_off_on && i.paid_off_on <= i.as_of ? "loan_paid_off" : i.transferred_on && i.transferred_on <= i.as_of ? "loan_transferred" : null;
  const out: DomainEvent[] = [];
  let state: HandoffState = s;
  let basis: CloseBasis;
  let exceptions: readonly { item_code: string; follow_on_owner: string; note?: string }[] = [];
  if (terminated) {
    basis = terminated;
    state = { ...s, items: s.items.map((x) => (x.status === "pending" ? { ...x, status: "not_applicable", na_reason: "loan_terminated" } : x)) };
  } else if (comp.open_items.length === 0 && statutory.length === 0 && comp.exceptions.length === 0) {
    if (!(i.third_statement_sent_on && i.third_statement_sent_on <= i.as_of) && i.as_of < s.handoff.close_by) return base("NOT_YET_CLOSABLE");
    basis = "all_items_satisfied";
    out.push(append(events, s.handoff, "servicing_handoff.completed", { handoff_id: s.handoff.handoff_id, completed_at: i.as_of, status: "complete" }));
  } else {
    if (!i.retention_gate_open && !i.override) return base("RETENTION_GATE_CLOSED");
    if (!i.override) return base("OFFICER_OVERRIDE_REQUIRED");
    if (i.override.officer_actor.kind !== "human" || i.override.officer_actor.role !== "officer") return base("OVERRIDE_REQUIRES_OFFICER");
    const listed = new Set(i.override.exceptions.map((e) => e.item_code));
    const must = [...comp.open_items, ...comp.exceptions];
    if (must.some((c) => !listed.has(c))) return base("OVERRIDE_MUST_LIST_OPEN_ITEMS");
    basis = "officer_override"; exceptions = i.override.exceptions;
    out.push(append(events, s.handoff, "servicing_handoff.completed", { handoff_id: s.handoff.handoff_id, completed_at: i.as_of, status: "complete_with_exceptions", exceptions }, i.override.officer_actor));
  }
  const timers_kept_running = exceptions.map((e) => handoffItem(s, e.item_code).timer_code).filter((t): t is string => t !== null);
  const closed: ServicingHandoffRow = { ...state.handoff, status: "closed", closed_at: i.as_of, close_basis: basis, exception_count: exceptions.length || comp.exceptions.length, agent_decision_id: i.agent_decision_id ?? i.override?.officer_decision_id ?? null };
  out.push(append(events, s.handoff, "servicing_handoff.closed", { handoff_id: s.handoff.handoff_id, close_basis: basis, closed_at: i.as_of, exception_count: closed.exception_count, exceptions, follow_on_timers: timers_kept_running, officer_decision_id: i.override?.officer_decision_id ?? null }, basis === "officer_override" ? i.override!.officer_actor : BOARDING_AGENT));
  return { closed: true, refused: null, status: "closed", close_basis: basis, closed_at: i.as_of, open_items: [], statutory_breaches: statutory, exception_count: closed.exception_count, state: { handoff: closed, items: state.items }, events: out, timers_kept_running };
}
/** A post-closure exception referencing the hand-off (Fannie Mae letter never evidenced; an EPD flag later cleared as a posting error) reopens it. */
export function reopenHandoff(events: EventStore, s: HandoffState, r: { reason: string; at: PlainDate }): HandoffState & { event: DomainEvent } {
  need(s.handoff.status === "closed", "only a closed hand-off reopens");
  const event = append(events, s.handoff, "servicing_handoff.reopened", { handoff_id: s.handoff.handoff_id, reason: r.reason, reopened_at: r.at });
  return { handoff: { ...s.handoff, status: "reopened" }, items: s.items, event };
}

// ============================================================ rule 13 — CS_BOARDED_ORIGINATIONS_DAILY
export interface ReportLoan { readonly loan_id: string; readonly servicer_loan_number: string; readonly borrower_name?: string; readonly boarded_on: PlainDate; readonly handoff_status: HandoffStatus; readonly timers: readonly { code: string; due_date: PlainDate | null; status: string }[]; readonly breaches_24h?: readonly { code: string; severity: string | null; owner: string }[]; readonly vendor_rejects?: readonly { vendor_kind: VendorKind; reason: string }[]; readonly compile_test?: { due: PlainDate; status: "satisfied" | "armed" | "breached" } | null; readonly ownership_status: OwnershipNoticeStatus; readonly epd_flags?: readonly { definition: EpdDefinition; raised_on: PlainDate; cleared_on: PlainDate | null }[]; readonly retention_gaps?: number; readonly closing_today?: boolean; readonly override_closure?: boolean; readonly warnings_open?: readonly { rule: string; clear_by: PlainDate }[]; }
export interface DailyReport { readonly kind: typeof DAILY_REPORT_KIND; readonly as_of: PlainDate; readonly population: number; readonly sections: { cohort: Record<string, number>; timer_health: { due_today: Record<string, string[]>; overdue: Record<string, string[]> }; breaches_24h: { loan: string; code: string; severity: string | null; owner: string }[]; epd: { raised: { loan: string; definition: EpdDefinition; on: PlainDate }[]; cleared: { loan: string; definition: EpdDefinition; on: PlainDate }[]; early_warnings: string[] }; ownership_1026_39: Record<OwnershipNoticeStatus, number>; vendor_rejects: Record<string, { loan: string; reason: string }[]>; retention_gaps: string[]; closures: { today: string[]; with_override: string[] }; warnings_beyond_clear: { loan: string; rule: string; clear_by: PlainDate }[] }; readonly hash: string; }
const isoWeek = (d: PlainDate): string => { const dow = (Number(new Date(d + "T00:00:00Z").getUTCDay()) + 6) % 7; const mon = addDays(d, -dow); return `week_of_${mon}`; };
/** Rule 13 / T14: population = every origination with `servicing_handoffs.status ∉ {closed}`; nine sections; hashed payload. */
export function buildBoardedOriginationsReport(asOf: PlainDate, loans: readonly ReportLoan[]): DailyReport {
  need(isDate(asOf), "as_of must be a PlainDate");
  const pop = loans.filter((l) => l.handoff_status !== "closed");
  const cohort: Record<string, number> = {};
  for (const l of pop) { const k = `${isoWeek(l.boarded_on)}|day_${daysBetween(l.boarded_on, asOf)}`; cohort[k] = (cohort[k] ?? 0) + 1; }
  const due_today: Record<string, string[]> = {}; const overdue: Record<string, string[]> = {};
  for (const l of pop) for (const t of l.timers) { if (t.status !== "armed" && t.status !== "breached") continue; if (t.due_date === asOf) (due_today[t.code] ??= []).push(l.servicer_loan_number); else if (t.due_date && t.due_date < asOf) (overdue[t.code] ??= []).push(l.servicer_loan_number); }
  for (const l of pop) if (l.compile_test && l.compile_test.status !== "satisfied" && l.compile_test.due < asOf) (overdue.SM_SERVICING_FILE_COMPILE_TEST_1BD ??= []).push(l.servicer_loan_number);
  const ownership = { not_applicable: 0, expected: 0, sent: 0, evidenced: 0, overdue_unconfirmed: 0, sent_by_sm: 0 } as Record<OwnershipNoticeStatus, number>;
  for (const l of pop) ownership[l.ownership_status]++;
  const vendor_rejects: Record<string, { loan: string; reason: string }[]> = {};
  for (const l of pop) for (const r of l.vendor_rejects ?? []) (vendor_rejects[r.vendor_kind] ??= []).push({ loan: l.servicer_loan_number, reason: r.reason });
  const sections: DailyReport["sections"] = {
    cohort, timer_health: { due_today, overdue },
    breaches_24h: pop.flatMap((l) => (l.breaches_24h ?? []).map((b) => ({ loan: l.servicer_loan_number, ...b }))),
    epd: { raised: pop.flatMap((l) => (l.epd_flags ?? []).filter((f) => f.raised_on === asOf).map((f) => ({ loan: l.servicer_loan_number, definition: f.definition, on: f.raised_on }))), cleared: pop.flatMap((l) => (l.epd_flags ?? []).filter((f) => f.cleared_on === asOf).map((f) => ({ loan: l.servicer_loan_number, definition: f.definition, on: f.cleared_on! }))), early_warnings: pop.filter((l) => (l.epd_flags ?? []).some((f) => f.definition === "sm_watch_p1_6_30" && f.cleared_on === null)).map((l) => l.servicer_loan_number) },
    ownership_1026_39: ownership, vendor_rejects, retention_gaps: pop.filter((l) => (l.retention_gaps ?? 0) > 0).map((l) => l.servicer_loan_number),
    closures: { today: pop.filter((l) => l.closing_today).map((l) => l.servicer_loan_number), with_override: pop.filter((l) => l.override_closure).map((l) => l.servicer_loan_number) },
    warnings_beyond_clear: pop.flatMap((l) => (l.warnings_open ?? []).filter((w) => w.clear_by < asOf).map((w) => ({ loan: l.servicer_loan_number, ...w }))),
  };
  const hash = createHash("sha256").update(JSON.stringify({ as_of: asOf, population: pop.length, sections })).digest("hex");
  return { kind: DAILY_REPORT_KIND, as_of: asOf, population: pop.length, sections, hash };
}
/** The partner `officer` copy: summary only — loan numbers, no NPI (no borrower names, no narrative). */
export function partnerCopy(r: DailyReport): { kind: typeof DAILY_REPORT_KIND; as_of: PlainDate; population: number; loan_numbers_only: true; summary: Record<string, unknown> } {
  const s = r.sections;
  return { kind: r.kind, as_of: r.as_of, population: r.population, loan_numbers_only: true, summary: { cohort: s.cohort, timers_due_today: s.timer_health.due_today, timers_overdue: s.timer_health.overdue, breaches_24h: s.breaches_24h.map((b) => ({ loan: b.loan, code: b.code, severity: b.severity })), epd_raised: s.epd.raised.map((x) => x.loan), epd_cleared: s.epd.cleared.map((x) => x.loan), ownership_1026_39: s.ownership_1026_39, vendor_rejects: Object.fromEntries(Object.entries(s.vendor_rejects).map(([k, v]) => [k, v.map((x) => x.loan)])), retention_gaps: s.retention_gaps, closures: s.closures, warnings_beyond_clear: s.warnings_beyond_clear.map((w) => w.loan) } };
}
/** True when a string carries NPI beyond a loan number (a name, an address, an SSN, a narrative) — the partner copy is checked against it. */
export function containsNpi(text: string, npi: readonly string[]): boolean { return npi.some((n) => n && text.includes(n)); }
/** The 06:00 ET scheduler tick for the daily report (global subject, origination context) — SM_CS_BOARDED_ORIG_REPORT_DAILY's trigger. */
export function dailyReportTick(events: EventStore, date: PlainDate): DomainEvent {
  need(isDate(date), "date must be a PlainDate");
  return events.append({ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, occurredAt: new Date(zonedSix(date)).toISOString(), payload: { cadence: "daily", at: "06:00", tz: "America/New_York", job: DAILY_REPORT_JOB, date, source: "origination" } });
}
const zonedSix = (d: PlainDate): number => Date.parse(`${d}T06:00:00-05:00`) + (isDst(d) ? -3_600_000 : 0);
const isDst = (d: PlainDate): boolean => { const { y } = parts(d); const mar = ymd(y, 3, 8 + ((7 - Number(new Date(`${y}-03-08T00:00:00Z`).getUTCDay())) % 7)); const nov = ymd(y, 11, 1 + ((7 - Number(new Date(`${y}-11-01T00:00:00Z`).getUTCDay())) % 7)); return d >= mar && d < nov; };
/** Publish: `compliance_report.published{kind=boarded_originations_daily}` (the timer's satisfier) with the hash; distribution list per rule 13. */
export function publishDailyReport(events: EventStore, r: DailyReport): { event: DomainEvent; distribution: readonly { to: string; copy: "full" | "partner" }[] } {
  const event = events.append({ type: "compliance_report.published", actor: SENTINEL_AGENT, payload: { kind: r.kind, as_of: r.as_of, population: r.population, hash: r.hash, source: "origination", job: DAILY_REPORT_JOB } });
  return { event, distribution: [{ to: "sm_servicing_lead", copy: "full" }, { to: "partner_officer", copy: "partner" }] };
}

/** Hand-off items as the Metro 2 / statement / investor evidence arrives: map an owner's event to the item it satisfies (rule 1 mirror). */
export function itemForEvent(e: DomainEvent): string | null {
  switch (e.type) {
    case "loan.active": return "HO-001";
    case "ledger.opening_posted": return "HO-002";
    case "notice.sent": return e.payload.template === "NTC_SM_FIRST_PAYMENT_LETTER" ? "HO-003" : null;
    case "escrow.statement.sent": return e.payload.statement_type === "initial" || e.payload.initial === true ? "HO-004" : null;
    case "escrow.line.projected": return "HO-005";
    case "tax_reporting.seeds.handed_off": return "HO-008";
    case "loan.fnma_established": return "HO-010";
    case "investor.first_lar.accepted": return "HO-011";
    case "investor_events.acked": return e.payload.type === "EscrowSetup" ? "HO-012" : null;
    case "custodial.prepurchase_funds.transferred": return "HO-013";
    case "mers.investor.fnma_verified": case "warehouse.interim_funder.removed": return "HO-014";
    case "insurance.policy.verified": return "HO-017";
    case "mi_policy.activated": return "HO-018";
    case "qc.selection.recorded": return "HO-022";
    default: return null;
  }
}
export { D as plainDate };
