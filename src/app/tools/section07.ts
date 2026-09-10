/**
 * §7 tools — compliance notices. spec/registry/agents.json names tools only
 * for 7.2 (the two ARM engines); 7.1's Data-model paragraph lists a 13-tool
 * allowlist for the `disclosures` agent (renderNotice … scheduleTimer) that
 * the registry extractor did not carry into the 7.1 row, so those act through
 * the Notice Registry commands and the domain guardrails
 * (ops.statementSuppressionRequest, ops.ceaseRequest, ops.bankruptcyStatementPlan,
 * esign.tcpaConsentFromCall) until the registry row carries them. Agent: `disclosures`.
 */
import { defineTools, compute, never, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { computeArmAdjustment, verifyArmAdjustment, type ArmAdjustmentInput, type ArmAdjustmentResult } from "../../domain/notices/ops.ts";
import { calculateAdjustment, verifyAdjustment, type OpsDeps } from "../../domain/notices/ops-7-2.ts";

/** On a boarded loan (`loan_id` + `change_date`) the engines run from the stored terms, schedule and index captures and append the 7.2 events (ops-7-2); without a loan they are pure computations over the supplied note terms. */
const onLoan = (i: ToolInput): boolean => typeof i.loan_id === "string" && i.loan_id !== "" && typeof i.change_date === "string" && i.change_date !== "";
const deps72 = (ctx: CommandContext, rt: ToolRuntime): OpsDeps => ({ events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now });

const input = (i: ToolInput): ArmAdjustmentInput => {
  for (const k of ["index_pct", "margin_pct", "prior_rate_pct", "initial_note_rate_pct", "initial_cap_pct", "periodic_cap_pct", "lifetime_cap_pct", "expected_upb_cents", "remaining_term_months"]) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`);
  return { index_pct: str(i, "index_pct"), margin_pct: str(i, "margin_pct"), prior_rate_pct: str(i, "prior_rate_pct"), initial_note_rate_pct: str(i, "initial_note_rate_pct"), initial_cap_pct: str(i, "initial_cap_pct"), periodic_cap_pct: str(i, "periodic_cap_pct"), lifetime_cap_pct: str(i, "lifetime_cap_pct"), first_change: flag(i, "first_change"), expected_upb_cents: typeof i.expected_upb_cents === "bigint" ? i.expected_upb_cents : BigInt(String(i.expected_upb_cents)), remaining_term_months: Number(i.remaining_term_months), ...(flag(i, "interest_only") ? { interest_only: true } : {}), ...(i.rounding === "half_up" ? { rounding: "half_up" as const } : {}) };
};
/** Result fields an LLM might try to hand the engines instead of the boarded inputs; their presence on the input is the tell. */
const RESULT_FIELDS = ["new_rate_pct", "new_rate", "unrounded_pct", "new_pi_cents", "new_pi", "new_payment_cents", "new_payment", "rate", "payment", "payment_cents"];
const supplied = (i: ToolInput): string[] => RESULT_FIELDS.filter((k) => i[k] !== undefined && i[k] !== null && i[k] !== "");
/** 7.2 guardrail: the LLM never computes rates or payments — the engines take only the note's terms and the captured index; any rate/payment figure on the input (or the caller's own flag) is refused. */
const llmNever = never("NO_LLM_ARITHMETIC", "7.2 guardrail: the LLM never computes rates or payments — the deterministic engines do", (i) => flag(i, "llm_supplied_figures") || supplied(i).length > 0, "rates and payments come only from the engines (supplied figure fields are refused)");

const p72 = defineTools("7.2", "disclosures", [
  { name: "computeArmAdjustment", kind: "act", handler: compute((i, ctx, rt) => (onLoan(i) ? calculateAdjustment(deps72(ctx, rt), str(i, "loan_id"), D(str(i, "change_date"))) : computeArmAdjustment(input(i)))), guardrails: [llmNever] },
  { name: "verifyArmAdjustment", kind: "act", handler: compute((i, ctx, rt) => (onLoan(i) ? verifyAdjustment(deps72(ctx, rt), str(i, "loan_id"), D(str(i, "change_date")), { escalations: rt.escalations }) : verifyArmAdjustment(input(i), i.engine_a as ArmAdjustmentResult | undefined))), guardrails: [llmNever] },
]);

export const SECTION_07_TOOLS: readonly ToolDef[] = [...p72];
