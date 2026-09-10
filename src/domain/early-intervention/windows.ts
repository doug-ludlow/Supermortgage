/**
 * §11.1 Live contact / §11.2 Written early intervention notice — Reg X
 * §1024.39 windows per unpaid due date, satisfaction/cancellation rules,
 * the 180/190-day notice cycle, bankruptcy and transferee overlays, and the
 * Fannie Mae D2-2-02 contact cadence.
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";

export type LiveStatus = "open" | "satisfied_live" | "satisfied_good_faith" | "satisfied_ongoing_lossmit" | "cancelled_paid" | "exempt_bk" | "exempt_discharge" | "exempt_investment" | "breached" | "breached_at_boarding";
export type NoticeStatus = "open" | "sent" | "satisfied_by_prior_180" | "cancelled_paid" | "exempt_bk" | "exempt_discharge" | "exempt_investment" | "deferred_transferee" | "breached" | "breached_at_boarding";

export interface Window { readonly due_date: PlainDate; readonly live_due_at: PlainDate; readonly notice_due_at: PlainDate; readonly principal_residence: boolean; live: LiveStatus; notice: NoticeStatus; live_basis?: string; covering_cycle_id?: string; cancel_reason?: string | null; }
export interface Cycle { readonly id: string; readonly provided_on: PlainDate; readonly variant: "standard" | "fdcpa" | "bk"; readonly cycle_end_at: PlainDate; }

export const LIVE_DAYS = 36, NOTICE_DAYS = 45, CYCLE_DAYS = 180, FDCPA_CYCLE_DAYS = 190, BK_NOTICE_DAYS = 45;

export function openWindow(dueDate: PlainDate, o: { principal_residence: boolean; active_cycle?: Cycle | null; bankruptcy?: "none" | "active" | "discharged"; transferor_notice_within_45?: boolean }): Window {
  const w: Window = { due_date: dueDate, live_due_at: addDays(dueDate, LIVE_DAYS), notice_due_at: addDays(dueDate, NOTICE_DAYS), principal_residence: o.principal_residence, live: "open", notice: "open" };
  if (!o.principal_residence) { w.live = "exempt_investment"; w.notice = "exempt_investment"; return w; }
  if (o.bankruptcy === "active") { w.live = "exempt_bk"; w.notice = "exempt_bk"; return w; }
  if (o.bankruptcy === "discharged") { w.live = "exempt_discharge"; w.notice = "exempt_discharge"; return w; }
  if (o.active_cycle && o.active_cycle.cycle_end_at >= w.notice_due_at) { w.notice = "satisfied_by_prior_180"; w.covering_cycle_id = o.active_cycle.id; }
  if (o.transferor_notice_within_45) w.notice = "deferred_transferee";
  return w;
}
export function liveDueMs(w: Window, loanTz: string): number { return zonedEpochMs(w.live_due_at, "23:59", loanTz); }

/** Comment 39(a)-1: paying the missed installment on/before day 36 (45) removes that duty; later payment leaves the obligation standing. */
export function installmentPaid(w: Window, creditedAsOf: PlainDate): void {
  if (w.live === "open" && creditedAsOf <= w.live_due_at) { w.live = "cancelled_paid"; w.cancel_reason = "paid_before_36"; }
  if (w.notice === "open" && creditedAsOf <= w.notice_due_at) { w.notice = "cancelled_paid"; w.cancel_reason = w.cancel_reason ?? "paid_before_45"; }
}
/** 11.1-T24 — a reversal (NSF) re-opens the installment: cancelled legs are reinstated with their original due dates. */
export function reinstateOnReversal(w: Window): { live_reinstated: boolean; notice_reinstated: boolean } {
  const l = w.live === "cancelled_paid", n = w.notice === "cancelled_paid";
  if (l) w.live = "open"; if (n) w.notice = "open"; w.cancel_reason = null;
  return { live_reinstated: l, notice_reinstated: n };
}
/** 11.1-T20 — windows seeded at boarding from the transferor's unpaid due dates; past deadlines are `breached_at_boarding`. */
export function seedWindowsAtBoarding(unpaidDueDates: readonly PlainDate[], boardedOn: PlainDate, principalResidence = true): Window[] {
  return unpaidDueDates.map((d) => { const w = openWindow(d, { principal_residence: principalResidence }); if (w.live === "open" && w.live_due_at < boardedOn) w.live = "breached_at_boarding"; if (w.notice === "open" && w.notice_due_at < boardedOn) w.notice = "breached_at_boarding"; return w; });
}
/** Any qualifying contact/effort dated inside (D, D+36] satisfies every open window containing that date. */
export function applyContact(windows: Window[], contactOn: PlainDate, kind: "live" | "good_faith" | "ongoing_lossmit", basis = "outbound"): Window[] {
  const hit: Window[] = [];
  for (const w of windows) if (w.live === "open" && contactOn > w.due_date && contactOn <= w.live_due_at) { w.live = kind === "live" ? "satisfied_live" : kind === "good_faith" ? "satisfied_good_faith" : "satisfied_ongoing_lossmit"; w.live_basis = basis; hit.push(w); }
  return hit;
}
export function sweep(windows: Window[], today: PlainDate): Window[] {
  const b: Window[] = [];
  for (const w of windows) { if (w.live === "open" && today > w.live_due_at) { w.live = "breached"; b.push(w); } if (w.notice === "open" && today > w.notice_due_at) { w.notice = "breached"; b.push(w); } }
  return b;
}

/** 11.2 rule 3: after a notice, the next required date. */
export function noticeCycle(providedOn: PlainDate, variant: Cycle["variant"], id: string): Cycle { return { id, provided_on: providedOn, variant, cycle_end_at: addDays(providedOn, variant === "fdcpa" ? FDCPA_CYCLE_DAYS : CYCLE_DAYS) }; }
export function nextNoticeDue(c: Cycle, regxDaysDelinquentAtCycleEnd: number, earliestUnpaidDue: PlainDate | null): { due_on: PlainDate; scheduled_on: PlainDate } {
  if (regxDaysDelinquentAtCycleEnd >= 45 || !earliestUnpaidDue) return { due_on: c.cycle_end_at, scheduled_on: addDays(c.cycle_end_at, -2) };
  const fromUnpaid = addDays(earliestUnpaidDue, NOTICE_DAYS);
  const due = c.variant === "fdcpa" && fromUnpaid < c.cycle_end_at ? c.cycle_end_at : fromUnpaid;
  return { due_on: due, scheduled_on: addDays(due, -2) };
}
export function printHandoffDue(noticeDue: PlainDate): PlainDate { return addDays(noticeDue, -2); }
/** §1024.39(c)(1)(iii)(A): one modified notice per case within 45 days of the petition. */
export function bkModifiedNoticeDue(petitionOn: PlainDate, alreadySentForCase: boolean): PlainDate | null { return alreadySentForCase ? null : addDays(petitionOn, BK_NOTICE_DAYS); }
/** Transferee rule: first notice due 45 days after the first post-transfer due date when the transferor noticed within 45 days before transfer. */
export function transfereeFirstNoticeDue(firstPostTransferDue: PlainDate): PlainDate { return addDays(firstPostTransferDue, NOTICE_DAYS); }
export type Variant = Cycle["variant"];
export function variantFor(f: { bk_active: boolean; debt_collector: boolean; cease_active: boolean }): Variant { return f.bk_active ? "bk" : f.debt_collector && f.cease_active ? "fdcpa" : "standard"; }

/** D2-2-02 cadence: first outbound attempt day 17 (policy), then every ≤7 days until a cessation trigger. */
export function cadence(regxDays: number, o: { consent_voice: boolean; suspended?: "bankruptcy" | "cease_request" | "attorney" | "pre_sale" | null; ceased?: string | null }): { attempt: boolean; channel: "ai_voice" | "human_manual_dial" | null; reason?: string } {
  if (o.suspended) return { attempt: false, channel: null, reason: `suspended:${o.suspended}` };
  if (o.ceased) return { attempt: false, channel: null, reason: `ceased:${o.ceased}` };
  if (regxDays < 17) return { attempt: false, channel: null, reason: "grace/pre-day-17" };
  return { attempt: true, channel: o.consent_voice ? "ai_voice" : "human_manual_dial", ...(o.consent_voice ? {} : { reason: "TCPA_64_1200_A1_CELL_CONSENT_GATE" }) };
}
export function bspDueAfterQrpc(qrpcOn: PlainDate): PlainDate { return addBusinessDays(qrpcOn, 3, servicer); }
