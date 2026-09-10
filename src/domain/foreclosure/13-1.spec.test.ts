// 13.1 120-day pre-foreclosure prohibition
// spec/sections/13-foreclosure/13-1-120-day-pre-foreclosure-prohibition.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 13.1-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.1-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.1-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.1-T4: Given occupancy unknown, Then treated as principal residence; escalation to `human_agent` if the model concludes otherwise with confidence 0.85.", { todo: true });
test("13.1-T5: Given complete application received day 100 and determination \"ineligible\" sent day 118 with 14-day appeal window, When referral attempted day 121, Then refused by `REGX_1024_41F2_PRE_FILING_APP_GATE` until day 133 (window expiry) or appeal denial.", { todo: true });
test("13.1-T6: Given a due-on-sale violation recorded by `officer` with counsel memo at day 60, When `foreclosure.first_notice.authorize{ground=due_on_sale}`, Then allowed; When `{ground=default}`, Then refused.", { todo: true });
test("13.1-T7: Given NY property, day 121 reached but \u00a71304 notice mailed only 50 days ago, Then referral allowed (policy) but `first_notice.authorize` refused by `STATE_PREFC_NOTICE_GATE:NY` until day 90 after mailing and \u00a71306 filing evidenced.", { todo: true });
test("13.1-T8: Given a referral attempt while the gate is closed, Then command refused, `foreclosure.gate.refused` written, sev-1 escalation, and no message leaves for the attorney network.", { todo: true });
test("13.1-T9: Given rule set flipped to `regx.lossmit.2024nprm` on an effective date, Then evaluations after that date reference the new gate codes and a diff report is produced.", { todo: true });
test("13.1-T10: Given a transfer-in with transferor first filing evidenced, Then no second \"first notice\" is authorized and the 7.1 statement flag is true from boarding.", { todo: true });
