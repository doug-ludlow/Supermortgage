// 17.3 Data/document transfer
// spec/sections/17-servicing-transfer-out/17-3-data-document-transfer.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 17.3-T1 — implemented in src/domain/transfers/transfers.test.ts
// 17.3-T2 — implemented in src/domain/transfers/transfers.test.ts
test("17.3-T3: Given a tape UPB \u2260 ledger `principal` for one loan, then the outbound DQ gate fails, attestation is blocked, and no balance is edited by the agent.", { todo: true });
test("17.3-T4: Given a payment received Dec 1 by lockbox for a listed loan, then no `payment.received` or investor event is created; a `misdirected_payments{direction=out}` row exists and is in the Dec 2 forwarding file.", { todo: true });
test("17.3-T5: Given events processed Nov 30 at 16:00 ET, then they are due 3:00 a.m. ET Dec 1 (event mode) and the November period closes Dec 2 17:00 ET with zero open hard rejects; an open reject at 16:00 ET Dec 2 escalates to `officer`.", { todo: true });
test("17.3-T6: Given the final accounting is not acked by Dec 31, 2026, then `FNMA_F1_11_FINAL_ACCOUNTING_30` breaches and an `officer` escalation exists; given the transferee has not reimbursed 541,109 cents 30 days after ack, then a demand letter draft exists.", { todo: true });
test("17.3-T7: Given an eNote with Servicing Agent still Supermortgage on Nov 30, then `FNMA_F1_11_ENOTE_SERVICING_AGENT_T0` breaches at sev 1 and the partner is escalated.", { todo: true });
test("17.3-T8: Given a `sub_to_sub` batch, then the partner's MIN Update file replaces Supermortgage's Org ID with the new subservicer's, and the Dec 4 snapshot shows no MIN with Supermortgage in the Subservicer field.", { todo: true });
test("17.3-T9: Given a transferee request for a missing modification agreement received Dec 10, then it is answered by Dec 17 (5 BD) with the document hash.", { todo: true });
test("17.3-T10: Given an NoE about a 2026 escrow disbursement received Nov 15, 2027, then it is timely (\u2264 T+1y) and the 4.1 clocks run; received Dec 15, 2027 \u2192 `untimely` with the \u00a71024.35(g)(2) notice.", { todo: true });
test("17.3-T11: Given a loan with an open non-liquidation Form 2009 release at T, then the executed Form 2009 is delivered to the transferee custodian by T and the custodian's 90-day report responsibility passes with it.", { todo: true });
test("17.3-T12: Given `retain_until` = Dec 1, 2033 for a loan with no legal hold, then PII de-identification runs after that date and the manifest hashes remain queryable.", { todo: true });
test("17.3-T13: Given the transferee's preliminary load report shows a mapping difference on `NoteRatePercent` for 12 loans, then `SM_XFER_OUT_PRELIM_QC_7` cannot be satisfied until a corrected preliminary is acknowledged.", { todo: true });
test("17.3-T14: Given the last batch for the partner cut over and the final-period draft cleared Dec 21, then the CBAM LOA-cancellation portal task is due Jan 6, 2027 (10 BD; Dec 25 and Jan 1 excluded).", { todo: true });
