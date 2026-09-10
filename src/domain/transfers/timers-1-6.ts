/**
 * §1.6 timer overrides (process-owned; the §1 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 1.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Rows that need no override (the emitter in src/app/tools/section1-6.ts / src/domain/transfers/ops-1-6.ts spells the
 * registry pattern exactly): SM_RECON_WIRE_MATCH_1 (`recon.wires.matched`), SM_RECON_VARIANCE_SLA_5
 * (`recon.variance.raised` → `recon.variance.resolved`), FNMA_F1_11_FINAL_ACCOUNTING_30 and SM_ADVANCE_REIMBURSE_TRANSFEROR_30
 * (`transfer.final_accounting.received` → `ledger.posted{advance_reimbursement_out}`), SM_ESCROW_COMPUTATION_YEAR_DECISION_30
 * (`loan.boarded{escrowed}` → `escrow.computation_year.decided`), REGX_1024_17E_INITIAL_ESCROW_STMT_60
 * (`escrow.terms.changed_at_transfer`; its `notice.sent{template=…}` satisfier is the §1 override). The section file already
 * carries SM_RECON_LOAN_LEVEL_T0 (evaluator gate) and SM_RECON_FNMA_POSITION_EOM (`fnma_position_deadline` anchor).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_1_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- inherited unapplied review: the 6.5 register spells an item's resolution `suspense.item.closed`
  o("SM_UNAPPLIED_INHERITED_REVIEW_60", { satisfied: "`suspense.item.closed`",
    why: "§1.6 timer table: satisfied by '`suspense.item.resolved` (6.5)' — the 6.5 suspense register emits an item's resolution as `suspense.item.closed{status ∈ applied, applied_to_oldest, returned, refunded, transferred, written_off}` on the loan (src/app/tools/section06.ts emitSuspenseTransition); the boarded unapplied balance is the `suspense_items` row 1.6 seeds at boarding (postOpeningEntries op=seed_inherited_unapplied, reason_code=inherited_unapplied) and 6.5 resolves it through its own tools (A2-7-03: the transferee must 'review its subsequent collection of funds from borrowers to ensure accurate accounting')." });
  // ---- advances reimbursement: the row anchors on the final accounting's receipt, which the event carries as `received_on`
  o("SM_ADVANCE_REIMBURSE_TRANSFEROR_30", { anchorField: "received_on",
    why: "§1.6 timer table: anchor 'receipt' of `transfer.final_accounting.received` — the event carries the transferor's delivery date as `received_on` (F-1-11: 'the transferee servicer must reimburse the transferor servicer once it receives a final accounting'; +30 calendar days is the funds-transfer agreement default)." });
}
