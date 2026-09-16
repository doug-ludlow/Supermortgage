/**
 * §35.8 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.8 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.8's recurring clock (SM_WORK_LOG_RECON_DAILY) is global: it is armed by a per-day completion receipt on the global
 * subject, not by a loan or application aggregate, so it takes the cited `subject: "global"` override on the
 * src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The two age clocks take the spec's
 * "17:00 servicer time" as the wall-clock deadline of their business-day offset (T10). The claim clock's breach action —
 * the only place a breach does more than open an escalation — is `claimBreachHandler` below, run by the sweep's
 * `work.breaches` pass (src/domain/operations-runtime/work-35-8/sweep.ts) after the engine breached the row; the generic
 * breach pass (src/runtime/app.ts) opens no escalation for the codes in BREACH_HANDLED_BY_35_8 because the handler
 * escalates on the third lapse of one item, never on the first (T9).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_8(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 5: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_WORK_LOG_RECON_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.8 timer table row `SM_WORK_LOG_RECON_DAILY`: recurring on `work.log.recon.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `work.log.recon.run_completed`, breach 'sev 3 → `compliance` (no reconciliation of the action log today, or the last run found orphans or a stale screen version)' — 'Trigger & frequency: … the action-log reconciliation runs once a calendar day'. The receipt is one global event per environment-day, not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table rows 2–3: the item's age in business days, due at the servicer's close of business (T10: "when the sweep crosses 2026-09-16 17:00 servicer time, then SM_WORK_ITEM_AGE_2BD breaches").
  o("SM_WORK_ITEM_AGE_2BD", { anchorField: "opened_at", offset: "+2 business_days_servicer, 17:00 ET",
    why: "§35.8 timer table row `SM_WORK_ITEM_AGE_2BD`: deadline on `work.item.opened`, anchor `opened_at`, offset '+2 business_days_servicer', satisfied by `work.item.closed`, breach 'sev 2 → `ops_analyst` (an item needing a person has sat two business days; the source's own legal clock is the owning section's timer, this is the operating backstop)'; T10: 'when the sweep crosses 2026-09-16 17:00 servicer time, then `SM_WORK_ITEM_AGE_2BD` breaches' — the wall-clock deadline of the business-day offset is the servicer's 17:00 (the column's grammar would otherwise end the day at 23:59)." });
  o("SM_WORK_ITEM_AGE_5BD", { anchorField: "opened_at", offset: "+5 business_days_servicer, 17:00 ET",
    why: "§35.8 timer table row `SM_WORK_ITEM_AGE_5BD`: deadline on `work.item.opened`, anchor `opened_at`, offset '+5 business_days_servicer', satisfied by `work.item.closed`, breach 'sev 1 → `officer` (five business days unworked: the queue is unstaffed for that role — 35.7 `role.queue.unstaffed` is emitted with the role)'; T10: 'when it crosses 2026-09-21, then `SM_WORK_ITEM_AGE_5BD` breaches to a sev 1 `officer` escalation and `role.queue.unstaffed{role}` is emitted' — the same 17:00 servicer deadline as the two-day clock." });
  // Timer table row 1: `+4 hours` parses through the engine's hour unit (src/kernel/timers/offset.ts) from `claimed_at`; no offset override.
  o("SM_WORK_ITEM_CLAIM_4H", { anchorField: "claimed_at",
    why: "§35.8 timer table row `SM_WORK_ITEM_CLAIM_4H`: deadline on `work.item.claimed`, anchor `claimed_at`, offset '+4 hours', satisfied by `work.item.released`, breach 'the claim lapses (`work.item.claim_expired`, `claim_lapses + 1`, status back to `open`); sev 3 → `ops_analyst` on the third lapse of one item' — the anchor is the event's `claimed_at` instant; the breach action is executed by claimBreachHandler below (rule 9; T9)." });
  o("SM_WORK_APPROVAL_1BD", { anchorField: "proposed_at",
    why: "§35.8 timer table row `SM_WORK_APPROVAL_1BD`: deadline on `work.action.proposed`, anchor `proposed_at`, offset '+1 business_days_servicer', satisfied by `work.action.decided`, breach 'sev 2 → `officer` (a money-field proposal — a reversal, a trustee application, a waiver — awaits a distinct officer; the proposal expires one further business day later)' — the anchor is the proposal event's `proposed_at` instant (rule 5; T3)." });
}

/** The codes whose breach action is executed by this process's handler rather than by the generic escalation (src/runtime/app.ts breach pass). */
export const BREACH_HANDLED_BY_35_8: ReadonlySet<string> = new Set(["SM_WORK_ITEM_CLAIM_4H"]);

/**
 * The breach handler of `SM_WORK_ITEM_CLAIM_4H` (timer table row 1; rule 9): for a breached claim clock whose item is still
 * `claimed` under that claim, the claim lapses — `work.item.claim_expired{lapses}`, `claim_lapses + 1`, status back to `open`
 * — and the third lapse of one item opens the sev 3 `ops_analyst` escalation; the first two open none (T9). Pure over the
 * rows it is handed; the sweep pass (work-35-8/sweep.ts) reads the breached rows and commits what this returns.
 */
export interface ClaimBreachInput { readonly item_id: string; readonly claim_lapses: number; readonly status: string; readonly claimed_by: string | null; readonly claimed_at: string | null; readonly timer_armed_at: string; readonly timer_id: string }
export interface ClaimBreachDecision { readonly item_id: string; readonly lapse: boolean; readonly lapses_after: number; readonly escalate: boolean; readonly timer_id: string }
export function claimBreachHandler(i: ClaimBreachInput, thirdLapse = 3): ClaimBreachDecision {
  // a claim released and re-taken after the clock armed is a newer claim: the old clock's breach lapses nothing (the new claim has its own clock)
  const lapse = i.status === "claimed" && i.claimed_at !== null && Date.parse(i.claimed_at) <= Date.parse(i.timer_armed_at);
  const lapses_after = lapse ? i.claim_lapses + 1 : i.claim_lapses;
  return { item_id: i.item_id, lapse, lapses_after, escalate: lapse && lapses_after >= thirdLapse, timer_id: i.timer_id };
}
