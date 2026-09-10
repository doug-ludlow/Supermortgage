// 13.2 Dual-tracking restriction
// spec/sections/13-foreclosure/13-2-dual-tracking-restriction.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 13.2-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T2: Given T1 and a determination \"ineligible\" sent Oct. 10 with no appeal right (tier <90), Then hold closes Oct. 10; certification permitted inside Oct. 19\u201327.", { todo: true });
// 13.2-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T4: Given a pending summary-judgment motion when the application arrives, Then `WITHDRAW_MOTION`/`REQUEST_CONTINUANCE` instruction issued; court rules anyway \u2192 compliance evidence = instruction + firm's filed request; no breach.", { todo: true });
// 13.2-T5 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T6: Given MN property, application (incomplete) received before referral, Then `foreclosure.refer` refused while pending.", { todo: true });
test("13.2-T7: Given a `POSTPONE_SALE` instruction not acknowledged in 1 BD, Then `attorney` escalation and phone task created; DRA reconciliation flags absence of a postponement event after 2 BD.", { todo: true });
// 13.2-T8 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T9: Given the certification window opens and the DMDC re-check shows active duty, Then certification withheld (13.8), postponement instructed.", { todo: true });
test("13.2-T10: Given rescission after a sale held in violation, Then 15.1 rescission flow and A1-4.2-02 fee exposure recorded.", { todo: true });
