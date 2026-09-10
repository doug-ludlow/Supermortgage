/**
 * §19.3 gate evaluators, keyed "19.3.<name>". Every key must be named by an
 * `evaluator:` override in timers-19-3.ts and vice versa (src/app/app.test.ts checks both).
 * (`19.3.evalSuitePassedAndInventoryUpdated`, named by the section-level SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY
 * override, lives in src/app/evaluators.ts.)
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { cutoverGate, form101Status, type Form101Row } from "./ops-19-3.ts";

export const EVALUATORS_19_3: Record<string, Evaluator> = {
  /**
   * FNMA_A2107_FORM101_INCEPTION_GATE — Form 101 acknowledged by Fannie Mae (state `acknowledged`/`active`, not terminated)
   * before any Fannie Mae application access under the partner's servicer numbers; otherwise `form101_inactive` (T8).
   * Facts: `form101_status`, or the `data_access_authorizations` row fields (`fnma_ack_at`, `terminated_at`, `termination_submitted_at`).
   */
  "19.3.form101Active": (f) => {
    const given = s(f, "form101_status");
    const row: Form101Row = { servicer_numbers: arr<string>(f, "servicer_numbers"), fnma_ack_at: s(f, "fnma_ack_at") || (b(f, "form101_acknowledged") ? "acknowledged" : null), terminated_at: s(f, "terminated_at") || (b(f, "form101_terminated") ? "terminated" : null), termination_submitted_at: s(f, "termination_submitted_at") || null, submitted_at: s(f, "submitted_at") || null, executed_at: s(f, "executed_at") || null };
    const status = given || form101Status(row);
    if (status === "terminated" || status === "termination_submitted") return no(`form101_inactive: Form 101 is ${status} — Fannie Mae adapters refuse to run under partner scope (A2-1-07; Form TR101 "may be terminated at any time")`);
    if (status === "active" || status === "acknowledged") return ok;
    return no(`form101_inactive: Form 101 is ${status === "drafted" && !given ? "not acknowledged" : status} — Fannie Mae's acknowledgement of the Form 101 is required before any application access under the partner's servicer numbers (A2-1-07; Form TR101)`);
  },
  /**
   * FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180 — not-before gate: a cutover may execute only on or after the written
   * notice date + 180 calendar days (T2: notice 2026-11-02 → 2027-05-01; a 2027-04-01 cutover is rejected).
   * Facts: `notice_sent_at`, `cutover_on` (or `today`).
   */
  "19.3.cutoverGateOpen": (f) => {
    const notice = s(f, "notice_sent_at"); const on = s(f, "cutover_on") || s(f, "today");
    if (!on) return no("cutover date unknown (cutover_on)");
    const g = cutoverGate({ notice_sent_at: notice ? plainDate(notice) : null, cutover_on: plainDate(on) });
    return g.open ? ok : no(g.reason ?? "closed");
  },
};
export const kit_19_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
