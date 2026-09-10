// 3.7 Tax disbursement
// spec/sections/03-escrow-administration/3-7-tax-disbursement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.7-T1: Given the $760 bill due 2027-12-10 with 2% discount to 11/30 and balance $810 on 11/24, then release 2027-11-26, amount $744.80, `confirmed` by 12/02, and no penalty.", { todo: true });
test("3.7-T2: Given balance $500 on the funds check, then advance $260, disbursement $760 released on time, loan escrow \u2212$260, event balance \u2212260.00 accepted (T&I negative allowed).", { todo: true });
test("3.7-T3: Given a jurisdiction with no annual discount and no installment fee, then the scheduler pays installments; given a 3% annual discount and sufficient funds, then it pays annually unless a borrower preference says installments.", { todo: true });
test("3.7-T4: Given a hazard renewal due 2027-10-01 for a borrower 45 days overdue with no cancellation notice and no vacancy, then the premium is paid/advanced and the LPI gate remains closed.", { todo: true });
test("3.7-T5: Given an insurer cancellation notice citing \"underwriting\" received 2027-09-15, then `inability_to_disburse=true` with the (k)(5)(ii)(A) reason recorded and the LPI gate opens for Section 9.2.", { todo: true });
test("3.7-T6: Given a deposit processed Thursday 2027-07-15 at 18:00 ET, then the event deadline is Friday 2027-07-16 03:00 ET; processed Friday 2027-07-16 \u2192 deadline Monday 2027-07-19 03:00 ET; processed Friday before a Fannie Mae Monday holiday \u2192 Tuesday 03:00 ET.", { todo: true });
test("3.7-T7: Given a rejected event \"balance mismatch,\" then a corrected event is generated with the same sequence position and accepted before the period close; the rejected event shows `corrected`.", { todo: true });
test("3.7-T8: Given the March 2027 period, then the attestation package is ready on BD3 (April) and the `human_portal_task` SLA is BD2 of May; a mismatch of one loan produces `attested_no_with_commentary` and a variance case.", { todo: true });
test("3.7-T9: Given cutover on 2026-11-16, then Setup events exist for every active and inactive escrowed loan per category before the first deposit event and 100% accepted by 2026-12-01.", { todo: true });
// 3.7-T10 — implemented in src/domain/escrow/escrow.test.ts
test("3.7-T11: Given a non-escrowed loan flagged delinquent by the tax service, then a borrower notice is sent, follow-up in 30 days, and if unpaid with a tax sale scheduled, an advance is posted and the waiver revocation (3.8) is triggered.", { todo: true });
test("3.7-T12: Given a vendor reject on 2027-11-29 for wrong parcel, then re-planned by 2027-12-01 via ACH direct and paid before 12/10.", { todo: true });
test("3.7-T13: Given a duplicate bill from two feeds, then the second is blocked and an anomaly is logged.", { todo: true });
test("3.7-T14: Given a payee ACH instruction changed yesterday and a $12,000 disbursement, then `officer` dual approval is required before release.", { todo: true });
test("3.7-T15: Given a disbursement reversal (returned check) posted 2027-12-15, then an opposite-signed escrow event (+744.80) is emitted with the next sequence and balance restored.", { todo: true });
