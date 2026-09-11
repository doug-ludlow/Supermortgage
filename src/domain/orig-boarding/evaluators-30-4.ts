/**
 * §30.4 gate evaluators, keyed "30.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-30-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   30.4.retentionClassified — SM_ORIG_RETENTION_CLASSIFY_GATE: every indexed document has `retention_class` ≠ null
 *                              and `retention_anchor_date` set (rule 11; `servicing_handoffs.complete` refused otherwise).
 *   30.4.epdWatchOpen        — SM_ORIG_EPD_WATCH_P6_60: the daily EPD window is open while `as_of` ≤ `epd_watch_until`
 *                              (sixth scheduled due date + 60 calendar days) and the loan is not paid off / transferred.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

interface DocFact { readonly document_id?: string; readonly retention_class?: string | null; readonly retention_anchor_date?: string | null; }

export const EVALUATORS_30_4: Record<string, Evaluator> = {
  "30.4.retentionClassified": (f) => {
    const docs = arr<DocFact>(f, "documents");
    const gaps = docs.filter((d) => !d.retention_class || !d.retention_anchor_date).map((d, k) => d.document_id ?? `#${k + 1}`);
    return gaps.length ? no(`SM_ORIG_RETENTION_CLASSIFY_GATE: ${gaps.length} document(s) without retention_class/retention_anchor_date (${gaps.join(", ")}) — servicing_handoffs.complete refused`) : ok;
  },
  "30.4.epdWatchOpen": (f) => {
    const asOf = s(f, "as_of"), until = s(f, "epd_watch_until");
    if (!asOf || !until) return no("SM_ORIG_EPD_WATCH_P6_60: as_of and epd_watch_until (sixth due date + 60 calendar days) are required");
    const paidOff = s(f, "paid_off_on"), transferred = s(f, "transferred_on");
    if (paidOff && paidOff <= asOf) return no(`SM_ORIG_EPD_WATCH_P6_60: window closed — loan paid off ${paidOff}`);
    if (transferred && transferred <= asOf) return no(`SM_ORIG_EPD_WATCH_P6_60: window closed — loan transferred ${transferred}`);
    return asOf <= until ? ok : no(`SM_ORIG_EPD_WATCH_P6_60: window ended ${until} (epd.watch.closed)`);
  },
};
export const kit_30_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
