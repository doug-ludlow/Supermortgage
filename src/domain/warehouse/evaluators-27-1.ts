/**
 * §27.1 gate evaluators, keyed "27.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-27-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   27.1.ucc1Filed            SM_WH_UCC1_FILING_GATE   — UCC-1 filed and acknowledged; lien search clean (else no advances)
 *   27.1.baileeLetterCovers   SM_WH_BAILEE_LETTER_GATE — bailee_letters.status ∈ {issued, acknowledged} covering the loan; Loan Delivery Letter Name active
 *   27.1.haircutReserveCovers SM_WH_HAIRCUT_RESERVE_GATE — partner_haircut_reserve ≥ partner_contribution_cents
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_27_1: Record<string, Evaluator> = {
  "27.1.ucc1Filed": (f) => {
    if (!s(f, "ucc1_filed_on")) return no("SM_WH_UCC1_FILING_GATE: UCC-1 not filed against the partner in its state of organization (9-307)");
    if (!b(f, "ucc1_acknowledged")) return no("SM_WH_UCC1_FILING_GATE: filing-office acknowledgment not on file");
    if (!b(f, "lien_search_clean")) return no("SM_WH_UCC1_FILING_GATE: lien search on the partner shows a prior lien / double-pledge — no advances until released (9-330(d))");
    return ok;
  },
  "27.1.baileeLetterCovers": (f) => {
    const status = s(f, "bailee_letter_status");
    if (status !== "issued" && status !== "acknowledged") return no(`SM_WH_BAILEE_LETTER_GATE: bailee letter status ${status || "(none)"} is not issued/acknowledged`);
    if (!b(f, "loan_on_letter")) return no("SM_WH_BAILEE_LETTER_GATE: the loan is not on the bailee letter's loan list");
    if (!b(f, "letter_name_active")) return no("SM_WH_BAILEE_LETTER_GATE: Loan Delivery Letter Name is not active in SM's warehouse-lender org");
    return ok;
  },
  "27.1.haircutReserveCovers": (f) => (c(f, "partner_haircut_reserve_cents") >= c(f, "partner_contribution_cents") ? ok : no(`SM_WH_HAIRCUT_RESERVE_GATE: partner haircut reserve ${c(f, "partner_haircut_reserve_cents")} < partner contribution ${c(f, "partner_contribution_cents")} — advance held; partner asked to fund; 26.3 informed`)),
};
export const kit_27_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
