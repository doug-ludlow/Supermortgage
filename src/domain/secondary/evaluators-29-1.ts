/**
 * §29.1 gate evaluators, keyed "29.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-29-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   29.1.duApproveWindow        FNMA_C2_1_2_03_DU_APPROVE_60_GATE — facts: `du_recommendation_at`, `executed_at` (or `now`), `underwriting_method`.
 *   29.1.dpaWindow              FNMA_PEWL_DPA_WINDOW_30 — facts: `dpa_exposure_until`, `requested_on`, `same_borrower_property`, `dpa_acknowledged`, `dpa_cost_cents`, `officer_approved`.
 *   29.1.commitAcceptWindow     FNMA_PEWL_COMMIT_ACCEPT_60S — facts: `now`, `quote_expires_at` (API) or `quoted_at` (+ `window_seconds`, UI 60 s).
 *   29.1.dailyLimit             FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE — facts: `executed_today_cents`, `amount_cents`, `daily_limit_cents`.
 *   29.1.beExtensionCap         FNMA_C2_1_2_02_BE_EXTENSION_CAP_30 — facts: `manual_extension_days`, `requested_days`, `closed`.
 *   29.1.mandExtensionCap       FNMA_C2_1_1_04_MAND_EXTENSION_CAP_30 — facts: `manual_extension_days`, `requested_days`.
 *   29.1.mandToleranceGate      FNMA_PEWL_MAND_TOLERANCE_GATE — facts: `original_amount_cents`, `purchased_cents`.
 *   29.1.deliveryCommitmentGate FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY — facts: `expires_on`, `today_et`, `custodian_receipt_possible_on` (29.4).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { beExtensionCapGate, commitAcceptWindowGate, dailyLimitGate, deliveryCommitmentGate, dpaWindowGate, duApproveWindowGate, mandExtensionCapGate, mandToleranceGate } from "./ops-29-1.ts";

const wrap = (g: (f: Record<string, unknown>) => { open: boolean; reason?: string }): Evaluator => (f) => { const r = g(f); return r.open ? ok : no(r.reason ?? "closed"); };
export const EVALUATORS_29_1: Record<string, Evaluator> = {
  "29.1.duApproveWindow": wrap(duApproveWindowGate),
  "29.1.dpaWindow": wrap(dpaWindowGate),
  "29.1.commitAcceptWindow": wrap(commitAcceptWindowGate),
  "29.1.dailyLimit": wrap(dailyLimitGate),
  "29.1.beExtensionCap": wrap(beExtensionCapGate),
  "29.1.mandExtensionCap": wrap(mandExtensionCapGate),
  "29.1.mandToleranceGate": wrap(mandToleranceGate),
  "29.1.deliveryCommitmentGate": wrap(deliveryCommitmentGate),
};
export const kit_29_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
