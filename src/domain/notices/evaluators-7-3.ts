/**
 * §7.3 gate evaluators, keyed "7.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-7-3.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there. ops-7-3.ts asserts both gates at its
 * command boundaries with the payload of the event that arms them (`arm.initial_notice.render_requested`,
 * `notice.render_requested{template=NTC_REGZ_20D_ARM_INITIAL}`), so the gate that holds a render is the same
 * function the TimerEngine's instance points at (`evaluator:7.3.…`).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

/** REGZ_1026_20D_ESTIMATE_INDEX_15BD — §1026.20(d)(2): the estimate "shall be based on the calculation of the index … within fifteen business days prior to the date of the disclosure" (servicer calendar; 7.3 rule 3 / T3). */
export const INDEX_RECENCY_BUSINESS_DAYS = 15;
export const EVALUATORS_7_3: Record<string, Evaluator> = {
  "7.3.indexRecentEnoughForEstimate": (f) => {
    const age = n(f, "index_age_business_days");
    if (Number.isNaN(age)) return no("no index publication on or before the disclosure date — hold; refresh index (§1026.20(d)(2))");
    return atMost(age, INDEX_RECENCY_BUSINESS_DAYS, "index age in business days at disclosure (§1026.20(d))");
  },
  /** SM_ARM_INITIAL_SEPARATE_DOC_GATE — comment 20(d)-3: the disclosures "shall be provided as a separate document" (own PDF; own first page; may share an envelope). */
  "7.3.separateDocumentEnforced": (f) => (b(f, "separate_document") ? ok : no("§1026.20(d) notice must be its own document (notice_templates.separate_document = true)")),
};
export const kit_7_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
