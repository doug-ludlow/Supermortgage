// 36.6 The post-refinance serviced pane contract: dark in V1, one refusal everywhere
// spec/sections/36-servicing-partner-portal/36-6-post-refinance-serviced-pane-contract.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("36.6-T1: Given a monitored loan, `GET /v1/partner/loans/:id/serviced` is `409 SERVICED_PANE_NOT_BUILT`.", { todo: true });
test("36.6-T2: Given an `active` boarded loan for this partner, the same endpoint is still `409 SERVICED_PANE_NOT_BUILT` in V1, and the loan page banner is already `Active`.", { todo: true });
test("36.6-T3: 36.6 introduces **no** new money field, timer, or notice.", { todo: true });
