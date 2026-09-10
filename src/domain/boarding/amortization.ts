/**
 * 1.1 rule HF-005 companion: the principal portion of the tape P&I against
 * the scheduled interest, and the W-014-class interest-method review when the
 * transferor's history disagrees by a cent (30/360 vs actual/365).
 */
import type { Cents } from "../../kernel/money/cents.ts";

export interface PrincipalPortion { readonly principal_portion_cents: Cents; readonly expected_upb_after_next_payment_cents: Cents; readonly review: "W-014" | null; readonly review_reason: string | null; }
export function principalPortion(upbCents: Cents, tapePiCents: Cents, scheduledInterestCents: Cents, historyPrincipalCents?: Cents): PrincipalPortion {
  const principal = tapePiCents - scheduledInterestCents;
  const diff = historyPrincipalCents === undefined ? 0n : historyPrincipalCents - principal;
  const off = diff < 0n ? -diff : diff;
  return {
    principal_portion_cents: principal, expected_upb_after_next_payment_cents: upbCents - principal,
    review: off === 0n ? null : "W-014",
    review_reason: off === 0n ? null : `history shows principal ${historyPrincipalCents} vs computed ${principal} (${off} cent(s)): interest-method review (30/360 vs actual), not a hard fail`,
  };
}
