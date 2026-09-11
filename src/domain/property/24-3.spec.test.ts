// 24.3 Property and project eligibility (property types, condo/PUD project review incl. CPM and deferred-maintenance rules, manufactured housing, ADUs, condition ratings, escrow holdbacks, new construction, zoning/environmental)
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-3-property-and-project-eligibility-property-types-condo-pud-pr.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("24.3-T1: Given the 40-unit Phoenix project (Branch A) with an application date of Oct 5, 2026, then all Full Review tests pass, `reserve_pct = 0.1042`, `project_type_code = S`, and `expires_at = 2027-10-09` after CPM certification on Oct 9, 2026.", { todo: true });
test("24.3-T2: Given the same project with an application date of Jan 4, 2027 and no reserve study, then the review fails on reserves (10.42% < 15%) and the decision cites LL-2026-03.", { todo: true });
test("24.3-T3: Given Branch B (engineer's report with active water intrusion) and the $2,400/unit assessment, then `project.ineligible.determined` fires with reason \"special assessment associated with unremediated critical repair\", and the application cannot pass `consummate`.", { todo: true });
test("24.3-T4: Given a 6-unit attached project not in a master association, then `review_type = waived`, `project_type_code = V`, and the B2-3/ineligible-characteristics checks still run; given the same project inside a master association, then Full Review is required.", { todo: true });
test("24.3-T5: Given an application dated Jul 31, 2026 in a Limited-Review-eligible project, then `limited_legacy` is allowed; dated Aug 3, 2026 \u2192 not allowed.", { todo: true });
test("24.3-T6: Given the C5 appraisal in R5 with a safety-related deck item, then the deck cannot enter a holdback, delivery is blocked until the Completion Report (received Nov 16, 2026) is accepted, and the paint item produces `escrow_cents = 384,000` with `completion_due_on = 2027-05-17`.", { todo: true });
test("24.3-T7: Given a C6 rating, then `result = ineligible` until a \"subject to\" appraisal and completion evidence show \u2265 C5; given Q6 with no safety items, then eligible.", { todo: true });
test("24.3-T8: Given a leasehold with lease expiry Dec 31, 2061 and loan maturity Dec 1, 2056, then the lease-term test passes (\u2265 5 years); expiry Nov 30, 2061 \u2192 fails.", { todo: true });
test("24.3-T9: Given a manufactured home built May 1, 1976, then ineligible; built Jul 1, 1976 with labels reported and affidavit of affixture, MH Advantage sticker verified \u2192 eligible with SFC 859.", { todo: true });
test("24.3-T10: Given a 1-unit purchase with a permitted ADU leased at 150,000 cents/month and total qualifying income of 1,000,000 cents/month, then usable ADU rent = min(112,500, 300,000) = 112,500 cents; on a cash-out refinance, ADU rent is not usable.", { todo: true });
test("24.3-T11: Given a holdback established Nov 18, 2026 with no completion by May 17, 2027, then `holdback.overdue` fires May 18, 2027 with an `officer` escalation.", { todo: true });
test("24.3-T12: Given CPM status \"Unavailable\" recorded by the operator, then `result = ineligible` regardless of the lender's own analysis.", { todo: true });
