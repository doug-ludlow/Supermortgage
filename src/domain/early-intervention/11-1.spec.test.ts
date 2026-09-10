// 11.1 Live contact
// spec/sections/11-early-intervention-collections/11-1-live-contact.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 11.1-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.1-T5: Given the borrower calls in on day 20 and completes a verified conversation, then the window is `satisfied_live` with `basis=borrower_initiated` and the Fannie Mae plan records an inbound contact.", { todo: true });
// 11.1-T6 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T7 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.1-T8: Given a Chapter 7 discharge, then no window ever reopens for (a) after the case closes, even on new delinquency; a later partial payment triggers the 11.2 notice path only.", { todo: true });
test("11.1-T9: Given `lossmit.ongoing_contact` active from day 30 to day 70, then windows maturing in that span are `satisfied_ongoing_lossmit`; after cure and re-delinquency, new windows require fresh efforts.", { todo: true });
test("11.1-T10: Given a mobile number with no `tcpa_voice` consent, when the planner selects a channel, then AI voice is refused (`TCPA_64_1200_A1_CELL_CONSENT_GATE`) and a human manual-dial task is created.", { todo: true });
test("11.1-T11: Given an inbound SMS \"STOP\", then `consent.revoked` is committed within 1 minute, all AI voice/SMS to that number are blocked, one confirmation text is sent within 5 minutes, and `TCPA_64_1200_A10_REVOCATION_HONOR_10BD` is satisfied immediately.", { todo: true });
test("11.1-T12: Given property in America/New_York and area code in America/Los_Angeles, when dialing at 20:45 ET, then the call is refused (17:45 PT is allowed but 20:45 ET exceeds the 20:30 voice policy); at 11:00 ET (08:00 PT) it is refused for PT; at 12:00 ET it is permitted.", { todo: true });
test("11.1-T13: Given the Reg F scenario in rule 10, then counts are B=1,2,2,2,3,4 and C=1 in order; the 12-15 callback is `regf_exclusion=consent_within_7d`; an attempted 8th counted call to B within 7 days is refused.", { todo: true });
test("11.1-T14: Given a conversation on 12-11 with no callback consent, when a dial to B is requested 12-16, then refused by `REGF_1006_14_POST_CONVERSATION_7`; permitted 12-18.", { todo: true });
test("11.1-T15: Given last attempt Thu 2026-11-19 and the servicer closed Thu 11-26 (Thanksgiving), then `FNMA_D2202_OUTBOUND_EVERY_7` due 11-26 shifts to Fri 11-27.", { todo: true });
test("11.1-T16: Given a judicial sale scheduled 2027-06-15, then outbound attempts are refused from 2027-04-16; given `contact_required_through_sale` for the state, then permitted with a logged basis.", { todo: true });
test("11.1-T17: Given a promise to pay by 2026-12-28 recorded 12-11, then the plan is `ceased{ptp_pending}`; when no covering payment exists at 12-29 00:05, then `promise_to_pay.broken` and the plan resumes the same day.", { todo: true });
test("11.1-T18: Given `live_contact.ai_voice_counts=false` for state XX, when the AI completes a QRPC dialog on day 22, then `live_contact=false`, `SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD` is due day 31, and a human-verified join on the same call sets a second `contacts` row with `live_contact=true`.", { todo: true });
test("11.1-T19: Given the borrower says \"I want a person,\" then a warm transfer starts within 10 s, `human_transfer_requested=true`, and the call's live-contact status is determined by the human leg.", { todo: true });
test("11.1-T20: Given transfer-in on 2026-10-01 with earliest unpaid due 2026-08-01 (61 days), then window(Aug 1) is `breached_at_boarding`, window(Sep 1) live due 2026-10-07, and a human call task is due 2026-10-03.", { todo: true });
test("11.1-T21: Given a landline with no written consent, when a 4th AI-voice call in 30 days is requested, then refused and routed to human dial.", { todo: true });
test("11.1-T22: Given an investment property, then no Reg X window is created (`not_applicable`) but `FNMA_D2202_OUTBOUND_START_36` and the 7-day cadence run.", { todo: true });
test("11.1-T23: Given a two-party-consent state, then the recording disclosure is present in the first 15 s of every recorded call transcript (automated check, 100 %).", { todo: true });
test("11.1-T24: Given `payment.reversed` (NSF) on 2026-12-15 for the Dec 10 application, then installment Nov 1 reopens, window(Nov 1) notice leg is reinstated with `cancel_reason` cleared and `notice_due_at` unchanged (2026-12-16), and 11.2 issues the notice by 12-16 if not already sent.", { todo: true });
