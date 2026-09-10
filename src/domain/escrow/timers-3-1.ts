/**
 * §3.1 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The facts named here are appended by src/domain/escrow/ops-3-1.ts (readBoardingFile),
 * ./ops.ts recordStatementSent (sendNotice) and §1.6's escrowContinuityDecision (src/domain/transfers/ops-1-6.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The column's parenthetical "(reason settlement or post-settlement)" is a payload condition: the transfer-in reason belongs to the 60-day code below, so it must not arm this one. The 3.1 settlement path (ops-3-1 verifyInitialStatementEvidence) emits reason=settlement anchored on `settlement_date`; the 3.8 revocation path (section03 postAdvance) emits reason=post_settlement.
  o("REGX_1024_17G_INITIAL_STMT_45", { trigger: "`escrow.initial_statement.required{reason∈{settlement, post_settlement}}`", satisfied: "`escrow.statement.sent{statement_type=initial}`",
    why: "§3.1 timer table: `escrow.initial_statement.required` (reason settlement or post-settlement) → `settlement_date` or `escrow_accounts.established_at` + 45 calendar days 23:59; satisfied by `escrow.statement.sent` (statement_type=initial) — recordStatementSent carries `statement_type`, so an annual or short-year send never closes the (g) row." });
  // "`transfer.in.completed` with payment/method change" is the loan-level fact §1.6 emits only when the payment or the accounting method changes: `escrow.terms.changed_at_transfer{payment_changed, method_changed, transfer_date}` (ops-1-6 escrowContinuityDecision; 1.6 rule 3). Its `transfer_date` is the transfer effective date the row anchors on ((e)(1)(i): the new computation year starts there).
  o("REGX_1024_17E_TRANSFER_INITIAL_STMT_60", { trigger: "`escrow.terms.changed_at_transfer`", anchorField: "transfer_date", satisfied: "`escrow.statement.sent{statement_type=initial}`",
    why: "§3.1 timer table: `transfer.in.completed` with payment/method change → transfer effective date + 60 calendar days (§1024.17(e)(1)); satisfied by `escrow.statement.sent` (initial). The platform spells the trigger `escrow.terms.changed_at_transfer` (Section 1.6's continuity decision, emitted only on a payment or method change) with the effective date as `transfer_date`; 3.1's readBoardingFile turns it into `escrow.initial_statement.required{reason=transfer_in}` (the state machine's `required`), which by design does not arm the 45-day code." });
  // The column names two closing facts and the grammar takes one pattern: both outcomes of the evidence check share the `escrow.initial_statement.` prefix (verifyInitialStatementEvidence / readBoardingFile emit exactly `.evidence_verified` or `.required`).
  o("ESC_BOARDING_EVIDENCE_CHECK_5BD", { satisfied: "`escrow.initial_statement.*`",
    why: "§3.1 timer table: `loan.boarded` → `boarded_at` + 5 business_days_servicer; satisfied by `escrow.initial_statement.evidence_verified` or `.required` — the two outcomes of the boarding-file evidence check (3.1 state machine: pending_evidence_check → satisfied_by_originator | required)." });
}
