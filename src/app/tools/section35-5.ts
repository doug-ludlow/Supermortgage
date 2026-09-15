/**
 * §35.5 process-owned tools — bus tools for 35.5 defined with `defineTools("35.5", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 35.5; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The schedule tools (rule set `cashiering.schedule.v1`) and the configuration tools (`35.5@config.v1`): the handlers live in
 * src/domain/operations-runtime/installments.ts and servicing-config.ts; the guardrails here are the spec's codes —
 * NO_MONEY_FIELD (no tool of this process changes a money field outside the owning engine's command), the `compliance` gates of
 * rule 9 (an explicit time zone or profile on a config row; every profile activation); the daily unit (`cashiering.run_unit`, rule set
 * `cashiering.allocation.v1`, NO_CLIENT_STATE). The lockbox and ACH cycles are the later groups' tools (lockbox.*, ach.*).
 */
import { defineTools, decision, humanWhen, needsRole, never, type ToolDef, type ToolInput } from "../tools.ts";
import { installmentsRead, installmentsReproject, installmentsWrite, MONEY_KEY, RULE_SET_SCHEDULE } from "../../domain/operations-runtime/installments.ts";
import { RULE_SET_CONFIG, servicerProfileWrite, servicingConfigWrite } from "../../domain/operations-runtime/servicing-config.ts";
import { RULE_SET_ALLOCATION, cashieringRunUnit } from "../../domain/operations-runtime/cashiering-cycle.ts";

const moneyKeys = (i: ToolInput): string[] => Object.keys(i).filter((k) => MONEY_KEY.test(k));
const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.5 guardrails: no tool here changes a money field outside the owning engine's command with the owning role", (i) => moneyKeys(i).length > 0, "a money field on the input (the schedule is arithmetic on the note's terms; 2.1/2.7/2.3 own the cash)");
const out = (o: unknown): Record<string, unknown> => (o && typeof o === "object" ? (o as Record<string, unknown>) : {});

export const TOOLS_35_5: readonly ToolDef[] = defineTools("35.5", "cashiering", [
  { name: "installments.write", kind: "act", ruleSetVersion: RULE_SET_SCHEDULE, handler: installmentsWrite, guardrails: [NO_MONEY_FIELD],
    decision: (i, o) => ({ action: "installments.write", rationale: `cashiering.schedule.v1: schedule (re)written from the boarded terms (source ${String(i.source ?? "transfer")}); rows ${String(out(o).rows ?? "")}, sha256 ${String(out(o).sha256 ?? "")}, maturity_variance_cents ${String(out(o).maturity_variance_cents ?? "")}`, subject: { kind: "installment_schedule_run", id: String(out(o).run_id ?? "") } }) },
  { name: "installments.reproject", kind: "act", ruleSetVersion: RULE_SET_SCHEDULE, handler: installmentsReproject, guardrails: [NO_MONEY_FIELD],
    decision: (i, o) => ({ action: "installments.reproject", rationale: `cashiering.schedule.v1: rows from ${String(out(o).effective_from ?? "")} re-projected under loan_terms ${String(out(o).terms_id ?? "")} (${String(i.source ?? "reprojection")}); rows_replaced ${String(out(o).rows_replaced ?? "")}, rows_kept ${String(out(o).rows_kept ?? "")}, sha256 ${String(out(o).sha256 ?? "")}`, subject: { kind: "installment_schedule_run", id: String(out(o).run_id ?? "") } }) },
  { name: "installments.read", kind: "read", handler: installmentsRead },
  // rule 6: one unit per loan per day on the command's own unit of work — 2.1 / 2.7 / 2.3 executed in-process; the state is the server's (rule 5)
  { name: "cashiering.run_unit", kind: "act", ruleSetVersion: RULE_SET_ALLOCATION, handler: cashieringRunUnit,
    guardrails: [never("NO_CLIENT_STATE", "35.5 rule 5: the unit derives LoanCashState from the typed rows; a caller's state, custodial ids or money figure is refused", (i) => i.state !== undefined || i.custodial !== undefined || moneyKeys(i).length > 0, "state / custodial / a money field on the input — the unit derives the loan's cash state itself")],
    decision: (i, o) => ({ action: "cashiering.run_unit", rationale: `cashiering.allocation.v1: unit ${String(out(o).unit_run_id ?? "")} for ${String(i.loan_id ?? "")} on ${String(i.as_of_date ?? "")} (local ${String(out(o).local_date ?? "")}): ${String(out(o).outcome ?? "")}; posted ${JSON.stringify(out(o).posted ?? [])}, fee_ids ${JSON.stringify(out(o).late_charge_fee_ids ?? [])}, checks ${JSON.stringify(out(o).amount_change_checks ?? [])}, interest_variance_cents ${String(out(o).interest_variance_cents ?? "0")}`, subject: { kind: "cashiering_unit_run", id: String(out(o).unit_run_id ?? "") }, ...(out(o).outcome === "already_done" ? { ruleCode: "ONE_UNIT_PER_LOAN_PER_DAY" } : {}) }) },
  // rule 9: the agent writes the defaults (the reviewed state map, the active profile); a manual time zone or profile is `compliance`'s
  { name: "servicing_config.write", kind: "act", ruleSetVersion: RULE_SET_CONFIG, handler: servicingConfigWrite,
    guardrails: [NO_MONEY_FIELD, needsRole("CONFIG_OVERRIDE_IS_COMPLIANCE", "35.5 rule 9 / AI agent design: every manual time-zone change and profile selection is `compliance`'s", (i) => i.time_zone !== undefined || i.servicer_profile_id !== undefined || i.time_zone_source !== undefined, ["compliance"], "an explicit time zone, time-zone source or servicer profile on a configuration row")],
    decision: (i, o) => ({ action: "servicing_config.write", rationale: `35.5@config.v1: time_zone ${String(out(o).time_zone ?? "")} (${String(out(o).time_zone_source ?? "")}), jurisdiction ${String(out(o).jurisdiction_state ?? "")}, servicer profile v${String(out(o).servicer_profile_version ?? "")}${i.reason ? `; ${String(i.reason)}` : ""}`, subject: { kind: "loan_servicing_config", id: String(out(o).config_id ?? "") } }) },
  // rule 9: activation is a human `compliance` act; the handler records its own decision (its id rides on `servicer_profile.activated`), so the bus's hook is off
  { name: "servicer_profile.write", kind: "act", ruleSetVersion: RULE_SET_CONFIG, humanRoles: ["compliance"], handler: servicerProfileWrite, decision: () => null,
    guardrails: [NO_MONEY_FIELD, humanWhen("PROFILE_ACTIVATION_IS_HUMAN", "35.5 rule 9: activating a profile version needs `compliance` and writes a decision", (i) => i.op === "activate", "an agent may draft a servicer profile version, never activate one"),
      needsRole("PROFILE_ACTIVATION_IS_COMPLIANCE", "35.5 rule 9: activating a profile version needs `compliance`", (i) => i.op === "activate", ["compliance"], "activating a servicer profile version")] },
  { name: "writeDecision", kind: "act", handler: decision() },
]);
