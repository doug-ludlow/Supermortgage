/**
 * §31.1 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * 31.1 sends nothing to borrowers ("Notices: none to borrowers"). Two internal notices:
 * NTC_INTERNAL_LICENSE_EXPIRY_WARN — the SM_LICENSE_EXPIRY_WARN_90 ladder (−90/−60/−30, sev 3 → 2 → 1) to the holder's
 *   officer / the MLO: holder, NMLS ID, licence type and state, expiry, days remaining, the NMLS renewal calendar
 *   (window Nov 1 – Dec 31; reinstatement to the last day of February), the §1008.107 CE state for individuals, the
 *   evidence that closes the warning. Internal — never borrower-facing.
 * NTC_INTERNAL_STATE_GATE_BLOCKED — a SM_LICENSE_STATE_GATE refusal: state, command, reason code, the predicate values,
 *   the sev 1 escalation and its owner, and the only sentence the borrower may be told ("… is not currently accepting
 *   applications for <State> properties through this channel") — no licence detail, no reason, no adverse-action
 *   language in that sentence.
 * Every sample is placeholder-only: fictional partner, people, ids and dates.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const INTERNAL_ONLY = (id: string) => R(`${id}-internal-only`, "31.1 outputs: notices — none to borrowers; internal only", "presence", "Internal notice — not for borrower distribution", "the internal-only footer is present");
const NO_ADVERSE_ACTION = (id: string) => R(`${id}-no-adverse-action-language`, "12 CFR 1002.9 — a licensing block is not a credit decision; no adverse-action language", "absence", "\\bdenied\\b|\\bdeclined\\b|\\bcredit decision\\b|\\badverse action\\b", "no denial/decline wording");

// ------------------------------------------------------------------ NTC_INTERNAL_LICENSE_EXPIRY_WARN
export const LICENSE_EXPIRY_WARN_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}INTERNAL — LICENSE EXPIRY WARNING ({{upper severity}}){{/block}}
{{#block "license" page=1 y=0.11 pt=11}}{{holder_name}} ({{holder_kind}}; NMLS ID {{nmls_id}}) holds {{license_type_code}} in {{jurisdiction}}, expiring {{date expires_at}} — {{days_remaining}} days remaining ({{warning_stage}} warning; timer SM_LICENSE_EXPIRY_WARN_90).{{/block}}
{{#block "calendar" page=1 y=0.22 pt=11}}NMLS renewal calendar: the renewal window opens {{date renewal_window_opens}} and closes {{date renewal_deadline}} (end of day ET); an unrenewed license is terminated-expired on {{date termination_date}}; reinstatement runs through {{date reinstatement_deadline}}. Policy target: request renewal by {{date policy_target}}.{{/block}}
{{#block "ce" page=1 y=0.36 pt=11}}{{#if individual}}Continuing education (12 CFR 1008.107): {{ce_hours_logged}} of 8 required hours logged for {{renewal_year}} (3 federal law / 2 ethics / 2 nontraditional); {{#if ce_complete}}CE complete — renewal may be requested.{{else}}renewal cannot be requested until CE is complete.{{/if}}{{/if}}{{/block}}
{{#block "action" page=1 y=0.5 pt=11 bold}}Action owner: {{action_owner_role}}. Evidence that closes this warning: {{evidence_required}}. Consequence of a missed deadline: {{consequence}}.{{/block}}
{{#block "footer" page=1 y=0.9 pt=9}}Internal notice — not for borrower distribution. Registry snapshot {{date as_of}} (31.1 licenses; nightly NMLS sync {{date last_nmls_sync}}).{{/block}}`;
export const LICENSE_EXPIRY_WARN_RULES: ContentRule[] = [
  R("severity-ladder", "31.1 timer table: SM_LICENSE_EXPIRY_WARN_90 breach 'sev 3 → 2 → 1'", "data_equality", "severity", "severity is one of sev3/sev2/sev1", { predicate: { in: [{ var: "severity" }, ["sev3", "sev2", "sev1"]] } }),
  R("stage-matches-severity", "31.1 timer table: −90/−60/−30 calendar_days", "data_equality", "warning_stage", "the warning stage names the −90/−60/−30 rung", { predicate: { in: [{ var: "warning_stage" }, ["90-day", "60-day", "30-day"]] } }),
  R("days-remaining-range", "31.1: the first warning fires 90 days before expiry", "data_range", "days_remaining", "days remaining between 0 and 90", { range: { min: 0, max: 90 } }),
  R("nmls-id-present", "12 CFR 1026.36(g); NMLS Consumer Access — the licence is identified by NMLS ID", "presence", "NMLS ID \\d{4,}", "the NMLS ID is printed"),
  R("license-identified", "31.1 data model: license_type_code + jurisdiction", "data_equality", "license_type_code,jurisdiction", "licence type and state are present", { predicate: { and: [{ present: "license_type_code" }, { matches: ["jurisdiction", "^[A-Z]{2}$"] }] } }),
  R("renewal-calendar", "NMLS Annual Renewal Overview: window Nov 1 – Dec 31; reinstatement Jan 1 – end of February", "presence", "renewal window opens .+ and closes .+ \\(end of day ET\\)", "the NMLS window and deadline are stated"),
  R("reinstatement-stated", "NMLS: reinstatement period January 1 through the end of February", "presence", "reinstatement runs through", "the reinstatement deadline is stated"),
  R("ce-for-individuals", "12 CFR 1008.107: 8 hours (3 federal law, 2 ethics, 2 nontraditional) before renewal", "conditional", "individual", "an individual licence shows its CE status", { when: { var: "individual" }, predicate: { and: [{ present: "ce_hours_logged" }, { present: "renewal_year" }] } }),
  R("ce-hours-range", "12 CFR 1008.107", "conditional", "ce_hours_logged", "logged CE hours are a non-negative number", { when: { var: "individual" }, predicate: { ">=": [{ var: "ce_hours_logged" }, 0] } }),
  R("action-owner", "31.1 escalations: officer (company) / each MLO (individual) perform the NMLS act; the agent prepares", "data_equality", "action_owner_role", "the action owner is a human role", { predicate: { in: [{ var: "action_owner_role" }, ["officer", "mlo_of_record", "licensed_specialist", "counsel"]] } }),
  R("action-prominent", "31.1: the action line is bold on page 1", "layout", "action", "bold ≥ 11pt on page 1", { layout: { page: 1, bold: true, minPt: 11 } }),
  R("heading-prominent", "internal notice heading", "layout", "heading", "bold ≥ 12pt on page 1", { layout: { page: 1, bold: true, minPt: 12 } }),
  INTERNAL_ONLY("expiry"), NO_ADVERSE_ACTION("expiry"),
];
export const LICENSE_EXPIRY_WARN_SAMPLE = {
  severity: "sev3", warning_stage: "90-day", holder_name: "Alex Ramirez", holder_kind: "partner_individual", nmls_id: "1234567", license_type_code: "AZ_MLO", jurisdiction: "AZ", expires_at: "2026-12-31", days_remaining: 90,
  renewal_window_opens: "2026-11-01", renewal_deadline: "2026-12-31", termination_date: "2027-01-01", reinstatement_deadline: "2027-02-28", policy_target: "2026-12-01",
  individual: true, ce_hours_logged: 0, renewal_year: 2026, ce_complete: false, action_owner_role: "mlo_of_record", evidence_required: "NMLS renewal confirmation (or CE certificate first)", consequence: "terminated_expired on Jan 1; assignable = false; in-flight applications reassigned",
  as_of: "2026-10-02", last_nmls_sync: "2026-10-02",
};

// ------------------------------------------------------------------ NTC_INTERNAL_STATE_GATE_BLOCKED
export const STATE_GATE_BLOCKED_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}INTERNAL — STATE GATE BLOCKED: {{state}} ({{state_name}}){{/block}}
{{#block "refusal" page=1 y=0.11 pt=11}}SM_LICENSE_STATE_GATE refused the command "{{command}}" on {{date blocked_on}} for a {{state_name}} property. Reason code: {{reason}}. Subject: {{subject_kind}} {{subject_id}}.{{/block}}
{{#block "predicates" page=1 y=0.2 pt=11}}Readiness predicates (rule 1): {{#each predicates}}{{this}}; {{/each}}{{/block}}
{{#block "escalation" page=1 y=0.3 pt=11 bold}}Escalated sev 1 to the {{escalated_party}} officer (escalation {{escalation_id}}). Task: {{task}}. No quote and no application was created.{{/block}}
{{#block "borrower_line" page=1 y=0.42 pt=11}}The only borrower-facing statement permitted: "{{partner_name}} is not currently accepting applications for {{state_name}} properties through this channel."{{/block}}
{{#block "footer" page=1 y=0.9 pt=9}}Internal notice — not for borrower distribution. State readiness evaluated {{date blocked_on}} from the 31.1 registries (licenses, license_requirements, mlo_roster).{{/block}}`;
export const STATE_GATE_BLOCKED_RULES: ContentRule[] = [
  R("gate-named", "31.1 timer table: SM_LICENSE_STATE_GATE breach — command refused; `licensing.gate.blocked`", "presence", "SM_LICENSE_STATE_GATE refused the command", "the gate and the refused command are named"),
  R("reason-code", "31.1 rule 1: the first failing predicate names the reason", "data_equality", "reason", "the reason is one of the six readiness reason codes", { predicate: { in: [{ var: "reason" }, ["partner_license_missing", "branch_license_missing", "no_assignable_mlo", "sm_credential_missing", "matrix_unverified", "ai_position_unresolved"]] } }),
  R("state-code", "31.1 data model: jurisdiction char(2)", "data_equality", "state", "a two-letter state code and its name", { predicate: { and: [{ matches: ["state", "^[A-Z]{2}$"] }, { present: "state_name" }] } }),
  R("escalated-party", "31.1 timer table: sev 1 → officer (partner) for a missing partner license, officer (SM) for a missing SM credential", "data_equality", "escalated_party", "the escalated party is partner or sm", { predicate: { in: [{ var: "escalated_party" }, ["partner", "sm"]] } }),
  R("sev1-escalation", "31.1 rule 3: sev 1 escalation to officer", "presence", "Escalated sev 1 to the (partner|sm) officer \\(escalation [A-Za-z0-9-]+\\)", "the sev 1 escalation and its id are printed"),
  R("nothing-created", "31.1 rule 3 / T3: no quote or application is created", "presence", "No quote and no application was created", "the no-quote / no-application statement is present"),
  R("borrower-line", "31.1 rule 3: intake may say only that the partner 'is not currently accepting applications for <State> properties through this channel'", "presence", "is not currently accepting applications for [A-Za-z ]+ properties through this channel", "the permitted borrower sentence is present verbatim"),
  R("predicates-listed", "31.1 audit: readiness history with every predicate value at each evaluation", "data_equality", "predicates", "all six predicate values are listed", { predicate: { and: [{ present: "predicates.0" }, { present: "predicates.5" }] } }),
  R("escalation-prominent", "31.1: the escalation line is bold on page 1", "layout", "escalation", "bold ≥ 11pt on page 1", { layout: { page: 1, bold: true, minPt: 11 } }),
  R("heading-prominent", "internal notice heading", "layout", "heading", "bold ≥ 12pt on page 1", { layout: { page: 1, bold: true, minPt: 12 } }),
  INTERNAL_ONLY("gate"), NO_ADVERSE_ACTION("gate"),
];
export const STATE_GATE_BLOCKED_SAMPLE = {
  state: "GA", state_name: "Georgia", command: "lead.create", blocked_on: "2026-10-06", reason: "matrix_unverified", subject_kind: "lead", subject_id: "LEAD-GA-0001",
  predicates: ["partner_company_ok=true", "branch_ok=true", "mlo_available=true", "sm_processing_ok=false", "matrix_ok=false", "ai_position_ok=true"],
  escalated_party: "sm", escalation_id: "esc-0f3a2c1d", task: "counsel verification of license_requirements(GA, processing_underwriting_entity)", partner_name: "Example Partner Bank, N.A.",
};

export const VERSIONS_31_1: VersionInput[] = [
  V("NTC_INTERNAL_LICENSE_EXPIRY_WARN", LICENSE_EXPIRY_WARN_SOURCE, LICENSE_EXPIRY_WARN_RULES, LICENSE_EXPIRY_WARN_SAMPLE, "31.1 licensing v1 (NMLS renewal calendar; 12 CFR 1008.107)", "internal — SM_LICENSE_EXPIRY_WARN_90 warning ladder"),
  V("NTC_INTERNAL_STATE_GATE_BLOCKED", STATE_GATE_BLOCKED_SOURCE, STATE_GATE_BLOCKED_RULES, STATE_GATE_BLOCKED_SAMPLE, "31.1 licensing v1 (state readiness rule 1)", "internal — SM_LICENSE_STATE_GATE refusal record"),
];
export const OVERRIDES_31_1: Record<string, Partial<NoticeTemplate>> = {
  NTC_INTERNAL_LICENSE_EXPIRY_WARN: { channelPolicy: "electronic_ok_without_esign", noticeClass: "internal", separateDocument: false, mayCombineWith: ["NTC_INTERNAL_STATE_GATE_BLOCKED"], retention: "corporate_7y", piiLevel: "low", citation: "31.1 timer SM_LICENSE_EXPIRY_WARN_90; NMLS Annual Renewal Overview; 12 CFR 1008.107 (internal — no borrower recipient)" },
  NTC_INTERNAL_STATE_GATE_BLOCKED: { channelPolicy: "electronic_ok_without_esign", noticeClass: "internal", separateDocument: false, mayCombineWith: ["NTC_INTERNAL_LICENSE_EXPIRY_WARN"], retention: "corporate_7y", piiLevel: "low", citation: "31.1 timer SM_LICENSE_STATE_GATE (rule 1 / rule 3); 12 CFR 1008.103 (internal — no borrower recipient)" },
};
