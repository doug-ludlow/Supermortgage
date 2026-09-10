/**
 * §14.2 gate evaluators, keyed "14.2.<name>". Every key must be named by an
 * `evaluator:` override in timers-14-2.ts and vice versa (src/app/app.test.ts checks both).
 *
 * `14.2.rule3002_1NoticesCeaseAfterRelief` — `SM_BK_3002_1_RELIEF_CEASE_CHECK`. Rule 3002.1(a): "Unless the court orders
 * otherwise, the requirements of this rule cease when an order terminating or annulling the automatic stay related to that
 * residence becomes effective." Policy 14.2-Q2: continue filing (b)/(c) notices while the case is open unless counsel
 * advises the district treats it as improper — so the gate is OPEN (filings continue) by default after a relief order and
 * closes only when the case is closed/dismissed or counsel confirms the notices must cease. This definition supersedes the
 * inline placeholder in src/app/evaluators.ts (the section map is spread after it), which closed the gate on any relief order.
 * Facts come from `reliefOrderDecision(...).gate_facts`, recorded on `bk_rule3002_1_scope` by
 * `bk.change.detect op=docket_event kind=relief_order_entered` and read back by every later `bk.change.detect`.
 *
 * `14.2.noB4MotionBeforeDueDate` — `FRBP_3002_1B4_OBJECTION_WINDOW`. Rule 3002.1(b)(4): a party in interest may move to
 * determine the change's validity "before the day the new payment is due"; "if no motion is filed before the day the new
 * payment is due, the change goes into effect on that date." The gate is CLOSED (the prior amount bills) while a motion
 * docketed before the due date is pending; it is OPEN when no motion was docketed, when the motion came on or after the
 * due date (the change took effect), or once the court's order is entered (the order's figures apply — `determined`).
 * Facts come from `b4MotionHold(...).gate_facts` / `effectiveOnDueDate(...).gate_facts`, recorded on the notice row's
 * `objection` by `bk.change.detect op=docket_event kind=objection_to_payment_change` and evaluated by `op=effective`.
 */
import { ok, no, b, s, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_14_2: Record<string, Evaluator> = {
  "14.2.rule3002_1NoticesCeaseAfterRelief": (f) => {
    if (!b(f, "relief_order_entered")) return ok;
    if (b(f, "court_orders_continued_compliance")) return ok;
    if (!b(f, "case_open")) return no(`relief order entered ${s(f, "relief_order_entered_on") || "(date not stated)"} and the case is closed/dismissed: Rule 3002.1 requirements ceased (Rule 3002.1(a)); no further (b)/(c) filings`);
    if (b(f, "counsel_advises_improper")) return no(`relief order entered ${s(f, "relief_order_entered_on") || "(date not stated)"} and counsel advises the district treats continued Rule 3002.1 notices as improper: cease filing (14.2-Q2 exception)`);
    return ok;   // default (14.2-Q2): keep filing (b)/(c) notices while the case is open — harmless, avoids disputes if the relief order is later vacated
  },
  "14.2.noB4MotionBeforeDueDate": (f) => {
    if (!b(f, "b4_motion_docketed")) return ok;
    if (b(f, "court_order_entered")) return ok;
    const on = s(f, "b4_motion_docketed_on"), due = s(f, "effective_due_date");
    if (on && due && on >= due) return ok;   // a motion on/after the due date does not hold the change: it went into effect on that date (Rule 3002.1(b)(4))
    return no(`Rule 3002.1(b)(4) motion docketed ${on || "(date not stated)"}${due ? ` before the due date ${due}` : ""}: hold the payment at the old amount until the court's order`);
  },
};
