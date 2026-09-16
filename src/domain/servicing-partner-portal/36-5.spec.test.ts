// 36.5 Home, the daily report and the two-mode loan page
// spec/sections/36-servicing-partner-portal/36-5-partner-home-reports-two-mode-loan-page.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("36.5-T1: Home counts equal 36.3 counts + 36.4 in-flight for the same `as_of`.", { todo: true });
test("36.5-T2: Daily report for the partner matches 34.3 `bookDailyReport` for that `partner_party_id` (same ids, same counts). No other partner’s report is listed.", { todo: true });
test("36.5-T3: Loan page for a monitored loan shows banner `Monitored — {partner} remains servicer`, no Pay control, and `serviced.available === false`.", { todo: true });
test("36.5-T4: Loan page for a boarded refinance shows banner `Active — Supermortgage subservicing` and `serviced.code === \"SERVICED_PANE_NOT_BUILT\"` in V1.", { todo: true });
test("36.5-T5: A `partner_auditor` can GET home, eligibility, pipeline, reports, and loan pages, and cannot POST imports.", { todo: true });
