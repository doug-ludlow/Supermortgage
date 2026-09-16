/**
 * §35.8 process-owned tools — the `case` agent's `work.queue`, `work.item.open`, `work.item.claim`, `work.item.release`,
 * `work.item.close`, `work.item.cancel`, `work.screen.read`, `work.screen.derive`, `work.screen.act`, `work.action.propose`,
 * `work.action.decide`, `work.log.recon` and `writeDecision` (spec/sections/35-operations-runtime/35-8-*.md "AI agent
 * design"), defined with `defineTools("35.8", "case", defs)` and spread by ./index.ts; every string is one
 * spec/registry/agents.json names for 35.8. Thin bus wrappers over src/domain/operations-runtime/work-35-8/* and
 * derivers-35-8.ts, run in the command's unit of work: rows are deferred into the command's transaction, events ride
 * ctx.events (the registry arms SM_WORK_* from them), the owning section's tool is dispatched through the command view
 * (a savepoint under the same transaction and lock), so a refusal writes nothing but the refused row (rule 7).
 *
 *   work.queue          read   the queue by role / screen / subject / status (rule 8: the console's five kinds widened).
 *   work.item.open      act    an item for a source no event raised (`manual`) or the pass's sources; agents may (the queue pass).
 *   work.item.claim     act    HUMAN ONLY — the session holds the item's role; CLAIMED_BY_OTHER{staff_user_id} for a second person.
 *   work.item.release   act    HUMAN ONLY — back to `open`.
 *   work.item.close     act    HUMAN ONLY — {disposition, reason, evidence_document_id?}.
 *   work.item.cancel    act    HUMAN ONLY — ops_analyst, {reason}.
 *   work.screen.read    read   the projection and the action list (rule 1); the roles are the tool's (rule 4).
 *   work.screen.derive  act    the dry run — the derivation row and its document, nothing else (rule 3).
 *   work.screen.act     act    HUMAN ONLY (HUMAN_ONLY_ACT) — derive, dispatch, log (rules 2–7).
 *   work.action.propose act    a proposal for a distinct officer (rule 5); the case agent's disposition with a rationale.
 *   work.action.decide  act    HUMAN ONLY — a distinct officer: approved re-derives (STALE_DERIVATION, rule 6) and executes; declined.
 *   work.log.recon      act    the daily reconciliation (rule 10) — the sweep's system actor, or compliance.
 *   writeDecision       act    the generic decision row.
 * Guardrails: NO_CLIENT_STATE (rule 2, inside the act), ROLE_REQUIRED (rule 4), TWO_PERSON_MONEY / SAME_PERSON (rule 5),
 * STALE_DERIVATION (rule 6), HUMAN_ONLY_ACT (the bus's humanOnly with this process's code), NO_CLOCK_EDIT, NO_NOTICE_OF_OWN,
 * NO_LEDGER_OF_OWN (rule 11), NO_PII_IN_LOG (34.1) — the last five as bus guardrails over the input's own keys.
 * Decision record (every act): {screen_code, screen_version, action_code, subject_kind, subject_id, decision_sha256,
 * input_sha256, tool, role, by, approval_of?, rule_set_version: work.v1, model_version: deterministic, prompt_version: 35.8-v1,
 * confidence: 1, rationale}.
 */
import { randomUUID } from "node:crypto";
import { defineTools, compute, decision, never, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime, type TimerSubject, type TimerSubjectDb } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import { HUMAN_ROLES } from "../roles.ts";
import { NO_CLOCK_EDIT, NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED } from "../../domain/operations-runtime/roles-35-7/guards.ts";
import { screenRead, screenDerive, screenAct, actionDecide, type ActDeps } from "../../domain/operations-runtime/work-35-8/act.ts";
import { openItem, claimItem, releaseItem, closeItem, cancelItem, workQueue, type ItemDeps } from "../../domain/operations-runtime/work-35-8/items.ts";
import { heldRoles } from "../../domain/operations-runtime/work-35-8/act.ts";
import { logRecon } from "../../domain/operations-runtime/work-35-8/recon.ts";
import type { WorkPorts } from "../../domain/operations-runtime/work-35-8/ports.ts";
import { PROCESS_35_8, WORK_AGENT, WORK_RULE_SET_VERSION, WORK_MODEL_VERSION, WORK_PROMPT_VERSION, actorId, isUuid, obj, subjectOf, type Row } from "../../domain/operations-runtime/work-35-8/types.ts";

const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const deferOf = (rt: ToolRuntime): ItemDeps["deferWrite"] => { const f = rt.services["deferWrite"] as ItemDeps["deferWrite"] | undefined; if (!f) throw new PortUnavailable("service:deferWrite"); return f; };
const portsOf = (rt: ToolRuntime): WorkPorts | undefined => rt.services["work_ports"] as WorkPorts | undefined;
const sessionOf = (i: ToolInput): string | null => (typeof i["session_id"] === "string" && isUuid(i["session_id"]) ? i["session_id"] : null);
const actDeps = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): ActDeps => ({ rt: runtimeOf(rt), q: dbOf(rt), store: rt.store, events: ctx.events, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, deferWrite: deferOf(rt), sessionId: sessionOf(i), ...(portsOf(rt) ? { ports: portsOf(rt)! } : {}) });
/** The clocks a command hydrates by subject (src/infra/db/timers.ts SUBJECT_HYDRATED_KINDS): the item's for the item tools and an act that names its item, the proposal's and its item's for the decide. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const itemSubjects = (i: ToolInput): TimerSubject[] => { const id = uuidOf(i["item_id"]) ?? uuidOf(i["work_item_id"]); return id ? [{ kind: "work_item", id }] : []; };
const decideSubjects = async (i: ToolInput, db: TimerSubjectDb): Promise<TimerSubject[]> => {
  const id = uuidOf(i["action_id"]); if (!id) return [];
  const [r] = await db.query<{ work_item_id: string | null }>(`SELECT work_item_id::text AS work_item_id FROM work_actions WHERE id = $1`, [id]);
  return [{ kind: "work_action", id }, ...(r?.work_item_id ? [{ kind: "work_item", id: r.work_item_id }] : [])];
};
const itemDeps = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): ItemDeps => ({ db: dbOf(rt), events: ctx.events, now: ctx.now, actor: ctx.actor, deferWrite: deferOf(rt), sessionId: sessionOf(i), registry: runtimeOf(rt).registry });
const held = async (ctx: CommandContext, rt: ToolRuntime): Promise<string[]> => heldRoles(dbOf(rt), ctx.actor);

// ---- guardrails (rule 11 / 34.1): the input's own keys, never a store
const keysOf = (i: ToolInput): string[] => [...Object.keys(i), ...Object.keys(obj(i["decision"]))];
export const NO_LEDGER_OF_OWN = never("NO_LEDGER_OF_OWN", "35.8 rule 11: 'Never a clock, never a notice, never a ledger line of its own … §35.8 owns no NTC code and no rule_ref'", (i) => ["entry_set", "lines", "rule_ref", "ledger_lines", "amountCents", "postings"].some((k) => i[k] !== undefined), "the screens post no ledger set; the owning tool's command does");
export const NO_NOTICE_OF_OWN = never("NO_NOTICE_OF_OWN", "35.8 rule 11: 'send no notice (16.1's sendNotice, 3.1's sendNotice, 25.2's deliverDisclosure do, dispatched as actions)'", (i) => ["template_code", "notice_id", "recipients", "render", "send_notice"].some((k) => i[k] !== undefined), "the screens send no notice of their own; a notice is the owning section's action");
export const TWO_PERSON_MONEY = never("TWO_PERSON_MONEY", "35.8 rule 5: 'Money-field actions are two people' — the screen adds no waiver of its own", (i) => ["approved", "approval", "skip_approval", "officer_override", "waive_approval", "self_approve", "approved_by", "approvedBy"].some((k) => i[k] !== undefined), "a money-field action is executed by a distinct officer through work.action.decide; an input that waives the second person is refused");
export const NO_PII_IN_LOG = never("NO_PII_IN_LOG", "34.1 rule 4 / 35.8 data model: the decision payload holds 'the person's fields only … never a name, address or account'", (i) => keysOf(i).some((k) => /^(email|e_mail|phone|name|legal_name|first_name|last_name|ssn|tin|address|account_number|routing_number|password|token)$/i.test(k)), "a screen carries ids, codes, dates and cents — never a name, address, account or token");
const COMMON = [NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED, NO_CLOCK_EDIT, NO_LEDGER_OF_OWN, NO_NOTICE_OF_OWN, TWO_PERSON_MONEY, NO_PII_IN_LOG];
const HUMAN_ONLY = { humanOnly: true, humanOnlyCode: "HUMAN_ONLY_ACT" } as const;
const ALL_ROLES = [...new Set(["ops_analyst", "officer", "compliance", ...HUMAN_ROLES])];
const READ_ROLES = [...ALL_ROLES, "admin"];

// ---- the decision record (AI agent design)
type Decision = NonNullable<ReturnType<NonNullable<ToolDef["decision"]>>>;
const workDecision = (action: string, subject: { kind: string; id: string }, fields: Row, rationale: string): Decision => {
  const record = { ...fields, rule_set_version: WORK_RULE_SET_VERSION, model_version: WORK_MODEL_VERSION, prompt_version: WORK_PROMPT_VERSION, confidence: 1, rationale };
  return { action, rationale: toJson(record), subject, ruleCode: WORK_RULE_SET_VERSION } as unknown as Decision;
};
const actDecision = (name: string) => (i: ToolInput, output: unknown, ctx: CommandContext): Decision => {
  const o = obj(output);
  return workDecision(`${name}:${String(o["status"] ?? o["decision"] ?? "done")}`, { kind: "work_action", id: String(o["action_id"] ?? "") }, { screen_code: o["screen_code"] ?? str(i, "code"), screen_version: o["screen_version"] ?? null, action_code: o["action_code"] ?? str(i, "action"), subject_kind: obj(i["subject"])["kind"] ?? null, subject_id: obj(i["subject"])["id"] ?? null, decision_sha256: null, input_sha256: o["input_sha256"] ?? null, tool: o["tool"] ? `${String(o["process"])} ${String(o["tool"])}` : null, role: ctx.actor.role ?? null, by: actorId(ctx.actor), approval_of: o["approval_of"] ?? o["executed_action_id"] ?? null }, str(i, "rationale") || `${name} ${String(o["status"] ?? o["decision"] ?? "")} by ${actorId(ctx.actor)}`);
};
const itemDecision = (name: string) => (i: ToolInput, output: unknown, ctx: CommandContext): Decision => { const o = obj(output); const it = obj(o["item"] ?? o); return workDecision(name, { kind: "work_item", id: String(it["id"] ?? str(i, "item_id")) }, { screen_code: it["screen_code"] ?? null, subject_kind: it["subject_kind"] ?? null, subject_id: it["subject_id"] ?? null, status: it["status"] ?? null, role: ctx.actor.role ?? null, by: actorId(ctx.actor) }, str(i, "reason") || str(i, "rationale") || `${name} by ${actorId(ctx.actor)}`); };

export const TOOLS_35_8: readonly ToolDef[] = defineTools(PROCESS_35_8, WORK_AGENT, [
  { name: "work.queue", kind: "read", ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: READ_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => workQueue(runtimeOf(rt), dbOf(rt), ctx.now, { role: str(i, "role") || null, screen: str(i, "screen") || null, status: str(i, "status") || null, subject: i["subject"] && typeof i["subject"] === "object" ? (i["subject"] as { kind: string; id: string }) : null, page: Number(i["page"] ?? 1), page_size: Number(i["page_size"] ?? 200) })) },
  { name: "work.item.open", kind: "act", ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => { const sub = subjectOf(i); const kind = str(i, "source_kind") || "manual"; const role = str(i, "required_role") || ctx.actor.role || "ops_analyst";
      return openItem(itemDeps(i, ctx, rt), { screen_code: str(i, "screen_code"), subject_kind: sub.kind, subject_id: sub.id, loan_id: sub.kind === "loan" ? sub.id : null, application_id: sub.kind === "application" ? sub.id : null, source_kind: kind as never, source_id: str(i, "source_id") || `manual:${randomUUID()}`, required_role: role, ...(str(i, "due_at") ? { due_at: str(i, "due_at") } : {}) }); }),
    decision: itemDecision("work.item.open") },
  { name: "work.item.claim", kind: "act", ...HUMAN_ONLY, timerSubjects: itemSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => claimItem(itemDeps(i, ctx, rt), await held(ctx, rt), str(i, "item_id"))), decision: itemDecision("work.item.claim") },
  { name: "work.item.release", kind: "act", ...HUMAN_ONLY, timerSubjects: itemSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => releaseItem(itemDeps(i, ctx, rt), str(i, "item_id"))), decision: itemDecision("work.item.release") },
  { name: "work.item.close", kind: "act", ...HUMAN_ONLY, timerSubjects: itemSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => closeItem(itemDeps(i, ctx, rt), await held(ctx, rt), { item_id: str(i, "item_id"), disposition: str(i, "disposition"), reason: str(i, "reason") || null, evidence_document_id: str(i, "evidence_document_id") || null })), decision: itemDecision("work.item.close") },
  { name: "work.item.cancel", kind: "act", ...HUMAN_ONLY, timerSubjects: itemSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ["ops_analyst"], guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => cancelItem(itemDeps(i, ctx, rt), { item_id: str(i, "item_id"), reason: str(i, "reason") })), decision: itemDecision("work.item.cancel") },
  { name: "work.screen.read", kind: "read", ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => screenRead(actDeps(i, ctx, rt), { code: str(i, "code"), subject: subjectOf(i) })) },
  { name: "work.screen.derive", kind: "act", ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => screenDerive(actDeps(i, ctx, rt), { code: str(i, "code"), action: str(i, "action"), subject: subjectOf(i), decision: obj(i["decision"]) })),
    decision: (i, output, ctx) => { const o = obj(output); return workDecision("work.screen.derive", { kind: "work_derivation", id: String(o["derivation_id"] ?? "") }, { screen_code: o["screen_code"] ?? str(i, "code"), action_code: o["action_code"] ?? str(i, "action"), subject_kind: obj(i["subject"])["kind"] ?? null, subject_id: obj(i["subject"])["id"] ?? null, input_sha256: o["input_sha256"] ?? null, tool: `${String(o["process"])} ${String(o["tool"])}`, role: ctx.actor.role ?? null, by: actorId(ctx.actor) }, "dry run: the derived input, its hash and sources; no write beyond the derivation"); } },
  { name: "work.screen.act", kind: "act", ...HUMAN_ONLY, timerSubjects: itemSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => screenAct(actDeps(i, ctx, rt), { code: str(i, "code"), action: str(i, "action"), subject: subjectOf(i), decision: obj(i["decision"]), work_item_id: str(i, "work_item_id") || null, rationale: str(i, "rationale") || null }, "act")),
    decision: actDecision("work.screen.act") },
  { name: "work.action.propose", kind: "act", timerSubjects: itemSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ALL_ROLES, guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => screenAct(actDeps(i, ctx, rt), { code: str(i, "code"), action: str(i, "action"), subject: subjectOf(i), decision: obj(i["decision"]), work_item_id: str(i, "work_item_id") || null, rationale: str(i, "rationale") || null }, "propose")),
    decision: actDecision("work.action.propose") },
  { name: "work.action.decide", kind: "act", ...HUMAN_ONLY, timerSubjects: decideSubjects, ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ["officer"], guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => { const decision = str(i, "decision"); if (decision !== "approved" && decision !== "declined") throw new RangeError("decision ∈ {approved, declined}"); return actionDecide(actDeps(i, ctx, rt), { action_id: str(i, "action_id"), decision, reason: str(i, "reason") || null }); }),
    decision: actDecision("work.action.decide") },
  { name: "work.log.recon", kind: "act", ruleSetVersion: WORK_RULE_SET_VERSION, humanRoles: ["compliance", "admin"], guardrails: COMMON,
    handler: compute(async (i, ctx, rt) => logRecon({ rt: runtimeOf(rt), q: dbOf(rt), events: ctx.events, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, deferWrite: deferOf(rt), ...(portsOf(rt) ? { ports: portsOf(rt)! } : {}) }, { as_of_date: str(i, "as_of_date") })),
    decision: (i, output, ctx) => { const o = obj(output); return workDecision("work.log.recon", { kind: "work_log_recon_run", id: String(o["run_id"] ?? "") }, { as_of_date: o["as_of_date"] ?? str(i, "as_of_date"), actions_checked: o["actions_checked"] ?? 0, orphans: o["orphans"] ?? 0, stale_screens: o["stale_screens"] ?? 0, sole_officer_money_acts: o["sole_officer_money_acts"] ?? 0, by: actorId(ctx.actor), role: ctx.actor.role ?? null }, `reconciled ${String(o["actions_checked"])} action(s): ${String(o["orphans"])} orphan(s), ${String(o["stale_screens"])} stale screen(s)`); } },
  { name: "writeDecision", kind: "act", ruleSetVersion: WORK_RULE_SET_VERSION, handler: decision() },
]);
export const WORK_TOOLS = TOOLS_35_8.map((t) => t.name);
