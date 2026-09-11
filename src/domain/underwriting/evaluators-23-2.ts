/**
 * §23.2 gate evaluators, keyed "23.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-23-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   23.2.homeownershipEducationGate  FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE — facts: `basis` (requirement_basis), `records[]`
 *                                    (homeownership_education_records rows: status, borrower_id, …), `closing_date`, `as_of`.
 *                                    Open when the basis is `none` or at least one record is `verified`; otherwise blocked
 *                                    (CTC_EDUCATION_NOT_VERIFIED) and `reason` names the underwriting_reviewer escalation
 *                                    when closing is < 3 creditor business days away.
 *   23.2.counselingCredit12m         FNMA_B5_6_01_COUNSELING_CREDIT_12M — facts: `completed_on`, `closing_date`. Open (credit
 *                                    applies, SFC 184) when completed_on ≥ closing − 12 calendar months and ≤ closing.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { homeownershipEducationGate, counselingCredit12m, type EducationRecord, type RequirementBasis } from "./ops-23-2.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASES: readonly RequirementBasis[] = ["homeready_all_ftb", "ltv_over_95_all_ftb", "du_no_tradelines", "none"];

export const EVALUATORS_23_2: Record<string, Evaluator> = {
  "23.2.homeownershipEducationGate": (f) => {
    const basis = s(f, "basis") || "none";
    if (!(BASES as readonly string[]).includes(basis)) return no(`FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE: unknown requirement basis ${basis}`);
    const as_of = s(f, "as_of"); if (!DATE.test(as_of)) return no("FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE: as_of (PlainDate) required");
    const closing = s(f, "closing_date");
    const r = homeownershipEducationGate({ basis: basis as RequirementBasis, records: arr<EducationRecord>(f, "records"), closing_date: DATE.test(closing) ? (closing as PlainDate) : null, as_of: as_of as PlainDate });
    return r.open ? ok : no(`${r.reason}${r.escalate ? ` → escalate ${r.escalate}` : ""}`);
  },
  "23.2.counselingCredit12m": (f) => {
    const completed = s(f, "completed_on"), closing = s(f, "closing_date");
    if (!DATE.test(completed) || !DATE.test(closing)) return no("FNMA_B5_6_01_COUNSELING_CREDIT_12M: completed_on and closing_date (PlainDate) required");
    const r = counselingCredit12m(completed as PlainDate, closing as PlainDate);
    return r.satisfied ? ok : no(`FNMA_B5_6_01_COUNSELING_CREDIT_12M: counseling completed ${completed} is outside the 12-month window before closing ${closing} (opens ${r.window_opens}) — no SFC 184, credit not applied`);
  },
};
export const kit_23_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
