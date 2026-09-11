/**
 * §29.3 gate evaluators, keyed "29.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-29-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   29.3.earlycheckClean        FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE — facts: `run_clean`, `run_file_sha256`, `uldd_sha256`, `run_file_kind` (same file, same hash).
 *   29.3.duFileEarlycheck       FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE — facts: `du_file_run_clean`, `du_file_run_sha256`, `du_spec_file_sha256`.
 *   29.3.identifierConsistency  FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE — facts: `mismatches[]` (R3 a–q), `identifier_snapshot_complete`.
 *   29.3.sfcCompleteness        FNMA_C1_2_02_SFC_COMPLETENESS_GATE — facts: `sfc_count`, `contradictions[]`, `required_missing[]` (≤ 10, none contradictory).
 *   29.3.sfc067Consistency      FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE — facts: `borrower_score_models[]`, `sfc_codes[]`.
 *   29.3.valueAcceptanceSfc     FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE — facts: `valuation_method`, `offer_date`, `note_date`, `sfc_codes[]`.
 *   29.3.packageFreeze          SM_O103_PACKAGE_FREEZE_GATE — facts: `uldd_sha256`, `clean_run_sha256`, `gate_results{code: open|closed|n/a}`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { earlycheckCleanGate, duFileEarlycheckGate, identifierConsistencyGate, sfcCompletenessGate, packageFreezeGate, sfc067Gate, valueAcceptanceGate, type ScoreModel } from "./ops-29-3.ts";

const wrap = (g: (f: Record<string, unknown>) => { open: boolean; reason?: string | null }): Evaluator => (f) => { const r = g(f); return r.open ? ok : no(r.reason ?? "closed"); };
export const EVALUATORS_29_3: Record<string, Evaluator> = {
  "29.3.earlycheckClean": wrap(earlycheckCleanGate),
  "29.3.duFileEarlycheck": wrap(duFileEarlycheckGate),
  "29.3.identifierConsistency": wrap(identifierConsistencyGate),
  "29.3.sfcCompleteness": wrap(sfcCompletenessGate),
  "29.3.sfc067Consistency": wrap((f) => sfc067Gate({ credit: { borrowers: arr<string>(f, "borrower_score_models").map((m, i) => ({ borrower_id: String(i), score_model: m as ScoreModel })), representative_score: 0, selection_method: "" } }, arr<string>(f, "sfc_codes"))),
  "29.3.valueAcceptanceSfc": wrap((f) => valueAcceptanceGate({ valuation: { method: s(f, "valuation_method") || "traditional", offer_date: s(f, "offer_date") ? plainDate(s(f, "offer_date").slice(0, 10)) : null, property_data_id: null, special_feature_codes: [] }, note_date: plainDate((s(f, "note_date") || "1970-01-01").slice(0, 10)) }, arr<string>(f, "sfc_codes"))),
  "29.3.packageFreeze": wrap(packageFreezeGate),
};
export const kit_29_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
