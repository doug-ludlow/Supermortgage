/**
 * §6.5 process-owned tools — the two 6.5 tool strings (spec/registry/agents.json) whose acts live in
 * src/domain/custodial/ops-6-5.ts; the other ten stay in ./section06.ts (p65), which takes `timerOps65` from here the
 * way it takes `timerOps63` from ./section6-3.ts. Every tool string is one the spec names for 6.5; src/app/tools.test.ts
 * refuses the rest and refuses a name defined twice for the process.
 *
 *   timer.*                    op=tick_weekly_register → weeklyRegisterTick (the Monday 06:00 `schedule.tick` that arms
 *                              SM_SUSPENSE_REGISTER_WEEKLY); op=review_register → reviewSuspenseRegister (the reviewer
 *                              run: `suspense.register.reviewed` satisfies and re-arms the row); op=cycle_sweep → the
 *                              per-state `unclaimed_property.cycle` sweep; list/open/arm/cancel as the kernel's timerOps
 *   unclaimed_property.compute op=compute (default) → escheat() dates; op=open → openUnclaimedPropertyItem
 *                              (`unclaimed_property.item_opened` arms STATE_UUPA_DORMANCY_3Y); op=presume_abandoned →
 *                              presumeAbandoned (`unclaimed_property.presumed_abandoned` arms the due-diligence window and
 *                              STATE_UUPA_REPORT_NOV1); op=officer_task → openOfficerVerificationTask; op=due_diligence_notice
 *                              → sendDueDiligenceNotice (`notice.sent{template=UP-DUE-DILIGENCE-v1}`); op=report →
 *                              reportUnclaimedProperty (`unclaimed_property.reported{remitted=true}`; a human act under the
 *                              officer's verification — agents prepare, never file)
 */
import { defineTools, timerOps, compute, humanWhen, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { escheat } from "../../domain/custodial/suspense.ts";
import { openUnclaimedPropertyItem, presumeAbandoned, openOfficerVerificationTask, unclaimedPropertyCycleSweep, sendDueDiligenceNotice, reportUnclaimedProperty, weeklyRegisterTick, reviewSuspenseRegister, type SuspenseOps65, type UnclaimedPropertyItemFacts, type RegisterItem } from "../../domain/custodial/ops-6-5.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | undefined => (typeof i[k] === "string" && i[k] !== "" ? D(str(i, k)) : undefined);
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const opsOf = (ctx: CommandContext, rt: ToolRuntime): SuspenseOps65 => ({ events: ctx.events, actor: ctx.actor, now: ctx.now, store: rt.store, escalations: rt.escalations });
const refuse = (ctx: CommandContext, command: string, code: string, citation: string, reason: string, subjectId?: string): never => {
  ctx.events.append({ type: "command.refused", ...(ctx.loanId ? { loanId: ctx.loanId } : {}), actor: ctx.actor, payload: { command, code, citation, reason, subject_id: subjectId ?? null } });
  throw new CommandRefused(command, code, citation, reason);
};
/** Register rows from the store (or the caller's list) shaped for the weekly review. */
const registerItems = (i: ToolInput, rt: ToolRuntime): RegisterItem[] => {
  if (Array.isArray(i.items)) return rows<Record<string, unknown>>(i, "items").map((r) => ({ id: String(r.id), loan_id: (r.loan_id as string | null | undefined) ?? null, amount_cents: cents(r.amount_cents), status: String(r.status ?? "open"), reason_code: String(r.reason_code ?? "other"), received_on: D(String(r.received_on)) }));
  return rt.store.list("suspense_items").map((r) => ({ id: r.id, loan_id: (r.data.loan_id as string | null | undefined) ?? null, amount_cents: cents(r.data.amount_cents), status: String(r.data.status ?? "open"), reason_code: String(r.data.reason_code ?? "other"), received_on: D(String(r.data.received_on)) }));
};
const upFacts = (i: ToolInput, rt: ToolRuntime, k = "items"): UnclaimedPropertyItemFacts[] => {
  if (Array.isArray(i[k])) return rows<Record<string, unknown>>(i, k).map((r) => ({ id: String(r.id), state: String(r.state ?? ""), amount_cents: cents(r.amount_cents), dormancy_start_on: D(String(r.dormancy_start_on)), status: String(r.status ?? "dormant"), loan_id: (r.loan_id as string | null | undefined) ?? null }));
  return rt.store.list("unclaimed_property_items").map((r) => ({ id: r.id, state: String(r.data.state ?? ""), amount_cents: cents(r.data.amount_cents), dormancy_start_on: D(String(r.data.dormancy_start_on)), status: String(r.data.status ?? "dormant"), loan_id: (r.data.loan_id as string | null | undefined) ?? null }));
};

/** `timer.*` for 6.5: the acts behind the register's scheduled rows, then the kernel's list/open/arm/cancel. */
export const timerOps65 = compute((i, ctx, rt) => {
  switch (i.op) {
    case "tick_weekly_register": return ctx.events.append(weeklyRegisterTick(date(i, "date")));
    case "review_register": return reviewSuspenseRegister(opsOf(ctx, rt), { ...(optDate(i, "reviewed_on") ? { reviewed_on: optDate(i, "reviewed_on")! } : {}), items: registerItems(i, rt), reviewer: str(i, "reviewer") || `${ctx.actor.kind}:${ctx.actor.id}` });
    case "cycle_sweep": return unclaimedPropertyCycleSweep(opsOf(ctx, rt), { today: date(i, "date"), items: upFacts(i, rt) });
    default: return timerOps()(i, ctx);
  }
});

const unclaimedPropertyOps = compute((i, ctx, rt) => {
  const ops = opsOf(ctx, rt);
  switch (i.op ?? "compute") {
    case "compute": return escheat(date(i, "dormancy_start_on"), str(i, "state") || "DEFAULT");
    case "open": { need(i, "state", "amount_cents", "dormancy_start_on"); return openUnclaimedPropertyItem(ops, { ...(str(i, "id") ? { id: str(i, "id") } : {}), ...(str(i, "suspense_item_id") ? { suspense_item_id: str(i, "suspense_item_id") } : {}), ...(str(i, "outstanding_check_id") ? { outstanding_check_id: str(i, "outstanding_check_id") } : {}), loan_id: str(i, "loan_id") || null, owner_name: str(i, "owner_name") || null, owner_last_address: str(i, "owner_last_address") || null, state: str(i, "state"), amount_cents: cents(i.amount_cents), dormancy_start_on: date(i, "dormancy_start_on"), naupa_property_code: str(i, "naupa_property_code") || null }); }
    case "presume_abandoned": need(i, "id"); return presumeAbandoned(ops, { id: str(i, "id"), ...(optDate(i, "today") ? { today: optDate(i, "today")! } : {}) });
    case "officer_task": need(i, "id"); return openOfficerVerificationTask(ops, { id: str(i, "id"), ...(optDate(i, "today") ? { today: optDate(i, "today")! } : {}) });
    case "due_diligence_notice": need(i, "id"); return sendDueDiligenceNotice(ops, { id: str(i, "id"), ...(str(i, "notice_id") ? { notice_id: str(i, "notice_id") } : {}), ...(optDate(i, "sent_on") ? { sent_on: optDate(i, "sent_on")! } : {}), ...(str(i, "channel") ? { channel: str(i, "channel") } : {}), recipient_party_id: str(i, "recipient_party_id") || null });
    case "report": {
      need(i, "state", "cycle", "file_id", "filed_on");
      const file = rt.store.get("naupa_files", str(i, "file_id"));
      if (!file) refuse(ctx, "unclaimed_property.compute", "NAUPA_FILE", "6.5 rule 7: the NAUPA II file is generated per state with the officer's verification", `no NAUPA II file ${str(i, "file_id")} (naupa.generate first)`, str(i, "file_id"));
      if (!file!.data.officer_verification) refuse(ctx, "unclaimed_property.compute", "OFFICER_VERIFICATION", "6.5 rule 7 / agent design: `officer` verifies and files the state report", `file ${str(i, "file_id")} carries no officer verification`, str(i, "file_id"));
      const ids = rows<string>(i, "item_ids");
      const items = upFacts({ items: ids.map((id) => rt.store.get("unclaimed_property_items", id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ id: r.id, ...r.data })) }, rt);
      if (items.length !== ids.length) throw new RangeError(`unknown unclaimed_property_items: ${ids.filter((id) => !rt.store.get("unclaimed_property_items", id)).join(", ")}`);
      return reportUnclaimedProperty(ops, { state: str(i, "state"), cycle: str(i, "cycle"), file_id: str(i, "file_id"), filed_on: date(i, "filed_on"), remitted: flag(i, "remitted"), remittance_cents: cents(i.remittance_cents), state_confirmation_ref: str(i, "state_confirmation_ref") || null, items });
    }
    default: throw new RangeError(`unclaimed_property.compute op ${String(i.op)} is not one of compute/open/presume_abandoned/officer_task/due_diligence_notice/report`);
  }
});

export const TOOLS_6_5: readonly ToolDef[] = defineTools("6.5", "custodial-recon", [
  { name: "unclaimed_property.compute", kind: "write", moneyFields: ["amount_cents", "remittance_cents"], handler: unclaimedPropertyOps,
    guardrails: [humanWhen("OFFICER_FILES", "6.5 integrations: NAUPA II file per state; upload/e-file by the `officer` (or ops staff under officer verification) through state portals", (i) => i.op === "report", "the state report is filed by a person under the officer's verification; agents prepare the file")],
    decision: (i, out) => (i.op && i.op !== "compute" ? { action: `unclaimed_property.${String(i.op)}`, rationale: str(i, "reason") || `${String(i.op)} by the custodial-recon suspense module`, subject: { kind: "unclaimed_property_item", id: str(i, "id") || (out && typeof out === "object" && "id" in out ? String((out as { id: unknown }).id) : str(i, "file_id") || "*") }, ruleCode: "6.5 rule 7" } : null) },
]);
