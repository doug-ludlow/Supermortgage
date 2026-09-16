/**
 * §35.9 rule 7 — "Every breach runs its registered action in the breach transaction." The sweep's breach pass (src/runtime/app.ts)
 * calls `breach.execute{timer_id}` for each evaluated breach after opening the escalation it opens today, on the breach
 * transaction's command view; the executor reads `breach_action_registry` for the code (its `cited_text` must still be the
 * registry's breach column, else REGISTRY_STALE → escalated_only + a compliance escalation), runs the registered action through
 * the owning section's tool with the input the named deriver builds from the case row (never from the breach payload), and
 * writes exactly one `breach_actions` row per breach instance (`timer_id` unique — ONE_ACTION_PER_BREACH): executed /
 * deferred / escalated_only / refused / failed. `breach.recon{as_of_date}` (daily, once, before the receipt) counts the day's
 * `timer.breached` events without a row and the failed rows. A registry row is added or re-versioned only by `compliance` with
 * `officer` confirmation (35.7's approval record) and never with an action the `cited_text` does not name.
 */
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { loadOverriddenRegistry } from "../../timer-overrides.ts";
import type { TimerRegistry } from "../../../kernel/timers/registry.ts";
import { wallClock, zonedEpochMs, toIso } from "../../../kernel/calendar/zoned.ts";
import { addDays, plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { ENGINE_ACTOR, ET, EV, PROMPT_VERSION_35_9, REFUSALS, RULE_SET_VERSION_35_9, citedTextNames, type ActionKind, type BreachOutcome } from "../default-35-9.ts";
import { asOfOf, need, portsFor, q, s } from "./commands.ts";
import { delegate, isGateClosed, refusalCode } from "./delegate.ts";
import { firmDispatch } from "./firm.ts";
import { caseUuid, loanRows, openBankruptcy, openForeclosure, str, type CurrentRow, type Row } from "./store.ts";

let registryCache: TimerRegistry | null = null;
const registry = (): TimerRegistry => (registryCache ??= loadOverriddenRegistry());
export type RegistryRow = { readonly timer_code: string; readonly owner_process: string; readonly cited_text: string; readonly action_kind: ActionKind; readonly action_spec: Row; readonly needs_human: boolean; readonly version: number };
export const registryRow = async (qx: Queryable, code: string): Promise<RegistryRow | null> =>
  (await qx.query<RegistryRow>(`SELECT timer_code, owner_process, cited_text, action_kind, action_spec, needs_human, version FROM breach_action_registry WHERE timer_code = $1`, [code]))[0] ?? null;
/** The registry's breach column for a code, verbatim (the lowest-numbered section owns a shared code — the loader's unique row). */
export const citedTextOf = (code: string): string | null => registry().get(code)?.breach ?? null;

// ---- the derivers (35.8 rule 3's pattern: a named function over the case row, never raw input) -------------------------------
type Deriver = (qx: Queryable, rt: ToolRuntime, loanId: string, spec: Row) => Promise<{ process: string; tool: string; input: Row; gate_step?: string } | null>;
const fcCase = async (qx: Queryable, rt: ToolRuntime, loanId: string): Promise<CurrentRow | null> => rt.store.list("foreclosure_cases", (d) => d["loan_id"] === loanId && !/^closed_/.test(String(d["status"] ?? "")))[0] ?? openForeclosure(await loanRows(qx, "foreclosure_cases", loanId));
const bkCase = async (qx: Queryable, rt: ToolRuntime, loanId: string): Promise<CurrentRow | null> => rt.store.list("bankruptcy_cases", (d) => d["loan_id"] === loanId)[0] ?? openBankruptcy(await loanRows(qx, "bankruptcy_cases", loanId));
const referralOf = (rt: ToolRuntime, caseRef: string): CurrentRow | null => rt.store.list("attorney_referrals", (d) => d["case_id"] === caseRef).at(-1) ?? null;
const matterOf = (rt: ToolRuntime, caseRef: string): CurrentRow | null => rt.store.list("attorney_matters", (d) => d["case_id"] === caseRef).at(-1) ?? null;
export const DERIVERS: Readonly<Record<string, Deriver>> = {
  async ackDemandFromCase(qx, rt, loanId, spec) {
    const fc = await fcCase(qx, rt, loanId); if (!fc) return null;
    const ref = referralOf(rt, fc.id); const matter = matterOf(rt, fc.id);
    return { process: "13.6", tool: "attorney.message.send", input: { kind: String(spec["kind"] ?? "ack_demand"), loan_id: loanId, firm_id: str(fc.data, "firm_id") || str(ref?.data ?? {}, "firm_id"), case_id: fc.id, ...(ref ? { referral_id: ref.id } : {}), ...(matter ? { matter_id: matter.id } : {}), subject: `Acknowledgment demand — referral of ${loanId} (E-3.2-05: two business days)`, scorecard: spec["scorecard"] === true } };
  },
  async statusDemandFromCase(qx, rt, loanId, spec) {
    const fc = await fcCase(qx, rt, loanId); if (!fc) return null;
    const matter = matterOf(rt, fc.id);
    return { process: "13.6", tool: "attorney.message.send", input: { kind: String(spec["kind"] ?? "status_demand"), loan_id: loanId, firm_id: str(fc.data, "firm_id"), case_id: fc.id, ...(matter ? { matter_id: matter.id } : {}), subject: `Status demand — case ${fc.id} (${str(fc.data, "status")})` } };
  },
  async postponeSaleFromCase(qx, rt, loanId, spec) {
    const fc = await fcCase(qx, rt, loanId); if (!fc) return null;
    return { process: "13.2", tool: "attorney.instruction.send", gate_step: String(spec["gate_step"] ?? "sale_conduct"), input: { loan_id: loanId, kind: "POSTPONE_SALE", firm_id: str(fc.data, "firm_id"), case_id: fc.id, ...(str(fc.data, "sale_scheduled_at") ? { sale_on: str(fc.data, "sale_scheduled_at").slice(0, 10) } : {}) } };
  },
  async docketSyncFromCase(qx, rt, loanId) {
    const bk = await bkCase(qx, rt, loanId); if (!bk) return null;
    return { process: "35.9", tool: "docket.sync", input: { loan_id: loanId, case_id: bk.id } };
  },
  async documentRequestFromCase(qx, rt, loanId) { const fc = await fcCase(qx, rt, loanId); return fc ? { process: "35.8", tool: "work.item.open", input: { case_id: fc.id } } : null; },
  async micpUploadFromCandidate(qx, _rt, loanId) { const c = (await qx.query<{ id: string }>(`SELECT id::text AS id FROM claim_candidates WHERE loan_id = $1::uuid AND claim_kind = 'mi_claim' AND status NOT IN ('closed', 'withdrawn', 'settled') ORDER BY opened_at DESC LIMIT 1`, [loanId]))[0]; return c ? { process: "35.8", tool: "work.item.open", input: { candidate_id: c.id } } : null; },
};

export type ActionRow = { readonly id: string; readonly timer_id: string; readonly timer_code: string; readonly outcome: BreachOutcome; readonly action_kind: string; readonly command_event_id: string | null; readonly escalation_id: string | null; readonly work_item_id: string | null; readonly refusal_code: string | null; readonly error_class: string | null; readonly registry_version: number | null };
const ASEL = `id::text AS id, timer_id::text AS timer_id, timer_code, outcome, action_kind, command_event_id::text AS command_event_id, escalation_id::text AS escalation_id, work_item_id::text AS work_item_id, refusal_code, error_class, registry_version`;
export const actionOf = async (qx: Queryable, timerId: string): Promise<ActionRow | null> => (await qx.query<ActionRow>(`SELECT ${ASEL} FROM breach_actions WHERE timer_id = $1::uuid`, [timerId]))[0] ?? null;

/**
 * `breach.execute{timer_id, timer_code?, loan_id?, escalation_id?, breached_at?}` — the executor. Also `{op: register, timer_code,
 * action_kind, action_spec, needs_human, cited_text?}` (compliance with an officer's approval record — the surfaces' dual control;
 * on the bus the approval rides `approvals[0]`).
 */
export async function breachExecute(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  if (s(i, "op") === "register") return registerBreachAction(i, ctx);
  need(i, "timer_id");
  const timerId = s(i, "timer_id");
  const existing = await actionOf(q(ctx), timerId);
  if (existing) return { ...existing, already: true };
  const t = (await q(ctx).query<{ code: string; loan_id: string | null; breached_at: string | null; status: string }>(`SELECT code, loan_id::text AS loan_id, breached_at::text AS breached_at, status::text AS status FROM timers WHERE id = $1::uuid`, [timerId]))[0];
  const code = s(i, "timer_code") || t?.code || ""; if (!code) throw new RangeError(`no timer ${timerId}`);
  const loanId = s(i, "loan_id") || t?.loan_id || ctx.loanId || null;
  const breachedAt = s(i, "breached_at") || t?.breached_at || ctx.now;
  const escalationId = s(i, "escalation_id") || null;
  const row = await registryRow(q(ctx), code);
  const ports = portsFor(rt);
  let outcome: BreachOutcome = "escalated_only"; let actionKind: string = row?.action_kind ?? "escalate"; let commandEventId: string | null = null; let workItemId: string | null = null; let refusal: string | null = null; let errorClass: string | null = null; let extraEscalation: string | null = null; let note = "";
  const open = (kind: "attorney" | "sev2" | "officer", ownerRole: string, payload: Row): string => rt.escalations.open({ kind, ownerRole, ...(loanId ? { loanId } : {}), payload: { timer_code: code, timer_id: timerId, ...payload } }, ctx.actor).id;
  if (!row) { outcome = "escalated_only"; note = "no registry row: the sweep's escalation is the action (open question 2)"; }
  else if (row.cited_text !== (citedTextOf(code) ?? row.cited_text)) {
    // edge case: the registry row's cited_text no longer matches spec/registry/timers.json after a re-register → escalate, compliance re-versions by hand
    outcome = "escalated_only"; extraEscalation = open("sev2", "compliance", { code: REFUSALS.registryStale, cited_text: row.cited_text, registry_breach: citedTextOf(code) }); note = REFUSALS.registryStale;
  } else if (row.action_kind === "escalate" || row.action_kind === "refuse_gate") {
    outcome = "escalated_only";
    for (const role of (Array.isArray(row.action_spec["inform_roles"]) ? (row.action_spec["inform_roles"] as string[]) : [])) open("sev2", role, { informed: true, action_kind: row.action_kind });
  } else if (row.needs_human || row.action_kind === "open_work_item") {
    const spec = row.action_spec;
    workItemId = await ports.workItems.open(q(ctx), { screen_code: String(spec["screen_code"] ?? "escalation"), subject_kind: "loan", subject_id: loanId ?? "global", loan_id: loanId, source_kind: "breached_timer", source_id: timerId, required_role: String(spec["role"] ?? "officer"), now: ctx.now, due_at: null });
    if (!workItemId) extraEscalation = open("sev2", String(spec["role"] ?? "officer"), { deferred: true, screen_code: spec["screen_code"] });
    outcome = "deferred";
  } else {
    try {
      const spec = row.action_spec; const deriverName = String(spec["input_derivation"] ?? "");
      const deriver = DERIVERS[deriverName];
      if (!deriver) { outcome = "deferred"; workItemId = await ports.workItems.open(q(ctx), { screen_code: "foreclosure_case", subject_kind: "loan", subject_id: loanId ?? "global", loan_id: loanId, source_kind: "breached_timer", source_id: timerId, required_role: "officer", now: ctx.now, due_at: null }); note = `derivation gap: ${deriverName}`; }
      else {
        const derived = loanId ? await deriver(q(ctx), rt, loanId, spec) : null;
        if (!derived) { outcome = "deferred"; workItemId = await ports.workItems.open(q(ctx), { screen_code: "foreclosure_case", subject_kind: "loan", subject_id: loanId ?? "global", loan_id: loanId, source_kind: "breached_timer", source_id: timerId, required_role: "officer", now: ctx.now, due_at: null }); note = "no case row to derive the action from"; }
        else {
          // every foreclosure act runs 13.1's gate evaluation inside the command (Verified requirement); a closed gate refuses with the 13.x refusal and is never retried
          if (row.action_kind === "instruct_firm" && loanId) {
            const g = (await delegate(rt, ctx, "13.1", "foreclosure.gates.evaluate", { loan_id: loanId, step: derived.gate_step ?? "sale_conduct", attempt_step: true })).output as { open: boolean; blocked_by: string[] };
            if (!g.open) { refusal = g.blocked_by.find((b) => b === "BK_362_STAY_GATE") ?? g.blocked_by.find((b) => !b.startsWith("HOLD:")) ?? g.blocked_by[0] ?? "GATE_CLOSED"; throw Object.assign(new Error(`${derived.tool} refused by ${refusal}`), { name: "GateClosed", ref: refusal }); }
          }
          if (row.action_kind === "run_tool" && derived.process === "35.9") { const { docketSync } = await import("./docket.ts"); const out = await docketSync(derived.input, ctx, rt); commandEventId = String(out["event_id"] ?? "") || null; }
          else { const r = await delegate(rt, ctx, derived.process, derived.tool, derived.input); commandEventId = r.event_id; }
          if (row.action_kind === "message_firm" && loanId) {
            await firmDispatch({ loan_id: loanId, case_id: String(derived.input["case_id"] ?? ""), firm_id: String(derived.input["firm_id"] ?? ""), kind: String(spec["kind"] ?? "message"), owning_event_id: commandEventId, payload: { subject: derived.input["subject"], timer_code: code } }, ctx, rt);
          }
          if (row.action_kind === "instruct_firm" && loanId) await firmDispatch({ loan_id: loanId, case_id: String(derived.input["case_id"] ?? ""), firm_id: String(derived.input["firm_id"] ?? ""), kind: "instruction", owning_event_id: commandEventId, payload: { instruction: derived.input["kind"], timer_code: code } }, ctx, rt);
          // a compound seed row (`also`): the secondary actions after the primary (set_flag through 13.5's own review, inform through escalations)
          for (const also of (Array.isArray(spec["also"]) ? (spec["also"] as Row[]) : [])) if (also["kind"] === "inform") for (const role of (Array.isArray(also["roles"]) ? (also["roles"] as string[]) : [])) open("sev2", role, { informed: true });
          outcome = "executed";
        }
      }
    } catch (e) {
      if (isGateClosed(e) || (e instanceof Error && e.name === "GateClosed")) { outcome = "refused"; refusal = refusal ?? refusalCode(e); extraEscalation = open("attorney", "attorney", { refusal_code: refusal, action_kind: row.action_kind, reason: (e as Error).message }); }
      else { outcome = "failed"; errorClass = e instanceof Error ? e.name || "Error" : "Error"; note = e instanceof Error ? e.message.slice(0, 500) : String(e); }
    }
  }
  const ins = await q(ctx).query<ActionRow>(
    `INSERT INTO breach_actions (timer_id, timer_code, loan_id, breached_at, registry_version, action_kind, outcome, command_event_id, escalation_id, work_item_id, refusal_code, error_class, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5, $6, $7, $8::uuid, $9::uuid, $10::uuid, $11, $12, $13::timestamptz) ON CONFLICT (timer_id) DO NOTHING RETURNING ${ASEL}`,
    [timerId, code, loanId, breachedAt, row?.version ?? null, actionKind, outcome, commandEventId, escalationId, workItemId, refusal, errorClass, ctx.now]);
  const a = ins[0] ?? (await actionOf(q(ctx), timerId))!;
  ctx.events.append({ type: EV.breachActionExecuted, ...(loanId ? { loanId } : { aggregate: { kind: "timer", id: timerId } }), actor: ctx.actor, payload: { timer_id: timerId, timer_code: code, action_kind: actionKind, outcome, command_event_id: commandEventId, escalation_id: escalationId, work_item_id: workItemId, refusal_code: refusal, error_class: errorClass, registry_version: row?.version ?? null, extra_escalation_id: extraEscalation, note, breach_action_id: a.id } });
  ctx.decide({ agent: ENGINE_ACTOR.id, action: `breach.execute:${actionKind}`, rationale: `${code} breached at ${breachedAt}: registry v${row?.version ?? "none"} (${row ? `"${row.cited_text}"` : "no row"}) → ${outcome}${refusal ? ` (${refusal})` : ""}${note ? ` — ${note}` : ""}`, ruleSetVersion: RULE_SET_VERSION_35_9, ...(loanId ? { loanId } : {}), subject: { kind: "breach", id: timerId }, ruleCode: code, confidence: 1, modelVersion: "deterministic", promptVersion: PROMPT_VERSION_35_9 });
  return { ...a, note };
}

/** rule 7's last sentence: registration by `compliance` with `officer` confirmation, never an action the cited_text does not name, never cancel_clock (34.4 rule 1). */
export async function registerBreachAction(i: ToolInput, ctx: CommandContext): Promise<Row> {
  need(i, "timer_code", "action_kind");
  const code = s(i, "timer_code"); const kind = s(i, "action_kind") as ActionKind;
  if (kind === "cancel_clock") throw new RangeError(`${REFUSALS.noClockEdit}: cancel_clock is refused at registration (34.4 rule 1 — no clock is edited from a breach)`);
  if (ctx.actor.kind !== "human" || ctx.actor.role !== "compliance") throw new RangeError(`${REFUSALS.registrationNeedsOfficer}: a registry row is added or re-versioned only by compliance`);
  const approvals = Array.isArray(i.approvals) ? (i.approvals as { id?: string; role?: string }[]) : [];
  const officer = approvals.find((a) => a.role === "officer" && a.id && a.id !== ctx.actor.id);
  if (!officer) throw new RangeError(`${REFUSALS.registrationNeedsOfficer}: a compliance registration needs a distinct officer's confirmation (dual control through 35.7)`);
  const cited = citedTextOf(code) ?? s(i, "cited_text");
  if (!cited) throw new RangeError(`no registry row for ${code} in spec/registry/timers.json`);
  if (!citedTextNames(kind, cited)) throw new RangeError(`${REFUSALS.actionMatchesCitedText}: the breach column "${cited}" does not name a ${kind} action`);
  const prev = await registryRow(q(ctx), code);
  const version = (prev?.version ?? 0) + 1;
  const staff = /^[0-9a-f-]{36}$/i.test(ctx.actor.id) && (await q(ctx).query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE id = $1::uuid`, [ctx.actor.id])).length ? ctx.actor.id : null;   // `registered_by → staff_users` (null for a principal the staff table does not hold; the event names the actor)
  await q(ctx).query(
    `INSERT INTO breach_action_registry (timer_code, owner_process, cited_text, action_kind, action_spec, needs_human, version, registered_by, registered_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9::timestamptz)
     ON CONFLICT (timer_code) DO UPDATE SET cited_text = EXCLUDED.cited_text, action_kind = EXCLUDED.action_kind, action_spec = EXCLUDED.action_spec, needs_human = EXCLUDED.needs_human, version = EXCLUDED.version, registered_by = EXCLUDED.registered_by, registered_at = EXCLUDED.registered_at`,
    [code, registry().get(code)?.process ?? s(i, "owner_process") ?? "35.9", cited, kind, JSON.stringify((i.action_spec as Row | undefined) ?? {}), i.needs_human === true, version, staff, ctx.now]);
  ctx.events.append({ type: "breach_action.registered", aggregate: { kind: "breach_action_registry", id: code }, actor: ctx.actor, payload: { timer_code: code, action_kind: kind, version, registered_by: ctx.actor.id, confirmed_by: officer.id, cited_text: cited } });
  return { timer_code: code, action_kind: kind, version, cited_text: cited };
}

/** `breach.recon{as_of_date}` — once per day: the day's breaches without an action row, the failed rows, the receipt and the compliance escalation. */
export async function breachRecon(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const asOf: PlainDate = asOfOf(ctx, i);
  const already = (await q(ctx).query<{ payload: Row }>(`SELECT payload FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2 ORDER BY sequence DESC LIMIT 1`, [EV.breachReconCompleted, asOf]))[0];
  if (already && i.force !== true) return { ...already.payload, already: true };
  const from = toIso(zonedEpochMs(asOf, "00:00", ET)); const to = toIso(zonedEpochMs(addDays(asOf, 1), "00:00", ET));
  const breaches = await q(ctx).query<{ timer_id: string; code: string; loan_id: string | null; outcome: string | null }>(
    `SELECT e.payload->>'timer_id' AS timer_id, e.payload->>'code' AS code, e.loan_id::text AS loan_id, a.outcome
       FROM loan_events e LEFT JOIN breach_actions a ON a.timer_id::text = e.payload->>'timer_id'
      WHERE e.type = 'timer.breached' AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz ORDER BY e.sequence`, [from, to]);
  const counts = { breaches: breaches.length, executed: 0, deferred: 0, escalated_only: 0, refused: 0, failed: 0, missing: 0 };
  const missingIds: string[] = [];
  for (const b of breaches) { if (!b.outcome) { counts.missing += 1; missingIds.push(b.timer_id); } else (counts as Record<string, number>)[b.outcome] = ((counts as Record<string, number>)[b.outcome] ?? 0) + 1; }
  // entries with applied_at null older than a business day are the docket side of the reconciliation (edge case: the second entry cannot hide behind the first's satisfaction)
  const stale = await q(ctx).query<{ c: string }>(`SELECT count(*)::text AS c FROM entity_current WHERE kind = 'bankruptcy_docket_events' AND (data->>'applied_at') IS NULL AND coalesce(data->>'event_date', '') <> '' AND (data->>'event_date')::date < $1::date`, [addDays(asOf, -1)]).catch(() => [{ c: "0" }]);
  let escalationId: string | null = null;
  if (counts.missing + counts.failed > 0) escalationId = rt.escalations.open({ kind: "sev2", ownerRole: "compliance", payload: { as_of_date: asOf, missing: counts.missing, failed: counts.failed, missing_timer_ids: missingIds, reason: "a breach of the day without its action row or an action whose outcome is failed (35.9 rule 7)" } }, ctx.actor).id;
  ctx.events.append({ type: EV.breachReconCompleted, aggregate: { kind: "breach_action_recon", id: asOf }, actor: ctx.actor, payload: { as_of_date: asOf, ...counts, docket_entries_unapplied: Number(stale[0]?.c ?? 0), escalation_id: escalationId, run_id: rt.services["sweep_run_id"] ?? null } });
  return { as_of_date: asOf, ...counts, escalation_id: escalationId, already: false };
}
export const etDate = (iso: string): PlainDate => D(wallClock(Date.parse(iso), ET).date);
