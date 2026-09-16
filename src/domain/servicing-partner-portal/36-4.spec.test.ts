// 36.4 The refinance pipeline feed: members in motion, projected from the rows that already exist
// spec/sections/36-servicing-partner-portal/36-4-refinance-pipeline-feed.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("36.4-T1: Given a monitored loan with `refi_opportunities.status=offered`, then it appears on the pipeline as `offered` and also remains on Eligible now.", { todo: true });
test("36.4-T2: Given that homeowner’s Yes (`engaged`) and a 33.3 readiness row with missing items, then the pipeline stage is `readiness` and `missing` is the 33.3 item list.", { todo: true });
test("36.4-T3: Given offer expiry via `expireOffers`, then the item’s current stage is `expired` and a subsequent 33.2 run is free to write `not_now` with cooldown.", { todo: true });
test("36.4-T4: Given a boarded new loan linked from the old monitored loan (35.10 / `prior_loan_id`), then the pipeline item is `boarded`, the old loan banner is paid off / refinanced, and the new loan banner is `Active — Supermortgage subservicing`.", { todo: true });
test("36.4-T5: Partner B cannot see partner A’s pipeline items (404 / absent).", { todo: true });
