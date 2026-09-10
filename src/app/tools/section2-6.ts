/**
 * §2.6 process-owned tools — additional bus tools for 2.6 defined with `defineTools("2.6", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section02.ts). Every tool string must be one
 * spec/registry/agents.json names for 2.6; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * `fees.suspend/waive` lives here (moved out of ./section02.ts): it runs through the late-charge engine
 * (src/domain/cashiering/latecharges.ts via TrialCashieringOps / CashieringOps.waive) so the loan state, the
 * receivable and the 2.7 courtesy counter move together, and its guardrails keep it to the trial's purposes —
 * rule 3 suspension (`accrued_suspended{trial_pending_waiver}`) and the conversion waiver (`trial_conversion`).
 * A courtesy waiver is a 2.7 `fees.waive` command (one per loan per 12 months by the agent; more only with
 * `officer`, SM_LC_COURTESY_WAIVER_LIMIT_12M) and is refused here for anyone but the officer.
 */
import { defineTools, compute, never, needsRole, str, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { TrialCashieringOps, TRIAL_SUPPRESSION } from "../../domain/cashiering/ops-2-6.ts";
import type { WaiverReason } from "../../domain/cashiering/latecharges.ts";
import type { LoanCashState } from "../../domain/cashiering/types.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";

const withTrialOps = (ctx: CommandContext) => new TrialCashieringOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor });
/** 2.7 rule 5's automatic reasons plus the trial conversion; `courtesy` is the counted one and is guarded below. */
const WAIVER_REASONS: readonly WaiverReason[] = ["trial_conversion", "workout_completion", "scra", "error_correction", "transfer_misdirected", "fnma_request", "bankruptcy_plan", "courtesy"];
const opOf = (i: ToolInput): "suspend" | "waive" => (i.op === "waive" ? "waive" : "suspend");

const feesSuspendWaive: Omit<ToolDef, "process" | "agent"> = {
  name: "fees.suspend/waive", kind: "write",
  handler: compute((i, ctx, rt) => {
    const feeId = str(i, "fee_id");
    if (!feeId) throw new RangeError("fees.suspend/waive: fee_id is required");
    if (i.op !== undefined && i.op !== "suspend" && i.op !== "waive") throw new RangeError(`fees.suspend/waive: op must be suspend or waive (got ${String(i.op)})`);
    const op = opOf(i);
    const state = i.state as LoanCashState | undefined;
    const on = D(ctx.now.slice(0, 10));
    const by = `${ctx.actor.kind}:${ctx.actor.id}`;
    const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
    if (op === "suspend") {
      if (state) {
        const fee = withTrialOps(ctx).suspendLateCharge(state, feeId, on, str(i, "case_id") || undefined);
        rt.store.put("fees", feeId, { state: fee.state, suppression: TRIAL_SUPPRESSION, amount_cents: fee.amount_cents.toString(), installment_due_date: fee.installment_due_date, by }, ctx.actor, ctx.now);
        return { fee_id: feeId, state: fee.state, suppression: TRIAL_SUPPRESSION, late_charges_due_cents: state.late_charges_due_cents.toString() };
      }
      // No engine state on the command: the row carries the suspension and the engine's next assessment run honours the overlay.
      const rec = rt.store.put("fees", feeId, { state: "accrued_suspended", suppression: TRIAL_SUPPRESSION, reason: str(i, "reason") || "pending_modification_hold", by }, ctx.actor, ctx.now);
      ctx.events.append({ type: "fee.suspended", loanId, aggregate: { kind: "fee", id: feeId }, actor: ctx.actor, payload: { fee_id: feeId, suppression: TRIAL_SUPPRESSION, case_id: str(i, "case_id") || null, on, cite: "Servicing Guide D2-3.2-06; F-1-27" } });
      return rec.data;
    }
    const reason = (str(i, "reason") || "trial_conversion") as WaiverReason;
    if (state) {
      const r = withTrialOps(ctx).ops.waive(state, feeId, reason, ctx.actor, on);
      if (!r.ok) throw new CommandRefused("fees.suspend/waive", r.code, "2.7 rule 5 (waivers: automatic reasons; one courtesy per loan per 12 months, more only with officer); 2.6 rule 3 (trial conversion waives all late charges)", r.reason);
      rt.store.put("fees", feeId, { state: "waived", waived_reason: reason, waived_cents: r.waived_cents.toString(), by }, ctx.actor, ctx.now);
      return { fee_id: feeId, state: "waived", reason, waived_cents: r.waived_cents.toString(), late_charges_due_cents: state.late_charges_due_cents.toString() };
    }
    const rec = rt.store.put("fees", feeId, { state: "waived", waived_reason: reason, by }, ctx.actor, ctx.now);
    ctx.events.append({ type: "fee.waived", loanId, aggregate: { kind: "fee", id: feeId }, actor: ctx.actor, payload: { fee_id: feeId, reason, [reason]: true, waived_on: on, by } });
    return rec.data;
  }),
  guardrails: [
    needsRole("COURTESY_VIA_2_7", "2.7 rule 5 / guardrails: one courtesy waiver per loan per 12 months by the agent, more only with `officer` (SM_LC_COURTESY_WAIVER_LIMIT_12M); 2.6 tools: `fees.suspend/waive` is the trial's suspension and conversion waiver",
      (i) => opOf(i) === "waive" && str(i, "reason") === "courtesy", ["officer"], "a courtesy waiver is the counted 2.7 `fees.waive` command, not the 2.6 trial waiver"),
    never("WAIVER_REASON", "2.6 rule 3 (waived on conversion: `fee.waived{reason=trial_conversion}`); 2.7 rule 5 (automatic reasons)",
      (i) => opOf(i) === "waive" && !!str(i, "reason") && !WAIVER_REASONS.includes(str(i, "reason") as WaiverReason), "unknown waiver reason"),
    never("NO_LC_FROM_TRIAL_FUNDS", "2.6 guardrails: cannot apply late charges from trial funds",
      (i) => flag(i, "collect_from_trial_funds") || data(i).source === "trial_funds" || data(i).collected_from === "trial_funds", "late charges are never collected from trial funds"),
    never("SUSPEND_ONLY_PENDING_MODIFICATION", "2.6 rule 3: late charges during the trial are `accrued_suspended{trial_pending_waiver}`; without a pending modification the 2.7 engine bills them",
      (i) => opOf(i) === "suspend" && (i.trial_active === false || i.modification_pending === false), "no Trial Period Plan / modification is pending on the loan"),
  ],
  decision: (i) => ({ action: `fees.suspend/waive:${opOf(i)}`, rationale: str(i, "rationale") || (opOf(i) === "waive" ? `late charge ${str(i, "fee_id")} waived (${str(i, "reason") || "trial_conversion"})` : `late charge ${str(i, "fee_id")} suspended (${TRIAL_SUPPRESSION})`), subject: { kind: "fee", id: str(i, "fee_id") } }),
};

export const TOOLS_2_6: readonly ToolDef[] = defineTools("2.6", "cashiering", [feesSuspendWaive]);
