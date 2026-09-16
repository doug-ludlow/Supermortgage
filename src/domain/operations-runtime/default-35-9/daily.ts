/**
 * §35.9 rule 2 — "The daily unit progresses a loan in one transaction under 35.1's lease." `case.progress{loan_id, as_of_date}`
 * is the body of the `default_case_daily` cycle's loan unit, callable by hand (`ops_analyst`): in order, (a) fold, (b) 11.x
 * contact cadence and 12.1 follow-up, (c) 12.x deemed rejection and the workout plan's end of term, (d) 13.x prereferral
 * review, referral proposal, exposure projection and expectations due, (e) 14.x docket reactions, (f) 15.x advance position
 * and the claims sweep. Each step runs as the owning agent; a step that throws is recorded on the unit and the later steps
 * still run; a gate refusal is a timeline row (`source: cycle`) and never a retry.
 *
 * The steps of later commit groups (referral, docket, exposure, claims) plug in here as they land; the unit's report names
 * every step it ran and every error it kept.
 */
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import { ENGINE_ACTOR } from "../default-35-9.ts";
import { asOfOf, foldInCommand, markExpectationsDue, need, s } from "./commands.ts";
import { isGateClosed, refusalCode } from "./delegate.ts";
import type { Row } from "./store.ts";

export interface StepOutcome { readonly ran: boolean; readonly detail?: Row; readonly error?: string; readonly refusal?: string }
export interface ProgressReport {
  readonly loan_id: string; readonly as_of_date: string; readonly events_folded: number; readonly unexpected: number; readonly milestones_due: number;
  readonly steps: Record<string, StepOutcome>; readonly errors: { step: string; error: string }[]; readonly refusals: { step: string; code: string }[];
}

/** One step of the unit: a gate refusal is recorded (the section already appended `foreclosure.gate.refused`), any other throw is kept and the unit goes on. */
export async function step(report: { steps: Record<string, StepOutcome>; errors: { step: string; error: string }[]; refusals: { step: string; code: string }[] }, name: string, fn: () => Promise<Row | void>): Promise<void> {
  try { const d = await fn(); report.steps[name] = { ran: true, ...(d ? { detail: d } : {}) }; }
  catch (e) {
    if (isGateClosed(e)) { const code = refusalCode(e); report.steps[name] = { ran: true, refusal: code }; report.refusals.push({ step: name, code }); return; }
    const msg = e instanceof Error ? e.message : String(e);
    report.steps[name] = { ran: false, error: msg }; report.errors.push({ step: name, error: msg });
  }
}

/** The optional step hooks the later commit groups register (referral, exposure, docket, claims); absent → the step is skipped, not failed. */
export interface ProgressSteps {
  readonly early_intervention?: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string) => Promise<Row | void>;
  readonly lossmit?: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string) => Promise<Row | void>;
  readonly foreclosure?: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string) => Promise<Row | void>;
  readonly bankruptcy?: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string) => Promise<Row | void>;
  readonly claims?: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string) => Promise<Row | void>;
}
export const PROGRESS_STEPS: { current: ProgressSteps } = { current: {} };

export async function caseProgress(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<ProgressReport> {
  const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const asOf = asOfOf(ctx, i);
  const report = { steps: {} as Record<string, StepOutcome>, errors: [] as { step: string; error: string }[], refusals: [] as { step: string; code: string }[] };
  let folded = 0, unexpected = 0, due = 0;
  // (a) the fold — everything the post-commit hook missed (events_folded counts the catch-up)
  await step(report, "fold", async () => { const r = await foldInCommand(ctx, rt, loanId, ENGINE_ACTOR); folded = r.folded; unexpected = r.unexpected; return { folded: r.folded, unexpected: r.unexpected }; });
  const hooks = PROGRESS_STEPS.current;
  // (b) 11.x — the contact cadence and 12.1's diligence follow-up, as default-collections / lossmit-underwriter
  if (hooks.early_intervention) await step(report, "early_intervention", () => hooks.early_intervention!(i, ctx, rt, asOf));
  // (c) 12.x — deemed rejection and the plan's end of term, through the sections' own tools
  if (hooks.lossmit) await step(report, "lossmit", () => hooks.lossmit!(i, ctx, rt, asOf));
  // (d) 13.x — review, referral proposal, exposure (rule 5), then the expectations due (rule 4)
  if (hooks.foreclosure) await step(report, "foreclosure", () => hooks.foreclosure!(i, ctx, rt, asOf));
  await step(report, "expectations_due", async () => { due = await markExpectationsDue(ctx, rt, loanId, asOf); return { due }; });
  // (e) 14.x — react to every docket entry with applied_at null (rule 6)
  if (hooks.bankruptcy) await step(report, "bankruptcy", () => hooks.bankruptcy!(i, ctx, rt, asOf));
  // (f) 15.x — the advance position and the claims sweep (rule 9)
  if (hooks.claims) await step(report, "claims", () => hooks.claims!(i, ctx, rt, asOf));
  return { loan_id: loanId, as_of_date: asOf, events_folded: folded, unexpected, milestones_due: due, steps: report.steps, errors: report.errors, refusals: report.refusals };
}
