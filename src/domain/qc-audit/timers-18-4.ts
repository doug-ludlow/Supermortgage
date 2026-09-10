/**
 * §18.4 timer satisfaction overrides: for every 18.4 registry row whose "Satisfied by"
 * column is prose — or a bare `filing.submitted{form_582}` that the pattern grammar would read as a
 * truthy payload field with no ECRM-confirmation condition — a
 * `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides. Every satisfying event named
 * here is emitted by a function in src/domain/qc-audit/ops-18-4.ts (filingSubmit, afsReceivedEvent,
 * partnerDataPackageDeliveredEvent, pendingActionsFiledEvent, majorChangeGateClearedEvent,
 * regulatoryActionNoticeEvent, partnerNotifiedEvent, techProviderNoticeEvent, insuranceRenewalEvent,
 * form183SubmittedEvent) and each carries the evidence pointer the spec's "evidenced" wording demands,
 * so a draft, an un-evidenced "sent" or a bare `{form_582: true}` never closes a clock. Every trigger
 * event has a producer in ops-18-4.ts too: `period.fiscal_year_end` is the scheduler's tick
 * (fiscalYearEndEvent / form582CycleOpen, on the entity's `fiscal_year` subject); `org.change.recorded`,
 * `org.change.planned`, `partner.reportable_event.occurred` and `corporate_insurance_policy.recorded`
 * come from the recorders (orgChangeRecorded, majorChangePlanned, corporateInsurancePolicyRecorded);
 * `regulatory.action.received` from recordRegulatoryAction; `contract_event.occurred` from
 * techProviderContractEvent (the same shape 19.3's `notices.draft` records); `tech_provider.change.intent_declared`
 * from techProviderChangeIntent; and `notice_template.published` from noticeTemplatePublishedEvent.
 * The A2-1-01 breach row's trigger is restated here as `contract_event.occurred{kind∈{termination, breach,
 * impairment}, fnma_notice_required=true}`: "under a technology contract" is 19.3's rule-5 classification
 * (classifyContractEvent — TECH_CONTRACT_KINDS or critical_servicing_function → fnma_notice_required), which the
 * section-level `contract_kind=tech_provider` condition missed for 19.3's `tech_provider_addendum` /
 * `subservicing_agreement` / `integration_agreement` events and for a contract_kind 19.3 left null; 18.4's own
 * emitter sets fnma_notice_required=true, so both processes' contract events arm both rows and one notice closes both.
 * Anchors: the registry's `occurrence` / `receipt` columns are prose words, not payload fields, and the default
 * anchor resolver would fall back to the event's recording time — wrong whenever a change is recorded after it
 * occurred (edge case "Ownership change discovered late") — so every deadline row here names its payload date:
 * `occurred_at` on the partner-notify row (orgChangeRecorded / recordRegulatoryAction both carry it),
 * `received_on` on the regulatory-action row and `occurred_on` on the A2-1-01 breach row (18.4's and 19.3's
 * emitters both carry it). `anchorField` is restated where the section-level override set it too:
 * TimerRegistry.override re-derives it from the anchor column, so a later satisfied-only override would otherwise
 * drop the computed anchor.
 * Subject scoping: the engine satisfies an instance only from an event on the same aggregate
 * (TimerEngine.sameSubject), so every satisfying event is emitted on the subject its arming event used —
 * the per-policy expiry clock armed by `corporate_insurance_policy.recorded` closes only on that policy's
 * renewal, the A2-1-01 breach clock armed on a `contract_events` subject closes on the officer-recorded
 * `fnma_notices.sent{kind=a2101_event_5bd}` for that contract event (19.3's `fnma_notices.recordSent`
 * emits exactly that, so a correctly handled 19.3 termination/breach/impairment never leaves a false
 * sev-1 breach here), and the partner-notify clock closes on the org_change or regulatory_action it
 * was armed on.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_18_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- annual cycle (A4-1-02)
  // The four FYE rows arm only on 18.4's own scheduler tick (`filing.form582.cycle` / `filing.afs.cycle`, payload `cycle=form582`, on the entity's `fiscal_year` subject): 18.6's attestation cycle emits a bare `period.fiscal_year_end` on its `attestation_cycle` subject, where no filing.submitted / afs.received / partner.data_package.delivered could ever close them.
  o("FNMA_A4102_FORM582_FYE_90", { trigger: "`period.fiscal_year_end{cycle=form582}`", satisfied: "`filing.submitted{form=form_582, ecrm_confirmation_document_id present, approved_by_officer_id present}`", why: "§18.4 timer table: '`filing.submitted{form_582}` with ECRM confirmation' — the regulatory_filings row reaches `submitted (ECRM)` only through filingSubmit, which the designated submitter takes with the ECRM confirmation document and the officer's approval record from `officer_review` (18.4-T7; guardrail: the agent cannot certify or submit)." });
  o("FNMA_A4102_AFS_FYE_90", { trigger: "`period.fiscal_year_end{cycle=form582}`", satisfied: "`filing.submitted{form=afs, ecrm_confirmation_document_id present}`", why: "§18.4 timer table: '`filing.submitted{afs}`' — the audited financial statements uploaded in the same ECRM application ('Getting started with AFS'), evidenced by the upload confirmation (A4-1-02 'within 90 days after the end of the seller/servicer's fiscal year')." });
  o("SM_AFS_AUDITOR_DELIVERY_FYE_75", { trigger: "`period.fiscal_year_end{cycle=form582}`", satisfied: "`afs.received{document_id present}`", why: "§18.4 timer table: '`afs.received`' — the auditor's secure upload of the statements with the independent public accountant's opinion, evidenced by the document (Integrations: Auditor; AFS delivery commitment ≥ 15 days before the Fannie Mae deadline)." });
  o("SM_FORM582_PARTNER_PACKAGE_FYE_60", { trigger: "`period.fiscal_year_end{cycle=form582, entity=partner}`", satisfied: "`partner.data_package.delivered{filing_type=form_582, receipt_document_id present}`", why: "§18.4 timer table: 'partner data package delivered' — the SFTP/portal delivery of the partner's Form 582 answer sheet with the partner's receipt acknowledgment (Integrations: Partner; subservicing agreement clause ≥ 30 days before the partner's deadline)." });
  // ---- organizational changes (A4-1-02 / A4-1-03)
  o("FNMA_A4102_ORG_CHANGE_5BD", { satisfied: "`org_change.notice.filed{pending_actions_document_id present, email_evidence_document_id present}`", why: "§18.4 timer table: 'Pending Actions updated + email sent (both evidenced)' — the state machine's `filed (Pending Actions + email)` step, emitted only with both evidence pointers (A4-1-02: Pending Actions update and an email to the Changes in Lender Organization mailbox within five business days)." });
  o("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60", { anchorField: "planned_effective_date", satisfied: "`org_change.gate.cleared{by∈{fnma_approval, fnma_acknowledgment, officer_waiver}, document_id present, basis present}`", why: "§18.4 timer table: 'Fannie Mae approval/acknowledgment recorded' — the approval/acknowledgment letter as `document_id` with its reference as `basis`; breach column: the change stays blocked in the platform's own records (ops-18-4.ts platformRecordWrite) 'until satisfied or `officer` waiver with rationale' — a waiver clears only with the signed waiver as `document_id` and the officer's rationale as `basis`, so a bare `{by: officer_waiver}` never matches; the officer role is the emitter's and the tool guardrail's check (needsRole), which the pattern grammar cannot express (A4-1-03: prior approval and 60 days' advance written notice)." });
  o("FNMA_A4103_REGULATORY_ACTION_IMMEDIATE", { anchorField: "received_on", satisfied: "`regulatory.action.notice_sent{evidence_document_id present}`", why: "§18.4 timer table: anchor 'receipt' = the payload's `received_on` (recordRegulatoryAction), not the recording time — a consent order received Tue 2026-11-10 and recorded 11-13 is still due 11-12; 'written notice sent to the customer account team' — 18.4-T6: the timer is satisfied only by sent evidence, never by the same-day draft (A4-1-03 'immediate written notice' of regulatory actions; 1-BD internal proxy)." });
  o("SM_PARTNER_NOTIFY_SUB_EVENT_1BD", { anchorField: "occurred_at", satisfied: "`partner.notified{kind=reportable_event, evidence_document_id present}`", why: "§18.4 timer table: anchor 'occurrence' = the payload's `occurred_at` on `partner.reportable_event.occurred` (orgChangeRecorded: the change's occurred_on; recordRegulatoryAction: the action's received_on), not the recording time — 18.4-T2: a CFO change on Tue 2026-11-10 is passed to the partner by 11-12 whenever it is recorded; 'partner notified' within 1 business day of any Supermortgage event the partner must report within 5 business days (subservicing agreement clause)." });
  // ---- technology provider (A2-1-01)
  o("FNMA_A2101_TECH_PROVIDER_CHANGE_180", { anchorField: "planned_effective_date", satisfied: "`tech_provider.change.notice_sent{evidence_document_id present}`", why: "§18.4 timer table: 'notice evidenced' — the TECH-PROV-NOTICE-v1 letter sent 180 calendar days before replacing a critical technology provider (≥ 20,000 loans) (A2-1-01)." });
  o("FNMA_A2101_TECH_PROVIDER_BREACH_5BD", { trigger: "`contract_event.occurred{kind∈{termination, breach, impairment}, fnma_notice_required=true}`", anchorField: "occurred_on", satisfied: "`fnma_notices.sent{kind=a2101_event_5bd, document_id present}`", why: "§18.4 timer table: 'termination/breach/impairment notice under a technology contract' → 'notice to Fannie Mae evidenced' within 5 business days (A2-1-01). 'Under a technology contract' is 19.3's rule-5 classification (`fnma_notice_required`, set for TECH_CONTRACT_KINDS — tech_provider, tech_provider_addendum, subservicing_agreement, integration_agreement — or a critical servicing function), so a 19.3-recorded termination under the partner's addendum arms this row as 18.4's own `contract_kind=tech_provider` event does; anchor 'occurrence' = the payload's `occurred_on`. Satisfied by the officer-recorded notice 19.3's `fnma_notices.recordSent` emits on the `contract_events` subject the arming event used (src/domain/data-security/timers-19-3.ts FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD waits for the same event), and by the event ops-18-4.ts techProviderNoticeEvent emits for an 18.4-recorded contract event; `document_id present` is the sent notice's evidence, so a draft never closes it." });
  // ---- insurance (A3-5-01)
  o("FNMA_A3501_INSURANCE_EXPIRY_30", { anchorField: "expires_on", satisfied: "`corporate_insurance_policy.renewed{lapse=false, policy_id present}`", why: "§18.4 timer table: 'renewal recorded (no lapse)' — a renewal or emergency binder effective on or before the prior expiry, on the expiring policy's own aggregate (a cyber renewal never closes the fidelity clock); Form 582 cannot verify with an expired policy (A3-5-01; edge case 'Expired insurance at filing time')." });
  // ---- Form 183 (A4-2.1-06)
  o("FNMA_A42106_FORM183_ON_CHANGE", { satisfied: "`form183.submitted{template_version present}`", why: "§18.4 timer table: 'Form 183 submitted' for the changed adverse-action template version; the template stays blocked until then (A4-2.1-06; companion certification (c))." });
}
