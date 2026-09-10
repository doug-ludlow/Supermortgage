// 13.6 Default-related law-firm management
// spec/sections/13-foreclosure/13-6-default-related-law-firm-management.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 13.6-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.6-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.6-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.6-T4 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.6-T5: Given a proposed suspension, Then implementation blocked until 5 BD after Fannie Mae notice with plan.", { todo: true });
// 13.6-T6 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.6-T7: Given a `POSTPONE_SALE` instruction acknowledged but no DRA \"sale postponed\" event after 2 BD, Then exception raised, firm call task, and 13.5 credit marked \"DRA unverified.\"", { todo: true });
test("13.6-T8: Given a matter completed through confirmation, Then 100% fee approved; before confirmation the 95% cap holds (\"cannot be considered to be earned until ... confirmation\").", { todo: true });
// 13.6-T9 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.6-T10: Given a firm scorecard in the bottom band two months running, Then risk-triggered review scheduled and `officer` informed.", { todo: true });
