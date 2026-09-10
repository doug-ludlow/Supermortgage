/**
 * §17.2 RESPA goodbye notice — operating rules over the §1.3/§17.2 calculators
 * in ./respa.ts, ./batch.ts and ./inbound.ts (all read-only here): the
 * goodbye/combined run plan and the §1024.33(b)(2) exclusion (T9), the
 * transferee-block verification, the machine content check and the four
 * release requirements (T3), the misdirected-payment classification with the
 * forward-or-return-and-notify duty of §1024.33(c)(2) and its emitters (T4/T5/T6),
 * the corrective notice and timer cancellation after a cancelled or moved
 * transfer (T10), the autodraft stop (T8), the short-year statement run (T7),
 * the daily forwarding file, the skip-trace completion, the contact-center
 * readiness gate and the post-transfer sweeps that close the 60-day protection
 * window and the 90-day support window. Supermortgage is the RESPA transferor
 * servicer here (12 U.S.C. 2605(i)(2)–(3)), so every notice is issued in its own
 * name. Every timer-satisfying event the §17.2 registry rows name is emitted by a
 * function in this file (timers-17-2.ts cites them).
 *
 * Defect worked around: ./respa.ts `correctiveNoticeDue` adds 7 calendar days;
 * the §17.2 timer row is "+5 business_days_servicer (policy)" — see
 * `correctiveNotice` below, which uses the servicer calendar.
 */
import { type PlainDate, addDays, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, businessDaysBetween, servicer } from "../../kernel/calendar/business.ts";
import { SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/types.ts";
import type { EventStore } from "../../kernel/events/store.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { contentCheck, noticeDates, respaEffectiveDate, runScheduledOn, protectedPayment, forwardBy, achCancelBy } from "./respa.ts";
import { respaNoticeRequired, type TransferType } from "./batch.ts";
import { masterServicerOnlyExclusion, releaseGate, returnedMail, type NoticeRunStatus } from "./inbound.ts";

export interface Escalation { readonly kind: "officer" | "human_agent"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; }

/** The §17.2 notice family (outputs and artifacts); `renderNotice` refuses anything else. */
export const TRANSFER_OUT_TEMPLATES = ["NTC_REGX_1024_33B_GOODBYE_MS2", "NTC_REGX_1024_33B_COMBINED_MS2", "NTC_REGX_1024_33B_CORRECTIVE", "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR", "NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN"] as const;
export type TransferOutTemplate = (typeof TRANSFER_OUT_TEMPLATES)[number];
/** Timers the goodbye run arms on `transfer.batch.approved{direction=out}`; all are cancelled (with the reason) when the transfer is cancelled or its date moves. */
export const GOODBYE_RUN_TIMERS = ["REGX_1024_33B3_GOODBYE_15", "REGX_1024_33B3_COMBINED_15", "SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20", "SM_XFER_OUT_AUTODRAFT_STOP_T0"] as const;
export const SUPPORT_WINDOW_DAYS = 90;   // decision 3: toll-free number and forwarding for 90 days (contract), then referral only
export const PROTECTION_WINDOW_DAYS = 60; // §1024.33(c)(1): the 60-day period beginning on the effective date
export const CONTACT_SCRIPT_VERSION = "transfer_out.v1";
export const SCRIPTS_LIVE_DAYS_BEFORE = 15; // prerequisites: toll-free number and IVR/AI scripts live by T-15; transfer banner from T-15

const AGG = (id: string) => ({ kind: "transfer_batch", id });
const isOfficer = (a: Actor | null | undefined): boolean => !!a && a.kind === "human" && a.role === "officer";
/** A date-anchored act happens mid-morning Eastern, so the engine anchors on the same civil date. */
const at = (d: PlainDate): string => `${d}T15:00:00.000Z`;
const seen = (events: EventStore, type: string, batchId: string): DomainEvent | undefined => events.ofType(type).find((e) => e.aggregate?.kind === "transfer_batch" && e.aggregate.id === batchId);

// ============================================================ dates (rule 1, worked examples)
/** Rule 1: `respa_effective_date` (conservative override when the 1st is not a Fannie Mae business day) and every date the goodbye run and the transferor's post-transfer duties hang on. */
export function goodbyeTiming(transferDate: PlainDate, installmentsDueOn1st: boolean): { transfer_date: PlainDate; respa_effective_date: PlainDate; goodbye_due: PlainDate; run_scheduled_on: PlainDate; transferee_data_due: PlainDate; scripts_live_by: PlainDate; transferor_stops: PlainDate; transferee_starts: PlainDate; window_end: PlainDate; short_year_due: PlainDate; short_year_mailed_by: PlainDate; ach_cancel_by: PlainDate; support_window_end: PlainDate } {
  const eff = respaEffectiveDate(transferDate, installmentsDueOn1st); const d = noticeDates(eff);
  return { transfer_date: transferDate, respa_effective_date: eff, goodbye_due: d.goodbye_due, run_scheduled_on: runScheduledOn(d.goodbye_due), transferee_data_due: addDays(eff, -20), scripts_live_by: addDays(transferDate, -SCRIPTS_LIVE_DAYS_BEFORE), transferor_stops: d.transferor_stops, transferee_starts: d.transferee_starts, window_end: d.window_end, short_year_due: d.short_year_statement_due, short_year_mailed_by: runScheduledOn(d.short_year_statement_due), ach_cancel_by: achCancelBy(transferDate), support_window_end: addDays(transferDate, SUPPORT_WINDOW_DAYS) };
}

// ============================================================ T9 — plan the run or record the (b)(2) exclusion
export interface PlanInput { readonly batch_id: string; readonly type: TransferType; readonly transfer_date: PlainDate; readonly installments_due_on_1st: boolean; readonly notice_mode: "separate" | "combined"; readonly unchanged: { payee: boolean; address: boolean; account: boolean; amount: boolean }; readonly officer: Actor | null; readonly exception_basis?: "termination_for_cause" | "bankruptcy" | "fdic" | "ncua" | null; readonly exception_confirmed_by?: Actor | null; }
export interface PlannedRun { readonly batch_id: string; readonly kind: "goodbye" | "combined"; readonly status: "planned"; readonly template: "NTC_REGX_1024_33B_GOODBYE_MS2" | "NTC_REGX_1024_33B_COMBINED_MS2"; readonly respa_effective_date: PlainDate; readonly due: PlainDate; readonly scheduled_on: PlainDate; readonly deadline_rule: "§1024.33(b)(3)(i) −15" | "§1024.33(b)(3)(ii) +30"; readonly timer: "REGX_1024_33B3_GOODBYE_15" | "REGX_1024_33B3_COMBINED_15" | "REGX_1024_33B3_EXCEPTION_30"; }
/** Rule: a `master_change_sub_retained` batch with no change in payee/address/account/amount owes no notice (§1024.33(b)(2)(i)(C)) — the exclusion is an officer record, never silence; a sale with a payee change gets a run. The (b)(3)(ii) 30-day exception is available only to a `fnma_directed` for-cause termination and needs an officer confirmation of the basis. */
export function planGoodbyeRun(i: PlanInput): { run: PlannedRun | null; exclusion_record: { batch_id: string; basis: string; approved_by: string; rule: "§1024.33(b)(2)" } | null; block: string | null } {
  if (!respaNoticeRequired(i.type, i.unchanged)) {
    const x = masterServicerOnlyExclusion(i.unchanged, i.officer);
    return { run: null, exclusion_record: x.exclusion_record ? { batch_id: i.batch_id, basis: x.exclusion_record.basis, approved_by: x.exclusion_record.approved_by, rule: "§1024.33(b)(2)" } : null, block: x.block };
  }
  const t = goodbyeTiming(i.transfer_date, i.installments_due_on_1st);
  if (i.exception_basis) {
    if (i.type !== "fnma_directed" || i.exception_basis !== "termination_for_cause") return { run: null, exclusion_record: null, block: `§1024.33(b)(3)(ii) does not apply to a ${i.type} transfer on basis ${i.exception_basis}: the only Section 17 case is a fnma_directed for-cause termination of the partner or of Supermortgage's contract — the −15 day goodbye applies` };
    if (!isOfficer(i.exception_confirmed_by ?? null)) return { run: null, exclusion_record: null, block: `§1024.33(b)(3)(ii) ${i.exception_basis}: the platform requires officer confirmation that the basis is met before relying on it` };
    return { run: { batch_id: i.batch_id, kind: "goodbye", status: "planned", template: "NTC_REGX_1024_33B_GOODBYE_MS2", respa_effective_date: t.respa_effective_date, due: addDays(t.respa_effective_date, 30), scheduled_on: runScheduledOn(addDays(t.respa_effective_date, 30)), deadline_rule: "§1024.33(b)(3)(ii) +30", timer: "REGX_1024_33B3_EXCEPTION_30" }, exclusion_record: null, block: null };
  }
  const kind = i.notice_mode === "combined" ? "combined" : "goodbye";
  return { run: { batch_id: i.batch_id, kind, status: "planned", template: kind === "combined" ? "NTC_REGX_1024_33B_COMBINED_MS2" : "NTC_REGX_1024_33B_GOODBYE_MS2", respa_effective_date: t.respa_effective_date, due: t.goodbye_due, scheduled_on: t.run_scheduled_on, deadline_rule: "§1024.33(b)(3)(i) −15", timer: kind === "combined" ? "REGX_1024_33B3_COMBINED_15" : "REGX_1024_33B3_GOODBYE_15" }, exclusion_record: null, block: null };
}

/** The −15-day clocks a §1024.33(b)(3)(ii) reliance replaces: the goodbye/combined deadline and its T−20 transferee-data milestone. */
export const EXCEPTION_B3II_SUPERSEDED_TIMERS = ["REGX_1024_33B3_GOODBYE_15", "REGX_1024_33B3_COMBINED_15", "SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20"] as const;
/**
 * Relying on §1024.33(b)(3)(ii) on the live engine. The registry trigger `transfer.batch.approved{direction=out}` is unconditional, so a
 * `fnma_directed` for-cause approval arms `REGX_1024_33B3_GOODBYE_15` (−15) next to `REGX_1024_33B3_EXCEPTION_30` (+30) and the −15 clock
 * would breach sev 1 → officer on T−14 although the exception applies (breach column: 'transfer date slips one month unless (b)(3)(ii)
 * applies'). Once the officer has confirmed the basis (planGoodbyeRun → timer REGX_1024_33B3_EXCEPTION_30) the −15 clock and its T−20
 * data milestone are cancelled with reason `exception_b3ii` and `transfer.notice.exception_relied` records the reliance with the
 * officer's decision; the +30 clock stays armed. Nothing is cancelled without the officer.
 */
export function relyOnExceptionB3ii(engine: TimerEngine, events: EventStore, i: { batch_id: string; basis: "termination_for_cause"; confirmed_by: Actor | null; decision_id?: string | null; on?: PlainDate | null }, actor: Actor): { cancelled: { code: string; timer_id: string; reason: "exception_b3ii" }[]; event: DomainEvent } {
  if (!isOfficer(i.confirmed_by)) throw new RangeError("§1024.33(b)(3)(ii): the platform requires officer confirmation that the basis is met before relying on it");
  const codes = new Set<string>(EXCEPTION_B3II_SUPERSEDED_TIMERS);
  const cancelled: { code: string; timer_id: string; reason: "exception_b3ii" }[] = [];
  for (const t of engine.forSubject("transfer_batch", i.batch_id)) if ((t.status === "armed" || t.status === "breached") && codes.has(t.code)) { engine.cancel(t.id, "exception_b3ii", actor); cancelled.push({ code: t.code, timer_id: t.id, reason: "exception_b3ii" }); }
  const event = events.append({ type: "transfer.notice.exception_relied", aggregate: AGG(i.batch_id), actor, ...(i.on ? { occurredAt: at(i.on) } : {}), payload: { batch_id: i.batch_id, rule: "§1024.33(b)(3)(ii)(A)", basis: i.basis, confirmed_by: i.confirmed_by!.id, decision_id: i.decision_id ?? null, timers_cancelled: cancelled.map((c) => c.code), retained: "REGX_1024_33B3_EXCEPTION_30" } });
  return { cancelled, event };
}

// ============================================================ transferee block (T-20), content check and release (T3)
export interface TransfereeBlock { readonly name?: string | null; readonly address?: string | null; readonly tollfree?: string | null; readonly remittance_address?: string | null; readonly payment_start_date?: PlainDate | null; readonly optional_insurance_statement?: string | null; readonly autodraft_enrollment_instructions?: string | null; }
const TOLLFREE = /^(\(\d{3}\) \d{3}-\d{4}|\d{3}-\d{3}-\d{4}|1-8\d{2}-\d{3}-\d{4})$/;
/** Prerequisite: the transferee's notice data (name, remittance address, toll-free number, payment start date, optional-insurance statement) received and verified by T-20; a verified block emits `transferee.notice_data.verified`. */
export function verifyTransfereeBlock(b: TransfereeBlock, expectedStart: PlainDate | null = null): { ok: boolean; missing: string[]; event: "transferee.notice_data.verified" | null } {
  const missing: string[] = [];
  if (!b.name) missing.push("name"); if (!b.address) missing.push("address"); if (!b.remittance_address) missing.push("remittance_address");
  if (!b.tollfree || !TOLLFREE.test(b.tollfree)) missing.push("tollfree");
  if (!b.payment_start_date) missing.push("payment_start_date"); else if (expectedStart && b.payment_start_date !== expectedStart) missing.push(`payment_start_date≠${expectedStart}`);
  if (b.optional_insurance_statement === undefined || b.optional_insurance_statement === null) missing.push("optional_insurance_statement");
  return { ok: missing.length === 0, missing, event: missing.length === 0 ? "transferee.notice_data.verified" : null };
}
/**
 * Machine content check (rule "Notice content (machine-checked before release)"): which of the nine required items a
 * rendered MS-2 notice actually carries, read from the payload the renderer consumed ((i) effective date, (ii)/(iii) the two
 * contact blocks and toll-free numbers, (iv) stop/start dates, (v) the optional-insurance paragraph) and from the rendered
 * text for the template-fixed sentences ((vi) servicing-terms-only; the MS-2 60-day sentence). Nothing is taken on assertion.
 */
export function contentPresentFromPayload(p: Record<string, unknown>, renderedText: string | null = null): string[] {
  const has = (...keys: string[]) => keys.every((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");
  const tollfree = (k: string) => typeof p[k] === "string" && TOLLFREE.test(p[k] as string);
  const present: string[] = [];
  if (has("effective_date")) present.push("effective_date");
  if (has("transferee_name", "transferee_address")) present.push("transferee_block");
  if (has("transferor_name", "transferor_address")) present.push("transferor_block");
  if (tollfree("transferor_tollfree")) present.push("transferor_tollfree");
  if (tollfree("transferee_tollfree")) present.push("transferee_tollfree");
  if (has("transferor_stop_date", "transferee_start_date")) present.push("stop_start_dates");
  if (p.optional_insurance === false || (p.optional_insurance === true && has("optional_insurance_action"))) present.push("insurance_paragraph");
  if (renderedText && /does not affect any term or condition of the mortgage documents/i.test(renderedText)) present.push("servicing_terms_only");
  if (renderedText && /60-day period following the effective date/i.test(renderedText)) present.push("ms2_60_day_sentence");
  return present;
}

export interface ReleaseInput { readonly run_id: string; readonly status: NoticeRunStatus; readonly kind: "goodbye" | "combined" | "corrective"; readonly notices: readonly { id: string; loan_id?: string | null; content_present: readonly string[]; address_valid: boolean }[]; readonly transferee_block_verified: boolean; readonly contact_center_ready: boolean; readonly loan_list_frozen: boolean; readonly officer_authorization: Actor | null;
  /** The frozen list (17.1 `transfer.loan_list.attested`): when given, every loan on it needs a checked, address-validated notice on the run — `notice.mailed` must cover "every loan on the frozen list" (REGX_1024_33B3_GOODBYE_15). */
  readonly frozen_loan_ids?: readonly string[] | null; }
/** State machine: only a `qc_passed` run releases (`planned` → `rendered` → `qc_passed` → `released_to_vendor`), and release requires (a) the transferee's notice block verified, (b) `SM_TOLLFREE_LIVE_GATE`, (c) the frozen list, (d) `officer` authorization — plus the machine-checked content of every rendered notice. A missing transferee toll-free number is required content (§1024.33(b)(4)(ii)): release is refused and the partner is chased. */
export function releaseTransferOutRun(i: ReleaseInput): { ok: boolean; run_id: string; refusals: string[]; required_content_missing: Record<string, string[]>; frozen_uncovered: string[]; escalation: Escalation | null; released_status: "released_to_vendor" | null } {
  const missing: Record<string, string[]> = {};
  for (const n of i.notices) { const m = contentCheck(n.content_present).missing; if (m.length) missing[n.id] = m; }
  const g = releaseGate({ status: i.status, kind: i.kind, transferor_authorization_on_file: isOfficer(i.officer_authorization), notices: i.notices.map((n) => ({ id: n.id, checklist_missing: missing[n.id] ?? [], address_valid: n.address_valid })) });
  const refusals = g.reasons.filter((r) => !r.startsWith("run is ")).map((r) => (r.startsWith("goodbye run needs") ? "release needs the Supermortgage officer's authorization (transferor of record; the partner is copied, not a signatory)" : r));
  if (i.status !== "qc_passed") refusals.unshift(`run is ${i.status}: only a qc_passed run releases (planned → rendered → qc_passed → released_to_vendor)`);
  if (i.notices.length === 0) refusals.push("no rendered notices with checklist results on file for the run");
  if (i.kind !== "corrective" && !i.transferee_block_verified) refusals.push("transferee notice block not verified (SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20)");
  if (!i.contact_center_ready) refusals.push("SM_TOLLFREE_LIVE_GATE closed: no contact_center.ready — toll-free number and IVR/AI scripts must be live");
  if (!i.loan_list_frozen) refusals.push("frozen list missing: transfer.loan_list.attested (17.1) not recorded");
  const covered = new Set(i.notices.filter((n) => n.loan_id && !(missing[n.id]?.length) && n.address_valid).map((n) => n.loan_id as string));
  const uncovered = i.frozen_loan_ids ? i.frozen_loan_ids.filter((l) => !covered.has(l)) : [];
  if (i.frozen_loan_ids && i.frozen_loan_ids.length === 0) refusals.push("frozen list is empty: no loan to notify");
  if (uncovered.length) refusals.push(`frozen list: no checked, address-validated notice on the run for ${uncovered.join(", ")} (notice.mailed must cover every loan on the frozen list)`);
  const tollfreeMissing = Object.entries(missing).filter(([, m]) => m.includes("transferee_tollfree")).map(([id]) => id);
  const escalation: Escalation | null = tollfreeMissing.length ? { kind: "officer", severity: "sev2", reason: `transferee toll-free number missing on ${tollfreeMissing.join(", ")} — required content §1024.33(b)(4)(ii); transfer agent chases the partner/transferee` } : null;
  return { ok: refusals.length === 0, run_id: i.run_id, refusals, required_content_missing: missing, frozen_uncovered: uncovered, escalation, released_status: refusals.length === 0 ? "released_to_vendor" : null };
}

/** SM_TOLLFREE_LIVE_GATE (evaluator `1.3.tollFreeAndIvrDisclosureLive`): the Supermortgage toll-free number and the IVR/AI scripts (with the automation disclosure) verified live by T-15 — `contact_center.ready` is emitted for the batch only when both facts hold. */
export function contactCenterReady(events: EventStore, batchId: string, facts: { toll_free_live: boolean; ivr_ai_disclosure_verified: boolean; tollfree?: string | null; script_version?: string | null }, on: PlainDate, actor: Actor = SYSTEM): { ready: boolean; missing: string[]; event: DomainEvent | null } {
  const missing = [!facts.toll_free_live ? "toll_free_live" : null, !facts.ivr_ai_disclosure_verified ? "ivr_ai_disclosure_verified" : null].filter((x): x is string => x !== null);
  if (missing.length) return { ready: false, missing, event: null };
  const event = events.append({ type: "contact_center.ready", aggregate: AGG(batchId), actor, occurredAt: at(on), payload: { batch_id: batchId, toll_free_live: true, ivr_ai_disclosure_verified: true, tollfree: facts.tollfree ?? null, script_version: facts.script_version ?? CONTACT_SCRIPT_VERSION, verified_on: on } });
  return { ready: true, missing: [], event };
}

// ============================================================ misdirected payments (T4/T5/T6, §1024.33(c))
export type Instrument = "check" | "ach" | "card" | "wire" | "cash";
export interface LedgerLine { readonly account: string; readonly side: "debit" | "credit"; readonly amount_cents: bigint; readonly rule_ref: string; }
export interface MisdirectedInput {
  readonly payment_id: string; readonly loan_id: string; readonly received_on: PlainDate; readonly due_date: PlainDate; readonly grace_days: number; readonly respa_effective_date: PlainDate;
  readonly amount_cents: bigint; readonly instrument: Instrument; readonly forwardable: boolean; readonly forward_block_reason?: string | null;
  readonly transferee: { name: string; remittance_address: string; tollfree: string };
  /** The date the disposition (wire / return) happens; default = the +1 business-day "promptly" date. */
  readonly disposed_on?: PlainDate | null;
  /** The officer's decision row (`agent_decisions`) authorising a return rather than a forward — never fabricated here. */
  readonly officer_decision?: { id: string; by: Actor } | null;
}
export interface MisdirectedResult {
  readonly payment_id: string; readonly protected: boolean; readonly credited_as_of: PlainDate; readonly window_end: PlainDate; readonly day_of_window: number; readonly forward_by: PlainDate;
  readonly disposed_on: PlainDate; readonly business_days_since_receipt: number; readonly prompt: boolean;
  readonly disposition: "forwarded" | "returned_to_payor"; readonly forwarding_file_on: PlainDate | null; readonly receipt_date_in_file: PlainDate;
  readonly return_notice: { template: "NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN"; payload: Record<string, unknown> } | null;
  readonly satisfies: "misdirected_payment.forwarded" | "misdirected_payment.returned"; readonly events: readonly string[]; readonly escalation: Escalation | null; readonly block: string | null;
  readonly ledger: { on_receipt: readonly LedgerLine[]; on_disposition: readonly LedgerLine[] }; readonly posted_to_loan_ledger: false;
}
/** Protected-payment rule (transferor view) and the (c)(2) duty: forwarding with the receipt date is the default; return-to-payor only when the instrument cannot be negotiated or forwarded, always with `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` and an officer decision. Funds move through `transfer_out_clearing`; nothing posts to the transferred loan's ledger. */
export function misdirectedPayment(i: MisdirectedInput): MisdirectedResult {
  const p = protectedPayment(i.received_on, i.due_date, i.grace_days, i.respa_effective_date);
  const windowEnd = addDays(i.respa_effective_date, PROTECTION_WINDOW_DAYS - 1); const day = daysBetween(i.respa_effective_date, i.received_on) + 1;
  const fwd = forwardBy(i.received_on); const disposedOn = i.disposed_on ?? fwd;
  const bd = businessDaysBetween(i.received_on, disposedOn, servicer);
  const rule = "17.2 money handling (§1024.33(c)(2))";
  const onReceipt: LedgerLine[] = [{ account: "custodial_pi_cash:transfer_out_clearing", side: "debit", amount_cents: i.amount_cents, rule_ref: rule }, { account: "due_to_transferee", side: "credit", amount_cents: i.amount_cents, rule_ref: rule }];
  const onDisposition: LedgerLine[] = [{ account: "due_to_transferee", side: "debit", amount_cents: i.amount_cents, rule_ref: rule }, { account: "custodial_pi_cash:transfer_out_clearing", side: "credit", amount_cents: i.amount_cents, rule_ref: rule }];
  const base = { payment_id: i.payment_id, protected: p.protected, credited_as_of: p.credited_as_of, window_end: windowEnd, day_of_window: day, forward_by: fwd, disposed_on: disposedOn, business_days_since_receipt: bd, prompt: bd <= 1, receipt_date_in_file: i.received_on, ledger: { on_receipt: onReceipt, on_disposition: onDisposition }, posted_to_loan_ledger: false as const };
  if (i.forwardable) return { ...base, disposition: "forwarded", forwarding_file_on: disposedOn, return_notice: null, satisfies: "misdirected_payment.forwarded", events: ["payment.misdirected.received", "payment.misdirected.forwarded"], escalation: null, block: null };
  const reason = i.forward_block_reason ?? "the instrument cannot be negotiated or forwarded";
  const decision = i.officer_decision && isOfficer(i.officer_decision.by) ? i.officer_decision.id : null;
  const escalation: Escalation = { kind: "officer", reason: `return rather than forward: ${reason} (17.2 decision 2 — forwarding is the default; return is an officer decision)` };
  const payload = { notice_date: disposedOn, transferee_name: i.transferee.name, transferee_remittance_address: i.transferee.remittance_address, transferee_tollfree: i.transferee.tollfree, received_on: i.received_on, amount_cents: i.amount_cents, instrument_label: i.instrument, effective_date: i.respa_effective_date, transferor_stop_date: addDays(i.respa_effective_date, -1), protected: p.protected, disposition: "returned_to_payor", return_reason: reason, business_days_since_receipt: bd, officer_approval_decision_id: decision };
  return { ...base, disposition: "returned_to_payor", forwarding_file_on: null, return_notice: { template: "NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN", payload }, satisfies: "misdirected_payment.returned", events: ["payment.misdirected.received", "payment.misdirected.returned"], escalation, block: decision ? null : "return-to-payor needs an officer decision (agent_decisions row); forward by default" };
}
/** Cashiering intake of a post-transfer receipt: `payment.received{loan.status='transferred_out', received_at}` arms `SM_1024_33C2_FORWARD_PROMPT_1` on the loan (+1 servicer BD from `received_at`) and the loan event `payment.misdirected.received` is recorded; funds go to `transfer_out_clearing` (ledger on the result), never to the loan. */
export function receiveMisdirectedPayment(events: EventStore, i: MisdirectedInput, actor: Actor): { classification: MisdirectedResult; receipt_event: DomainEvent } {
  const r = misdirectedPayment(i);
  const e = events.append({ type: "payment.received", loanId: i.loan_id, actor, occurredAt: at(i.received_on), payload: { payment_id: i.payment_id, loan: { status: "transferred_out" }, loan_status: "transferred_out", received_by: "supermortgage", received_at: i.received_on, amount_cents: i.amount_cents, instrument: i.instrument, respa_effective_date: i.respa_effective_date, protected: r.protected, day_of_window: r.day_of_window, forward_by: r.forward_by, clearing: "transfer_out_clearing" } });
  events.append({ type: "payment.misdirected.received", loanId: i.loan_id, actor, occurredAt: at(i.received_on), causationId: e.id, payload: { payment_id: i.payment_id, received_at: i.received_on, protected: r.protected, credited_as_of: r.credited_as_of, amount_cents: i.amount_cents, ledger: r.ledger.on_receipt } });
  return { classification: r, receipt_event: e };
}
/** The (c)(2) disposition: `misdirected_payment.forwarded` (wire + detail file) or `misdirected_payment.returned` (instrument returned with `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN`) — the events `SM_1024_33C2_FORWARD_PROMPT_1` is satisfied by — plus the loan events `payment.misdirected.forwarded/returned`. A return is emitted only with its notice id and only after the officer decision the classification recorded. */
export function disposeMisdirectedPayment(events: EventStore, r: MisdirectedResult, i: { loan_id: string; disposed_on?: PlainDate | null; forward_reference?: string | null; return_notice_id?: string | null }, actor: Actor): DomainEvent {
  if (r.block) throw new RangeError(r.block);
  const on = i.disposed_on ?? r.disposed_on;
  if (r.disposition === "returned_to_payor" && !i.return_notice_id) throw new RangeError("a return to the payor is emitted only with its NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN notice id (§1024.33(c)(2)(ii): notify the payor of the proper recipient)");
  const type = r.disposition === "forwarded" ? "misdirected_payment.forwarded" : "misdirected_payment.returned";
  const e = events.append({ type, loanId: i.loan_id, actor, occurredAt: at(on), payload: { payment_id: r.payment_id, disposition: r.disposition, receipt_date: r.receipt_date_in_file, protected: r.protected, credited_as_of: r.credited_as_of, disposed_on: on, forwarding_file_on: r.disposition === "forwarded" ? on : null, forward_reference: i.forward_reference ?? null, return_notice_id: i.return_notice_id ?? null, ledger: r.ledger.on_disposition } });
  events.append({ type: r.disposition === "forwarded" ? "payment.misdirected.forwarded" : "payment.misdirected.returned", loanId: i.loan_id, actor, occurredAt: at(on), causationId: e.id, payload: { payment_id: r.payment_id, receipt_date: r.receipt_date_in_file, disposed_on: on } });
  return e;
}

// ============================================================ daily forwarding file (SM_XFER_OUT_FORWARD_FILE_DAILY)
export interface ForwardedPayment { readonly payment_id: string; readonly loan_id: string; readonly borrower: string; readonly received_on: PlainDate; readonly amount_cents: bigint; readonly instrument: Instrument; readonly image_reference: string | null; readonly protected: boolean; readonly forwarding_file_on: PlainDate | null; }
export interface PostTransferRefund { readonly debit_id: string; readonly loan_id: string; readonly settled_on: PlainDate; readonly amount_cents: bigint; readonly refund_by: PlainDate; }
/** Integrations: the daily `misdirected_payments.csv` + wire to the transferee's custodial account — every payment forwarded on `on` with its Supermortgage receipt date (loan, borrower, receipt date, amount, instrument, image reference), plus any post-T debit refunds reported in the same file. */
export function forwardingFile(batchId: string, on: PlainDate, payments: readonly ForwardedPayment[], refunds: readonly PostTransferRefund[] = []): { file_id: string; batch_id: string; file_date: PlainDate; rows: { loan_id: string; borrower: string; receipt_date: PlainDate; amount_cents: bigint; instrument: Instrument; image_reference: string | null; protected: boolean }[]; refunds: readonly PostTransferRefund[]; wire_total_cents: bigint; satisfies: "transferee.forward_file.acked" } {
  const rows = payments.filter((p) => p.forwarding_file_on === on).map((p) => ({ loan_id: p.loan_id, borrower: p.borrower, receipt_date: p.received_on, amount_cents: p.amount_cents, instrument: p.instrument, image_reference: p.image_reference, protected: p.protected }));
  return { file_id: `fwd-${batchId}-${on}`, batch_id: batchId, file_date: on, rows, refunds, wire_total_cents: rows.reduce((s, r) => s + r.amount_cents, 0n), satisfies: "transferee.forward_file.acked" };
}
/**
 * The transferee's acknowledgment of a forwarding file (SFTP inbound): validated against the file id the platform built for the batch
 * (`fwd-<batch>-<date>`, forwardingFile), then `transferee.forward_file.acked` on the batch — the event `SM_XFER_OUT_FORWARD_FILE_DAILY`
 * is satisfied by. The row is `recurring`: the engine satisfies the day's instance and re-arms the next servicer-business-day recurrence
 * from the ack (TimerEngine.onEvent iterates a snapshot of its instances, so the re-armed instance is not re-satisfied by the same
 * ack); the day-90 sweep (postTransferSweep) cancels the recurrence. An ack for a file the platform never built is refused.
 */
export function recordForwardFileAck(events: EventStore, batchId: string, fileId: string, ackedOn: PlainDate, actor: Actor = { kind: "external", id: "transferee" }): DomainEvent {
  if (!new RegExp(`^fwd-${batchId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}$`).test(fileId)) throw new RangeError(`${fileId} is not a forwarding file of batch ${batchId} (fwd-<batch>-<date>, forwardingFile)`);
  return events.append({ type: "transferee.forward_file.acked", aggregate: AGG(batchId), actor, occurredAt: at(ackedOn), payload: { batch_id: batchId, file_id: fileId, acked_on: ackedOn } });
}

// ============================================================ autodraft stop (T8)
export interface ScheduledDebit { readonly id: string; readonly loan_id?: string; readonly settlement_date: PlainDate; /** set once the ODFI reports the debit settled (a debit that settles on/after T is a missed Nacha window) */ readonly settled_on?: PlainDate | null; readonly amount_cents?: bigint; }
/** Rule: the last Supermortgage-originated debit is the one whose settlement date < T; debits with settlement ≥ T are cancelled at T−3 BD; any that settles on/after T is refunded within 1 business day and reported in the forwarding file (QA finding). */
export function autodraftStop(transferDate: PlainDate, scheduled: readonly ScheduledDebit[]): { cancel_by: PlainDate; cancel: string[]; keep: string[]; last_supermortgage_debit: PlainDate | null; satisfies: "autodraft.schedule.terminated"; settled_on_or_after_t: { id: string; loan_id: string | null; settled_on: PlainDate; amount_cents: bigint; refund_by: PlainDate; report_in_forwarding_file: true; qa_finding: true }[] } {
  const cancel = scheduled.filter((s) => s.settlement_date >= transferDate); const keep = scheduled.filter((s) => s.settlement_date < transferDate);
  const last = keep.map((k) => k.settlement_date).sort().at(-1) ?? null;
  const settled = scheduled.filter((s): s is ScheduledDebit & { settled_on: PlainDate } => !!s.settled_on && s.settled_on >= transferDate).map((s) => ({ id: s.id, loan_id: s.loan_id ?? null, settled_on: s.settled_on, amount_cents: s.amount_cents ?? 0n, ...postTransferDebitRefund(s.settled_on) }));
  return { cancel_by: achCancelBy(transferDate), cancel: cancel.map((c) => c.id), keep: keep.map((k) => k.id), last_supermortgage_debit: last, satisfies: "autodraft.schedule.terminated", settled_on_or_after_t: settled };
}
export function postTransferDebitRefund(settledOn: PlainDate): { refund_by: PlainDate; report_in_forwarding_file: true; qa_finding: true } { return { refund_by: addBusinessDays(settledOn, 1, servicer), report_in_forwarding_file: true, qa_finding: true }; }
/** Cancel the scheduled debits with settlement ≥ T through `nacha` (2.3) and emit `autodraft.schedule.terminated` per drafted loan and — once every drafted loan is done — on the batch (`every_loan=true`), which satisfies `SM_XFER_OUT_AUTODRAFT_STOP_T0`; a debit already settled on/after T raises `autodraft.debit.refund_due` (refund within 1 BD, QA finding). */
export function stopAutodrafts(events: EventStore, batchId: string, transferDate: PlainDate, scheduled: readonly ScheduledDebit[], on: PlainDate, actor: Actor): { result: ReturnType<typeof autodraftStop>; late: boolean; loan_events: DomainEvent[]; batch_event: DomainEvent; refund_events: DomainEvent[] } {
  const result = autodraftStop(transferDate, scheduled);
  const late = on > result.cancel_by;
  const byLoan = new Map<string, string[]>();
  for (const s of scheduled) if (result.cancel.includes(s.id)) { const k = s.loan_id ?? "unknown"; byLoan.set(k, [...(byLoan.get(k) ?? []), s.id]); }
  const loan_events = [...byLoan.entries()].map(([loanId, ids]) => events.append({ type: "autodraft.schedule.terminated", ...(loanId !== "unknown" ? { loanId } : {}), aggregate: AGG(batchId), actor, occurredAt: at(on), payload: { batch_id: batchId, loan_id: loanId, cancelled: ids, transfer_date: transferDate, cancel_by: result.cancel_by, every_loan: false } }));
  const batch_event = events.append({ type: "autodraft.schedule.terminated", aggregate: AGG(batchId), actor, occurredAt: at(on), payload: { batch_id: batchId, transfer_date: transferDate, cancel_by: result.cancel_by, cancelled_on: on, late, cancelled: result.cancel, kept: result.keep, last_supermortgage_debit: result.last_supermortgage_debit, every_loan: true } });
  const refund_events = result.settled_on_or_after_t.map((r) => events.append({ type: "autodraft.debit.refund_due", ...(r.loan_id ? { loanId: r.loan_id } : {}), aggregate: AGG(batchId), actor, occurredAt: at(on), payload: { debit_id: r.id, settled_on: r.settled_on, amount_cents: r.amount_cents, refund_by: r.refund_by, report_in_forwarding_file: true, qa_finding: true } }));
  return { result, late, loan_events, batch_event, refund_events };
}

// ============================================================ short-year statement (T7, §1024.17(i)(4)(ii))
export function shortYearStatement(effective: PlainDate, lastAnnualStatementOn: PlainDate, interestOnEscrowState: boolean): { template: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"; covers_from: PlainDate; covers_through: PlainDate; due: PlainDate; mailed_by: PlainDate; escrow_interest_through: PlainDate | null; timer: "REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60" } {
  const due = addDays(effective, 60);
  return { template: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR", covers_from: addDays(lastAnnualStatementOn, 1), covers_through: addDays(effective, -1), due, mailed_by: runScheduledOn(due), escrow_interest_through: interestOnEscrowState ? addDays(effective, -1) : null, timer: "REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60" };
}
export interface ShortYearRun { readonly run_id: string; readonly batch_id: string; readonly kind: "short_year_escrow"; readonly template: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"; readonly due: PlainDate; readonly mailed_by: PlainDate; readonly loans: readonly { loan_id: string; notice_id: string; covers_from: PlainDate; covers_through: PlainDate; escrow_interest_through: PlainDate | null }[]; readonly skipped_not_escrowed: readonly string[]; status: "planned" | "rendered" | "qc_passed" | "mailed" | "complete"; readonly mailed: Map<string, { mailed_on: PlainDate; proof_of_mailing_id: string }>; }
/** Short-year run (state machine): planned at T for the escrowed loans of the batch; each statement covers `last_annual_statement_date + 1` through T−1 with escrow interest credited through T−1 in interest-on-escrow states (3.9). */
export function planShortYearRun(b: { batch_id: string; respa_effective_date: PlainDate; loans: readonly { loan_id: string; escrowed: boolean; last_annual_statement_on: PlainDate; interest_on_escrow_state: boolean }[] }, runId = `${b.batch_id}:short_year_escrow`): ShortYearRun {
  const s = shortYearStatement(b.respa_effective_date, b.respa_effective_date, false);
  const escrowed = b.loans.filter((l) => l.escrowed);
  return { run_id: runId, batch_id: b.batch_id, kind: "short_year_escrow", template: s.template, due: s.due, mailed_by: s.mailed_by, status: "planned", mailed: new Map(), skipped_not_escrowed: b.loans.filter((l) => !l.escrowed).map((l) => l.loan_id),
    loans: escrowed.map((l) => { const x = shortYearStatement(b.respa_effective_date, l.last_annual_statement_on, l.interest_on_escrow_state); return { loan_id: l.loan_id, notice_id: `${runId}:${l.loan_id}`, covers_from: x.covers_from, covers_through: x.covers_through, escrow_interest_through: x.escrow_interest_through }; }) };
}
/** Proof of mailing per statement: `notice.mailed{template=NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR}` and `notice.escrow.short_year.sent` on the loan, and — once every escrowed loan has a proof — the batch-level `notice.mailed{template, every_loan=true}` that satisfies `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60`. */
export function shortYearRunMailed(events: EventStore, run: ShortYearRun, proofs: readonly { loan_id: string; proof_of_mailing_id: string; mailed_on: PlainDate }[], actor: Actor = { kind: "external", id: "print-mail" }): { mailed_count: number; every_loan: boolean; run_event: DomainEvent | null } {
  for (const p of proofs) {
    const n = run.loans.find((l) => l.loan_id === p.loan_id); if (!n || run.mailed.has(p.loan_id)) continue;
    run.mailed.set(p.loan_id, { mailed_on: p.mailed_on, proof_of_mailing_id: p.proof_of_mailing_id });
    events.append({ type: "notice.mailed", loanId: p.loan_id, aggregate: { kind: "notice", id: n.notice_id }, actor, occurredAt: at(p.mailed_on), payload: { notice_id: n.notice_id, template: run.template, run_id: run.run_id, batch_id: run.batch_id, mailed_at: p.mailed_on, proof_of_mailing_id: p.proof_of_mailing_id, covers_from: n.covers_from, covers_through: n.covers_through, every_loan: false } });
    events.append({ type: "notice.escrow.short_year.sent", loanId: p.loan_id, actor, occurredAt: at(p.mailed_on), payload: { notice_id: n.notice_id, template: run.template, mailed_at: p.mailed_on } });
  }
  const every = run.loans.length > 0 && run.loans.every((l) => run.mailed.has(l.loan_id));
  let run_event: DomainEvent | null = null;
  if (every && run.status !== "mailed" && run.status !== "complete") {
    run.status = "mailed";
    const last = [...run.mailed.values()].map((m) => m.mailed_on).sort().at(-1)!;
    run_event = events.append({ type: "notice.mailed", aggregate: AGG(run.batch_id), actor, occurredAt: at(last), payload: { run_id: run.run_id, batch_id: run.batch_id, template: run.template, kind: run.kind, mailed_at: last, mailed_count: run.mailed.size, every_loan: true } });
  }
  return { mailed_count: run.mailed.size, every_loan: every, run_event };
}

// ============================================================ corrective notice (T10)
export interface CorrectiveInput { readonly event: "transfer_cancelled" | "transfer_date_changed"; readonly event_on: PlainDate; readonly goodbye_mailed_on: PlainDate | null; readonly original_effective_date: PlainDate; readonly original_transfer_date?: PlainDate | null; readonly new_transfer_date?: PlainDate | null; readonly installments_due_on_1st?: boolean; }
/** Edge case: transfer cancelled or date moved after mailing → corrective notice within 5 servicer business days (policy); a new goodbye ≥15 days before any new date; the goodbye-run timers are cancelled with the reason and re-issued from the new approval. `drafts_cancelled` tells the notice whether the T−3 BD autodraft cancellation had already run. */
export function correctiveNotice(i: CorrectiveInput): { required: boolean; template: "NTC_REGX_1024_33B_CORRECTIVE"; corrective_due: PlainDate; timer: "SM_XFER_OUT_CORRECTIVE_NOTICE_5"; timer_cancellations: { code: string; reason: CorrectiveInput["event"] }[]; new_respa_effective_date: PlainDate | null; new_goodbye_due: PlainDate | null; ach_cancel_by: PlainDate; drafts_cancelled: boolean; escalation: Escalation } {
  const required = i.goodbye_mailed_on !== null && i.goodbye_mailed_on <= i.event_on;
  const newEff = i.new_transfer_date ? respaEffectiveDate(i.new_transfer_date, i.installments_due_on_1st ?? false) : null;
  const achCancel = achCancelBy(i.original_transfer_date ?? i.original_effective_date);
  return { required, template: "NTC_REGX_1024_33B_CORRECTIVE", corrective_due: addBusinessDays(i.event_on, 5, servicer), timer: "SM_XFER_OUT_CORRECTIVE_NOTICE_5", timer_cancellations: GOODBYE_RUN_TIMERS.map((code) => ({ code, reason: i.event })), new_respa_effective_date: newEff, new_goodbye_due: newEff ? addDays(newEff, -15) : null, ach_cancel_by: achCancel, drafts_cancelled: i.event_on >= achCancel, escalation: { kind: "officer", reason: `${i.event} after the goodbye notice was mailed: corrective notice ${required ? "required" : "not required (nothing mailed)"} — officer approves corrective notices (17.2 escalations)` } };
}
function cancelGoodbyeRunTimers(engine: TimerEngine, batchId: string, reason: CorrectiveInput["event"], actor: Actor): { code: string; timer_id: string; reason: CorrectiveInput["event"] }[] {
  const codes = new Set<string>(GOODBYE_RUN_TIMERS);
  const cancelled: { code: string; timer_id: string; reason: CorrectiveInput["event"] }[] = [];
  for (const t of engine.forSubject("transfer_batch", batchId)) if ((t.status === "armed" || t.status === "breached") && codes.has(t.code)) { engine.cancel(t.id, reason, actor); cancelled.push({ code: t.code, timer_id: t.id, reason }); }
  return cancelled;
}
/** Cancel a transfer-out batch on the live engine: `transfer.batch.cancelled{reason=transfer_cancelled, goodbye_mailed}` arms `SM_XFER_OUT_CORRECTIVE_NOTICE_5` when the goodbye had been mailed; every open goodbye-run timer on the batch is cancelled with reason `transfer_cancelled`. */
export function cancelTransferOut(engine: TimerEngine, events: EventStore, i: { batch_id: string; cancelled_on: PlainDate; goodbye_mailed_on: PlainDate | null; original_effective_date: PlainDate; original_transfer_date?: PlainDate | null }, actor: Actor): { cancellation_event_id: string; cancelled: { code: string; timer_id: string; reason: "transfer_cancelled" }[]; corrective: ReturnType<typeof correctiveNotice> } {
  const corrective = correctiveNotice({ event: "transfer_cancelled", event_on: i.cancelled_on, goodbye_mailed_on: i.goodbye_mailed_on, original_effective_date: i.original_effective_date, original_transfer_date: i.original_transfer_date ?? null });
  const cancelled = cancelGoodbyeRunTimers(engine, i.batch_id, "transfer_cancelled", actor) as { code: string; timer_id: string; reason: "transfer_cancelled" }[];
  const e = events.append({ type: "transfer.batch.cancelled", aggregate: AGG(i.batch_id), actor, occurredAt: at(i.cancelled_on), payload: { reason: "transfer_cancelled", cancelled_on: i.cancelled_on, goodbye_mailed_on: i.goodbye_mailed_on, goodbye_mailed: corrective.required, corrective_due: corrective.corrective_due, drafts_cancelled: corrective.drafts_cancelled, timers_cancelled: cancelled.map((c) => c.code) } });
  return { cancellation_event_id: e.id, cancelled, corrective };
}
/** Move a transfer-out date on the live engine: `transfer.batch.date_changed{reason=transfer_date_changed, goodbye_mailed}` arms `SM_XFER_OUT_CORRECTIVE_NOTICE_5` when the goodbye had been mailed; the goodbye-run timers are cancelled with reason `transfer_date_changed` and re-issued by the re-approval (`transfer.batch.approved{direction=out}` with the new dates), with a new goodbye ≥15 days before the new effective date. */
export function changeTransferOutDate(engine: TimerEngine, events: EventStore, i: { batch_id: string; changed_on: PlainDate; goodbye_mailed_on: PlainDate | null; original_effective_date: PlainDate; original_transfer_date?: PlainDate | null; new_transfer_date: PlainDate; installments_due_on_1st: boolean }, actor: Actor): { change_event_id: string; cancelled: { code: string; timer_id: string; reason: "transfer_date_changed" }[]; corrective: ReturnType<typeof correctiveNotice> } {
  const corrective = correctiveNotice({ event: "transfer_date_changed", event_on: i.changed_on, goodbye_mailed_on: i.goodbye_mailed_on, original_effective_date: i.original_effective_date, original_transfer_date: i.original_transfer_date ?? null, new_transfer_date: i.new_transfer_date, installments_due_on_1st: i.installments_due_on_1st });
  const cancelled = cancelGoodbyeRunTimers(engine, i.batch_id, "transfer_date_changed", actor) as { code: string; timer_id: string; reason: "transfer_date_changed" }[];
  const e = events.append({ type: "transfer.batch.date_changed", aggregate: AGG(i.batch_id), actor, occurredAt: at(i.changed_on), payload: { reason: "transfer_date_changed", changed_on: i.changed_on, goodbye_mailed_on: i.goodbye_mailed_on, goodbye_mailed: corrective.required, original_effective_date: i.original_effective_date, new_transfer_date: i.new_transfer_date, new_respa_effective_date: corrective.new_respa_effective_date, new_goodbye_due: corrective.new_goodbye_due, corrective_due: corrective.corrective_due, drafts_cancelled: corrective.drafts_cancelled, timers_cancelled: cancelled.map((c) => c.code) } });
  return { change_event_id: e.id, cancelled, corrective };
}

// ============================================================ returned mail and skip trace (A2-7-03)
export function ingestMailReturns(returns: readonly { notice_id: string; loan_id: string; template: string; proof_of_mailing_id: string }[], returnedOn: PlainDate): { notice_id: string; loan_id: string; template: string; respa: boolean; skip_trace_due: PlainDate; original_proof_of_mailing_id: string; event: "mail.returned" }[] {
  return returns.map((r) => { const m = returnedMail({ id: r.notice_id, proof_of_mailing_id: r.proof_of_mailing_id }, returnedOn); return { notice_id: r.notice_id, loan_id: r.loan_id, template: r.template, respa: /^NTC_REGX_1024_33B_/.test(r.template), skip_trace_due: m.skip_trace_due, original_proof_of_mailing_id: m.original_proof_of_mailing_id, event: "mail.returned" }; });
}
export function skipTraceOrder(i: { notice_id: string; loan_id: string; returned_on: PlainDate; proof_of_mailing_id: string }): { notice_id: string; loan_id: string; due: PlainDate; outbound_contact: false; original_proof_of_mailing_id: string; on_result: "remailed" | "undeliverable_documented"; satisfies: "skiptrace.completed" } {
  return { notice_id: i.notice_id, loan_id: i.loan_id, due: addBusinessDays(i.returned_on, 5, servicer), outbound_contact: false, original_proof_of_mailing_id: i.proof_of_mailing_id, on_result: "remailed", satisfies: "skiptrace.completed" };
}
/** The skip-trace vendor result: `skiptrace.completed{result∈{remailed, undeliverable_documented}}` on the loan (the original proof of mailing is preserved) — the event `FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5` is satisfied by; a remail needs the alternate address and also records `notice.remailed`. */
export function completeSkipTrace(events: EventStore, i: { notice_id: string; loan_id: string; result: "remailed" | "undeliverable_documented"; new_address?: string | null; completed_on: PlainDate; original_proof_of_mailing_id: string }, actor: Actor = { kind: "external", id: "skip-trace-vendor" }): DomainEvent {
  if (i.result === "remailed" && !i.new_address) throw new RangeError("a remail needs the alternate mailing address the skip trace found (A2-7-03)");
  const e = events.append({ type: "skiptrace.completed", loanId: i.loan_id, actor, occurredAt: at(i.completed_on), payload: { notice_id: i.notice_id, result: i.result, new_address: i.new_address ?? null, completed_on: i.completed_on, original_proof_of_mailing_id: i.original_proof_of_mailing_id } });
  if (i.result === "remailed") events.append({ type: "notice.remailed", loanId: i.loan_id, actor, occurredAt: at(i.completed_on), causationId: e.id, payload: { notice_id: i.notice_id, address: i.new_address, original_proof_of_mailing_id: i.original_proof_of_mailing_id } });
  return e;
}

// ============================================================ borrower-comms routing window (SM_XFER_OUT_BORROWER_ROUTING_90) and the post-transfer sweeps
export const TRANSFER_OUT_INTENTS = ["who_do_i_pay", "where_is_my_payment", "why_did_my_draft_stop"] as const;
/** The `borrower-comms` scripts (`contact_scripts` `transfer_out.v1`) are live from T−15 (transfer banner, pre-transfer questions), route days 1–90 after `transfer_date` with the transferee's details, and after day 90 refer with the transferee's number only. Supermortgage accepts payments through T−1; from T only as misdirected payments. */
export function borrowerRoutingWindow(transferDate: PlainDate, today: PlainDate): { day: number; phase: "not_started" | "pre_transfer" | "active" | "refer_only"; scripts_live: boolean; script_version: typeof CONTACT_SCRIPT_VERSION; agent: "borrower-comms"; intents: readonly string[]; warm_transfer_to: "human_agent"; outbound_allowed: false; accepts_payments: boolean; closes_on: PlainDate; close_event: "transfer.support_window.closed" } {
  const day = daysBetween(transferDate, today);
  const phase = day < -SCRIPTS_LIVE_DAYS_BEFORE ? "not_started" : day < 1 ? "pre_transfer" : day <= SUPPORT_WINDOW_DAYS ? "active" : "refer_only";
  return { day, phase, scripts_live: day >= -SCRIPTS_LIVE_DAYS_BEFORE, script_version: CONTACT_SCRIPT_VERSION, agent: "borrower-comms", intents: TRANSFER_OUT_INTENTS, warm_transfer_to: "human_agent", outbound_allowed: false, accepts_payments: day < 0, closes_on: addDays(transferDate, SUPPORT_WINDOW_DAYS), close_event: "transfer.support_window.closed" };
}
/**
 * The daily post-transfer sweep for a cut-over batch: on day 61 it emits `transfer.protection_window.expired` (closes
 * `REGX_1024_33C1_LATE_FEE_PROTECTION_60` — later receipts are forwarded but not protected) and after day 90 it emits
 * `transfer.support_window.closed` (closes `SM_XFER_OUT_BORROWER_ROUTING_90`: calls are referred with the transferee's number
 * only, the lockbox is closed to the loans' coupons). The two recurrences that end with the window —
 * `SM_XFER_OUT_FORWARD_FILE_DAILY` and `SM_XFER_OUT_BORROWER_ROUTING_90` — are closed on the engine first, with reason
 * `support_window_closed`: the kernel re-arms a recurring row from its own satisfying event (TimerEngine.onEvent), so a
 * window that closes must be cancelled, not satisfied — the engine is therefore required, an append without the
 * cancellation would re-arm the closed window on any engine over the same store. Idempotent: each event is emitted once
 * per batch.
 */
export function postTransferSweep(engine: TimerEngine, events: EventStore, b: { batch_id: string; transfer_date: PlainDate; respa_effective_date: PlainDate }, today: PlainDate, actor: Actor = SYSTEM): { protection_window_expired: DomainEvent | null; support_window_closed: DomainEvent | null; recurrences_closed: { code: string; timer_id: string; reason: "support_window_closed" }[] } {
  const windowEnd = addDays(b.respa_effective_date, PROTECTION_WINDOW_DAYS - 1); const closesOn = addDays(b.transfer_date, SUPPORT_WINDOW_DAYS);
  let protection: DomainEvent | null = null, support: DomainEvent | null = null; const closed: { code: string; timer_id: string; reason: "support_window_closed" }[] = [];
  if (today > windowEnd && !seen(events, "transfer.protection_window.expired", b.batch_id))
    protection = events.append({ type: "transfer.protection_window.expired", aggregate: AGG(b.batch_id), actor, occurredAt: at(today), payload: { batch_id: b.batch_id, respa_effective_date: b.respa_effective_date, window_end: windowEnd, expired_on: today, day: daysBetween(b.respa_effective_date, today) + 1 } });
  if (today > closesOn && !seen(events, "transfer.support_window.closed", b.batch_id)) {
    for (const t of engine.forSubject("transfer_batch", b.batch_id)) if ((t.code === "SM_XFER_OUT_FORWARD_FILE_DAILY" || t.code === "SM_XFER_OUT_BORROWER_ROUTING_90") && (t.status === "armed" || t.status === "breached")) { engine.cancel(t.id, "support_window_closed", actor); closed.push({ code: t.code, timer_id: t.id, reason: "support_window_closed" }); }
    support = events.append({ type: "transfer.support_window.closed", aggregate: AGG(b.batch_id), actor, occurredAt: at(today), payload: { batch_id: b.batch_id, transfer_date: b.transfer_date, closes_on: closesOn, closed_on: today, day: daysBetween(b.transfer_date, today), refer_only: true, lockbox_closed_to_coupons: true, forward_on_receipt: true, recurrences_closed: closed.map((c) => c.code) } });
  }
  return { protection_window_expired: protection, support_window_closed: support, recurrences_closed: closed };
}

// ============================================================ final statement gate (SM_XFER_OUT_FINAL_STATEMENT_GATE, 7.1)
/**
 * `SM_XFER_OUT_FINAL_STATEMENT_GATE` (not_before_gate; evaluator `17.2.noStatementForCyclesOnOrAfterTransfer`, registered in
 * src/app/evaluators.ts and named by the section override in ./timers.ts): no periodic statement is owed for a billing cycle in which
 * Supermortgage is not the servicer (Reg Z §1026.41; 7.1-T15) — the last statement Supermortgage issues covers the cycle ending before T.
 * The 7.1 statement generator consults this for a loan on a transfer-out batch before rendering: a cycle whose due date is on/after
 * `transfer_date` is refused ("statement generator refuses"); the allowed cycle whose successor is due on/after T is the final one
 * (the final-statement variant, `transfer_notice_runs.kind = final_statement`).
 */
export function finalStatementGate(i: { cycle_due_date: PlainDate; transfer_date: PlainDate }): { code: "SM_XFER_OUT_FINAL_STATEMENT_GATE"; statement_allowed: boolean; last_supermortgage_cycle: boolean; reason: string | null } {
  const g = evaluateGate("17.2.noStatementForCyclesOnOrAfterTransfer", { cycle_due_date: i.cycle_due_date, transfer_date: i.transfer_date });
  return { code: "SM_XFER_OUT_FINAL_STATEMENT_GATE", statement_allowed: g.open, last_supermortgage_cycle: g.open && addMonths(i.cycle_due_date, 1) >= i.transfer_date, reason: g.reason ?? null };
}
/** The generator's decision on the event log: `statement.generation.refused{code=SM_XFER_OUT_FINAL_STATEMENT_GATE}` on the loan for a refused cycle; nothing for an allowed one (the statement itself is 7.1's). */
export function statementCycleGate(events: EventStore, i: { loan_id: string; batch_id?: string | null; cycle_id: string; cycle_due_date: PlainDate; transfer_date: PlainDate; on?: PlainDate | null }, actor: Actor = SYSTEM): ReturnType<typeof finalStatementGate> & { event: DomainEvent | null } {
  const g = finalStatementGate(i);
  const event = g.statement_allowed ? null : events.append({ type: "statement.generation.refused", loanId: i.loan_id, ...(i.batch_id ? { aggregate: AGG(i.batch_id) } : {}), actor, ...(i.on ? { occurredAt: at(i.on) } : {}), payload: { code: g.code, cycle_id: i.cycle_id, cycle_due_date: i.cycle_due_date, transfer_date: i.transfer_date, reason: g.reason } });
  return { ...g, event };
}
