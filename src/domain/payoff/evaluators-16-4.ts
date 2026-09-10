/**
 * §16.4 gate evaluators, keyed "16.4.<name>". Every key must be named by an
 * `evaluator:` override (this section's timers.ts / timers-16-4.ts) and vice versa (src/app/app.test.ts checks both).
 *
 * "16.4.allCountiesRecorded" backs `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE`. It is defined here (spread into
 * the aggregate map after the section-level entry in src/app/evaluators.ts, so this definition wins) over the
 * rule-1 predicate shared with the tool guardrail: closed with *no* release task (no recording evidence), with any
 * county not `recorded`/`third_party_recorded`, or with a third-party recording not yet verified against the land
 * records — the spec's "never deactivate before recording evidence".
 */
import { ok, no, s, arr, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { releaseRecordedGate, type ReleaseTask } from "./ops-16-4.ts";

export const EVALUATORS_16_4: Record<string, Evaluator> = {
  "16.4.allCountiesRecorded": (f) => {
    const r = releaseRecordedGate({ release_tasks: arr<ReleaseTask>(f, "release_tasks"), chargeoff_release_recorded_on: (s(f, "chargeoff_release_recorded_on") || null) as PlainDate | null });
    return r.open ? ok : no(r.reason ?? "release not recorded");
  },
};
export type { PlainDate };
