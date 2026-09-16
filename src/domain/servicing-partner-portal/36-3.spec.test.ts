// 36.3 The eligibility board: three buckets projected from the daily review
// spec/sections/36-servicing-partner-portal/36-3-eligibility-board-three-buckets.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("36.3-T1: Given the demo book after a 33.2 daily run, when eligibility is fetched as the partner, then every monitored loan appears in exactly one of the three buckets or Holds, and the sum of counts equals monitored-not-held + held.", { todo: true });
test("36.3-T2: Given a loan whose review verdict is `watching` with `watch_rate_pct` set, then the partner row shows bucket `likely_soon` and that watch rate, and does not show investor, DTI, or score fields.", { todo: true });
test("36.3-T3: Given a loan `excluded` for bankruptcy, then it is `not_near` with the engine reason code, not a free-text diagnosis.", { todo: true });
test("36.3-T4: Given a query `?bucket=eligible_now&state=CA`, then only `candidate` loans in CA return. Adding `?fico=` or `?dti=` is ignored (unknown query keys dropped, not applied).", { todo: true });
test("36.3-T5: Given partner A, when they request eligibility, then partner B’s loans are absent (not empty-with-403).", { todo: true });
