/**
 * §18.6 timer satisfaction overrides: for every 18.6 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides.
 *
 * Every 18.6 row is a deadline/recurring clock with a calendar offset, so each is satisfied by an event the
 * attestation module emits (the `attestation_packages.status` transitions of the state machine, the §6.3
 * reconciling-item resolution, or the partner notice) rather than by an evaluator, which would replace the offset.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_18_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("REGAB_1122_ASSESSMENT_PSA_DUE", { satisfied: "`attestation.package.delivered{kind=regab_1122_assessment}`", why: "§18.6 timer table: 'assessment + attestation delivered' — the 1122 package reaches `delivered` only after `attestation_received` (state machine), so its delivery event carries both (17 CFR 229.1122(a)–(b); Instruction 3)." });
  o("REGAB_1123_STATEMENT_PSA_DUE", { satisfied: "`attestation.package.delivered{kind=regab_1123_statement}`", why: "§18.6 timer table: 'officer statement delivered' — the Item 1123 statement / sub-certification package delivered to the partner's officer (17 CFR 229.1123; rule 18.6-5)." });
  o("SM_ATTEST_EVIDENCE_COMPILE_FYE_15", { satisfied: "`attestation.package.status_changed{status=evidence_compiled}`", why: "§18.6 timer table: '`control_evidence` complete for all matrix rows' — `planned → evidence_compiled` fires only when `generateControlEvidence(...).complete` is true for every control_matrix row (rule 18.6-4)." });
  o("SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45", { satisfied: "`attestation.package.status_changed{status=assertion_signed, signed_by_role=officer}`", why: "§18.6 timer table: 'assertion signed by `officer`' — the `assertion_signed` transition is refused without an officer signature record (18.6-T7; guardrail: the agent never signs or asserts)." });
  o("SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", { satisfied: "`partner.notified{reason=material_noncompliance}`", why: "§18.6 timer table: 'partner notified' — the `partner.notified` event with reason `material_noncompliance` within 1 business day of `material_noncompliance.determined` (rule 18.6-3: disclosed in the assessment and to the partner within 1 BD)." });
  o("REGAB_1122_2VII_RECON_ITEMS_90", { satisfied: "`reconciliation_item.resolved{status∈{cleared, posted, funded}}`", why: "§18.6 timer table: 'item resolved (Section 6.3)' — the §6.3 reconciling item leaves aging as `cleared`/`posted`/`funded`; unresolved at day 90 → control exception for 1122(d)(2)(vii) (18.6-T4)." });
}
