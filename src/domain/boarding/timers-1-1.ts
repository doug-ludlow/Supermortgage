/**
 * §1.1 timer overrides (process-owned; the §1 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 1.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * The other 1.1 rows need no re-spelling: `transfer.tape.received{kind=…}` (BoardingService.ingestTape),
 * `loan.staged` / `loan.boarded` (stage / board), `loan.boarding_exception.raised{severity=hard}` /
 * `.resolved` (validate, raiseException, applyCorrection, proposeWaiver), `investor_events.acked{type=EscrowSetup,
 * every_category=true}` (recordEscrowSetupAck; section override in ./timers.ts), `transfer.batch.cutover_completed`
 * (completeCutover) and `transfer.batch.closed` (1.2 TransferBatchService) are emitted as the registry spells them.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_1_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // MERS registration of an unregistered loan: the platform has one MERS acknowledgment event, `mers.txn.accepted`, carrying
  // the transaction in `txn_type` (1.5 data model mers_transactions.txn_type; inbound.ts recordMersAcknowledgement). The 1.1
  // row's `mers.registration.confirmed` is that acknowledgment for a `registration` transaction.
  o("MERS_PROC_REGISTER_UNREGISTERED_7", { satisfied: "`mers.txn.accepted{txn_type=registration}`",
    why: "§1.1 timer table: trigger '`loan.boarded{min is null, mers_eligible=true}`', anchor `transfer_date` +7 calendar_days, satisfied by '`mers.registration.confirmed`' — MERS Procedures Manual Release 24.2: \"registered on MERS® System no later than seven (7) calendar days after the date upon which the purchaser begins servicing the loan\"; the registration acknowledgment is `mers.txn.accepted{txn_type=registration}` (1.5)." });
}
