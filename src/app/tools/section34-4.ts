/**
 * §34.4 process-owned tools — the `compliance-sentinel` agent's `controls.timers`, `controls.escalation.complete`,
 * `controls.outbox.requeue`, `controls.ai.kill` and `controls.evidence.pack` (spec/sections/34-operator-portal/34-4-*.md
 * "AI agent design"), defined with `defineTools("34.4", "compliance-sentinel", defs)` and spread by ./index.ts. Every tool
 * string is one spec/registry/agents.json names for 34.4. Thin bus wrappers over src/runtime/controls/* (the runtime seam the
 * portal's routes call through the bus, so the staff member is the actor and the decision record names them):
 *
 *   controls.timers               read  every armed / due / breached clock with code, subject, due, the registry's severity and breach
 *                                       role, the arming and satisfying events — shown, never edited (rule 1).
 *   controls.escalation.complete  act   a named person completes an escalation with a disposition from its own set and a reason; the
 *                                       owning section's completion command runs where one exists, else the row; ROLE_REQUIRED
 *                                       against the escalation's role (rule 2). Decision {subject, action, disposition, reason, by}.
 *   controls.outbox.requeue       act   a dead / failed message back to queued, at most three times by hand; the fourth attempt is
 *                                       REQUEUE_CAP_3 and an ops_analyst escalation (rule 3). Decision {subject, action, reason, by}.
 *   controls.ai.kill              act   op=request (compliance: code, action trip | reset, reason) → a request row (event) that expires
 *                                       in 10 minutes; op=confirm (admin, a different person: request_id) → 18.1's trip / reset with
 *                                       both actors and the reason (rule 4). Decision {subject, action, reason, by, confirmed_by}.
 *   controls.evidence.pack        act   compliance assembles the stored rows for a loan / application / party / period with a manifest
 *                                       (count + sha256 per row set) and one document with a sha256, event parts of ≤ 100,000 (rule 5).
 *                                       Decision {subject: evidence_pack, action, reason: the subject, by}.
 *
 * Guardrails (the paragraph's list): NO_CLOCK_EDIT (an input that asks a clock to be satisfied, extended, cancelled or re-dated
 * is refused — only the owning process's events move a timer), ROLE_REQUIRED (an agent never completes, requeues, trips or
 * packs; an input naming a role to act as is refused — the session's role is the role; the handlers check the row's role),
 * TWO_PERSON_KILL (an input that asks to confirm its own request, skip the confirmation or name the confirmer is refused; the
 * handler refuses the requester as confirmer and any confirmation after 10 minutes), REQUEUE_CAP_3 (an input that asks to
 * reset the count, force or bypass the cap is refused; the handler counts the stored receipts), NO_MONEY_FIELD (any money key,
 * `changes`, a waiver or a refund in the input is refused — a waiver remains the owning section's officer command),
 * PACK_IS_STORED_ROWS (an input asking for a summary, a narrative, a computation or a model in the pack is refused).
 */
import { defineTools, compute, never, guard, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { CONTROLS_AGENT, CONTROLS_PROCESS, CONTROLS_RULE_SET_VERSION, controlsDecision, s, type Row } from "../../runtime/controls/common.ts";
import { controlsTimers } from "../../runtime/controls/timers.ts";
import { completeEscalation } from "../../runtime/controls/escalations.ts";
import { requeueMessage } from "../../runtime/controls/outbox.ts";
import { confirmKillSwitch, requestKillSwitch, type KillAction } from "../../runtime/controls/ai.ts";
import { buildEvidencePack, parseSubject } from "../../runtime/controls/evidence.ts";

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "" && i[k] !== false;
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const by = (ctx: CommandContext): string => (ctx.actor.kind === "human" ? ctx.actor.id : `${ctx.actor.kind}:${ctx.actor.id}`);

// ───────── guardrails ─────────

/** Rule 1: clocks are shown, never edited — an instruction to satisfy, extend, cancel, re-date or re-arm a timer is refused outright (the registry rule: only the owning process's events move a clock). */
const CLOCK_EDIT_KEYS = ["satisfy", "satisfied", "extend", "extension", "cancel", "cancelled", "due_at", "due_date", "new_due", "new_due_date", "rearm", "re_arm", "arm", "breach", "unbreach", "timer_status", "set_status", "changes"];
const CLOCK_EDIT_OPS = new Set(["satisfy", "extend", "cancel", "arm", "rearm", "edit", "update", "write", "breach", "set"]);
const NO_CLOCK_EDIT = never("NO_CLOCK_EDIT", "34.4 rule 1: 'Clocks are shown, never edited … a person cannot satisfy, extend or cancel a clock here — only the owning process's events do (the registry rule)'", (i) => CLOCK_EDIT_KEYS.some((k) => has(i, k)) || (typeof i.op === "string" && CLOCK_EDIT_OPS.has(i.op)), "clocks are shown, never edited: no route or tool satisfies, extends, cancels or re-dates a timer — the owning process's events do");
/** Rule 2 / 34.1 rule 3: the acts are a person's, under the session's own role — an agent never acts here, and an input naming a role to act as is refused (the handler checks the row's role against the actor's). */
const ROLE_KEYS = ["as_role", "act_as", "override_role", "assume_role", "role_override", "impersonate", "on_behalf_of"];
const ROLE_REQUIRED = guard("ROLE_REQUIRED", "34.4 rule 2: 'refuses an escalation whose role the caller lacks (ROLE_REQUIRED)'; 34.1 rule 3: the session's role is the role", (i, ctx) => ctx.actor.kind !== "human" ? "a controls act is a named person's: an agent may prepare but never complete, requeue, trip or pack" : ROLE_KEYS.some((k) => has(i, k)) ? `the session's role is the role; \`${ROLE_KEYS.find((k) => has(i, k))}\` is refused` : undefined);
/** Rule 4: two people — an input that confirms its own request, skips the confirmation, names the confirmer or trips directly is refused; the handler refuses the requester as confirmer and a late confirmation. */
const KILL_BYPASS_KEYS = ["confirmed", "confirmed_by", "self_confirm", "skip_confirmation", "no_confirmation", "single_person", "one_person", "force", "immediate", "trip_now", "bypass"];
const TWO_PERSON_KILL = never("TWO_PERSON_KILL", "34.4 rule 4: 'Tripping or resetting a system needs a compliance session and an admin confirmation within 10 minutes (a second request from an admin session naming the same request id)'", (i) => KILL_BYPASS_KEYS.some((k) => has(i, k)) || (i.op === "request" && has(i, "request_id") && has(i, "reason") && has(i, "code") && i["confirm"] === true), "the kill switch is two people's decision: compliance requests (op=request), a different admin confirms the request id within 10 minutes (op=confirm); nothing trips on one person");
/** Rule 3: the cap is three hand requeues, counted from the stored receipts — an input asking to reset, force or bypass it is refused. */
const CAP_BYPASS_KEYS = ["force", "reset_count", "reset_attempts", "ignore_cap", "bypass_cap", "override_cap", "unlimited", "attempts", "requeues"];
const REQUEUE_CAP_3 = never("REQUEUE_CAP_3", "34.4 rule 3: 'An outbox message may be requeued at most three times by hand … a fourth attempt opens an ops_analyst escalation instead'", (i) => CAP_BYPASS_KEYS.some((k) => has(i, k)), "at most three hand requeues per message; the count is the stored outbox.requeued receipts and cannot be reset or forced");
/** Rule 6: nothing here changes a money field — a money key, `changes`, a waiver or a refund in the input is refused; a waiver remains the owning section's officer command. */
const MONEY_RE = /(_cents|_bps|_pct)$|^(amount|cents|rate|upb|balance|fee|waive|waiver|refund|credit|payment|principal|interest|escrow|late_charge|ledger|entry_set|post)$/i;
const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "34.4 rule 6: 'Nothing here changes a money field. The tools dispatch the sections' own commands or write their own rows; a waiver remains the owning section's officer command'", (i) => Object.keys(i).some((k) => MONEY_RE.test(k)) || has(i, "changes") || has(i, "data"), "no money field is written by the portal; a waiver, a refund or a posting is the owning section's officer command");
/** Rule 5: the pack is the stored rows — nothing computed or summarized by a model; an input asking for it is refused. */
const PACK_COMPUTE_KEYS = ["summary", "summarize", "summarise", "narrative", "compute", "computed", "estimate", "model", "llm", "prompt", "explain", "analysis", "derive"];
const PACK_IS_STORED_ROWS = never("PACK_IS_STORED_ROWS", "34.4 AI agent design: 'PACK_IS_STORED_ROWS (nothing computed or summarized by a model in a pack)'; rule 5: 'each as the stored row, with a manifest and a hash'", (i) => PACK_COMPUTE_KEYS.some((k) => has(i, k)), "the pack is the stored rows with a manifest and a hash: nothing is computed, estimated, summarized or narrated in it");

const READ_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance", "admin"];

// ───────── the tools ─────────

export const TOOLS_34_4: readonly ToolDef[] = defineTools(CONTROLS_PROCESS, CONTROLS_AGENT, [
  { name: "controls.timers", kind: "read", humanRoles: READ_ROLES, guardrails: [NO_CLOCK_EDIT, NO_MONEY_FIELD],
    handler: compute((i, ctx, rt) => controlsTimers(runtimeOf(rt), { status: str(i, "status") || null, code: str(i, "code") || null, subject: str(i, "subject") || str(i, "loan_id") || ctx.loanId || null, due_before: str(i, "due_before") || null, ...(typeof i["limit"] === "number" ? { limit: i["limit"] } : {}) }, ctx.now)) },
  { name: "controls.escalation.complete", kind: "act", ruleSetVersion: CONTROLS_RULE_SET_VERSION, humanOnly: true, humanRoles: ["ops_analyst", "officer", "compliance"], guardrails: [ROLE_REQUIRED, NO_CLOCK_EDIT, NO_MONEY_FIELD],
    handler: compute((i, ctx, rt) => completeEscalation(runtimeOf(rt), { id: str(i, "escalation_id") || str(i, "id"), disposition: str(i, "disposition"), reason: str(i, "reason"), actor: ctx.actor }, ctx.now)),
    decision: (i, output, ctx) => { const o = obj(output); return controlsDecision({ subject: { kind: "escalation", id: s(o["escalation_id"]) || str(i, "escalation_id") || str(i, "id") }, action: "controls.escalation.complete", disposition: s(o["disposition"]) || str(i, "disposition"), reason: str(i, "reason"), by: by(ctx), by_role: ctx.actor.role ?? null }); } },
  { name: "controls.outbox.requeue", kind: "act", ruleSetVersion: CONTROLS_RULE_SET_VERSION, humanOnly: true, humanRoles: ["ops_analyst", "officer"], guardrails: [ROLE_REQUIRED, REQUEUE_CAP_3, NO_CLOCK_EDIT, NO_MONEY_FIELD],
    handler: compute((i, ctx, rt) => requeueMessage(runtimeOf(rt), { id: str(i, "message_id") || str(i, "id"), actor: ctx.actor, reason: str(i, "reason") || null }, ctx.now)),
    decision: (i, output, ctx) => { const o = obj(output); return controlsDecision({ subject: { kind: "integration_message", id: s(o["message_id"]) || str(i, "message_id") || str(i, "id") }, action: "controls.outbox.requeue", reason: str(i, "reason") || `hand requeue ${s(o["requeue_no"])} of 3`, by: by(ctx), by_role: ctx.actor.role ?? null }); } },
  { name: "controls.ai.kill", kind: "act", ruleSetVersion: CONTROLS_RULE_SET_VERSION, humanOnly: true, humanRoles: ["compliance", "admin"], guardrails: [ROLE_REQUIRED, TWO_PERSON_KILL, NO_CLOCK_EDIT, NO_MONEY_FIELD],
    handler: compute((i, ctx, rt) => {
      const runtime = runtimeOf(rt); const op = str(i, "op") || (str(i, "request_id") ? "confirm" : "request");
      if (op === "confirm") return confirmKillSwitch(runtime, { request_id: str(i, "request_id"), actor: ctx.actor }, ctx.now);
      if (op !== "request") throw new RangeError("controls.ai.kill op is request (compliance) or confirm (admin)");
      const action = (str(i, "action") || "trip") as KillAction;
      return requestKillSwitch(runtime, { code: str(i, "code") || str(i, "system") || str(i, "agent"), action, reason: str(i, "reason"), actor: ctx.actor }, ctx.now);
    }),
    decision: (i, output, ctx) => { const o = obj(output); const confirm = (str(i, "op") || (str(i, "request_id") ? "confirm" : "request")) === "confirm";
      return controlsDecision({ subject: { kind: "ai_system", id: s(o["code"]) || str(i, "code") }, action: confirm ? `controls.ai.kill:confirm:${s(o["action"])}` : `controls.ai.kill:request:${s(o["action"]) || str(i, "action") || "trip"}`, reason: s(o["reason"]) || str(i, "reason"), by: confirm ? s(o["by"]) : by(ctx), by_role: confirm ? "compliance" : ctx.actor.role ?? null, confirmed_by: confirm ? by(ctx) : null }); } },
  { name: "controls.evidence.pack", kind: "act", ruleSetVersion: CONTROLS_RULE_SET_VERSION, humanOnly: true, humanRoles: ["compliance"], guardrails: [ROLE_REQUIRED, PACK_IS_STORED_ROWS, NO_CLOCK_EDIT, NO_MONEY_FIELD],
    handler: compute((i, ctx, rt) => buildEvidencePack(runtimeOf(rt), { subject: parseSubject(i["subject"] ?? i), ...(Array.isArray(i["sections"]) ? { sections: (i["sections"] as unknown[]).map(String) } : {}), produced_by: ctx.actor, ...(typeof i["part_size"] === "number" ? { part_size: i["part_size"] } : {}) }, ctx.now)),
    decision: (i, output, ctx) => { const o = obj(output); const m = obj(o["manifest"]); const subj = obj(m["subject"]);
      return controlsDecision({ subject: { kind: "evidence_pack", id: s(o["id"]) }, action: "controls.evidence.pack", reason: `pack for ${s(subj["kind"])} ${s(subj["id"]) || `${s(subj["from_date"])}..${s(subj["to_date"])}`}: ${Array.isArray(o["sections"]) ? (o["sections"] as unknown[]).length : 0} row sets, ${s(o["part_count"])} event part(s), sha256 ${s(o["sha256"])}`, by: by(ctx), by_role: ctx.actor.role ?? null }); } },
]);
