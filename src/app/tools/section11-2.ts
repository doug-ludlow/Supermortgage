/**
 * §11.2 process-owned tools — additional bus tools for 11.2 defined with `defineTools("11.2", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section11.ts). Every tool string must be one
 * spec/registry/agents.json names for 11.2; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * The 11.2 written-notice request step (`requestWrittenEiNotice`) also lives here: the section's `notice.render`
 * tool calls it before rendering an EI variant. It appends `notice.early_intervention_written.requested` — the
 * trigger of the 4.3 gate `REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE` (11.2 timer table: "assignment exists";
 * breach "auto-assign then send") — and, when no assigned-contact block exists, either runs the 4.3
 * auto-assignment (`ensureContinuityAssignment` → `continuity.assigned`, the gate's satisfier) with the
 * default team the caller names, or refuses the send with the gate's code (11.2-T9).
 */
import { str, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ensureContinuityAssignment } from "./section04.ts";
import type { ContactTeamBlock } from "../../domain/servicing-requests/ops.ts";
import { writtenNoticeRequest, type AssignedTeam } from "../../domain/early-intervention/ops-11-2.ts";

export const TOOLS_11_2: readonly ToolDef[] = [];

export const ASSIGN_BEFORE_EI_NOTICE = "REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE";
const ASSIGN_CITATION = "§1024.40(a)(1); §1024.39(b)(2)(ii); 11.2 timer table REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE: assignment exists — auto-assign then send";

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
/** The caller's `default_team` (4.3 ContactTeamBlock) when complete enough to assign. */
const defaultTeam = (i: ToolInput): ContactTeamBlock | null => {
  const t = i.default_team as Partial<ContactTeamBlock> | undefined;
  if (!t || !nonEmpty(t.team_name) || !nonEmpty(t.direct_number) || !nonEmpty(t.named_human_first_name)) return null;
  return { team_name: t.team_name, named_human_first_name: t.named_human_first_name, direct_number: t.direct_number, title: nonEmpty(t.title) ? t.title : "Loan Counselor", hours: nonEmpty(t.hours) ? t.hours : "8 a.m.–8 p.m. local, Monday–Friday" };
};
/** The active 4.3 episode on the store (continuity.assign / an earlier auto-assign), as the block the notice carries. */
const activeAssignment = (rt: ToolRuntime, loanId: string | undefined, episodeId: string): AssignedTeam | null => {
  const e = rt.store.get("continuity_episodes", episodeId)?.data;
  if (!e || e.status !== "assigned" || (e.loan_id !== undefined && e.loan_id !== loanId)) return null;
  const named = e.named_human ?? e.named_human_first_name;
  return { team_name: String(e.team_name ?? e.team ?? ""), direct_number: String(e.direct_number ?? ""), ...(nonEmpty(named) ? { named_human_first_name: named } : {}) };
};

/**
 * 11.2-T9: "Given the assigned-contact block is missing at render, then the send is refused, auto-assignment runs
 * (4.3) and the re-render passes." Returns the render payload carrying the team block; appends the request event
 * (arms the 4.3 gate) for every EI-variant render; non-EI templates pass through untouched.
 */
export function requestWrittenEiNotice(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Record<string, unknown> {
  const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
  const payload = (i.payload as Record<string, unknown> | undefined) ?? {};
  const template = str(i, "template_code");
  const episodeId = str(i, "episode_id") || `ep-${loanId}`;
  const r = writtenNoticeRequest({ template, payload, active_assignment: activeAssignment(rt, loanId, episodeId), requested_on: D(ctx.now.slice(0, 10)) });
  if (!r.event) return payload;
  ctx.events.append({ type: r.event.type, ...(loanId ? { loanId } : {}), actor: ctx.actor, payload: { ...r.event.payload, episode_id: episodeId } });
  if (r.block_source !== null) return r.payload;   // the caller's payload or the active 4.3 episode carries the block: the gate's "assignment exists"
  const team = defaultTeam(i);
  if (!team) {
    const reason = `no assigned-contact block for ${template}: no active 4.3 episode ${episodeId} and no default_team to auto-assign — the (b)(2)(ii) telephone number is the assigned team's (action: ${r.gate.action})`;
    ctx.events.append({ type: "command.refused", ...(loanId ? { loanId } : {}), actor: ctx.actor, payload: { command: "notice.render", code: ASSIGN_BEFORE_EI_NOTICE, citation: ASSIGN_CITATION, reason, subject_id: episodeId } });
    throw new CommandRefused("notice.render", ASSIGN_BEFORE_EI_NOTICE, ASSIGN_CITATION, reason);
  }
  // "auto-assign then send": the 4.3 helper assigns the default team (emits `continuity.assigned`) and returns the block.
  const dueUnpaid = nonEmpty(i.due_unpaid) ? D(i.due_unpaid) : nonEmpty(payload.due_date) ? D(payload.due_date) : D(ctx.now.slice(0, 10));
  const a = ensureContinuityAssignment(rt, ctx, { team, due_unpaid: dueUnpaid, principal_residence: i.principal_residence !== false, episode_id: episodeId });
  return { ...r.payload, team_name: a.notice_block.team_name, team_phone: a.notice_block.direct_number, named_human: a.notice_block.named_human_first_name, continuity_block_present: true, auto_assigned: a.auto_assigned, episode_id: a.episode_id };
}
