/**
 * §35.5 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.5 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.5's recurring clocks (SM_CASHIERING_DAILY_RECEIPT_1D, SM_LOCKBOX_FILE_EXPECTED_1BD, SM_ACH_FILE_BUILD_1BD) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.5
 * parse and arm from the registry as written; SM_INSTALLMENT_REPROJECT_1BD alone takes an override (three spellings of one
 * trigger, below). `armServicingSideClocks` at the end arms this section's loan clocks on servicing-side events the engine skips.
 * Emitter of the daily receipt: src/domain/operations-runtime/cashiering-cycle.ts electDailyReceipt — `cashiering.daily.run_completed{as_of_date,
 * run_id, loans, posted, late_charges_assessed, amount_change_checks, units_total, units_done, units_dead, units_skipped, origination: true}` once per
 * day in a global unit of work (35.3's `electReceipt` owns the literal at its merge). Emitter of the lockbox clocks' trigger and satisfier:
 * src/domain/operations-runtime/lockbox.ts ingestLockboxFile — `lockbox.batch.received{lockbox_id, batch_id, receipt_date, lockbox_receipt_date,
 * received_on, items, control_total_cents, sha256, …, origination: true}` on the batch aggregate (arms SM_LOCKBOX_BATCH_POSTED_1BD on the batch and
 * re-arms the global SM_LOCKBOX_FILE_EXPECTED_1BD; 2.1's and 6.1's deposit clocks read their own anchor spellings from the same payload) and
 * `lockbox.batch.posted{batch_id, posted, unidentified, rejected}` once every item is a payment or a suspense item. Emitter of the ACH clocks:
 * src/domain/operations-runtime/ach.ts — `ach.file.built{file_id, as_of_date, entries, total_debit_cents, sha256, …, origination: true}` in a global unit of
 * work per build (SM_ACH_FILE_BUILD_1BD's trigger and satisfier, re-armed for the next banking day at 14:00 ET), `ach.return.received{code, reason_code,
 * received_on, original_settlement_date, …, origination: true}` on the loan per matched return (arms SM_ACH_RETURN_ACTIONED_1BD; 2.3's own clocks read their
 * fields from the same payload) and `ach.return.actioned{entry_id, payment_id, code, action, nsf_fee_id?, reinitiation_entry_id?}` in the loan's next unit of work.
 */
import type { TimerDef, TimerRegistry } from "../../kernel/timers/registry.ts";
import { isOriginationContext, type TimerEngine } from "../../kernel/timers/engine.ts";
import { eventMatches, type DomainEvent } from "../../kernel/events/index.ts";

export function applySatisfiedOverrides_35_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_CASHIERING_DAILY_RECEIPT_1D", { anchorField: "as_of_date", subject: "global",
    why: "§35.5 timer table row `SM_CASHIERING_DAILY_RECEIPT_1D`: recurring on `cashiering.daily.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `cashiering.daily.run_completed`, breach 'sev 2 → `officer` (no whole-book cashiering run completed for a calendar day; 35.4's `eod_cutoff` cannot receipt)' — 'Trigger & frequency: Per loan at `loan.boarded` (both paths) and at every `loan_terms.activated`; daily for the whole book (the `cashiering_daily` cycle of 35.3); daily on the lockbox file, the ACH file build and the NACHA return file'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 2: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_LOCKBOX_FILE_EXPECTED_1BD", { anchorField: "receipt_date", subject: "global",
    why: "§35.5 timer table row `SM_LOCKBOX_FILE_EXPECTED_1BD`: recurring on `lockbox.batch.received`, anchor `receipt_date`, offset '+1 business_days_servicer', satisfied by `lockbox.batch.received`, breach 'sev 2 → `officer` (no remittance file by 10:00 local on a servicer business day: SFTP, PGP or the bank — items may be waiting uncredited)' — 'Trigger & frequency: Per loan at `loan.boarded` (both paths) and at every `loan_terms.activated`; daily for the whole book (the `cashiering_daily` cycle of 35.3); daily on the lockbox file, the ACH file build and the NACHA return file'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor receipt_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 3: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_ACH_FILE_BUILD_1BD", { anchorField: "as_of_date", subject: "global", offset: "+1 business_days_federal, 14:00 America/New_York",
    why: "§35.5 timer table row `SM_ACH_FILE_BUILD_1BD`: recurring on `ach.file.built`, anchor `as_of_date`, offset '+1 business_days_federal', satisfied by `ach.file.built`, breach 'sev 2 → `officer` (no ACH file built by 14:00 ET on a banking day: tomorrow's drafts will miss their settlement date and C-1.1-03's penalty-free window)' — 'Trigger & frequency: Per loan at `loan.boarded` (both paths) and at every `loan_terms.activated`; daily for the whole book (the `cashiering_daily` cycle of 35.3); daily on the lockbox file, the ACH file build and the NACHA return file'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY). The due time is the table note's fixed zone ('the ACH clock's 14:00 America/New_York' — 2.3's schedule row: `autodraft.file.build` daily at 14:00 ET for entries settling T+1/T+2), so the offset carries the wall-clock deadline the grammar allows (src/kernel/timers/offset.ts parseTime); the emitter is src/domain/operations-runtime/ach.ts buildAchFile." });
  // Timer table row 2: one clock on three spellings of one fact — the prefix wildcard covers 2.4's, 7.2's and 3.6/12.8's literals (registry.ts firstPattern keeps one pattern per row).
  o("SM_INSTALLMENT_REPROJECT_1BD", { trigger: "`loan_terms.*`", anchorField: "effective_on",
    why: "§35.5 timer table row `SM_INSTALLMENT_REPROJECT_1BD`: trigger `loan_terms.activated` / `loan_terms.version.activated` / `loan_terms.versioned`, anchor `activated_on`, offset '+1 business_days_servicer', satisfied by `installment.schedule.reprojected`, breach 'sev 2 → `officer` (terms changed and the schedule still shows the old P&I / rate: statements and drafts would state the wrong amount)' — the table's own note: 'arms on three spellings of one fact — 2.4's `loan_terms.activated`, 7.2's `loan_terms.version.activated` and 3.6/12.8's `loan_terms.versioned` — through a cited override in src/domain/operations-runtime/timers-35-5.ts that lists all three as triggers; `activated_on` is the event's `effective_from` / `effective_on` / `effective_date`'. The emitters at HEAD: src/domain/cashiering/ops.ts:230 `loan_terms.activated{effective_on}` (2.4), src/domain/notices/ops-7-2.ts:486,616 `loan_terms.version.activated{effective_on}` (7.2), src/domain/escrow/ops-3-6.ts:29,127 `loan_terms.versioned{effective_from}` (3.6), src/domain/lossmit/ops-12-8.ts:325 `loan_terms.versioned{effective_date}` (12.8). The registry keeps one pattern per row (src/kernel/timers/registry.ts firstPattern), so the prefix wildcard `loan_terms.*` (src/kernel/events/match.ts typeMatches; registry.ts triggeredBy) covers all four; `activated_on` is the effective date under whichever spelling the event carries — `effective_on` (the def's anchor field, the resolver's own read), else `effective_from` / `effective_date` (armServicingSideClocks below arms with the spelling the event carries, since src/kernel/timers/engine.ts defaultAnchorResolver reads one field), else the resolver's event date (never later than the change). The wildcard also matches `loan_terms.rate_changed`, a legitimate reprojection trigger. None of the four spellings carries origination context, so on a servicing-side loan the engine skips this section-35 def (engine.ts isOriginationDef); `armServicingSideClocks` arms it explicitly — the reactor before the reprojection runs, the reprojection before it appends the satisfier." });
}

/** The 35.5 codes `armServicingSideClocks` may arm explicitly: the two boarding clocks (trigger `loan.boarded`) and the reprojection clock (trigger `loan_terms.*`); each projection names its own. */
export const CODES_35_5: readonly string[] = ["SM_INSTALLMENT_SCHEDULE_AT_BOARD_0", "SM_LOAN_SERVICING_CONFIG_AT_BOARD_0", "SM_INSTALLMENT_REPROJECT_1BD"];

/**
 * Section 35 is numbered ≥ 20, so the engine treats its defs as origination clocks and arms them only for an event that
 * carries origination context (src/kernel/timers/engine.ts onEvent / isOriginationDef): the fund path's `loan.boarded{source:
 * origination, application_id}` arms 35.5's boarding clocks by itself, the transfer path's `loan.boarded{transfer_date,
 * boarded_at}` (src/domain/boarding/service.ts) and the four `loan_terms.*` spellings do not. This arms each 35.5 def whose
 * trigger pattern matches `event` on the loan subject when the engine skipped it and no instance of the code is armed or was
 * armed by this very event (a clock satisfied in the same transaction is not armed twice) — `engine.arm` is the engine's own
 * public entry (the section03/section3-7 precedent); satisfaction is then the engine's (`sameSubject` on the loan). Harmless on
 * the fund path (the event carries origination context, the engine armed it). The kernel narrowing of `isOriginationDef` to
 * 20–31 is a cohort decision, not made here.
 */
export function armServicingSideClocks(engine: TimerEngine, registry: TimerRegistry, event: DomainEvent, codes: readonly string[] = CODES_35_5): TimerDef[] {
  const armed: TimerDef[] = [];
  if (!event.loanId || isOriginationContext(event)) return armed;
  const payload = event.payload as Record<string, unknown>;
  for (const code of codes) {
    const def = registry.get(code);
    if (!def?.triggerPattern || !eventMatches(def.triggerPattern, event)) continue;
    if (engine.forSubject("loan", event.loanId).some((i) => i.code === code && (i.status === "armed" || i.armedByEventId === event.id))) continue;
    // the spec's anchor under the spelling this emitter uses (`activated_on` = effective_on / effective_from / effective_date): the resolver reads one field, so the def is armed with the field the payload carries
    const spelled = def.anchorField && payload[def.anchorField] === undefined ? ANCHOR_SPELLINGS.find((k) => typeof payload[k] === "string") : undefined;
    engine.arm(spelled ? { ...def, anchorField: spelled } : def, event);
    armed.push(def);
  }
  return armed;
}
/** The spellings of one anchor fact across the emitters (§35.5 timer table: "`activated_on` is the event's `effective_from` / `effective_on` / `effective_date`"; `boarded_on` for the boarding clocks). */
const ANCHOR_SPELLINGS: readonly string[] = ["effective_on", "effective_from", "effective_date", "activated_on", "boarded_on"];
