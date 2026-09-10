/**
 * §19.2 gate evaluators, keyed "19.2.<name>". Every key must be named by an
 * `evaluator:` override in timers-19-2.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { tlsCipherOk } from "./incident.ts";

export const EVALUATORS_19_2: Record<string, Evaluator> = {
  /** FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF: CTL-SEC-03 passes only when every enabled cipher is ECDHE-GCM (Technology Guide profile, cutoff 2026-10-23). Facts: { ciphers: string[] }. */
  "19.2.tlsProfileEcdheGcmOnly": (f) => {
    const ciphers = arr<string>(f, "ciphers");
    if (ciphers.length === 0) return no("CTL-SEC-03: no cipher inventory presented (fail-closed)");
    const bad = ciphers.filter((x) => !tlsCipherOk(x));
    return bad.length === 0 ? ok : no(`CTL-SEC-03: non-ECDHE-GCM cipher(s) still enabled: ${bad.join(", ")}`);
  },
};
export const kit_19_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
