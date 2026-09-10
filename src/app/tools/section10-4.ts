/**
 * §10.4 process-owned tools — additional bus tools for 10.4 defined with `defineTools("10.4", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section10.ts). Every tool string must be one
 * spec/registry/agents.json names for 10.4; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * The spec names four tools for 10.4 and no more, so the disclosure cycle's code paths hang off the section's
 * `notices.compose/send` (handler `disclosureComposeSendOps_10_4`, bound in ./section10.ts):
 *   op `compose`      — carrier + template + checklist → `mi_disclosures` row, `mi.disclosure.composed`
 *   op `release`      — re-check MI status, send through the Notice Registry → `mi.disclosure.sent` (+ `notice.sent`)
 *   op `compose_send` — both (default; also the standalone auto-send path)
 * A template outside the annual-disclosure family falls through to the registry's plain render+send.
 */
import { noticeOps, str, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Recipient } from "../../notices/channel.ts";
import { composeDisclosure, releaseDisclosure, composeAndReleaseDisclosure, DISCLOSURE_CODES, type DisclosureDeps, type ComposeInput } from "../../domain/pmi/ops-10-4.ts";

export function disclosureDeps(ctx: CommandContext, rt: ToolRuntime): DisclosureDeps {
  return { events: ctx.events, timers: ctx.timers, store: rt.store, clock: { now: () => ctx.now }, escalations: rt.escalations, actor: ctx.actor, ...(rt.notices ? { notices: rt.notices } : {}) };
}

const optDate = (i: ToolInput, k: string): PlainDate | null | undefined => (i[k] === undefined ? undefined : i[k] === null || i[k] === "" ? null : D(str(i, k)));
const composeInput = (i: ToolInput, ctx: CommandContext): ComposeInput => {
  const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
  if (!loanId) throw new RangeError("loan_id is required");
  const inc = i.included_with as ComposeInput["included_with"] | undefined;
  if (inc !== undefined && !["escrow_statement", "form_1098", "standalone"].includes(inc)) throw new RangeError(`included_with ${String(inc)} is not escrow_statement/form_1098/standalone`);
  const esc = optDate(i, "escrow_statement_on"), f1098 = optDate(i, "form_1098_on"), sendOn = optDate(i, "send_on");
  const p80 = optDate(i, "projected_80_date"), p78 = optDate(i, "projected_78_date"), pMid = optDate(i, "projected_midpoint_date");
  return { loan_id: loanId, ...(Array.isArray(i.recipients) ? { recipients: i.recipients as readonly Recipient[] } : {}), ...(i.payload && typeof i.payload === "object" ? { payload: i.payload as Record<string, unknown> } : {}),
    ...(typeof i.template_code === "string" && i.template_code ? { template_code: i.template_code } : {}), ...(inc !== undefined ? { included_with: inc } : {}), ...(sendOn ? { send_on: sendOn } : {}),
    ...(esc !== undefined ? { escrow_statement_on: esc } : {}), ...(f1098 !== undefined ? { form_1098_on: f1098 } : {}), ...(typeof i.schedule_version_id === "string" ? { schedule_version_id: i.schedule_version_id } : {}),
    ...(p80 !== undefined ? { projected_80_date: p80 } : {}), ...(p78 !== undefined ? { projected_78_date: p78 } : {}), ...(pMid !== undefined ? { projected_midpoint_date: pMid } : {}) };
};

/** `notices.compose/send` for 10.4: the disclosure cycle ops above; other templates go through the registry as before. */
export function disclosureComposeSendOps_10_4(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown | Promise<unknown> {
  const op = String(i.op ?? "compose_send");
  const template = str(i, "template_code");
  if (op === "compose_send" && template && !DISCLOSURE_CODES.has(template)) return noticeOps("render_send")(i, ctx, rt);
  const deps = disclosureDeps(ctx, rt);
  const channel = i.channel_context && typeof i.channel_context === "object" ? { channel_context: i.channel_context as Record<string, unknown> } : {};
  switch (op) {
    case "compose": return composeDisclosure(deps, composeInput(i, ctx));
    case "release": case "send": { const id = str(i, "disclosure_id"); if (!id) throw new RangeError("disclosure_id is required"); return releaseDisclosure(deps, { disclosure_id: id, ...channel }); }
    case "compose_send": return composeAndReleaseDisclosure(deps, { ...composeInput(i, ctx), ...channel });
    default: throw new RangeError(`op ${op} is not one of compose/release/compose_send`);
  }
}

export const TOOLS_10_4: readonly ToolDef[] = [];
