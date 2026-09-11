/**
 * Roles and actor gates (ARCHITECTURE §"Agents propose, humans approve what
 * the spec says humans approve"). The registry's breach column and every
 * process's guardrails name the same small vocabulary of human roles; the
 * gates here are the only way a command checks them, so the AI path and
 * the ops-console path are held to identical rules.
 */
import type { Actor } from "../kernel/events/index.ts";

export const HUMAN_ROLES = ["officer", "attorney", "signing_officer", "fnma_portal_operator", "human_agent", "lossmit_reviewer", "fraud_officer", "ciso", "compliance", "counsel", "ops_analyst",
  // origination touchpoints (spec/origination/01-architecture-baseline-addendum.md §8): the person the law or policy names
  "mlo_of_record", "underwriting_reviewer", "notary", "settlement_agent", "closing_attorney", "appraiser", "property_data_collector", "funding_approver", "bsa_officer", "qc_officer", "licensed_specialist"] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

export class RoleDenied extends Error {
  readonly code = "ROLE_DENIED";
  readonly required: readonly string[];
  readonly actor: Actor;
  constructor(actor: Actor, required: readonly string[], what: string) {
    super(`${what} requires ${required.length === 1 ? `role ${required[0]}` : `one of ${required.join(", ")}`}; actor is ${describe(actor)}`);
    this.name = "RoleDenied"; this.required = required; this.actor = actor;
  }
}
export const describe = (a: Actor): string => `${a.kind}:${a.id}${a.role ? ` (${a.role})` : ""}`;
export const isHuman = (a: Actor): boolean => a.kind === "human";
export const isAgent = (a: Actor): boolean => a.kind === "agent";
export const hasRole = (a: Actor, roles: readonly string[]): boolean => a.kind === "human" && !!a.role && roles.includes(a.role);

/** A human act: any human, any role (e.g. "every waiver needs a human"). */
export function requireHuman(a: Actor, what: string): void { if (!isHuman(a)) throw new RoleDenied(a, ["human"], what); }
/** A human with one of the named roles. */
export function requireRole(a: Actor, roles: readonly HumanRole[] | readonly string[], what: string): void { if (!hasRole(a, roles)) throw new RoleDenied(a, roles, what); }
export function requireOfficer(a: Actor, what: string): void { requireRole(a, ["officer"], what); }

/**
 * Dual control: amounts at or above the threshold need a second, distinct
 * officer (5.2: single transfer > $250,000 or daily > $1,000,000 → `officer`
 * dual approval; 3.7 payee changes > $10,000; 15.4/16.2 write-offs).
 */
export function requireDualControl(actors: readonly Actor[], role: HumanRole, what: string): void {
  const approvers = actors.filter((a) => hasRole(a, [role]));
  const distinct = new Set(approvers.map((a) => a.id));
  if (distinct.size < 2) throw new RoleDenied(actors[0] ?? { kind: "system", id: "none" }, [`two distinct ${role}s`], what);
}

/** Money fields are never agent-corrected (1.1 guardrail): an agent may propose; only a transferor correction or an officer waiver changes them. */
export function assertNoAgentMoneyChange(a: Actor, changedFields: readonly string[], moneyFields: readonly string[], what: string): void {
  const touched = changedFields.filter((f) => moneyFields.includes(f));
  if (touched.length && !hasRole(a, ["officer"])) throw new RoleDenied(a, ["officer"], `${what}: money field${touched.length > 1 ? "s" : ""} ${touched.join(", ")}`);
}
