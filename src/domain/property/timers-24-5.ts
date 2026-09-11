/**
 * §24.5 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 24.5 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — `REGX_1024_17G_INITIAL_STMT_45` (3.1 owns; 30.3 satisfies it) is a
 * reference only. Wired by src/domain/timer-overrides.ts.
 *
 * Emitters live in src/domain/property/ops-24-5.ts (the `title-closing` agent's rules): `flood.determination.ordered`
 * (orderFloodDetermination), `flood.determination.received{in_sfha, sfc_180, status, determination_date}`
 * (receiveFloodDetermination), `flood.notice.delivered{effective_receipt_date, days_before_consummation}` /
 * `flood.notice.acknowledged` (deliverFloodNotice / acknowledgeFloodNotice), `insurance.requirement.computed
 * {computed_on}` (computeInsuranceRequirements), `insurance.evidence.requested` (requestEvidence),
 * `insurance.policy.verified{policy_kind=hazard}` (verifyHazardPolicy — 9.1's event name and rule set),
 * `flood.coverage.verified` (verifyFloodCoverage — 9.6's event name), `project.insurance.verified`
 * (verifyProjectInsurance), `flood.lol.enrolled{lol_purchased=true}` (handOffToServicing). Consumed, never redefined:
 * `title.ordered` (24.4), `closing.scheduled` (26.1), `funding.authorized` (26.3), `loan.funded` (26.3/30.2).
 * SM_FLOOD_DETERMINATION_ORDER_1BD needs no override — its columns parse (`title.ordered` +1 business_days_creditor,
 * satisfied by `flood.determination.received`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_24_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Rule 5 / T4: the 10-calendar-day "reasonable time" gate on `consummate`, evaluated against the effective receipt of the notice (e-sign same day; mailbox rule +3 business_days_regz_specific for mail); short-period path only with a reason + acknowledgment.
  o("FDPA_4104A_FLOOD_NOTICE_GATE", { trigger: "`flood.determination.received{in_sfha=true}`", anchorField: "determination_date", evaluator: "24.5.floodNoticeGate", satisfied: "`flood.notice.delivered`",
    why: "§24.5 timer table: not_before_gate, trigger '`flood.determination.received` with `in_sfha=true`', anchor '`notice_delivered_at` (effective receipt: e-sign confirmed same day; mailbox rule +3 `business_days_regz_specific` for mail)', 'consummation ≥ notice receipt + 10 `calendar_days` (Interagency Q&A \"generally ... reasonable\"); shorter only with `notice_short_period_reason` + borrower acknowledgment before signing', satisfied by '`flood.notice.delivered` (+ `acknowledged`)', breach '`consummate` refused; 21.4 lock-exposure alert' — 42 U.S.C. 4104a(a)(1); 2022 Interagency Q&A Notice 3: 'The Agencies generally regard 10 days as a reasonable time interval' (evaluators-24-5.ts floodNoticeGate; T4: received Tue Oct 6, e-signed Wed Oct 7, consummation Fri Nov 6, 2026 → 30 days)." });
  // Policy: the notice goes out within one creditor business day of an SFHA determination.
  o("SM_FLOOD_NOTICE_DELIVER_1BD", { trigger: "`flood.determination.received{in_sfha=true}`", anchorField: "determination_date",
    why: "§24.5 timer table: deadline (policy), trigger '`flood.determination.received` with `in_sfha=true`', anchor 'receipt', '+1 `business_days_creditor`', satisfied by '`flood.notice.delivered`', breach 'sev-3' — AI agent design: 'if SFHA, renders and delivers the notice within one business day' (receiveFloodDetermination emits in_sfha and determination_date; deliverFloodNotice satisfies)." });
  // B7-3-06 / 44 CFR 61.11: evidence of flood coverage with amount, deductible, closing-date effectiveness and mortgagee clause before `consummate` on SFHA loans; 9.6's `flood.coverage.verified` closes it.
  o("FNMA_B7_3_06_FLOOD_COVERAGE_GATE", { evaluator: "24.5.floodCoverageGate",
    why: "§24.5 timer table: not_before_gate on `consummate`, trigger '`closing.scheduled` (SFHA loans)', 'evidence of NFIP/private flood coverage with amount ≥ `flood_required_amount_cents`, deductible ≤ `flood_deductible_max_cents`, effective at or before closing (44 CFR 61.11 loan-closing rule: applied/paid at or prior to closing), mortgagee clause valid', satisfied by '`flood.coverage.verified`', breach '`consummate` refused' — B7-3-06 (02/07/2024) lesser of 100% RCV / NFIP max / UPB; 44 CFR 61.11(b) effective 'as of the time of the loan closing, provided … applied for and the presentment of payment of premium is made at or prior to the loan closing' (evaluators-24-5.ts floodCoverageGate; T5: NFIP $250,000 / $5,000 applied and paid Nov 5 for a Nov 6 consummation)." });
  // B7-3-02 / B7-3-07: the hazard policy `verified` under fnma.insurance.2026-08 before `disburse`; 9.1's event carries policy_kind.
  o("FNMA_B7_3_02_HAZARD_EVIDENCE_GATE", { evaluator: "24.5.hazardEvidenceGate", satisfied: "`insurance.policy.verified{policy_kind=hazard}`",
    why: "§24.5 timer table: not_before_gate on `disburse`, trigger '`funding.authorized` request', 'hazard policy `verified` (rule set `fnma.insurance.2026-08`), effective date ≤ disbursement date, first-year premium paid or collected on the CD (purchase) / policy in force (refinance)', satisfied by '`insurance.policy.verified` (`policy_kind='hazard'`)', breach '`disburse` refused' — B7-3-02 (08/05/2026) replacement-cost basis with the roof exception, 5% deductibles; B7-3-07 evidence; 24.5-Q4 effective on/before disbursement (evaluators-24-5.ts hazardEvidenceGate; T1 verified with hazard_deductible_max_cents=2600000)." });
  // B7-3-03 / B7-3-04 / B7-4: master, HO-6, liability and fidelity evidence before `disburse` on project units.
  o("FNMA_B7_3_03_PROJECT_INSURANCE_GATE", { evaluator: "24.5.projectInsuranceGate",
    why: "§24.5 timer table: not_before_gate on `disburse`, trigger '`funding.authorized` request (condo/co-op/attached PUD)', 'master policy verified (100% RCV documentation option, Special/Broad perils, 5% and $50,000 per-unit deductibles), HO-6 verified when required, liability (B7-4-01) and fidelity (B7-4-02) evidence unless waived', satisfied by '`project.insurance.verified`', breach '`disburse` refused' — B7-3-03 (08/05/2026) 'at least 100% of the estimated replacement cost value', '$50,000 per unit'; B7-3-04 HO-6 'greater of: 5% … or $2,500'; LL-2026-03 mandatory for applications on/after July 1, 2026 (evaluators-24-5.ts projectInsuranceGate; T7)." });
  // Policy: evidence requested within 3 creditor business days of the requirement computation.
  o("SM_INSURANCE_EVIDENCE_REQUEST_3BD", { anchorField: "computed_on",
    why: "§24.5 timer table: deadline (policy), trigger '`insurance.requirement.computed`', anchor 'computation date', '+3 `business_days_creditor`', satisfied by '`insurance.evidence.requested`', breach 'sev-3' — computeInsuranceRequirements emits computed_on; requestEvidence satisfies." });
  // 42 U.S.C. 4012a(b)(3) / B7-3-06: life-of-loan enrolment proved at boarding — the 9.6 `flood_determinations` row is seeded with the LOL contract linked to the loan id (handOffToServicing emits `flood.lol.enrolled{lol_purchased=true}`); otherwise boarding warning W-007 (30.2 OW-007).
  o("FDPA_4012A_LOL_ENROLLED_GATE", { evaluator: "24.5.lolEnrolledGate", satisfied: "`flood.lol.enrolled{lol_purchased=true}`",
    why: "§24.5 timer table: not_before_gate, trigger '`loan.funded` → boarding (30.4)', '`lol_purchased=true` and vendor contract linked to `loan_id`', satisfied by '9.6 `flood_determinations` seeded', breach 'boarding warning W-007 (1.1)' — 42 U.S.C. 4012a(b)(3): Fannie Mae procedures 'reasonably designed to ensure that … any loan purchased … is covered for the term of the loan'; 30.4's SM_FLOOD_LOL_SERVICING_LINK_2BD then proves the servicing link (evaluators-24-5.ts lolEnrolledGate; INT-O5-8: W-007 absent on a clean fixture)." });
}
