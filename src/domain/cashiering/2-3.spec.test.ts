// 2.3 Automatic draft (ACH) setup
// spec/sections/02-payment-processing-cashiering/2-3-automatic-draft-ach-setup.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CashieringService } from "./service.ts";
import type { LoanCashState } from "./types.ts";
const AGENT = { kind: "agent" as const, id: "cashiering" };
function L1(o: Partial<LoanCashState> = {}, firstDue = D("2026-09-01"), n = 4): LoanCashState {
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(firstDue, i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"), installments,
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: "5", late_charge_grace_days: 15, fees: [], overlays: [], ...o };
}
function harness(nowIso: string, loan: LoanCashState) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const pay = (amount: bigint, on: string, extra: Record<string, unknown> = {}) => {
    const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: amount, received_at: `${on}T14:00:00.000Z`, loan_id: loan.loan_id, source_item_id: `${on}-${amount}`, ...extra }).payment;
    svc.identify(p.id, loan.loan_id); return svc.post(p.id);
  };
  return { clock, events, ledger, svc, pay, state: () => store.get(loan.loan_id)! };
}
void AGENT; void harness; void L1;
import { newEnrollment, handleReturn, voiceEnrollmentEvidence, terminateOnTransferOut, fileLoans, type Authorization } from "./autodraft.ts";
import { assessLateCharge } from "./latecharges.ts";
const AUTH: Authorization = { borrower_name: "B", loan_number_masked: "******1234", routing: "021000021", account_last4: "9876", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: D("2026-10-01"), authorized_on: D("2026-09-20"), company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };

// 2.3-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T7 — implemented in src/domain/cashiering/section2.test.ts
// 2.3-T8 — implemented in src/domain/cashiering/section2.test.ts
test("2.3-T9: Given the retry in example E settles 2027-02-08, when 2.7 evaluates February, then no late charge is assessed.", () => {
  const e = newEnrollment("L-1", AUTH, 1, 10_000n);
  const ret = handleReturn(e, "R01", D("2027-02-03"), { authorization_valid: true, retryOn: () => D("2027-02-08") });
  assert.equal(ret.reverse_payment, true); assert.equal(ret.retry_on, "2027-02-08"); assert.equal(ret.notice, "AUTODRAFT-RETURN-v1");
  // the retry settles 2027-02-08 → the February installment is credited 02-08, inside the grace period ending 02-16
  const feb = L1({ upb_cents: 24_921_831n, lpi_date: D("2027-01-01") }, D("2027-02-01"), 3);
  const a = assessLateCharge({ state: feb, installment_due_date: D("2027-02-01"), received_toward_basis_cents: 158_017n, run_on: D("2027-02-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "not_assessed"); assert.equal(a.grace_end_on, "2027-02-16"); if (a.outcome === "not_assessed") assert.equal(a.reason, "paid within grace");
});
test("2.3-T10: Given a voice enrollment, when the call starts, then the AI disclosure is logged before any account data is requested, and the recording + written confirmation are linked to the consent.", () => {
  const good = voiceEnrollmentEvidence([{ at: "2026-09-20T15:00:00Z", kind: "ai_disclosure", text: "You are speaking with an automated assistant; say 'agent' for a person." }, { at: "2026-09-20T15:00:05Z", kind: "human_offered" }, { at: "2026-09-20T15:01:00Z", kind: "account_data_requested" }, { at: "2026-09-20T15:03:00Z", kind: "consent_given" }], { recording_id: "rec-1", written_confirmation_id: "conf-1" });
  assert.equal(good.ok, true); assert.equal(good.disclosure_before_account_data, true); assert.deepEqual(good.consent_links, { recording_id: "rec-1", written_confirmation_id: "conf-1" });
  const bad = voiceEnrollmentEvidence([{ at: "2026-09-20T15:00:00Z", kind: "account_data_requested" }, { at: "2026-09-20T15:00:30Z", kind: "ai_disclosure" }], { recording_id: "rec-2", written_confirmation_id: null });
  assert.equal(bad.ok, false); assert.deepEqual(bad.problems, ["AI disclosure must be logged before any account data is requested", "a human must be offered at the start of every voice/chat enrollment", "written confirmation not linked to the consent"]);
});
test("2.3-T11: Given a loan transferred out, when cutover completes, then the enrollment is `terminated` and no file after cutover contains the loan.", () => {
  const e = newEnrollment("L-1", AUTH, 1); e.status = "active"; e.next_draft_on = D("2026-12-01");
  const other = newEnrollment("L-2", AUTH, 1); other.status = "active";
  assert.deepEqual(fileLoans([e, other], D("2026-11-25")), ["L-1", "L-2"]);
  terminateOnTransferOut(e, D("2026-12-01"));                                   // transfer.batch.cutover_completed
  assert.equal(e.status, "terminated"); assert.equal(e.termination_reason, "transfer_out"); assert.equal(e.next_draft_on, null);
  assert.deepEqual(fileLoans([e, other], D("2026-12-01")), ["L-2"]); assert.deepEqual(fileLoans([e, other], D("2027-01-01")), ["L-2"]);
});
