/**
 * §20.1 gate evaluators, keyed "20.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-20-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts come from the opportunity / gate context (ops-20-1.ts checkGates): `{ declined_on, as_of, days }`,
 * `{ offered_at[], as_of, max_offers_per_loan_per_12m }`, `{ note_date, new_note_date }`, `{ title_date,
 * disbursement_date, exception }`, `{ pass, factors }` or the raw borrower's-interest inputs.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { resolicitCooldownGateFacts, offerFrequencyCapGateFacts, cashoutNoteSeasoningGateFacts, titleSeasoningGateFacts, borrowerInterestGateFacts } from "./ops-20-1.ts";

export const EVALUATORS_20_1: Record<string, Evaluator> = {
  /** SM_REFI_RESOLICIT_COOLDOWN_90 (rule 9; T7): open once declined_on + 90 calendar days has passed; the borrower-request path never consults it. */
  "20.1.resolicitCooldownGate": (f) => resolicitCooldownGateFacts(f),
  /** SM_REFI_OFFER_FREQUENCY_CAP (rule 9): at most `max_offers_per_loan_per_12m` offers per rolling 12 months. */
  "20.1.offerFrequencyCapGate": (f) => offerFrequencyCapGateFacts(f),
  /** FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M (worked example 2; T4): new note date ≥ existing note date + 12 months. */
  "20.1.cashoutNoteSeasoningGate": (f) => cashoutNoteSeasoningGateFacts(f),
  /** FNMA_B2_1_3_03_TITLE_SEASONING_6M: on title ≥ 6 months before the new loan's disbursement (inheritance / legal award / delayed financing excepted). */
  "20.1.titleSeasoningGate": (f) => titleSeasoningGateFacts(f),
  /** MA_183_28C_BORROWER_INTEREST_60M (worked example 3; T6): inside the 60-month window the refinance must carry a borrower's-interest factor. */
  "20.1.borrowerInterestGate": (f) => borrowerInterestGateFacts(f),
};
