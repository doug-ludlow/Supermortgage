/**
 * §22.1 gate evaluators, keyed "22.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-22-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * The predicates are ops-22-1.ts gateResult() over the facts the tools assemble from the application's documents:
 *   22.1.creditDocs4m   { relied_documents: ReliedDocument[], scheduled_note_date }            B1-1-03 four months at the note date (most-recent-document rule)
 *   22.1.paystubFloor   { initial_application_date | application_date, paystubs: PaystubEvidence[] }   B3-3.2-01: pay date ≥ initial application date − 30 days, with YTD earnings
 *   22.1.taxYear        { application_date, scheduled_disbursement_date, returns, extension_evidence, tax_liability_comparison_recorded, irs_no_transcript_response_recorded, form_4506c_signed }
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { gateResult } from "./ops-22-1.ts";

const via = (code: Parameters<typeof gateResult>[0]): Evaluator => (f) => { const r = gateResult(code, f); return r.open ? ok : no(r.reason ?? "closed"); };

export const EVALUATORS_22_1: Record<string, Evaluator> = {
  "22.1.creditDocs4m": via("FNMA_B1_1_03_CREDIT_DOCS_4M"),
  "22.1.paystubFloor": via("FNMA_B3_3_2_01_PAYSTUB_30D_GATE"),
  "22.1.taxYear": via("FNMA_B1_1_03_TAX_YEAR_GATE"),
};
export const kit_22_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
