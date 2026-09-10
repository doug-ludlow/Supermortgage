// 11.4 FDCPA compliance
// spec/sections/11-early-intervention-collections/11-4-fdcpa-compliance.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 11.4-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.4-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.4-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.4-T4: Given the B-1 mortgage variant, then the itemization lines sum: 31,254,022 + 123,811 + 16,500 \u2212 0 \u2212 0 = 31,394,333 cents = $313,943.33 and the checklist passes; given the (c)(5) substitute, then the latest statement is attached and referenced.", { todo: true });
test("11.4-T5: Given a written dispute received 2026-10-20, then `collection_ceased_at` is set, an outbound collection call on 10-21 is refused, statements still generate, and after verification mails 2026-11-05 collection resumes.", { todo: true });
test("11.4-T6: Given an EI notice due during the validation period, then the template check refuses a version demanding payment \"within 10 days\" and accepts the standard MS-4 version with the \u00a71006.18(e) fragment.", { todo: true });
test("11.4-T7: Given a written cease from the borrower on a DC loan, then 11.1's plan is `suspended{cease_request}`, the 11.2 variant switches to `fdcpa` (190-day cycle), the cease acknowledgement is sent once, and a borrower-initiated call about a modification is answered fully.", { todo: true });
test("11.4-T8: Given an oral \"stop calling me,\" then voice/SMS/email stop within 1 minute, mail continues, the EI variant stays standard, and the transcript shows the written-request explanation.", { todo: true });
test("11.4-T9: Given an attorney letter of representation, then direct communications are refused, counsel receives the communications, and after 30 days of documented non-response direct contact re-opens with a decision record.", { todo: true });
test("11.4-T10: Given the validation notice mailed 2026-10-02 with no undeliverability notice by 2026-10-16, then `furnishing_gate_open_at`=2026-10-16 and 8.x may furnish; given a conversation on 2026-10-05, then the gate opens 2026-10-05.", { todo: true });
test("11.4-T11: Given an SMS to a consented number last RND-checked 70 days ago and no inbound text in 60 days, then the send is refused until a fresh RND check.", { todo: true });
test("11.4-T12: Given any DC-loan email, then the opt-out statement is present and the subject line contains no debt reference (automated check, 100 %).", { todo: true });
test("11.4-T13: Given a voicemail on a DC loan, then only the LCM template is used (business name, request to reply, agent name, number); a message mentioning \"your mortgage payment\" is refused.", { todo: true });
test("11.4-T14: Given a deceased borrower reported by a neighbor, then no debt information is disclosed, location information for the estate may be requested, and communications wait for an executor/successor (4.4).", { todo: true });
test("11.4-T15: Given the AI persona \"Ava,\" then the assumed name is in the registry and every DC-loan call transcript shows \"Ava with Supermortgage\u2026 this communication is from a debt collector.\"", { todo: true });
test("11.4-T16: Given a CA loan boarded current, then Reg F is not applicable but the Rosenthal overlay enforces quiet hours and harassment rules in the Contact Engine.", { todo: true });
