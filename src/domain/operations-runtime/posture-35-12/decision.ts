/**
 * §35.12 decision record schema (AI agent design): `{subject: {kind: manifest | check_run | finding | switch | drill | scan | parallel_run |
 * diff | checklist, id}, environment, action, control_code?, vendor?, field?, proposed_disposition?, by, by_role, confirmed_by?, reason,
 * rule_set_version: posture.v1, model_version: deterministic (the reconciliation and checks) | <model> (a proposed disposition's
 * rationale), prompt_version: 35.12-v1, confidence}` — rendered once here as the rationale text and the row's versions (35.7's
 * rolesDecision precedent), so an examiner reads one shape on every act of the process.
 */
import { toJson } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { POSTURE_MODEL_VERSION, POSTURE_PROMPT_VERSION, POSTURE_RULE_SET_VERSION } from "./types.ts";

export type DecisionSubjectKind = "manifest" | "check_run" | "finding" | "switch" | "drill" | "scan" | "parallel_run" | "diff" | "checklist";
export interface PostureDecisionInput {
  readonly subject: { readonly kind: DecisionSubjectKind; readonly id: string }; readonly environment: string; readonly action: string;
  readonly control_code?: string | null; readonly vendor?: string | null; readonly field?: string | null; readonly proposed_disposition?: string | null;
  readonly by: string; readonly by_role?: string | null; readonly confirmed_by?: string | null; readonly reason: string;
  readonly model_version?: string; readonly confidence?: number;
}
export interface PostureDecision { readonly action: string; readonly rationale: string; readonly subject: { readonly kind: string; readonly id: string }; readonly ruleCode: string; readonly modelVersion: string; readonly promptVersion: string; readonly confidence: number }

export const byOf = (actor: Actor): string => (actor.kind === "human" ? actor.id : `${actor.kind}:${actor.id}`);

export function postureDecision(d: PostureDecisionInput): PostureDecision {
  const model = d.model_version ?? POSTURE_MODEL_VERSION; const confidence = d.confidence ?? 1;
  const record = { subject: d.subject, environment: d.environment, action: d.action, ...(d.control_code ? { control_code: d.control_code } : {}), ...(d.vendor ? { vendor: d.vendor } : {}), ...(d.field ? { field: d.field } : {}), ...(d.proposed_disposition ? { proposed_disposition: d.proposed_disposition } : {}),
    by: d.by, by_role: d.by_role ?? null, ...(d.confirmed_by !== undefined ? { confirmed_by: d.confirmed_by } : {}), reason: d.reason, rule_set_version: POSTURE_RULE_SET_VERSION, model_version: model, prompt_version: POSTURE_PROMPT_VERSION, confidence };
  return { action: d.action, rationale: toJson(record), subject: d.subject, ruleCode: POSTURE_RULE_SET_VERSION, modelVersion: model, promptVersion: POSTURE_PROMPT_VERSION, confidence };
}
