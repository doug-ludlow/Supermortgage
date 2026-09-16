/**
 * §35.9 process-owned tools — the fourteen `foreclosure-ops` tools the spec names for 35.9 (spec/registry/agents.json;
 * src/app/tools.test.ts refuses any other name), defined with `defineTools("35.9", "foreclosure-ops", defs)` and spread by
 * ./index.ts. The bodies live in src/domain/operations-runtime/default-35-9/ (commands, referral, docket, firm, breach,
 * claims, daily); this file is the registration: name, kind, the human roles, the guardrails and the decision record.
 *
 *   case.timeline           read   {loan_id, case_id?} — rule 1's fold in event_sequence order with the owning rows' status
 *   case.progress           act    {loan_id, as_of_date} — the daily unit's body, callable by hand (rule 2)
 *   case.milestone.expect   write  {case_id, milestone_code, expected_on, basis} | {op: waive, reason} (attorney / officer)
 *   case.milestone.record   act    {case_id, milestone_code, occurred_on, source, evidence_document_id?} — 13.3's ingest, never a fabricated milestone
 *   writeDecision           act    the decision record (default-ops.v1)
 *   (case.refer, docket.sync, docket.react, firm.dispatch, firm.inbound, breach.execute, breach.recon, claims.sweep, claims.package are registered by the commits that build them)
 *
 * Guardrails (AI agent design): NO_MONEY_FIELD (an input carrying `amount_cents`, `benefit_cents`, `exposure_cents` or any
 * money-looking key is refused — rule 10), NO_CLOCK_EDIT (34.4 rule 1: no clock is armed, cancelled or edited from here),
 * SECTION_STATUS_READ_ONLY (an input that names a section's status column is refused), NO_LEGAL_ACT_UNREGISTERED (a filing,
 * sale or bid instruction is never an input of this process's tools).
 */
import { compute, decision, defineTools, needsRole, never, type ToolDef, type ToolInput } from "../tools.ts";
import { AGENT_35_9, PROCESS_35_9, REFUSALS, RULE_SET_VERSION_35_9, hasMoneyKey } from "../../domain/operations-runtime/default-35-9.ts";
import { caseMilestoneExpect, caseMilestoneRecord, caseTimeline, s } from "../../domain/operations-runtime/default-35-9/commands.ts";
import { caseProgress } from "../../domain/operations-runtime/default-35-9/daily.ts";
import { firmDispatch, firmInbound } from "../../domain/operations-runtime/default-35-9/firm.ts";
import { breachExecute, breachRecon } from "../../domain/operations-runtime/default-35-9/breach.ts";
import { docketReact, docketSync } from "../../domain/operations-runtime/default-35-9/docket.ts";

const HUMANS = ["ops_analyst", "officer", "attorney", "compliance", "fnma_portal_operator", "counsel"] as const;
const LEGAL_ACT = /^(file|filing|instruct_sale|sale_instruction|bid|bid_instruction|foreclose|evict)$/i;
export const NO_MONEY_FIELD = never(REFUSALS.noMoneyField, "35.9 rule 10: no money field, no legal act, from this process — a tool input that carries a money field this process did not derive is refused", (i: ToolInput) => hasMoneyKey(i), "35.9 never applies a payment, waives, writes off or changes an amount: the money act is the owning section's officer command (35.8)");
export const NO_CLOCK_EDIT = never(REFUSALS.noClockEdit, "35.9 guardrail NO_CLOCK_EDIT (34.4 rule 1): no clock is edited from a breach or a screen", (i: ToolInput) => ["cancel", "arm", "edit", "extend", "cancel_clock"].includes(s(i, "timer_op")) || s(i, "action_kind") === "cancel_clock", "a timer is armed and satisfied by the registry's events only");
export const SECTION_STATUS_READ_ONLY = never(REFUSALS.sectionStatusReadOnly, "35.9 guardrail SECTION_STATUS_READ_ONLY: the owning section's status is read after the event, never written here", (i: ToolInput) => s(i, "status") !== "" || s(i, "status_after") !== "" || (i.changes !== undefined && typeof i.changes === "object" && i.changes !== null && "status" in (i.changes as Record<string, unknown>)), "the section's row is right by definition — the expectation map is what gets fixed");
export const NO_LEGAL_ACT_UNREGISTERED = never(REFUSALS.noLegalActUnregistered, "35.9 guardrail NO_LEGAL_ACT_UNREGISTERED: the engine never files, instructs a sale or a bid on its own initiative — only a registered breach action does, with its citation", (i: ToolInput) => LEGAL_ACT.test(s(i, "act")) || LEGAL_ACT.test(s(i, "instruction")), "a legal act is a 35.8 act with the section's role gate (`attorney` for filings)");
const COMMON = [NO_MONEY_FIELD, NO_CLOCK_EDIT, SECTION_STATUS_READ_ONLY, NO_LEGAL_ACT_UNREGISTERED];

export const TOOLS_35_9: readonly ToolDef[] = defineTools(PROCESS_35_9, AGENT_35_9, [
  { name: "case.timeline", kind: "read", humanRoles: [...HUMANS], guardrails: COMMON, handler: compute(caseTimeline) },
  { name: "case.progress", kind: "act", humanRoles: ["ops_analyst", "officer"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: COMMON, handler: compute(caseProgress),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return { action: "case.progress", subject: { kind: "run", id: String(o["as_of_date"] ?? s(i, "as_of_date")) }, rationale: `daily unit for loan ${s(i, "loan_id")} on ${String(o["as_of_date"] ?? "")}: folded ${String(o["events_folded"] ?? 0)}, due ${String(o["milestones_due"] ?? 0)}, steps ${JSON.stringify(o["steps"] ?? {})}` }; } },
  { name: "case.milestone.expect", kind: "write", humanRoles: ["attorney", "officer", "ops_analyst"], ruleSetVersion: RULE_SET_VERSION_35_9,
    guardrails: [...COMMON, needsRole("MILESTONE_WAIVED_BY_ATTORNEY_OR_OFFICER", "35.9 state machine: expected | due → waived by `attorney` or `officer` on the screen with a reason", (i) => s(i, "op") === "waive", ["attorney", "officer"], "a waiver is a person's act on the case screen")],
    handler: compute(caseMilestoneExpect),
    decision: (i, output) => { const o = (output ?? {}) as { expectation?: Record<string, unknown> }; return { action: s(i, "op") === "waive" ? "case.milestone.waive" : "case.milestone.expect", subject: { kind: "case", id: s(i, "case_id") }, rationale: s(i, "reason") || `${s(i, "milestone_code")} expected ${s(i, "expected_on")} (${s(i, "basis")}) — expectation ${String(o.expectation?.["id"] ?? "")}` }; } },
  { name: "case.milestone.record", kind: "act", humanRoles: ["attorney", "ops_analyst", "officer"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: COMMON, handler: compute(caseMilestoneRecord),
    decision: (i) => ({ action: "case.milestone.record", subject: { kind: "case", id: s(i, "case_id") }, rationale: `${s(i, "milestone_code")} on ${s(i, "occurred_on")} reported by ${s(i, "source")} — recorded through 13.3, never fabricated` }) },
  // rule 6: the docket sync (PACER through the port; 14.1 applies what it allows) and the reaction (deterministic where the section is, else counsel)
  { name: "docket.sync", kind: "act", humanRoles: ["attorney", "ops_analyst", "officer"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: COMMON, handler: compute(docketSync),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return { action: "docket.sync", subject: { kind: "case", id: String(o["case_id"] ?? s(i, "case_id")) }, rationale: `PACER since ${String(o["since"] ?? "")}: ${String(o["entries"] ?? 0)} entries, ${String((o["applied"] as unknown[] | undefined)?.length ?? 0)} applied by 14.1, ${String((o["stored"] as unknown[] | undefined)?.length ?? 0)} stored for reaction (synced: ${String(o["synced"])})` }; } },
  { name: "docket.react", kind: "act", humanRoles: ["attorney", "ops_analyst", "officer"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: [...COMMON, needsRole("DOCKET_DECISION_IS_COUNSEL", "35.9 rule 6: an entry below 0.85 confidence or outside the deterministic set is decided by `attorney` on the screen", (i) => s(i, "classification") !== "", ["attorney"], "the classification a person supplies is counsel's decision")],
    handler: compute(docketReact), decision: () => null },   // the reaction writes its own decision record (subject docket_event, the classifier's confidence)
  // rule 8: the firm as an outbox counterparty
  { name: "firm.dispatch", kind: "act", humanRoles: ["attorney", "ops_analyst", "officer"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: COMMON, handler: compute(firmDispatch),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return { action: `firm.dispatch:${s(i, "kind")}`, subject: { kind: "case", id: s(i, "case_id") }, rationale: `${s(i, "kind")} to ${String(o["firm_id"] ?? s(i, "firm_id"))} — outbox row ${String(o["integration_message_id"] ?? "")}${o["duplicate"] ? " (duplicate: the idempotency key exists)" : ""}` }; } },
  { name: "firm.inbound", kind: "act", humanRoles: ["attorney", "ops_analyst", "officer"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: COMMON, handler: compute(firmInbound),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return { action: `firm.inbound:${s(i, "kind")}`, subject: { kind: "firm", id: s(i, "firm_id") }, rationale: `${s(i, "kind")} from ${s(i, "firm_id")} (${s(i, "source") || "fake"}) → ${o["ingested"] ? `owning event ${String(o["owning_event_id"] ?? "")}` : "duplicate, nothing"}` }; } },
  // rule 7: the executor and the reconciliation (the decision record is written by the executor itself — subject breach)
  { name: "breach.execute", kind: "act", humanRoles: ["officer", "compliance"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT, SECTION_STATUS_READ_ONLY,
      needsRole("REGISTRY_CHANGE_IS_COMPLIANCE", "35.9 rule 7: a registry row is added or re-versioned only by `compliance` with `officer` confirmation (dual control through 35.7)", (i) => s(i, "op") === "register", ["compliance"], "the executable set is explicit and reviewable")],
    dualControl: { role: "officer", threshold: (i) => s(i, "op") === "register" },
    handler: compute(breachExecute), decision: (i, output) => (s(i, "op") === "register" ? { action: "breach.registry.register", subject: { kind: "breach_action_registry", id: s(i, "timer_code") }, rationale: `${s(i, "action_kind")} registered for ${s(i, "timer_code")} v${String((output as Record<string, unknown> | undefined)?.["version"] ?? "")}` } : null) },
  { name: "breach.recon", kind: "act", humanRoles: ["compliance", "officer", "ops_analyst"], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: COMMON, handler: compute(breachRecon),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return { action: "breach.recon", subject: { kind: "run", id: String(o["as_of_date"] ?? s(i, "as_of_date")) }, rationale: o["already"] ? "already reconciled today" : `breaches ${String(o["breaches"])}: executed ${String(o["executed"])}, deferred ${String(o["deferred"])}, escalated_only ${String(o["escalated_only"])}, refused ${String(o["refused"])}, failed ${String(o["failed"])}, missing ${String(o["missing"])}` }; } },
  { name: "writeDecision", kind: "act", humanRoles: [...HUMANS], ruleSetVersion: RULE_SET_VERSION_35_9, guardrails: [NO_MONEY_FIELD], handler: decision() },
]);
