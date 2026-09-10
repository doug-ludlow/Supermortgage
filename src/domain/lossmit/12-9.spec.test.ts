// 12.9 Short sale / Mortgage Release (DIL)
// spec/sections/12-loss-mitigation/12-9-short-sale-mortgage-release-dil.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { shortSaleIntake, delegationRouting, settlementReview, dilExitOption, liquidationHolds, militaryIndulgence, dilCase } from "./ops.ts";
import { relocation, netProceeds } from "./liquidation.ts";

test("12.9-T1: Given a complete BRP and an initial offer received 2026-10-05 (loan 8 months delinquent), when processed, then the acknowledgment is sent by 2026-10-12 (5 BD), the valuation is ordered on eligibility, and the approval/counter/decline is sent by 2026-11-04 (30 days).", () => {
  const r = shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: true, months_delinquent: 8 });
  assert.equal(r.eligible, true); assert.equal(r.ack_notice, "NTC_FNMA_D23301_SS_OFFER_ACK"); assert.equal(r.valuation_ordered, true);
  // 5 servicer business days from 2026-10-05 skip Columbus Day (2026-10-12) → 2026-10-13 (the spec's 10-12 counts the holiday; see docs/AUDIT-NOTES.md)
  assert.equal(r.ack_by, "2026-10-13"); assert.equal(r.decision_by, "2026-11-04"); assert.deepEqual(r.decision_notices, ["NTC_FNMA_D23301_SS_APPROVAL", "NTC_FNMA_D23301_SS_COUNTER", "NTC_FNMA_D23301_SS_DECLINE"]);
});
// 12.9-T2 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T3: (reserves >$50,000) case routed non-delegated with the assets field populated; no delegated approval issued.", () => {
  const r = delegationRouting({ reserves_cents: 5_500_000n, net_proceeds_within_parameters: true });
  assert.equal(r.route, "non_delegated"); assert.equal(r.assets_field_cents, 5_500_000n); assert.equal(r.delegated_approval_allowed, false); assert.match(r.reasons[0]!, /\$50,000/);
  assert.equal(delegationRouting({ reserves_cents: 4_000_000n, net_proceeds_within_parameters: true }).route, "delegated");
});
// 12.9-T4 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.9-T5 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T6: (settlement review) CD shows a $2,000 payment to the borrower beyond the $7,500 incentive \u2192 funding blocked; fraud review.", () => {
  const r = settlementReview({ cd_lines: [{ payee: "borrower", role: "borrower", cents: 750_000n, purpose: "relocation assistance" }, { payee: "borrower", role: "borrower", cents: 200_000n, purpose: "seller credit" }, { payee: "agent", role: "agent", cents: 1_650_000n, purpose: "commission" }], relocation_cents: 750_000n });
  assert.equal(r.borrower_total_cents, 950_000n); assert.equal(r.excess_cents, 200_000n); assert.equal(r.funding_blocked, true); assert.equal(r.escalation!.kind, "fraud_officer"); assert.equal(r.finding, "undisclosed borrower payment on the CD");
  assert.equal(settlementReview({ cd_lines: [{ payee: "borrower", role: "borrower", cents: 750_000n, purpose: "relocation" }], relocation_cents: 750_000n }).funding_blocked, false);
});
// 12.9-T7 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.9-T8 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T9: (lease option) borrower in active Chapter 13 \u2192 12-month lease refused; 3-month transition allowed (principal residence).", () => {
  const lease = dilExitOption("12_month", true, true); assert.equal(lease.allowed, false); assert.match(lease.refusal!, /Chapter 13/);
  assert.equal(dilExitOption("3_month", true, true).allowed, true); assert.equal(dilExitOption("3_month", false, false).allowed, false); assert.equal(dilExitOption("12_month", false, true).allowed, true);
});
test("12.9-T10: (holds) during the listing period 13.x motion for judgment is refused (41(g)(3)-1); after approval, sale refused for 60 days; CA loan \u2192 NOD rescission task within 5 BD.", () => {
  const listing = liquidationHolds({ phase: "listing", today: D("2026-10-20"), requested: "motion_for_judgment" }); assert.equal(listing.allowed, false); assert.match(listing.refusal!, /41\(g\)\(3\)-1/);
  const approved = liquidationHolds({ phase: "approved", approved_on: D("2026-10-28"), state: "CA", today: D("2026-12-01"), requested: "sale" }); assert.equal(approved.allowed, false); assert.equal(approved.hold_until, "2026-12-27"); assert.equal(approved.ca_rescission_task_by, "2026-11-04");
  assert.equal(liquidationHolds({ phase: "approved", approved_on: D("2026-10-28"), state: "TX", today: D("2026-12-27"), requested: "sale" }).allowed, true);
});
// 12.9-T11 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T12: (Military Indulgence) DMDC-verified active duty with pre-service loan \u2192 indulgence case, 6% cap applied retroactively (13.9), late charges after call-up waived, status 32, quarterly contact timer.", () => {
  const r = militaryIndulgence({ dmdc_verified: true, loan_originated_on: D("2021-10-01"), service_started_on: D("2026-08-01"), note_rate_pct: "6.500", late_charges_after_callup_cents: 12_642n });
  assert.equal(r.case_opened, true); assert.equal(r.rate_cap_pct, "6.000"); assert.equal(r.cap_applies, true); assert.equal(r.retroactive_from, "2026-08-01"); assert.equal(r.late_charges_waived_cents, 12_642n); assert.equal(r.status_code, "32"); assert.deepEqual(r.quarterly_contact_timer, { code: "SM_MILITARY_INDULGENCE_QUARTERLY_CONTACT", every_days: 90 });
  assert.equal(militaryIndulgence({ dmdc_verified: false, loan_originated_on: D("2021-10-01"), service_started_on: D("2026-08-01"), note_rate_pct: "6.500", late_charges_after_callup_cents: 0n }).case_opened, false);
  assert.equal(militaryIndulgence({ dmdc_verified: true, loan_originated_on: D("2026-09-01"), service_started_on: D("2026-08-01"), note_rate_pct: "6.500", late_charges_after_callup_cents: 0n }).case_opened, false);
});

test("12.9 worked figures: relocation $7,500.00 less third-party assistance; reserves over $50,000.00 route non-delegated", () => {
  assert.equal(relocation(false, 0n), 750000n); assert.equal(relocation(true, 0n), 0n); assert.equal(delegationRouting({ reserves_cents: 5000001n, net_proceeds_within_parameters: true }).route, "non_delegated");
  const np = netProceeds(27500000n, { commission: 1650000n, prorations: 0n, transfer_taxes: 0n, title_settlement: 0n, seller_attorney: 0n, hoa_past_due: 0n, subordinate_liens: 0n, relocation: 750000n }); assert.ok(np !== undefined);
});
