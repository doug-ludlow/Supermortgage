/**
 * §13.8 gate evaluators, keyed "13.8.<name>". Every key must be named by an `evaluator:` override in
 * timers-13-8.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_13_8: Record<string, Evaluator> = {
  /**
   * SCRA_3931_AFFIDAVIT_GATE (§13.8 timer table: "affidavit executed by `signing_officer` on certificates ≤30 days old
   * (policy) and filed" → "motion instruction refused"). Facts from `affidavitGateFacts_13_8` (src/app/tools/section13-8.ts):
   * the newest affidavit executed on/after the firm's judicial proposal, its certificate age at execution, the executing
   * role and whether the firm's filing evidence is on file. Graded reasons name the missing step for the refusal trail.
   */
  "13.8.affidavitOnFreshCertificates": (f) => {
    if (!s(f, "affidavit_id")) return no("no §3931 affidavit executed for the proposed default-judgment/dispositive motion — a signing_officer executes it on certificates ≤30 days old after the records review, then the firm files it");
    if (!(n(f, "certificate_age_days") <= 30)) return no(`DMDC certificates ${s(f, "certificate_age_days")} days old at execution — never older than 30 days (13.8 rule 5)`);
    if (s(f, "executed_by_role") !== "signing_officer") return no("only a signing_officer executes the §3931 affidavit (13.8 rule 5)");
    if (!b(f, "filed")) return no("affidavit executed but not filed — the motion instruction is released only on the firm's filing evidence (scra.affidavit.filed; 13.8-T5)");
    return ok;
  },
};
export const kit_13_8 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
