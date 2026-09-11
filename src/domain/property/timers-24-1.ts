/**
 * §24.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 24.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it; `REGZ_1026_19E2_INTENT_FEE_GATE` is 21.4's (referenced,
 * consumed through ops-21-4 checkFeeGate) and is not touched. The events named here are appended by
 * src/domain/property/ops-24-1.ts; `du.findings.received` by 23.1 and `closing.consummated` by 26.2.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_24_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // SLA anchors are the creditor's civil date of the instant (payload `*_on`, cf. 21.4's rate_set_date) so a late-evening MST selection is not an ET next-day anchor.
  o("SM_VALUATION_ORDER_SLA_1BD", { trigger: "`valuation.method.selected{method≠value_acceptance}`", anchorField: "selected_on", satisfied: "`valuation.ordered`",
    why: "§24.1 timer table: trigger '`valuation.method.selected` (method ≠ VA)', anchor selected_at, '+1 `business_days_creditor`', satisfied by `valuation.ordered` — value acceptance is exercised without an order; VA+PD, hybrid, desktop and traditional all place an order the same business day (recordMethodSelection / placeOrder)." });
  o("SM_VALUATION_ASSIGN_SLA_2BD", { anchorField: "ordered_on", satisfied: "`valuation.assigned`",
    why: "§24.1 timer table: trigger `valuation.ordered`, anchor ordered_at, '+2 `business_days_creditor`', satisfied by `valuation.assigned` (AMC/panel acceptance; license + registration verified — assignAppraiser); breach 'reassign to alternate AMC/panel'." });
  o("SM_VALUATION_INSPECT_SLA_7CD", { anchorField: "assigned_on", satisfied: "`valuation.inspection.completed`",
    why: "§24.1 timer table: trigger `valuation.assigned`, anchor assigned_at, '+7 `calendar_days`', satisfied by `valuation.inspection.completed` (completeInspection); R4: 'Columbus Day Mon Oct 12 is irrelevant to a calendar-day timer'." });
  o("SM_VALUATION_REPORT_SLA_10CD", { anchorField: "ordered_on", satisfied: "`valuation.received`",
    why: "§24.1 timer table: trigger `valuation.ordered`, anchor ordered_at, '+10 `calendar_days`', satisfied by `valuation.received` (receiveReport); breach 'escalate to AMC; lock-expiry risk flag to 21.4'." });
  // R5/R6: the DU offer has a four-month life measured to the note date; `closing.consummated` on/before `offer_expires_on` satisfies it (a later consummation is refused by the 24.1.offerAgeGate assertion at `consummate`).
  o("FNMA_B4_1_4_10_VALUE_ACCEPTANCE_OFFER_4M", { trigger: "`du.findings.received{value_acceptance_offer∈{value_acceptance, value_acceptance_pd}}`", anchorField: "offer_issued_at", satisfied: "`closing.consummated`",
    why: "§24.1 timer table: trigger '`du.findings.received{offer}`' (23.1's `du_submissions.value_acceptance_offer` ∈ {value_acceptance, value_acceptance_pd}), anchor offer_issued_at, '+4 months (same day-of-month; end-of-month clamp) must be ≥ note date', satisfied by '`closing.consummated` on/before expiry'; R6: 'offer_expires_on = add_months(offer_issued_at, 4): Oct 19, 2026 → Feb 19, 2027; Oct 31, 2026 → Feb 28, 2027 (clamped)'." });
  // B4-1.4-11: a state gate on `consummate` — the Property Data ID must be held before the note date (evaluators-24-1.ts `24.1.pdcApiSubmitGate`); `pdc.accepted` closes it.
  o("FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE", { trigger: "`valuation.method.selected{method=value_acceptance_pd}`", evaluator: "24.1.pdcApiSubmitGate", satisfied: "`pdc.accepted`",
    why: "§24.1 timer table: 'not_before_gate on `consummate`', trigger '`valuation.method.selected{value_acceptance_pd}`', 'must hold `property_data_id_fnma` before note date', satisfied by `pdc.accepted` (submitPropertyData); breach 'block `consummate`; convert method'. B4-1.4-11: 'the property data collection is submitted to the Property Data API prior to the note date'." });
  // B4-1.2-04 (24.1 owns; 22.1 references): the 12-month rule is asserted at `consummate` (`24.1.appraisalAge12mGate`: effective_date + 12 months > note date); consummation closes it.
  o("FNMA_B4_1_2_04_APPRAISAL_12M", { trigger: "`valuation.received{assignment_type≠appraisal_update}`", evaluator: "24.1.appraisalAge12mGate", anchorField: "effective_date", satisfied: "`closing.consummated`",
    why: "§24.1 timer table: 'deadline (gate on `consummate`)', trigger `valuation.received`, anchor effective_date, '+12 months `calendar_days` must be > note date', satisfied by 'consummation before expiry'; B4-1.2-04: 'the property must be appraised within the 12 months prior to the date of the note and mortgage' — measured from the ORIGINAL report's effective date ('with or without an appraisal update'), so an update report never re-arms it (receiveReport stamps age_12m_expires_on on the event)." });
  // B4-1.2-04 four-month rule: the registry row parses as-is (+4 months from effective_date; satisfied by the update report `valuation.received{assignment_type=appraisal_update, declined=false}` — receiveAppraisalUpdate); only the anchor is restated for the audit trail.
  o("FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M", { trigger: "`valuation.received{assignment_type≠appraisal_update}`", anchorField: "effective_date",
    why: "§24.1 timer table: trigger `valuation.received` (the original report — the update report is the satisfier, not a new clock: 'the effective date of the original appraisal report'), anchor effective_date, '+4 months; if note date later, update must be dated within the 4 months before the note date', satisfied by '`valuation.received{assignment_type=appraisal_update, declined=false}`'; breach 'order update; if \"declined\" → new appraisal' (evaluateAppraisalUpdate / receiveAppraisalUpdate)." });
  // UAD 3.6: a state gate on the order — the deliverable must be UAD 3.6 when the first UCDP submission is on/after Nov 2, 2026 (`24.1.uad36RequiredGate`); the UAD 3.6 report received closes it, a 2.6 file is rejected with FNM0391.
  o("FNMA_UAD_3_6_REQUIRED_GATE", { evaluator: "24.1.uad36RequiredGate", satisfied: "`valuation.received{uad_version=3.6}`",
    why: "§24.1 timer table: 'not_before_gate', trigger `valuation.ordered`, anchor 2026-11-02, 'orders whose report will be first submitted to UCDP on/after Nov 2, 2026 must be `uad_version = 3.6`', satisfied by 'engagement specifies UAD 3.6'; breach 'reject UAD 2.6 deliverable; re-engage' (receiveReport: FNM0391 + `valuation.engagement.reissued`)." });
  // Appraiser licensing: a state gate on the assignment (`24.1.appraiserLicenseGate`); the `appraiser_panel` verification snapshot (`valuation.appraiser.verified`, written by assignAppraiser right after `valuation.assigned`) closes it.
  o("SM_APPRAISER_LICENSE_GATE", { evaluator: "24.1.appraiserLicenseGate", satisfied: "`valuation.appraiser.verified`",
    why: "§24.1 timer table: 'not_before_gate', trigger `valuation.assigned`, 'license active in subject-property state; ASC check ≤ 30 `calendar_days` old', satisfied by '`appraiser_panel` verification'; breach 'block assignment' (assignAppraiser reassigns the order when the gate is closed — T9)." });
  // AMC registration: a state gate on the AMC-path order (`24.1.amcRegistrationGate`); the verified `amc_registrations` row snapshot (`valuation.amc.verified`, placeOrder) closes it.
  o("SM_AMC_REGISTRATION_GATE", { trigger: "`valuation.ordered{channel=amc}`", evaluator: "24.1.amcRegistrationGate", satisfied: "`valuation.amc.verified`",
    why: "§24.1 timer table: 'not_before_gate', trigger '`valuation.ordered` (AMC path)', '`amc_registrations.state = property state`, unexpired', satisfied by 'verified row'; breach 'block order' (12 U.S.C. 3353(d): no AMC may perform services in a State unless registered)." });
  // §1026.42(g): the officer determination starts the 30-day policy clock; the signed referral closes it.
  o("REGZ_1026_42G_MISCONDUCT_REFERRAL_30", { anchorField: "determination_at", satisfied: "`air.misconduct.referred`",
    why: "§24.1 timer table: trigger '`air.misconduct.suspected`' (the `officer` determination — suspectMisconduct), anchor determination_at, '+30 `calendar_days` (policy value for \"a reasonable period of time\")', satisfied by `air.misconduct.referred` (referMisconduct); breach 'sev 1 → `officer`'." });
}
