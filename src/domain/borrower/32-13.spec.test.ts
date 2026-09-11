// 32.13 Cross-cutting: acceptance harness, copy library rules, side-quest catalogue
// spec/sections/32-borrower-experience/32-13-cross-cutting-acceptance-harness-copy-library-rules-side-que.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.13-T1: Disclosure first — Given any new session on app, voice or SMS, then `lead.disclosure.delivered` precedes any other assistant content (32.3-T1 generalized to servicing sessions: `consent.ai_disclosure.acknowledged` per session).", { todo: true });
test("32.13-T2: No invented dates — Given any Dates row rendered, then its `timer_code` is in the 32.2 §4 allow-list and `due_at` equals `timers.due_at`.", { todo: true });
test("32.13-T3: Serializer allow-list — Given every `/v1/borrower/*` response schema, then no field name from `du_findings_interpretations`, `risk_assessment`, `credit_reports.*` (except score-notice fields), `compliance_test_runs`, `qc_*`, `fraud_*`, `applicant_demographics` appears.", { todo: true });
test("32.13-T4: Consent precedes e-delivery — Given any `DocumentCard` with `disclosure_id`, then a `consents{kind=esign, status=active}` row scoped to the disclosure class exists for that party at `delivered_at`.", { todo: true });
test("32.13-T5: Cards commit, chat doesn't — Given a borrower message whose text matches a pending card's affirmative (e.g., \"yes proceed\", \"lock it\", \"I agree\"), then no command executes and the reply contains the deep link.", { todo: true });
test("32.13-T6: Party scoping — Given a co-borrower session, then the Record shows the other party's first name and `progress` booleans only; `applicant_demographics`, income and liabilities of the other party never appear.", { todo: true });
test("32.13-T7: Voice never consents — Given any `ConsentCard`, when a voice session affirms, then the card stays `pending` and the invitation link is sent.", { todo: true });
test("32.13-T8: Talk to a person — Given any screen, then a control emitting `human.request` is visible without scrolling; after `human.transfer.completed`, a `PersonCard{human_agent}` exists.", { todo: true });
test("32.13-T9: Money and rates — Given any rendered amount, then it is produced from cents via `Intl.NumberFormat` and any rate from a decimal string; no float arithmetic in the client.", { todo: true });
test("32.13-T10: Mobile parity — Given every card kind at 390 px, then it is operable and the status strip shows badge, next event and the needed-from-you count.", { todo: true });
test("32.13-T11: Deep links — Given an SMS deep link opened without a session, then L1 is required before any loan data renders; the token resolves to the card and expires at 7 days.", { todo: true });
test("32.13-T12: Degraded vendor — Given Truv returns an error, then the `ConnectCard` shows `failed` with the upload fallback and no error code is shown to the borrower.", { todo: true });
test("32.13-T13: Reading level — Given every string in 12 outside notice templates, then its Flesch-Kincaid grade ≤ 8.", { todo: true });
test("32.13-T14: Forbidden words — Given every string in 12, then none of the forbidden words appears outside its allowed keys.", { todo: true });
test("32.13-T15: Nothing-needed — Given zero `owner=you` items, then the nothing-needed state renders and no reminder is sent.", { todo: true });
test("32.13-T16: Read-only after terminal — Given `denied | withdrawn | closed_incomplete | rescinded | paid_in_full → closed | transferred_out`, then no command except `case.open`, `human.request`, document download and contact update succeeds.", { todo: true });
