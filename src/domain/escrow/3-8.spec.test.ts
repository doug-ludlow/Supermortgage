// 3.8 Escrow waiver administration
// spec/sections/03-escrow-administration/3-8-escrow-waiver-administration.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.8-T1: Given the worked-example loan at UPB $240,000 (HPML), then decision = denied with reason HPML_LTV_GE_80_ORIG_VALUE and a re-request date.", { todo: true });
test("3.8-T2: Given UPB $239,900, no lates in 24 months, no prior mod, annual MI, no flood, then approved; effective next due date \u2265 15 days; refund within 30 days; short-year statement within 60 days; escrow event to balance 0.", { todo: true });
test("3.8-T3: Given one 30-day delinquency 8 months ago, then denied DELINQ_12M; given a 60-day delinquency 20 months ago, then denied DELINQ_60D_24M.", { todo: true });
test("3.8-T4: Given monthly borrower-paid MI, then the MI line is excluded from the waiver and the decision is partial.", { todo: true });
test("3.8-T5: Given `flood_escrow_mandatory=true`, then the flood line cannot be waived.", { todo: true });
test("3.8-T6: Given an advance for unpaid taxes on a waived loan on 2027-12-11, then the waiver is revoked the same day, the account is established with the deficiency, and the initial statement timer is due 2028-01-25.", { todo: true });
test("3.8-T7: Given a Flex Mod trial offer being prepared for a waived loan current on T&I, then the exception is documented and the offer proceeds; given T&I delinquent, then the offer is blocked until escrow is established.", { todo: true });
test("3.8-T8: Given a Minnesota loan reaching its 5th anniversary, then the right-to-discontinue notice is sent within 60 days; a written election with no >30-day delinquency in 12 months is approved even if the Fannie Mae 80% test fails (per open question 1 default).", { todo: true });
test("3.8-T9: Given an Illinois loan at 64% of original amount by timely payments and not in default, then the termination election is approved.", { todo: true });
test("3.8-T10: Given any outbound script, then a content test confirms no waiver solicitation language.", { todo: true });
