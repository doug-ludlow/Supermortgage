/**
 * §27.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 27.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. Referenced codes are never
 * redefined here: `FNMA_C1_1_01_PREMIUM_RECAPTURE_120` (20.1 owns the not-before gate; 27.2 keeps
 * `recapture_exposure_cents` on the GOS record until it opens), `FNMA_C2_2_DELIVERY_LPI_45` and the certification /
 * purchase timers (29.4), `SM_WH_AGING_*` / `SM_WH_REPURCHASE_PAYMENT_5BD` (27.1), `REGX_1024_17G_INITIAL_STMT_45` (3.1).
 * 27.2 owns `FNMA_C2_2_05_PPA_REQUEST_30` (29.4 / 30.1 reference it); `FNMA_C1_2_02_PPA_LLPA_REPRICING_18M` is 29.4's
 * (the registry lists 27.2's restatement first, but the spec marks it "(owned by 29.4; reference)" and timers-29-4.ts
 * carries the definition, applied after this file). Every event named here is appended by src/domain/warehouse/ops-27-2.ts
 * except `custody.certified` (29.4's observation, recorded by 27.2 as a platform record), `loan.purchased` (29.4 / 30.1),
 * `warehouse.interim_funder.removed` (30.1's MERS acknowledgment) and `warehouse.facility.activated` (27.1).
 * Wired by src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_27_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Expected proceeds: +1 Fannie Mae ET business day from the certification date; the bank credit for the loan closes it.
  o("SM_WH_PROCEEDS_EXPECTED_1BD", { trigger: "`custody.certified`", anchorField: "certification_date", satisfied: "`proceeds.received`",
    why: "§27.2 timer table: trigger '`custody.certified` (paper) / eNote auto-certification (29.4)' — recordCertificationObserved appends the observation as a platform record with `certification_date`; '+1 business_days_fannie_et (C2-2-04 / User Guide p. 64 \"next business day\")'; satisfied by '`proceeds.received` matched to the loan' (recordReceipt with the loan keys); breach: day +2 Loan Delivery status check (fnma_portal_operator), `secondary` investigates edits; sev 2; day +3 sev 1 to officer{sm}." });
  // Same-day match by 18:00 ET on the value date (a non-business value date rolls to the next servicer business day).
  o("SM_WH_PROCEEDS_MATCH_SAME_DAY", { offset: "0, 18:00 ET (rolled to the next servicer business day)", anchorField: "value_date",
    why: "§27.2 timer table: 'by 18:00 ET the same business_days_servicer' from the receipt value date (recordReceipt writes value_date); satisfied by `proceeds.matched` (recordMatch); breach: receipt to purchase_proceeds_suspense; sev 2." });
  // Payoff posting the same day as the match: the waterfall posting is the later of the two named events (`warehouse.advance.repaid` is emitted inside it).
  o("SM_WH_PAYOFF_POST_SAME_DAY", { satisfied: "`settlement.waterfall.posted`",
    why: "§27.2 timer table: 'same day' from matched_at; satisfied by '`warehouse.advance.repaid` + `settlement.waterfall.posted`' — recordWaterfall appends the waterfall posting and, when the warehouse is repaid in full, `warehouse.advance.repaid{repaid_from=purchase_proceeds}` in the same call; breach: sev 1 (27.1 accrual stops at the value date regardless)." });
  // Paper collateral: the bailee letter is released the same servicer business day as the repayment (anchor repaid_at, a date).
  o("SM_WH_BAILEE_RELEASE_SAME_DAY", { offset: "0 (rolled to the next servicer business day)", anchorField: "repaid_at",
    why: "§27.2 timer table: trigger `warehouse.advance.repaid{note_form=paper}`, 'same business_days_servicer' from repaid_at; satisfied by '`warehouse.bailee_letter.released` (release notice to the custodian; letter status released)' (recordReleases); breach: sev 2 — Fannie Mae already owns the note on payment (C1-2-03)." });
  // Partner residual: +1 federal business day from the posting (dual control; verified beneficiary).
  o("SM_WH_PARTNER_RESIDUAL_1BD", { anchorField: "posted_at", satisfied: "`partner.residual.paid`",
    why: "§27.2 timer table: trigger `settlement.waterfall.posted`, '+1 business_days_federal' from posted_at (fixture: Thu Nov 19 → Fri Nov 20); satisfied by '`partner.residual.paid` (dual control; verified beneficiary)' — recordResidualPaid after the funding_approver release; breach: sev 2; interest on the late residual at the facility rate (LSA)." });
  // Shortfall: the column's `{shortfall_cents > 0}` condition is carried by the boolean `shortfall` the posting emits; the partner's draw or wire satisfies it.
  o("SM_WH_SHORTFALL_DRAFT_2BD", { trigger: "`settlement.waterfall.posted{shortfall=true}`", anchorField: "posted_at", satisfied: "`settlement.shortfall.received`",
    why: "§27.2 timer table: trigger '`settlement.waterfall.posted{shortfall_cents > 0}`' (recordWaterfall emits shortfall=true with the cents), '+2 business_days_servicer' from posted_at (fixture D(ii): Thu Nov 19 → Mon Nov 23); satisfied by 'partner shortfall received (haircut-reserve draw or wire)' — recordShortfallReceived; breach: LSA event; set-off against later residuals with officer{sm} approval." });
  // C2-2-05: 30 calendar days from the advice date, no business-day roll (Sat Dec 19, 2026 for the Nov 19 advice; the platform targets Fri Dec 18).
  o("FNMA_C2_2_05_PPA_REQUEST_30", { anchorField: "advice_date", satisfied: "`ppa.requested{kind=funds_transfer_error}`",
    why: "§27.2 timer table: trigger `purchase_advice.received` (recordPurchaseAdvice), anchor advice_date, '+30 calendar_days'; satisfied by '`ppa.requested{kind=funds_transfer_error}` when a funds-transfer variance exists' (recordPpaRequested); breach: forfeiture ('Fannie Mae will assume that the information on its Purchase Advice is correct'); sev 1 at day 20 if an unresolved exception exists. 29.4 and 30.1 reference this code." });
  // FNMA_C1_2_02_PPA_LLPA_REPRICING_18M: "(owned by 29.4; reference)" — src/domain/secondary/timers-29-4.ts defines it (trigger `loan.purchased`, anchor
  // `acquisition_date`, +18 months, satisfied by `ppa.requested{llpa_relevant=true}`); 27.2 emits that spelling for its LSDU data-correction PPAs
  // (recordPpaRequested: llpa_relevant = kind === data_correction), records `ppa.resolved`, and adds the officer{sm} write-off decision when repricing is lost.
  // Gain on sale and the pass-through reconciliation the next servicer business day: one posting event carries both facts.
  o("SM_GOS_POST_1BD", { anchorField: "posted_at", satisfied: "`gain_on_sale.posted{passthrough_reconciled=true}`",
    why: "§27.2 timer table: trigger `settlement.waterfall.posted`, '+1 business_days_servicer' from posted_at; satisfied by '`gain_on_sale.posted` and `rate_passthrough.reconciled`' — recordPassthroughReconciled appends `rate_passthrough.reconciled{status}` then `gain_on_sale.posted{passthrough_reconciled=true}`; breach: sev 2." });
  o("SM_MSR_HANDOFF_1BD", { anchorField: "matched_at",
    why: "§27.2 timer table: trigger `proceeds.matched`, '+1 business_days_servicer' from matched_at; satisfied by `msr.handoff.issued` (recordMsrHandoff); breach: sev 3; partner month-end close at risk." });
  // Recurring: the platform fee accrues per purchased loan on the 1st at 03:00 ET (armed by `loan.purchased`, re-armed by each accrual); the GL export runs 20:00 ET each servicer business day for the facility.
  o("SM_PLATFORM_FEE_ACCRUAL_MONTHLY", { trigger: "`loan.purchased`", offset: "first day of next month, 03:00 ET", anchorField: "purchase_date",
    why: "§27.2 timer table: recurring, '1st calendar day, 03:00 ET', monthly; satisfied by '`platform_fee.accrued` for every loan with `fnma_purchase_date` set' — one instance per purchased loan armed on 30.1's `loan.purchased{purchase_date}` (accrual begins at the Fannie Mae purchase date, 27.2-Q3; recordPlatformFee), re-armed by the engine for the following 1st; breach: sev 2; catch-up run." });
  o("SM_GL_EXPORT_DAILY", { trigger: "`warehouse.facility.activated`", offset: "next business_days_servicer at 20:00 ET", anchorField: null, satisfied: "`gl.export.completed{target=partner_gl}`",
    why: "§27.2 timer table: recurring, '20:00 ET each business_days_servicer', daily; satisfied by '`gl.export.completed` for `sm_gl` and `partner_gl` with acknowledgments' — exportGl appends one completion per target for the facility (the partner_gl batch is exported after the sm_gl batch in the same run; recordGlExport), re-armed for the next servicer business day; breach: sev 2; re-export idempotent." });
}
