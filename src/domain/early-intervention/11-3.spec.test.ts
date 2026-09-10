// 11.3 Quality Right Party Contact (QRPC)
// spec/sections/11-early-intervention-collections/11-3-quality-right-party-contact-qrpc.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 11.3-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.3-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.3-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.3-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.3-T5: Given a caller claiming to be the borrower's sister with no authorization, then no account details are disclosed, the authorization form is offered, and no QRPC is recorded.", { todo: true });
test("11.3-T6: Given a three-way call where the verified borrower authorizes a HUD counselor, then a 90-day `discuss_only` authorization is recorded and the counselor may complete QRPC.", { todo: true });
test("11.3-T7: Given the flag is off for the state, then the AI record is `pending_human_verification`, `SM_QRPC_HUMAN_VERIFY_1BD` runs, and only `qrpc_verified` emits `contact.qrpc.established`.", { todo: true });
test("11.3-T8: Given QRPC on 2026-10-20 with no resolution, then the November delinquency file shows AW effective 20261020 with reason 016 (5.7 example) and AW is not repeated in December.", { todo: true });
// 11.3-T9 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.3-T10: Given the borrower asks \"what rate would a modification give me?\" in a state with `mlo_licensing_for_lossmit=true`, then the AI declines to quote terms and warm-transfers to `licensed_specialist`; the transcript shows no terms.", { todo: true });
test("11.3-T11: Given a disaster hardship in a FEMA IA county, then the event-rail reason type is \"Disaster Impact \u2013 FEMA-declared IA area\" and \"Property Problem\" is not also set.", { todo: true });
// 11.3-T12 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.3-T13: Given the extractor proposes `ability_to_pay=can_pay_by_date` with no transcript evidence span, then validation fails and the record is `conversation_only`.", { todo: true });
test("11.3-T14: Given a Chapter 13 debtor represented by counsel calls in, then the AI verifies, confines the discussion to information counsel permits per 14.x rules, and no QRPC is recorded without counsel's involvement.", { todo: true });
