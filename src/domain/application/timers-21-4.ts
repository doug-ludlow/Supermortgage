/**
 * §21.4 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 21.4 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 * The events named here are appended by src/domain/application/ops-21-4.ts (and src/notices/service.ts for `notice.sent`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_21_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Rule 1: a state gate, not a count — created closed at `application.trid_received`, opens at the later of LE receipt and a valid intent
  // (evaluators-21-4.ts `21.4.intentFeeGate` asserts the same condition for the guarded commands); satisfied by the valid intent event.
  o("REGZ_1026_19E2_INTENT_FEE_GATE", { evaluator: "21.4.intentFeeGate", satisfied: "`intent.to_proceed.received{valid=true}`", anchorField: "trid_received_at",
    why: "§21.4 timer table: 'not_before_gate … created closed … opens at the later of disclosures.effective_receipt_date (initial LE) and intent_records.received_at (valid) … 0 calendar_days — a state gate, not a count'; satisfied by `intent.to_proceed.received` after receipt (recordIntent emits it only when valid=true; a premature statement is `intent.to_proceed.rejected_premature`)." });
  // Rule 3: three *general* business days on the creditor calendar from the creditor's civil date of the lock (`rate_set_date` = locked_at::date, creditor tz);
  // the row's satisfier is 21.5's revised LE; when (e)(4)(ii) bars one, recordChangedCircumstance retires the instance citing 25.2's corrected CD.
  o("REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD", { offset: "+3 business_days_creditor", anchorField: "rate_set_date", satisfied: "`disclosure.le.revised{reason=rate_lock}`",
    why: "§21.4 timer table: anchor '`locks.locked_at` date, creditor time zone', offset '+3 `business_days_creditor`, end of day'; satisfied by '`disclosure.le.revised{reason=rate_lock}` (21.5) delivered or mailed; or, when a revised LE is barred by (e)(4)(ii), `disclosure.cd.delivered`/`disclosure.cd.corrected` … with `changed_circumstances.reflected_on='cd'`' (the alternative is applied by ops-21-4 reflectedDisclosure)." });
  // Rule 11: the MLO SLA anchors on the request instant (payload `requested_at`); `lock.approved` or `lock.rejected{reason}` satisfies it.
  o("SM_LOCK_MLO_APPROVAL_SLA_30MIN", { offset: "+30 minutes", anchorField: "requested_at", satisfied: "`lock.approved`",
    why: "§21.4 timer table: trigger `lock.requested`, anchor `requested_at`, '+30 minutes (clock time; only inside lock-desk hours)', satisfied by '`lock.approved` or `lock.rejected` by `mlo_of_record`' — the stale-quote path emits `lock.rejected{reason=quote_expired}` for the superseded request." });
  // Rule 4: both expiry rows anchor on the lock's `expires_on` (17:00 creditor time is on the row; the grammar has no America/Phoenix zone, so the deadline is the expiration date).
  o("SM_LOCK_EXPIRY_DEADLINE", { anchorField: "expires_on", satisfied: "`closing.consummated`",
    why: "§21.4 timer table: anchor `locks.expires_at` (= `expires_on` 17:00 creditor time zone, rule 4), offset '0 (the expiration instant)', satisfied by '`closing.consummated` … before `expires_at`, or an extension/relock decision' (extendLock/relock re-arm the row from `lock.extended`/`lock.relocked`)." });
  o("SM_LOCK_EXPIRY_WARN_7", { anchorField: "expires_on", satisfied: "`lock.expiry.warned`",
    why: "§21.4 timer table: anchor `locks.expires_at`, offset '−7 `calendar_days`', satisfied by '`lock.expiry.warned` (borrower notice + MLO/agent task)'." });
  // 3 NYCRR §38.6(b)(4): the window is −20 to −12 creditor business days before `expires_on`, required only for NY property when the expiry is more than 12 business days from the lock date (executeLock stamps `ny_expiry_notice_required`).
  o("NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD", { trigger: "`lock.executed{ny_expiry_notice_required=true}`", offset: "between −20 and −12 business_days_creditor", anchorField: "expires_on", satisfied: "`notice.sent{template=NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE}`",
    why: "§21.4 timer table: trigger '`lock.executed` for NY property when `expires_on − locked_on > 12 business days`', anchor `locks.expires_on`, 'window −20 to −12 `business_days_creditor`', satisfied by '`notice.sent{NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE}` inside the window' (NoticeService emits `notice.sent{template}`; sendNotice refuses a send outside the window)." });
  // 29.1 owns this code (its row's trigger cell is prose); 21.4 supplies only the trigger spelling of the events it emits and 29.1's own
  // offset/satisfier so the referenced row is armable — 29.1's override, applied after this one, supersedes it.
  o("FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD", { trigger: "`lock.relocked`", offset: "+1 business_days_fannie_et, 17:00 ET", satisfied: "`commitment.modified`",
    why: "§29.1 timer table (owned there; 21.4 references): trigger 'any change to loan amount, product, note rate … (`lock.relocked`, `lock.float_down.applied`, …)', '+1 `business_days_fannie_et`, due 5:00 p.m. ET', satisfied by '`commitment.modified` (API or UI)' — the in-process best-efforts adapter (ops-21-4 InMemoryCommitmentAdapter.keyDataChange) emits it until 29.1's adapter exists." });
}
