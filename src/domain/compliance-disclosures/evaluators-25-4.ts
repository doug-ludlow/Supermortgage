/**
 * §25.4 gate evaluators, keyed "25.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-25-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   25.4.privacyGateOpen          — GLBA_1016_4_INITIAL_PRIVACY_GATE (not_before_gate): every customer borrower has
 *                                   `disclosures{kind=privacy}.delivered_at ≤ consummation_at` (21.3's evidence or the notice
 *                                   acknowledged in the closing package). Facts: `borrowers[]{borrower_id, privacy_delivered_at,
 *                                   customer}`, `consummation_at`.
 *   25.4.closingPackageGateOpen   — SM_O64_CLOSING_PACKAGE_NOTICES_GATE (not_before_gate): the run is `gated` — every required
 *                                   item rendered from the consummation_ready CD version, CD-escrow consistency `match`.
 *                                   Facts: `status`, `cd_status`, `consistency_result`, `required_items_rendered`.
 *   25.4.utReserveOptionsGateOpen — UT_7_17_4_RESERVE_OPTIONS_NOTICE_GATE: notice delivered at or prior to the closing and
 *                                   `escrow_elections.elected_at ≤ consummation_at`. Facts: `property_state`, `notice_delivered_on`,
 *                                   `elected_at`, `consummation_at`.
 *   25.4.caImpoundStmtGateOpen    — CA_CIV_2954_IMPOUND_STMT_GATE: the written statement delivered before or with the election
 *                                   whenever it is required. Facts: `property_state`, `required`, `statement_delivered_on`, `elected_at`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { checkPrivacyNotice, closingPackageGate, utReserveOptionsGate, caImpoundStmtGate, type BorrowerPrivacyFact } from "./ops-25-4.ts";

const optStr = (f: Record<string, unknown>, k: string): string | null => (f[k] === undefined || f[k] === null ? null : String(f[k]));

export const EVALUATORS_25_4: Record<string, Evaluator> = {
  "25.4.privacyGateOpen": (f) => {
    const borrowers = arr<BorrowerPrivacyFact>(f, "borrowers").map((x) => ({ borrower_id: String(x.borrower_id), privacy_delivered_at: x.privacy_delivered_at ? String(x.privacy_delivered_at) : null, customer: x.customer !== false }));
    if (!borrowers.length || !f.consummation_at) return no("GLBA_1016_4_INITIAL_PRIVACY_GATE: borrowers[] and consummation_at required");
    const r = checkPrivacyNotice(borrowers, s(f, "consummation_at"));
    return r.result === "open" ? ok : no(`GLBA_1016_4_INITIAL_PRIVACY_GATE closed: no privacy notice evidence ≤ consummation for ${r.missing_borrower_ids.join(", ")} (§1016.4(a)(1))`);
  },
  "25.4.closingPackageGateOpen": (f) => {
    const g = closingPackageGate({ ...(optStr(f, "status") !== null ? { status: s(f, "status") } : {}), ...(optStr(f, "cd_status") !== null ? { cd_status: s(f, "cd_status") } : {}), ...(optStr(f, "consistency_result") !== null ? { consistency_result: s(f, "consistency_result") } : {}), ...(typeof f.required_items_rendered === "boolean" ? { required_items_rendered: f.required_items_rendered } : {}) });
    return g.open ? ok : no(`SM_O64_CLOSING_PACKAGE_NOTICES_GATE closed: ${g.reason}`);
  },
  "25.4.utReserveOptionsGateOpen": (f) => {
    const g = utReserveOptionsGate({ ...(optStr(f, "property_state") !== null ? { property_state: s(f, "property_state") } : {}), notice_delivered_on: optStr(f, "notice_delivered_on"), elected_at: optStr(f, "elected_at"), consummation_at: optStr(f, "consummation_at") });
    return g.open ? ok : no(`UT_7_17_4_RESERVE_OPTIONS_NOTICE_GATE closed: ${g.reason}`);
  },
  "25.4.caImpoundStmtGateOpen": (f) => {
    const g = caImpoundStmtGate({ ...(optStr(f, "property_state") !== null ? { property_state: s(f, "property_state") } : {}), ...(typeof f.required === "boolean" ? { required: f.required } : {}), statement_delivered_on: optStr(f, "statement_delivered_on"), elected_at: optStr(f, "elected_at") });
    return g.open ? ok : no(`CA_CIV_2954_IMPOUND_STMT_GATE closed: ${g.reason}`);
  },
};
export const kit_25_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
