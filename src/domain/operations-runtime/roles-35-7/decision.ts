/**
 * §35.7 decision record schema (AI agent design): `{subject: {kind: grant | principal | handover | breakglass | approval | scan, id},
 * action, environment, role?, by, by_role, confirmed_by?, reason, rule_set_version: roles.v1, model_version: deterministic,
 * prompt_version: 35.7-v1, confidence: 1}` — rendered once here as the rationale text and the row's versions (34.4's
 * controlsDecision precedent, src/runtime/controls/common.ts), so an examiner reads one shape on every act of the process.
 */
import { toJson } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { ROLES_MODEL_VERSION, ROLES_PROMPT_VERSION, ROLES_RULE_SET_VERSION } from "./types.ts";

export type DecisionSubjectKind = "grant" | "principal" | "handover" | "breakglass" | "approval" | "scan";
export interface RolesDecisionInput { readonly subject: { readonly kind: DecisionSubjectKind; readonly id: string }; readonly action: string; readonly environment: string; readonly role?: string | null; readonly by: string; readonly by_role?: string | null; readonly confirmed_by?: string | null; readonly reason: string }
export interface RolesDecision { readonly action: string; readonly rationale: string; readonly subject: { readonly kind: string; readonly id: string }; readonly ruleCode: string; readonly modelVersion: string; readonly promptVersion: string; readonly confidence: number }

export const byOf = (actor: Actor): string => (actor.kind === "human" ? actor.id : `${actor.kind}:${actor.id}`);

export function rolesDecision(d: RolesDecisionInput): RolesDecision {
  const record = { subject: d.subject, action: d.action, environment: d.environment, ...(d.role ? { role: d.role } : {}), by: d.by, by_role: d.by_role ?? null, ...(d.confirmed_by !== undefined ? { confirmed_by: d.confirmed_by } : {}), reason: d.reason,
    rule_set_version: ROLES_RULE_SET_VERSION, model_version: ROLES_MODEL_VERSION, prompt_version: ROLES_PROMPT_VERSION, confidence: 1 };
  return { action: d.action, rationale: toJson(record), subject: d.subject, ruleCode: ROLES_RULE_SET_VERSION, modelVersion: ROLES_MODEL_VERSION, promptVersion: ROLES_PROMPT_VERSION, confidence: 1 };
}
