/**
 * §7.4 timer overrides (process-owned; the §7 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 7.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by ops-7-4.ts (the consent service); the
 * conditions are exact string compares on payload fields (src/kernel/events/match.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_7_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("ESIGN_7001C_CONSENT_GATE", { trigger: "`notice.channel_decision{requested_channel=electronic}`",
    why: "§7.4 timer table: trigger 'any `notice.channel_decision` requesting electronic' — ops-7-4 `decideNoticeChannel` appends `notice.channel_decision{requested_channel}` for every notice (electronic when the template and jurisdiction allow it, mail when state-mandated), so only the electronic requests arm the gate; the evaluator `7.4.esignConsentActiveForEveryRecipient` (section timers.ts) asserts 'consents(kind=esign, scope ∋ class, status=active) for every intended recipient'; closed → 'fall back to mail (no breach; logged)' (rule 4)." });
  o("IRS_1098_ECONSENT_GATE", { trigger: "`tax_form.1098.furnish_requested{channel=electronic}`",
    why: "§7.4 timer table: trigger '`tax_form.1098.furnish_requested` (electronic)' — ops-7-4 `requestForm1098Furnish` appends the request with `channel` = electronic|paper, so a paper furnish never arms the gate; the evaluator `7.4.irsEstatementConsentActive` asserts 'consents(kind=irs_estatement, status=active)'; closed → 'paper 1098' (rule 11, T9)." });
  o("ESIGN_7001C1D_RECONSENT_GATE", { anchorField: "effective_on",
    why: "§7.4 timer table: anchor 'change effective date' — ops-7-4 `announceHwSwChange` appends `hw_sw_requirements.changed{material=true, effective_on}` (the officer-approved material determination, rule 6 / T5); the gate stays open 'until (C) re-demonstrated' and closes on `consent.esign.reconsented`, appended by `completeReconsent` only after link + PDF token (§7001(c)(1)(D))." });
  o("SM_ESIGN_VERIFY_EXPIRY_7", { anchorField: "clicked_at",
    why: "§7.4 timer table: anchor 'consent click' — ops-7-4 `captureConsent` appends `consent.esign.pending{clicked_at}` (the checkbox + typed-name click that starts the 7-calendar-day demonstration window, rule 2); `completeVerification` appends `consent.esign.verified` only when the link was opened from the email and the PDF token entered; breach → status `expired`; re-invite (`expireVerification`)." });
  o("SM_ESIGN_WITHDRAWAL_EFFECT_1BD", { satisfied: "`consent.esign.withdrawn{confirmation_sent=true}`",
    why: "§7.4 timer table: satisfied by '`consent.esign.withdrawn` applied to all classes; confirmation sent' — ops-7-4 `applyWithdrawal` appends `consent.esign.withdrawn{classes, partial, all_classes_mail, confirmation_sent=true}` once the classes revert to mail and `NTC_ESIGN_WITHDRAWAL_CONFIRMATION` is queued by mail (rule 7; a partial withdrawal — 'unless the borrower withdraws only some classes' — carries partial=true); armed by `receiveWithdrawal`'s `consent.esign.withdrawal_received{receipt}` (+1 business_days_servicer, T6)." });
  o("TCPA_REVOCATION_HONOR_10BD", { satisfied: "`consent.tcpa.revoked{applied_to_all_lists=true}`",
    why: "§7.4 timer table: satisfied by '`consent.tcpa.revoked` applied to dialer/SMS lists' — ops-7-4 `applyTcpaRevocation` appends `consent.tcpa.revoked{lists, applied_to_all_lists}`; only a revocation reaching every outbound dialer and SMS list closes the clock (rule 12, FCC 2024 revocation order ≤ 10 BD; policy target 1 BD, T7); armed by the STOP/free-text ingestion `receiveTcpaRevocation`'s `consent.tcpa.revocation_received{receipt}`." });
  o("SM_CONSENT_REVALIDATION_12M", { satisfied: "`consent.esign.revalidated`",
    why: "§7.4 timer table: satisfied by '`consent.esign.revalidated` (any notice viewed in the portal in the last 12 months counts)' — ops-7-4 `recordPortalView` appends `consent.esign.revalidated{basis=portal_view, viewed_at}` from the `edelivery_events.viewed_at` record; armed on `completeVerification`'s `consent.esign.active{verified_at}` (anchor verified_at, +12 months; breach 'none — informational', open question 3)." });
}
