/**
 * §17.3 gate evaluators, keyed "17.3.<name>". Every key must be named by an
 * `evaluator:` override in timers-17-3.ts and vice versa (src/app/app.test.ts checks both).
 *
 *  - noeRfiWithinPostTransferTail: REGX_1024_35G_NOE_TAIL_1Y — a notice of error / information
 *    request about Supermortgage's servicing received ≤ T + 1 year runs the 4.1/4.2 clocks; after
 *    T + 1 year it is `untimely` (§1024.35(g)(1)(iii), §1024.36(f)(1)(v)).
 *  - retentionFloorElapsed: REGX_1024_38C1_RETENTION_1Y — no purge / de-identification before
 *    T + 1 year (§1024.38(c)(1)); `transfer_out_archive` (retain_until) and any legal hold extend it.
 *  - supportWindowOpen: SM_XFER_OUT_SUPPORT_WINDOW_90 — the 90-day support window (days 1–90 after
 *    `transfer_date`): forwarding daily and transferee requests at 5 BD while open; after it forward
 *    on receipt and answer within 10 BD (decision 3).
 */
import { ok, no, b, s, addYears, addDays, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

const date = (v: string): PlainDate => v as PlainDate;

export const EVALUATORS_17_3: Record<string, Evaluator> = {
  "17.3.noeRfiWithinPostTransferTail": (f) => {
    const received = s(f, "received_on"), T = s(f, "transfer_date");
    if (!received || !T) return no("received_on and transfer_date are required to test the one-year tail");
    const tailEnd = addYears(date(T), 1);
    return received <= tailEnd ? ok : no(`untimely: received ${received} more than one year after the ${T} transfer (tail ended ${tailEnd}; §1024.35(g)(1)(iii) / §1024.36(f)(1)(v)) — send the (g)(2)/(f)(2) notice`);
  },
  "17.3.retentionFloorElapsed": (f) => {
    const today = s(f, "today"), T = s(f, "transfer_date");
    if (!today || !T) return no("today and transfer_date are required to test the retention floor");
    if (b(f, "legal_hold")) return no("legal hold: no purge or de-identification while the hold is open");
    const floor = addYears(date(T), 1); const retainUntil = s(f, "retain_until") || floor; const until = retainUntil > floor ? retainUntil : floor;
    return today > until ? ok : no(`no purge before ${until} (§1024.38(c)(1) one-year floor${retainUntil > floor ? `; transfer_out_archive retain_until ${retainUntil}` : ""})`);
  },
  "17.3.supportWindowOpen": (f) => {
    const today = s(f, "today"), T = s(f, "transfer_date");
    if (!today || !T) return no("today and transfer_date are required to test the support window");
    const end = addDays(date(T), 90);
    return today <= end ? ok : no(`support window closed ${end} (transfer_date + 90 days): forward on receipt, answer transferee requests within 10 business days (decision 3)`);
  },
};
