/**
 * §15.2 gate evaluators, keyed "15.2.<name>". Every key must be named by an
 * `evaluator:` override in timers-15-2.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

const ESCROW_CUTOFF_DAYS = 14;
/** Advance kinds the F-1-05 14-day post-event cut-off governs (insurance and HOA advances). */
export const CUTOFF_ADVANCE_KINDS: ReadonlySet<string> = new Set(["hazard", "flood", "hoa", "escrow_hazard", "escrow_flood"]);
/** Advance kinds the cut-off does not govern (taxes, MI, inspections, preservation, legal, …) — the gate passes them by name; anything else fails closed. */
export const NON_CUTOFF_ADVANCE_KINDS: ReadonlySet<string> = new Set(["taxes", "escrow_tax", "mi_premium", "inspection", "preservation", "attorney_fee", "attorney_fee_fcl", "attorney_fee_bk", "attorney_cost", "legal_cost", "technology", "technology_fee", "einvoice", "einvoice_fee", "registration", "utilities", "recording", "valuation", "mediation", "workout_expense", "mortgage_release_doc", "code_violation", "other"]);

export const EVALUATORS_15_2: Record<string, Evaluator> = {
  /**
   * FNMA_F105_ESCROW_ADV_CUTOFF_14 (not_after gate, F-1-05): insurance and HOA advances are reimbursable
   * "for a period of up to 14 days after" the foreclosure sale / Mortgage Release acceptance / short-sale
   * closing / TPS completion (legal date). Facts: `legal_date`, `paid_on`, `advance_kind` (the advance's kind —
   * deliberately not `kind`, which on the arming `claim.milestone.reached` fact is the milestone kind). A named
   * non-escrow advance kind passes; an escrow/HOA kind, or an unknown/absent one, is held to the cut-off (fails closed).
   * Invoked by validateLine152 for every hazard/flood/HOA line (the validateLine / assembleClaim tools), not only annotated on the instance.
   */
  "15.2.escrowAdvanceWithinCutoff": (f) => {
    const advanceKind = s(f, "advance_kind");
    if (advanceKind && NON_CUTOFF_ADVANCE_KINDS.has(advanceKind) && !CUTOFF_ADVANCE_KINDS.has(advanceKind)) return ok;
    const legal = s(f, "legal_date"), paid = s(f, "paid_on");
    if (!legal || !paid) return no("legal_date and paid_on are required to apply the 14-day post-event cut-off (F-1-05)");
    const cutoff = addDays(legal as PlainDate, ESCROW_CUTOFF_DAYS);
    return paid <= cutoff ? ok : no(`post_sale_nonreimbursable: advance paid ${paid} is ${daysBetween(cutoff, paid as PlainDate)} day(s) after the cut-off ${cutoff} (legal date ${legal} + 14; F-1-05)`);
  },
};
export const kit_15_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
