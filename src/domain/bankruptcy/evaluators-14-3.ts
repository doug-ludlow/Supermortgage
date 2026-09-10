/**
 * §14.3 gate evaluators, keyed "14.3.<name>". Every key must be named by an
 * `evaluator:` override in timers-14-3.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_14_3: Record<string, Evaluator> = {
  /**
   * REGX_1024_39C2_RESUME_GATE — §1024.39(c)(2)(i): after dismissal, closure or reaffirmation the 11.1 live-contact and 11.2
   * written-notice clocks re-arm only "after the next payment due date that follows" the event. The facts are the payload of
   * the `bankruptcy.early_intervention.evaluated{timer=REGX_1024_39C2_RESUME_GATE}` event bk.statement_mode.set publishes
   * (`resume_from_due_date` from ops-14-3.ts earlyInterventionResume, `status`, `debt_discharged`, `reaffirmed`) plus `today`.
   * The gate opens the day after the due date — "after" it, the same line the communications matrix draws (ops-14-3.ts
   * communicationsMatrix suppresses collection communications through the due date; T9/T12: dismissed 2027-06-05 → due
   * 2027-07-01 → open from 2027-07-02). A discharge without reaffirmation never re-opens live contact — the written notice
   * re-arms on a payment through REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE instead ((c)(2)(ii)).
   */
  "14.3.earlyInterventionResumeGate": (f) => {
    if (b(f, "debt_discharged") && !b(f, "reaffirmed")) return no("discharged without reaffirmation: live contact never resumes; the written notice re-arms only on a payment (§1024.39(c)(2)(ii))");
    const due = s(f, "resume_from_due_date"), today = s(f, "today");
    if (!due) return no("resume_from_due_date not computed — the next payment due date after the dismissal/closure/reaffirmation (§1024.39(c)(2)(i))");
    if (!today) return no("today not supplied");
    return today > due ? ok : no(`11.1/11.2 stay exempt through the next payment due date ${due} that follows the ${s(f, "status") || "dismissal"}; the clocks re-arm from that due date and compliance resumes after it (§1024.39(c)(2)(i))`);
  },
};
export const kit_14_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
