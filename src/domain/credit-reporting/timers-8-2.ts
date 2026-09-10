/**
 * §8.2 timer overrides (process-owned; the §8 section-level overrides in ./timers.ts run first and these win the
 * merge). One `reg.override(code, { trigger?, satisfied?, anchorField?, offset?, why })` per 8.2 registry row whose
 * trigger/satisfied/anchor column names something the platform spells differently or carries a condition the column
 * grammar drops; `why` quotes the spec. Wired by src/domain/timer-overrides.ts.
 *
 * Conventions the grammar forces (src/kernel/events/match.ts holds ONE dotted pattern per column; conditions are
 * exact string compares on payload fields; a mid-string wildcard never matches):
 * - `credit.dispute.*.received` (the XB gate) becomes the one receipt event every intake channel emits next to its own
 *   (`credit.dispute.received`, from `DisputeCaseRunner.ingestAcdv` and `receiveDirectDispute` in ./ops-8-2.ts);
 * - "45 if the ACDV indicates consumer-supplied information" is a computed anchor carried on the triggering event
 *   (`cra_outer_bound_on`) with a zero offset — the grammar cannot hold a conditional offset;
 * - "to every other bureau that received the data" is the last AUD of the required set carrying `fan_out_complete=true`
 *   (`submitAudFanOut`), so one bureau's AUD never satisfies the fan-out clock;
 * - "until `closed`" holds while ANY dispute on the loan is open (rule 6: XB from receipt until close), so the satisfier
 *   is the close that leaves `open_disputes_remaining=0`.
 * Every trigger and satisfier named here is appended to the event store by ./ops-8-2.ts (called by the 8.2 tools in
 * src/app/tools/section08.ts, the scheduler tick, or the ingestion of the inbound ACDV / letter) — never a bare literal.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_8_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- rule 1: the ACDV's CRA-assigned Response Due Date governs; it is carried on the receipt event as `response_due_on`
  o("FCRA_1681S2B_ACDV_RESPONSE_DUE", { anchorField: "response_due_on", why: "§8.2 timer table: anchor 'ACDV `responseDueDate` (CRA-assigned)', offset '0 (due at the payload date, 23:59 ET)', satisfied by '`credit.dispute.acdv.responded` (RESOLVED-SENDINGTOAGENCY)' — `ingestAcdv` validates the ACDV and carries its Response Due Date as `response_due_on` (rule 1: 'the ACDV's `responseDueDate` governs (never later than the CRA's 30/45-day outer bound)'); the `eoscar.acdv.find/view/validate/submit{submit}` tool emits the satisfier through `acdvResponded`." });
  // ---- rule 1: the CRA's outer bound — 30 calendar days from `cra_received_at`, 45 when the ACDV carries consumer-supplied information
  o("FCRA_1681I_A1_CRA_OUTER_30_45", { anchorField: "cra_outer_bound_on", offset: "0 calendar_days", why: "§8.2 timer table: anchor '`cra_received_at` (else ACDV create date)', offset '30 `calendar_days` (45 if the ACDV indicates consumer-supplied information)' — the grammar cannot hold the conditional offset, so `ingestAcdv` computes `cra_outer_bound_on` = `cra_received_at` + 30 (+45 with `consumer_supplied_information`; 15 U.S.C. §1681i(a)(1)(A)–(B)) and the row is due on that date (worked example: CRA received 2027-09-12 → 2027-10-12)." });
  // ---- §1022.43(e)(3): supplementation within the 30 days replaces the 30-day clock with 45 from the original receipt
  o("FCRA_1022_43E_DIRECT_RESULTS_EXT_45", { trigger: "`credit.dispute.direct.supplemented{within_30=true}`", anchorField: "received_at", why: "§8.2 timer table: trigger '`credit.dispute.direct.supplemented` within the 30 days', anchor '`received_at` date', 45 `calendar_days`, 'replaces the 30 when triggered' — `supplementDirectDispute` emits the event with `within_30` and the ORIGINAL `received_at` (rule 1: supplementation on 2027-09-20 of a 2027-09-03 receipt → `extended_to` 2027-10-18) and cancels the open FCRA_1022_43E_DIRECT_RESULTS_30 instance; a supplementation after day 30 opens a new case instead (edge case) and arms nothing here." });
  // ---- §1681s-2(a)(3): the XB flag holds from receipt (any channel) until no dispute on the loan is open
  o("FCRA_1681S2A3_XB_FLAG_GATE", { trigger: "`credit.dispute.received`", anchorField: "received_at", satisfied: "`credit.dispute.closed{open_disputes_remaining=0}`", why: "§8.2 timer table: trigger '`credit.dispute.*.received`', anchor 'receipt', offset 'until `closed`' — the event matcher honours only a trailing wildcard, so `ingestAcdv` and `receiveDirectDispute` both emit `credit.dispute.received{source, ccc=XB, ccc_via}` next to their channel events; rule 6: 'On receipt (any channel): XB … from the next furnishing' and the flag clears only on close, so the gate is satisfied by the close that leaves `open_disputes_remaining=0` (`closeDispute`); breach column: '8.1 generator must carry XB … `metro2.file.render` asserts' → `xbGateAssertion`." });
  // ---- §1681s-2(b)(1)(D): AUDs to every other bureau within 2 BD of a data-changing response
  o("FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2", { trigger: "`credit.dispute.responded{determination∈{modified, deleted_account, deleted_consumer, unverifiable}}`", anchorField: "submitted_at", satisfied: "`eoscar.aud.submitted{fan_out_complete=true}`", why: "§8.2 timer table: trigger '`credit.dispute.responded` with determination ∈ {modified, deleted_*}', anchor `submitted_at`, 2 `business_days_servicer`, satisfied by '`eoscar.aud.submitted` to every other bureau that received the data' — `acdvResponded` / `sendResultsNotice` emit `credit.dispute.responded{determination, submitted_at, aud_to}` (rule 3(iii): `unverifiable` deletes/modifies the item, so it fans out too); `submitAudFanOut` validates and submits one AUD per required bureau and marks the last of the set `fan_out_complete=true`, so a single bureau's AUD never closes the clock (worked example: submitted Wed 2027-09-22 → AUDs to Equifax/TransUnion/Innovis by Fri 2027-09-24)." });
  // ---- reviewer SLA: the request timestamp is the anchor
  o("SM_DISPUTE_REVIEW_SLA_BD1", { anchorField: "requested_at", why: "§8.2 timer table: trigger '`credit.dispute.review_requested`', anchor 'request', 1 `business_days_servicer`, satisfied by 'reviewer action' — `investigate` emits the request with `requested_at` and the escalation package (AI agent design: 'Reviewer SLA 1 BD; the timers keep running'); `recordReview` (a human_agent/officer actor) emits `credit.dispute.reviewed`." });
}
