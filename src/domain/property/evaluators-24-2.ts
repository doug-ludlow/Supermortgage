/**
 * §24.2 gate evaluators, keyed "24.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-24-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   24.2.regbCopy3bdGate     REGB_1002_14_APPRAISAL_COPY_3BD_GATE — facts: `consummation_date`, `latest_version_provided_on`
 *                            (null until the latest version is provided; mailed copies use ops-24-2.ts providedOn), optional
 *                            `waiver_obtained_on`, `copy_at_or_before_consummation`. Closed → reason names the earliest consummation.
 *   24.2.waiver3bdGate       REGB_1002_14_WAIVER_3BD_GATE — facts: `consummation_date`, `waiver_obtained_on`.
 *   24.2.ucdpSuccessfulGate  FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE — facts: `fnma_status` (successful | not_successful | pending),
 *                            `doc_file_id`, `is_final_version`, `command` (submitDelivery gates; other commands pass).
 *   24.2.rovClosingGate      FNMA_B4_1_3_12_ROV_CLOSING_GATE — facts: `consummated`, `requested_by` (borrower | lender).
 *   (REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD keeps 23.4.hpmlAppraisalCopy3bd — the same hpmlAppraisalCopyGate ops-24-2.ts re-exports.)
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { regBCopyGate, waiverDecision, rovClosingGate } from "./ops-24-2.ts";

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dateOrNull = (f: Record<string, unknown>, k: string): PlainDate | null => (isDate(f[k]) ? (f[k] as PlainDate) : null);

export const EVALUATORS_24_2: Record<string, Evaluator> = {
  "24.2.regbCopy3bdGate": (f) => {
    const consummation_on = dateOrNull(f, "consummation_date");
    if (!consummation_on) return no("REGB_1002_14_APPRAISAL_COPY_3BD_GATE: consummation_date required");
    const r = regBCopyGate({ consummation_on, latest_version_provided_on: dateOrNull(f, "latest_version_provided_on"), waiver_obtained_on: dateOrNull(f, "waiver_obtained_on"), copy_at_or_before_consummation: b(f, "copy_at_or_before_consummation") });
    return r.open ? ok : no(r.reason!);
  },
  "24.2.waiver3bdGate": (f) => {
    const consummation_on = dateOrNull(f, "consummation_date"), obtained_on = dateOrNull(f, "waiver_obtained_on");
    if (!consummation_on || !obtained_on) return no("REGB_1002_14_WAIVER_3BD_GATE: a dated borrower statement (waiver_obtained_on) and consummation_date are required");
    const r = waiverDecision({ obtained_on, consummation_on });
    return r.accepted ? ok : no(r.reason);
  },
  "24.2.ucdpSuccessfulGate": (f) => {
    const command = s(f, "command") || "submitDelivery";
    if (command !== "submitDelivery") return ok;
    if (f.is_final_version === false) return no("FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE: the final version used in the underwriting decision must be the one submitted (B4-1.1-06)");
    if (s(f, "fnma_status") !== "successful") return no(`FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE: Fannie Mae UCDP status is ${s(f, "fnma_status") || "pending"}, not Successful — delivery blocked (29.4) until the hard stops are corrected or overridden by a fnma_portal_operator`);
    if (!s(f, "doc_file_id")) return no("FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE: Doc File ID not stored");
    return ok;
  },
  "24.2.rovClosingGate": (f) => {
    const r = rovClosingGate({ consummated: b(f, "consummated"), requested_by: s(f, "requested_by") === "lender" ? "lender" : "borrower" });
    return r.open ? ok : no(r.reason!);
  },
};
export const kit_24_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
