/**
 * §7 tools — compliance notices (7.2 names the only tools: the two ARM
 * engines). 7.1/7.3/7.4/7.5/7.6 name no tools; their agents act through the
 * Notice Registry commands. Agent: `disclosures`.
 */
import { defineTools, compute, never, str, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { computeArmAdjustment, verifyArmAdjustment, type ArmAdjustmentInput, type ArmAdjustmentResult } from "../../domain/notices/ops.ts";

const input = (i: ToolInput): ArmAdjustmentInput => {
  for (const k of ["index_pct", "margin_pct", "prior_rate_pct", "initial_note_rate_pct", "initial_cap_pct", "periodic_cap_pct", "lifetime_cap_pct", "expected_upb_cents", "remaining_term_months"]) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`);
  return { index_pct: str(i, "index_pct"), margin_pct: str(i, "margin_pct"), prior_rate_pct: str(i, "prior_rate_pct"), initial_note_rate_pct: str(i, "initial_note_rate_pct"), initial_cap_pct: str(i, "initial_cap_pct"), periodic_cap_pct: str(i, "periodic_cap_pct"), lifetime_cap_pct: str(i, "lifetime_cap_pct"), first_change: flag(i, "first_change"), expected_upb_cents: typeof i.expected_upb_cents === "bigint" ? i.expected_upb_cents : BigInt(String(i.expected_upb_cents)), remaining_term_months: Number(i.remaining_term_months), ...(flag(i, "interest_only") ? { interest_only: true } : {}), ...(i.rounding === "half_up" ? { rounding: "half_up" as const } : {}) };
};
const llmNever = never("NO_LLM_ARITHMETIC", "7.2 guardrail: the LLM never computes rates or payments — the deterministic engines do", (i) => flag(i, "llm_supplied_figures"), "rates and payments come only from the engines");

const p72 = defineTools("7.2", "disclosures", [
  { name: "computeArmAdjustment", kind: "read", handler: compute((i) => computeArmAdjustment(input(i))), guardrails: [llmNever] },
  { name: "verifyArmAdjustment", kind: "read", handler: compute((i) => verifyArmAdjustment(input(i), i.engine_a as ArmAdjustmentResult | undefined)), guardrails: [llmNever] },
]);

export const SECTION_07_TOOLS: readonly ToolDef[] = [...p72];
