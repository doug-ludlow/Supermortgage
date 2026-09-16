/**
 * §35.9 rule 6 — "Docket reactions are deterministic where the section is." `docket.sync{case_id}` reads PACER through the port
 * (`FakePacer.docket(caseNumber, since)`) per open bankruptcy case: an entry whose structured class 14.1 itself allows the agent
 * to apply (its `docketClassification`: not ALWAYS_HUMAN, confidence ≥ 0.9) and that is in this process's deterministic set is
 * applied at ingest through 14.1 `docket.classify{op: apply}` (14.1 emits `bankruptcy.docket.event.received{source: pcl}` and
 * the status event, sets `applied_at`) and its `docket_reactions{needs_human: false}` row is written then; every other entry is
 * stored raw (`applied_at: null` — 14.1 has no tool that ingests an unapplied entry, recorded as an assumption) and the received
 * literal is emitted for it, arming SM_DOCKET_REACTION_1BD. `docket.react{docket_event_id}` (the daily unit, or the screen's
 * decision) classifies the rest — 14.1's `docket.classify` (LLM, `classifier_confidence`) when the entry is free text — and
 * defers anything below 0.85, outside the deterministic set or naming money to an `attorney` item (`needs_human: true`); the
 * two money applications are never a reaction (35.8's officer act). Either path emits `case.docket.reacted`.
 */
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import { docketClassification } from "../../bankruptcy/ops-14-1.ts";
import { DETERMINISTIC_DOCKET_CLASSES, DOCKET_CONFIDENCE, ENGINE_ACTOR, EV, MONEY_DOCKET_CLASSES, REACTION_OF_CLASS, STEP_AGENTS, type ReactionKind } from "../default-35-9.ts";
import { need, portsFor, q, s } from "./commands.ts";
import { delegate } from "./delegate.ts";
import { loanRows, openBankruptcy, str, type CurrentRow, type Row } from "./store.ts";

const DOCKET_KIND = "bankruptcy_docket_events";
/** A FAKE docket classifier for free-text entries (the 14.1 LLM's stand-in when no documentAi service is wired): a few phrases → class + confidence. */
export function fakeClassifyText(text: string): { event_type: string; confidence: number } {
  const t = text.toLowerCase();
  if (/plan.*confirm/.test(t)) return { event_type: "plan_confirmed", confidence: 0.97 };
  if (/objection/.test(t)) return { event_type: "objection_to_claim", confidence: 0.62 };
  if (/trustee.*payment|payment.*trustee/.test(t)) return { event_type: "trustee_payment_received", confidence: 0.95 };
  if (/motion for relief|relief from stay/.test(t)) return { event_type: "mfr_filed", confidence: 0.91 };
  if (/dismiss/.test(t)) return { event_type: "dismissal_order", confidence: 0.9 };
  return { event_type: "unclassified", confidence: 0.3 };
}
export interface DocketEntry { readonly id: string; readonly case_id: string; readonly loan_id: string; readonly source: string; readonly event_type: string; readonly event_date: string; readonly entered_at: string; readonly docket_no: string | null; readonly parsed: Row; readonly classifier_confidence: number | null; readonly applied_at: string | null }
const entryOf = (r: CurrentRow): DocketEntry => ({ id: r.id, case_id: str(r.data, "case_id"), loan_id: str(r.data, "loan_id"), source: str(r.data, "source"), event_type: str(r.data, "event_type") || str(r.data, "kind"), event_date: str(r.data, "event_date"), entered_at: str(r.data, "entered_at"), docket_no: str(r.data, "docket_no") || null, parsed: (r.data["parsed"] as Row | undefined) ?? {}, classifier_confidence: r.data["classifier_confidence"] === undefined || r.data["classifier_confidence"] === null ? null : Number(r.data["classifier_confidence"]), applied_at: str(r.data, "applied_at") || null });
const bkCaseOf = async (ctx: CommandContext, rt: ToolRuntime, loanId: string, caseRef: string): Promise<CurrentRow | null> => (caseRef ? rt.store.get("bankruptcy_cases", caseRef) ?? null : null) ?? rt.store.list("bankruptcy_cases", (d) => d["loan_id"] === loanId)[0] ?? openBankruptcy(await loanRows(q(ctx), "bankruptcy_cases", loanId));

/** 14.1's own gate for an agent application, intersected with 35.9's deterministic set and the money exclusion (DOCKET_CONFIDENCE_0_85). */
export function deterministicReaction(eventType: string, confidence: number, namesMoney: boolean): { deterministic: boolean; reaction_kind: ReactionKind; reason: string } {
  if (namesMoney || MONEY_DOCKET_CLASSES.has(eventType)) return { deterministic: false, reaction_kind: "none", reason: "names money — 35.8's officer act (rule 6)" };
  if (confidence < DOCKET_CONFIDENCE) return { deterministic: false, reaction_kind: "none", reason: `confidence ${confidence} < ${DOCKET_CONFIDENCE}` };
  if (!DETERMINISTIC_DOCKET_CLASSES.has(eventType)) return { deterministic: false, reaction_kind: "none", reason: `${eventType} is outside the deterministic set` };
  const g = docketClassification({ event_type: eventType, confidence });
  if (!g.state_change_allowed) return { deterministic: false, reaction_kind: REACTION_OF_CLASS[eventType] ?? "none", reason: `14.1: ${g.reason}` };
  return { deterministic: true, reaction_kind: REACTION_OF_CLASS[eventType] ?? "status_change", reason: "structured class 14.1 allows the agent to apply" };
}
const namesMoney = (parsed: Row): boolean => Object.keys(parsed).some((k) => /amount|_cents/i.test(k)) || /\$\s?\d/.test(String(parsed["text"] ?? ""));

async function writeReaction(ctx: CommandContext, rt: ToolRuntime, e: { loan_id: string; case_id: string; docket_event_id: string; classification: string; confidence: number | null; reaction_kind: ReactionKind; needs_human: boolean; command_event_id: string | null; reason: string }): Promise<{ id: string; work_item_id: string | null } | null> {
  const existing = (await q(ctx).query<{ id: string }>(`SELECT id::text AS id FROM docket_reactions WHERE docket_event_id = $1`, [e.docket_event_id]))[0];
  if (existing) return null;
  const workItemId = e.needs_human ? await portsFor(rt).workItems.open(q(ctx), { screen_code: "bankruptcy_case", subject_kind: "loan", subject_id: e.loan_id, loan_id: e.loan_id, source_kind: "manual", source_id: `docket:${e.docket_event_id}`, required_role: "attorney", now: ctx.now, due_at: null }) : null;
  if (e.needs_human && !workItemId) rt.escalations.open({ kind: "attorney", loanId: e.loan_id, payload: { docket_event_id: e.docket_event_id, classification: e.classification, confidence: e.confidence, reason: e.reason } }, ctx.actor);
  const ins = await q(ctx).query<{ id: string }>(
    `INSERT INTO docket_reactions (loan_id, case_id, docket_event_id, classification, classifier_confidence, reaction_kind, command_event_id, needs_human, work_item_id, reacted_at, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9::uuid, $10::timestamptz, $10::timestamptz) ON CONFLICT (docket_event_id) DO NOTHING RETURNING id::text AS id`,
    [e.loan_id, e.case_id, e.docket_event_id, e.classification, e.confidence, e.reaction_kind, e.command_event_id, e.needs_human, workItemId, ctx.now]);
  ctx.events.append({ type: EV.docketReacted, loanId: e.loan_id, actor: ctx.actor, payload: { docket_event_id: e.docket_event_id, case_id: e.case_id, classification: e.classification, confidence: e.confidence, reaction_kind: e.reaction_kind, needs_human: e.needs_human, command_event_id: e.command_event_id, work_item_id: workItemId, reason: e.reason } });
  ctx.decide({ agent: STEP_AGENTS.foreclosure, action: `docket.react:${e.reaction_kind}`, rationale: `${e.classification} (${e.confidence ?? "structured"}) → ${e.needs_human ? "attorney" : e.reaction_kind}: ${e.reason}`, ruleSetVersion: "default-ops.v1", loanId: e.loan_id, subject: { kind: "docket_event", id: e.docket_event_id }, confidence: e.confidence ?? 1, modelVersion: e.confidence === null ? "deterministic" : "14.1-classifier", promptVersion: "35.9-v1" });
  return { id: ins[0]?.id ?? "", work_item_id: workItemId };
}

/** `docket.sync{case_id}` — PACER's new entries since the last synced date; structured entries 14.1 allows are applied at ingest. */
export async function docketSync(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const bk = await bkCaseOf(ctx, rt, loanId, s(i, "case_id"));
  if (!bk) throw new RangeError(`no open bankruptcy case on ${loanId}`);
  const caseNumber = str(bk.data, "case_number_full") || str(bk.data, "case_number") || bk.id;
  const existing = rt.store.list(DOCKET_KIND, (d) => d["case_id"] === bk.id || d["loan_id"] === loanId).map(entryOf);
  const since = existing.map((e) => e.event_date).sort().at(-1) ?? (str(bk.data, "petition_date") || "1970-01-01");
  const seen = new Set(existing.map((e) => e.id));
  let entries: readonly { seq: number; filedOn: string; kind: string; text: string }[] = []; let synced = true; let error: string | null = null;
  try { entries = rt.ports.pacer ? await rt.ports.pacer.docket(caseNumber, since) : []; } catch (e) { synced = false; error = e instanceof Error ? e.message : String(e); }
  const applied: string[] = []; const stored: string[] = [];
  for (const en of entries) {
    const id = `dk-${loanId}-${en.seq}`; if (seen.has(id)) continue;
    const structured = DETERMINISTIC_DOCKET_CLASSES.has(en.kind) || MONEY_DOCKET_CLASSES.has(en.kind) || /^[a-z0-9_]+$/.test(en.kind) && en.kind !== "text";
    const parsed: Row = { seq: en.seq, text: en.text, ...(structured ? {} : {}) };
    const d = structured ? deterministicReaction(en.kind, 1, namesMoney(parsed)) : { deterministic: false, reaction_kind: "none" as ReactionKind, reason: "free text: classified by 14.1's classifier at reaction time" };
    if (d.deterministic) {
      // 14.1 applies: its received literal, its status event, its applied_at
      const r = await delegate(rt, ctx, "14.1", "docket.classify", { op: "apply", id, loan_id: loanId, case_id: bk.id, case_number_full: caseNumber, chapter: Number(bk.data["chapter"] ?? 13), source: "pcl", kind: en.kind, event_date: en.filedOn, entered_at: `${en.filedOn}T00:00:00.000Z`, docket_no: String(en.seq), parsed, confidence: 1, verified_by: "agent" }, { kind: "agent", id: STEP_AGENTS.bankruptcy });
      const statusEv = ctx.events.all().filter((e) => e.loanId === loanId && e.type === "bankruptcy.status.changed").at(-1);
      await writeReaction(ctx, rt, { loan_id: loanId, case_id: bk.id, docket_event_id: id, classification: en.kind, confidence: null, reaction_kind: d.reaction_kind, needs_human: false, command_event_id: statusEv?.id ?? r.event_id, reason: d.reason });
      applied.push(id);
    } else {
      // stored raw with applied_at null (the ingest of an inbound fact; 14.1 has no tool for an unapplied entry) and the received literal emitted for it
      rt.store.put(DOCKET_KIND, id, { id, case_id: bk.id, loan_id: loanId, source: "pcl", docket_no: String(en.seq), event_type: structured ? en.kind : "text", event_date: en.filedOn, entered_at: `${en.filedOn}T00:00:00.000Z`, parsed, classifier_confidence: null, verified_by: null, applied_at: null, ingested_by: "35.9" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "bankruptcy.docket.event.received", loanId, aggregate: { kind: "bankruptcy_case", id: bk.id }, actor: ctx.actor, payload: { loan_id: loanId, case_id: bk.id, case_number_full: caseNumber, chapter: Number(bk.data["chapter"] ?? 13), source: "pcl", kind: structured ? en.kind : "text", event_type: structured ? en.kind : "text", event_date: en.filedOn, entered_at: `${en.filedOn}T00:00:00.000Z`, docket_no: String(en.seq), docket_event_id: id, seq: en.seq, ingested_by: "35.9" } });
      stored.push(id);
    }
  }
  const ev = ctx.events.append({ type: EV.docketSynced, loanId, actor: ctx.actor, payload: { case_id: bk.id, case_number: caseNumber, entries: entries.length, since, synced, applied: applied.length, stored: stored.length, ...(error ? { error } : {}) } });
  return { case_id: bk.id, entries: entries.length, since, synced, applied, stored, event_id: ev.id };
}

/** `docket.react{docket_event_id, classification?, reaction_kind?}` — the reaction for one unapplied entry (the daily unit's step e; the screen's decision arrives as `classification` from an attorney). */
export async function docketReact(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  need(i, "docket_event_id"); const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const rec = rt.store.get(DOCKET_KIND, s(i, "docket_event_id")); if (!rec) throw new RangeError(`no docket entry ${s(i, "docket_event_id")}`);
  const e = entryOf(rec);
  const already = (await q(ctx).query<{ id: string; needs_human: boolean }>(`SELECT id::text AS id, needs_human FROM docket_reactions WHERE docket_event_id = $1`, [e.id]))[0];
  if (already && ctx.actor.kind !== "human") return { docket_event_id: e.id, reaction_id: already.id, already: true };
  let classification = e.event_type; let confidence: number | null = e.classifier_confidence;
  const attorneyDecided = ctx.actor.kind === "human" && ctx.actor.role === "attorney" && s(i, "classification") !== "";
  if (attorneyDecided) { classification = s(i, "classification"); confidence = 1; }
  else if (classification === "text" || classification === "") {
    // 14.1's classifier: the documentAi service when wired (its LLM), else the FAKE over the entry's text
    const ai = rt.services["documentAi"] as { classifyDocket?: (id: string) => Promise<{ event_type: string; confidence: number }> } | undefined;
    const c = ai?.classifyDocket ? await ai.classifyDocket(e.id) : fakeClassifyText(String(e.parsed["text"] ?? ""));
    classification = c.event_type; confidence = c.confidence;
  }
  const d = attorneyDecided ? { deterministic: DETERMINISTIC_DOCKET_CLASSES.has(classification) && !MONEY_DOCKET_CLASSES.has(classification), reaction_kind: REACTION_OF_CLASS[classification] ?? "none", reason: "counsel's decision on the screen" } : deterministicReaction(classification, confidence ?? 0, namesMoney(e.parsed));
  let commandEventId: string | null = null;
  if (d.deterministic) {
    const r = await delegate(rt, ctx, "14.1", "docket.classify", { op: "apply", id: e.id, loan_id: loanId, case_id: e.case_id, case_number_full: str(rt.store.get("bankruptcy_cases", e.case_id)?.data ?? {}, "case_number_full") || e.case_id, chapter: Number(rt.store.get("bankruptcy_cases", e.case_id)?.data["chapter"] ?? 13), source: e.source || "pcl", kind: classification, event_date: e.event_date, entered_at: e.entered_at, docket_no: e.docket_no, parsed: e.parsed, confidence: confidence ?? 1, ...(attorneyDecided ? { verified_by: "attorney" } : {}) }, attorneyDecided ? ctx.actor : { kind: "agent", id: STEP_AGENTS.bankruptcy });
    const statusEv = ctx.events.all().filter((x) => x.loanId === loanId && x.type === "bankruptcy.status.changed").at(-1);
    commandEventId = statusEv?.id ?? r.event_id;
  }
  const w = await writeReaction(ctx, rt, { loan_id: loanId, case_id: e.case_id, docket_event_id: e.id, classification, confidence, reaction_kind: d.reaction_kind, needs_human: !d.deterministic, command_event_id: commandEventId, reason: d.reason });
  return { docket_event_id: e.id, classification, confidence, reaction_kind: d.reaction_kind, needs_human: !d.deterministic, command_event_id: commandEventId, reaction_id: w?.id ?? already?.id ?? null, work_item_id: w?.work_item_id ?? null };
}

/** rule 2 step (e): react to every docket entry of the loan with applied_at null and no reaction row. */
export async function reactPending(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId;
  const pending = rt.store.list(DOCKET_KIND, (d) => d["loan_id"] === loanId && (d["applied_at"] === null || d["applied_at"] === undefined)).map(entryOf);
  const reacted: string[] = []; const deferred: string[] = [];
  for (const e of pending) {
    const already = (await q(ctx).query<{ id: string }>(`SELECT id::text AS id FROM docket_reactions WHERE docket_event_id = $1`, [e.id]))[0];
    if (already) continue;
    const r = await docketReact({ loan_id: loanId, docket_event_id: e.id }, ctx, rt);
    (r["needs_human"] ? deferred : reacted).push(e.id);
  }
  return { pending: pending.length, reacted, deferred };
}
export const engineActor = ENGINE_ACTOR;
