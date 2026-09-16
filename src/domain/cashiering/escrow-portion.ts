/**
 * The escrow portion of an installment (3.6's effective-dated `loan_terms` version with its step-down, else the boarded
 * terms) — shared by the runtime's cash state (src/runtime/servicing.ts) and 35.5's installment schedule.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export interface EscrowTerms { readonly escrow_payment_cents: Cents; readonly escrow_version: { escrow_payment_cents: Cents; effective_from: PlainDate; step_down_on: PlainDate | null; step_down_to_cents: Cents | null } | null; }

/** The escrow portion of the installment due on `due`: the 3.6 loan_terms version from its effective date (and the step-down after the plan) else the boarded terms. */
export function escrowPortionOn(terms: EscrowTerms, due: PlainDate): Cents {
  const v = terms.escrow_version;
  if (v && due >= v.effective_from) { if (v.step_down_on && due >= v.step_down_on && v.step_down_to_cents !== null) return v.step_down_to_cents; return v.escrow_payment_cents; }
  return terms.escrow_payment_cents;
}
