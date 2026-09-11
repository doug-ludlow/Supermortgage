// 32.4 Disclosures, intent to proceed, lock, revised LEs
// spec/sections/32-borrower-experience/32-4-disclosures-intent-to-proceed-lock-revised-les.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.4-T1: Given `consents{esign}` inactive at LE approval, then `disclosure.le.mailed` and the Documents row reads *Mailed {{date}}*; given consent becomes active later, then a re-delivered electronic copy appears as a new row, and the original mailing evidence remains.", { todo: true });
test("32.4-T2: Given an e-mailed LE with no confirmation, then `deemed_received` is set on the third specific business day and the Record shows *(deemed)*.", { todo: true });
test("32.4-T3: Given a companion `hcl` planned with `hud_snapshot_at` 31 days old, then the card is not created until a fresh snapshot exists (21.3 gate).", { todo: true });
test("32.4-T4: Given an ARM selected in R7, then `NTC_REGZ_1026_19B_ARM_PROGRAM` and `NTC_REGZ_1026_19B_CHARM` cards exist before the LE receipt card is shown.", { todo: true });
test("32.4-T5: Given a spoken \"proceed\" on an in-app call after LE receipt, then the pending intent `ChoiceCard` resolves with evidence `{channel=voice, transcript_ref}` and `intent_records.valid=true`.", { todo: true });
test("32.4-T6: Given a lock executed Tue Oct 27, 2026 for 45 days, then Numbers show expiry Fri Dec 11, 2026; `SM_LOCK_EXPIRY_WARN_7` styles the Dates row caution on Fri Dec 4.", { todo: true });
test("32.4-T7: Given a lock expired, then no closing slot `ScheduleCard` can be created until a relock (`SM_O71_DOC_GEN_GATE`), and the Thread explains why.", { todo: true });
test("32.4-T8: Given `changed_circumstances.evaluated_valid{kind=new_info}` 2 specific business days before consummation, then no revised LE issues; the change is `reflected_on_cd` and the Thread message uses `revised_le.on_cd_instead`.", { todo: true });
test("32.4-T9: Given `le_v2` differs from `le_v1` in the appraisal fee, then the What-changed block lists exactly that row with both amounts and the kind label.", { todo: true });
test("32.4-T10: Given `tolerance_tests.refund_required` after consummation, then a `NoticeCard` and a ledger refund appear within 60 days and the borrower took no action.", { todo: true });
