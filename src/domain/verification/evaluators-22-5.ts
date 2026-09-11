/**
 * §22.5 gate evaluators, keyed "22.5.<name>". Every key must be named by an `evaluator:` override in
 * timers-22-5.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * The predicates live in ops-22-5.ts; the facts are the DTI version's figures (`dti_bps`), the payoff plan(s) with
 * their verified funds and settlement-statement evidence, the liability rows with `remaining_months` against the
 * `scheduled_note_date`, the legal / IRS documents on file, and the final version against the current included set.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { duCapGate, payoffFundsGate, tenMonthRemainingRule, legalDocGate, irsAgreementGate, liabilityRecalcGate } from "./ops-22-5.ts";

export const EVALUATORS_22_5: Record<string, Evaluator> = {
  /** FNMA_B3_6_01_LIABILITY_RECALC_GATE (B3-6-01 / R9): the final DTI version carries the current included set and terms, post-dates the last change and matches the final DU submission. */
  "22.5.liabilityRecalcGate": (f) => liabilityRecalcGate(f),
  /** FNMA_B3_6_02_DU_DTI_50_GATE (B3-6-02): `dti_bps ≤ 5000`. */
  "22.5.duDti50Gate": (f) => duCapGate(f),
  /** FNMA_B3_6_07_PAYOFF_FUNDS_GATE (B3-6-07): verified funds ≥ payoff in addition to closing funds and reserves; settlement-statement line or pre-closing payoff/zero-balance evidence. */
  "22.5.payoffFundsGate": (f) => payoffFundsGate(f),
  /** FNMA_B3_6_05_10MO_REMAINING_RULE (B3-6-05): remaining months recomputed as of the scheduled note date; > 10 included, ≤ 10 excluded unless significantly_affects. */
  "22.5.tenMonthRemainingRule": (f) => tenMonthRemainingRule(f),
  /** FNMA_B3_6_05_LEGAL_DOC_GATE (B3-6-05): decree / separation agreement / court order confirming the amount. */
  "22.5.legalDocGate": (f) => legalDocGate(f),
  /** FNMA_B3_6_05_IRS_AGREEMENT_GATE (B3-6-05, SEL-2026-05): approved agreement + current payments (or pending application), no lien in the subject county, payment included unless paid in full. */
  "22.5.irsAgreementGate": (f) => irsAgreementGate(f),
};
export const kit_22_5 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
