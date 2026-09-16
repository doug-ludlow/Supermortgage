/**
 * §35.8 — the queue (rule 8) and the items' state machine (rule 9; State machine): one open item per source
 * (`work_items`, unique on (source_kind, source_id) while open), opened by the sweep's queue pass from the console's five
 * kinds (src/console/pg-store.ts — kept, not replaced) plus 35.3's dead units, 35.6's held steps, this process's pending
 * proposals and 35.9's case milestones (ports.ts), each mapped to a `screen_code` by its source's process; closed by the
 * person (`work.item.close{disposition}`) or by the source's own closing (the pass finds the source gone: `source_closed`).
 * A claim is one person until SM_WORK_ITEM_CLAIM_4H (the registry row, computed by the engine's own computeDue) lapses it; a second person is refused CLAIMED_BY_OTHER{staff_user_id} (the id, never the
 * name); the lapse (timers-35-8.ts claimBreachHandler) returns the item to `open` and counts.
 *
 * Every item act runs inside a bus command (the tools in src/app/tools/section35-8.ts): the row moves through the
 * command's transaction (`deps.deferWrite`), the event rides `deps.events` (the registry arms the clocks from it), so a
 * refusal writes nothing. The pass (sweep.ts) runs the same functions under its own global units of work.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor, EventStore } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { PgConsoleStore } from "../../../console/pg-store.ts";
import { queueKindsFor, type QueueItem } from "../../../console/store.ts";
import { actorId, isUuid, obj, s, WorkRefused, CLAIM_TIMER_CODE, type ItemStatus, type Row, type SourceKind } from "./types.ts";
import { computeDue } from "../../../kernel/timers/engine.ts";
import type { TimerRegistry } from "../../../kernel/timers/registry.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import * as ev from "./events.ts";
import { portsOf, type WorkPorts } from "./ports.ts";
import { SCREENS } from "./screens.ts";

export interface WorkItem { readonly id: string; readonly screen_code: string; readonly subject_kind: string; readonly subject_id: string; readonly loan_id: string | null; readonly application_id: string | null; readonly source_kind: SourceKind; readonly source_id: string; readonly required_role: string; readonly status: ItemStatus; readonly claimed_by: string | null; readonly claimed_at: string | null; readonly claim_expires_at: string | null; readonly claim_lapses: number; readonly opened_at: string; readonly due_at: string | null; readonly closed_at: string | null; readonly closed_by: string | null; readonly disposition: string | null }
export const ITEM_COLS = `id::text AS id, screen_code, subject_kind, subject_id, loan_id::text AS loan_id, application_id::text AS application_id, source_kind, source_id, required_role, status, claimed_by::text AS claimed_by, claimed_at::text AS claimed_at, claim_expires_at::text AS claim_expires_at, claim_lapses, opened_at::text AS opened_at, due_at::text AS due_at, closed_at::text AS closed_at, closed_by::text AS closed_by, disposition`;
const toItem = (r: Row): WorkItem => ({ id: String(r["id"]), screen_code: String(r["screen_code"]), subject_kind: String(r["subject_kind"]), subject_id: String(r["subject_id"]), loan_id: (r["loan_id"] as string | null) ?? null, application_id: (r["application_id"] as string | null) ?? null, source_kind: String(r["source_kind"]) as SourceKind, source_id: String(r["source_id"]), required_role: String(r["required_role"]), status: String(r["status"]) as ItemStatus, claimed_by: (r["claimed_by"] as string | null) ?? null, claimed_at: (r["claimed_at"] as string | null) ?? null, claim_expires_at: (r["claim_expires_at"] as string | null) ?? null, claim_lapses: Number(r["claim_lapses"] ?? 0), opened_at: String(r["opened_at"]), due_at: (r["due_at"] as string | null) ?? null, closed_at: (r["closed_at"] as string | null) ?? null, closed_by: (r["closed_by"] as string | null) ?? null, disposition: (r["disposition"] as string | null) ?? null });
export async function getItem(q: Queryable, id: string): Promise<WorkItem | null> { if (!isUuid(id)) return null; const [r] = await q.query<Row>(`SELECT ${ITEM_COLS} FROM work_items WHERE id = $1`, [id]); return r ? toItem(r) : null; }
export async function openItemFor(q: Queryable, sourceKind: string, sourceId: string): Promise<WorkItem | null> { const [r] = await q.query<Row>(`SELECT ${ITEM_COLS} FROM work_items WHERE source_kind = $1 AND source_id = $2 AND status NOT IN ('closed', 'cancelled') LIMIT 1`, [sourceKind, sourceId]); return r ? toItem(r) : null; }

// ---------------------------------------------------------------- rule 8: the source → screen mapping
/** The screen a source's process opens (rule 8); `escalation` is the 34.4 view for anything else. */
export function screenForProcess(process: string | null | undefined, hint?: { kind?: string | null; adapter?: string | null; hasLoan?: boolean }): string {
  const p = String(process ?? ""); const sec = p.split(".")[0];
  if (p === "23.3") return "conditions";
  if (p === "25.2") return "cd_review";
  if (p === "21.2") return "le_review";
  if (p === "26.2") return "closing_schedule";
  if (p === "26.3" || p === "35.6") return "funding_release";
  if (sec === "2") return /revers|return|nsf|dead|ach/i.test(String(hint?.kind ?? "")) ? "payment_reverse" : "payment_post";
  if (sec === "3") return "escrow_analysis";
  if (sec === "16") return "payoff_quote";
  if (sec === "12") return "lossmit_decision";
  if (sec === "13") return "foreclosure_case";
  if (sec === "14") return "bankruptcy_case";
  if (/nacha|ach/i.test(String(hint?.adapter ?? "")) && hint?.hasLoan) return "payment_reverse";   // worked example B: the ACH return's dead letter opens the reversal screen
  return "escalation";
}
/** A console queue row (the five kinds) → the item to open. */
export function itemOfConsoleRow(rt: Runtime, r: QueueItem): { screen_code: string; subject_kind: string; subject_id: string; loan_id: string | null; application_id: string | null; source_kind: SourceKind; source_id: string; required_role: string; opened_at: string; due_at: string | null } {
  const d = r.detail ?? {};
  let process: string | null = null; let kind: string | null = null;
  if (r.kind === "breached_timer") process = String(d["process"] ?? rt.registry.get(String((d["code"] as string | undefined) ?? "").trim())?.process ?? "");
  else if (r.kind === "escalation") { const tc = typeof d["timer_code"] === "string" ? rt.registry.get(d["timer_code"]) : undefined; process = typeof d["process"] === "string" ? d["process"] : typeof d["command"] === "string" ? String(d["command"]).split(" ")[0]! : tc?.process ?? null; kind = String(d["kind"] ?? d["command"] ?? ""); }
  else if (r.kind === "portal_task") process = typeof d["process"] === "string" ? d["process"] : null;
  const screen_code = screenForProcess(process, { kind, adapter: r.kind === "dead_letter" ? String((r.title ?? "").split(" ")[0]) : null, hasLoan: !!r.loanId });
  const applicationId = typeof d["application_id"] === "string" && isUuid(d["application_id"]) ? d["application_id"] : null;
  const subject = r.loanId ? { kind: "loan", id: r.loanId } : applicationId ? { kind: "application", id: applicationId } : { kind: r.kind, id: r.id };
  // the role: an escalation's or a portal task's owner as the console names it; a held notice, dead letter or breached timer that opens a screen is the screen's work — ops_analyst unless the console's owner is one of the screen's roles (worked example B: the ACH return's dead letter is the analyst's)
  const screen = SCREENS.find((x) => x.code === screen_code);
  const screenRoles = screen ? [...new Set(screen.actions.flatMap((a) => [...(a.needs ?? [])]))] : [];
  const required_role = r.kind === "escalation" || r.kind === "portal_task" || screen_code === "escalation" ? r.ownerRole : screenRoles.includes(r.ownerRole) ? r.ownerRole : "ops_analyst";
  return { screen_code, subject_kind: subject.kind, subject_id: subject.id, loan_id: r.loanId ?? null, application_id: applicationId, source_kind: r.kind, source_id: r.id, required_role, opened_at: r.openedAt, due_at: r.dueAt ?? null };
}

// ---------------------------------------------------------------- the queue read
export interface QueueRow extends WorkItem { readonly title: string }
export async function workQueue(rt: Runtime, q: Queryable, now: string, f: { role?: string | null; screen?: string | null; subject?: { kind: string; id: string } | null; status?: string | null; page?: number; page_size?: number }): Promise<{ items: QueueRow[]; total: number; page: number; page_size: number }> {
  const conds: string[] = []; const params: unknown[] = [];
  const statuses = f.status ? [f.status] : ["open", "claimed", "waiting_approval"];
  params.push(statuses); conds.push(`status = ANY($${params.length}::text[])`);
  if (f.screen) { params.push(f.screen); conds.push(`screen_code = $${params.length}`); }
  if (f.subject) { params.push(f.subject.kind, f.subject.id); conds.push(`subject_kind = $${params.length - 1} AND subject_id = $${params.length}`); }
  if (f.role) {
    // the console's role filter kept (src/console/store.ts queueKindsFor + pg-store.ts queue): the five kinds by role, an escalation / portal task only for its owner; the four new kinds by required_role
    const kinds = queueKindsFor(f.role); params.push(kinds, f.role);
    conds.push(`((source_kind = ANY($${params.length - 1}::text[]) AND (source_kind NOT IN ('escalation', 'portal_task') OR required_role = $${params.length})) OR (source_kind IN ('job_dead', 'orchestration_held', 'approval_pending', 'case_milestone', 'manual') AND required_role = $${params.length}))`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const page = Math.max(1, Math.floor(f.page ?? 1)); const page_size = Math.min(500, Math.max(1, Math.floor(f.page_size ?? 200)));
  const [c] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_items ${where}`, params);
  const rows = (await q.query<Row>(`SELECT ${ITEM_COLS} FROM work_items ${where} ORDER BY opened_at, created_at, id`, params)).map((r) => ({ ...toItem(r), title: `${String(r["source_kind"])} → ${String(r["screen_code"])}` }));
  // rule 8: the five console kinds keep the console's own order (src/console/pg-store.ts queue — by opened instant, then the console's kind order); the four new kinds follow by opened_at
  const FIVE = ["escalation", "portal_task", "held_notice", "dead_letter", "breached_timer"];
  const consoleRows = f.role && !f.screen && !f.subject ? await new PgConsoleStore(rt.db, rt.registry, rt.agents).queue({ role: f.role, now }) : null;
  const rank = new Map<string, number>((consoleRows ?? []).map((r, k) => [`${r.kind}:${r.id}`, k]));
  const ordered = consoleRows ? [...rows.filter((r) => FIVE.includes(r.source_kind)).sort((a, b) => (rank.get(`${a.source_kind}:${a.source_id}`) ?? Number.MAX_SAFE_INTEGER) - (rank.get(`${b.source_kind}:${b.source_id}`) ?? Number.MAX_SAFE_INTEGER)), ...rows.filter((r) => !FIVE.includes(r.source_kind))] : rows;
  return { items: ordered.slice((page - 1) * page_size, page * page_size), total: Number(c?.n ?? 0), page, page_size };
}

// ---------------------------------------------------------------- the acts (inside a command)
export interface ItemDeps { readonly db: Queryable; readonly events: EventStore; readonly now: string; readonly actor: Actor; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; readonly sessionId?: string | null; readonly registry?: TimerRegistry }
/** The claim's deadline as the engine will arm it: the registry row's offset over the claim instant (never a constant of this module). */
export function claimDeadline(registry: TimerRegistry | undefined, claimedAtIso: string): string {
  const def = registry?.get(CLAIM_TIMER_CODE); if (!def) throw new WorkRefused(503, "TIMER_UNREGISTERED", `${CLAIM_TIMER_CODE} is not in the registry`, { code: CLAIM_TIMER_CODE });
  const ms = Date.parse(claimedAtIso); const due = computeDue(def.offsetParsed, wallClock(ms, "America/New_York").date, ms);
  if (due.dueAt === undefined) throw new WorkRefused(503, "TIMER_UNREGISTERED", `${CLAIM_TIMER_CODE} has no instant deadline`, { code: CLAIM_TIMER_CODE });
  return new Date(due.dueAt).toISOString();
}
const byOf = (a: Actor): string => actorId(a);
const staffId = (a: Actor): string | null => (a.kind === "human" && isUuid(a.id) ? a.id : null);
const logEvent = (d: ItemDeps, itemId: string, kind: string, reason: string | null = null): void => d.deferWrite(async (q) => { await q.query(`INSERT INTO work_item_events (work_item_id, kind, staff_user_id, session_id, role, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`, [itemId, kind, staffId(d.actor), d.sessionId ?? null, d.actor.role ?? null, reason, d.now]); });

export interface OpenItemInput { readonly screen_code: string; readonly subject_kind: string; readonly subject_id: string; readonly loan_id?: string | null; readonly application_id?: string | null; readonly source_kind: SourceKind; readonly source_id: string; readonly required_role: string; readonly opened_at?: string; readonly due_at?: string | null }
/** `work.item.open` — once per source while open (the unique index); an existing open item is returned unchanged (`opened: false`). */
export async function openItem(d: ItemDeps, i: OpenItemInput): Promise<{ item: WorkItem; opened: boolean }> {
  const existing = await openItemFor(d.db, i.source_kind, i.source_id);
  if (existing) return { item: existing, opened: false };
  const id = randomUUID(); const opened_at = i.opened_at ?? d.now;
  const item: WorkItem = { id, screen_code: i.screen_code, subject_kind: i.subject_kind, subject_id: i.subject_id, loan_id: i.loan_id ?? null, application_id: i.application_id ?? null, source_kind: i.source_kind, source_id: i.source_id, required_role: i.required_role, status: "open", claimed_by: null, claimed_at: null, claim_expires_at: null, claim_lapses: 0, opened_at, due_at: i.due_at ?? null, closed_at: null, closed_by: null, disposition: null };
  d.deferWrite(async (q) => { await q.query(`INSERT INTO work_items (id, screen_code, subject_kind, subject_id, loan_id, application_id, source_kind, source_id, required_role, status, opened_at, due_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10::timestamptz, $11::timestamptz, $12::timestamptz, $12::timestamptz)`, [id, item.screen_code, item.subject_kind, item.subject_id, item.loan_id, item.application_id, item.source_kind, item.source_id, item.required_role, opened_at, item.due_at, d.now]); });
  logEvent(d, id, "opened");
  d.events.append(ev.itemOpened(id, d.actor, { screen_code: item.screen_code, subject_kind: item.subject_kind, subject_id: item.subject_id, source_kind: item.source_kind, source_id: item.source_id, required_role: item.required_role, opened_at, loan_id: item.loan_id, application_id: item.application_id, due_at: item.due_at }));
  return { item, opened: true };
}
/** `work.item.claim` — the session holds `required_role`; one person until the claim clock lapses it (rule 9). */
export async function claimItem(d: ItemDeps, held: readonly string[], itemId: string): Promise<WorkItem> {
  const it = await getItem(d.db, itemId); if (!it) throw new WorkRefused(404, "NOT_FOUND", `no work item ${itemId}`);
  if (it.status === "closed" || it.status === "cancelled") throw new WorkRefused(409, "ITEM_CLOSED", `item ${itemId} is ${it.status}`, { item_id: itemId, status: it.status });
  if (!held.includes(it.required_role) && d.actor.role !== it.required_role) throw new WorkRefused(403, "ROLE_REQUIRED", `item ${itemId} needs ${it.required_role}`, { role: it.required_role, held: [...held], act_as: held.includes(it.required_role) ? [it.required_role] : [] });
  const me = byOf(d.actor);
  // while the row says `claimed` the claim holds: only the clock's breach (the sweep's handler) or the claimant's release ends it, never the wall clock read here
  if (it.status === "claimed" && it.claimed_by && it.claimed_by !== me) throw new WorkRefused(409, "CLAIMED_BY_OTHER", `item ${itemId} is claimed`, { staff_user_id: it.claimed_by, claim_expires_at: it.claim_expires_at });
  if (it.status === "waiting_approval") throw new WorkRefused(409, "WAITING_APPROVAL", `item ${itemId} awaits an officer`, { item_id: itemId });
  const claimed_at = d.now; const claim_expires_at = claimDeadline(d.registry, claimed_at);
  d.deferWrite(async (q) => { await q.query(`UPDATE work_items SET status = 'claimed', claimed_by = $2, claimed_at = $3::timestamptz, claim_expires_at = $4::timestamptz, updated_at = $3::timestamptz WHERE id = $1`, [itemId, staffId(d.actor), claimed_at, claim_expires_at]); });
  logEvent(d, itemId, "claimed");
  d.events.append(ev.itemClaimed(itemId, d.actor, { by: me, claimed_at, claim_expires_at, role: d.actor.role ?? it.required_role }));
  return { ...it, status: "claimed", claimed_by: staffId(d.actor) ?? me, claimed_at, claim_expires_at };
}
/** `work.item.release` — the claimant (or the role's holder on a lapsed claim) returns it to `open`. */
export async function releaseItem(d: ItemDeps, itemId: string): Promise<WorkItem> {
  const it = await getItem(d.db, itemId); if (!it) throw new WorkRefused(404, "NOT_FOUND", `no work item ${itemId}`);
  if (it.status !== "claimed") throw new WorkRefused(409, "NOT_CLAIMED", `item ${itemId} is ${it.status}`, { item_id: itemId, status: it.status });
  const me = byOf(d.actor);
  if (it.claimed_by && it.claimed_by !== me) throw new WorkRefused(409, "CLAIMED_BY_OTHER", `item ${itemId} is claimed`, { staff_user_id: it.claimed_by });
  d.deferWrite(async (q) => { await q.query(`UPDATE work_items SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = $2::timestamptz WHERE id = $1`, [itemId, d.now]); });
  logEvent(d, itemId, "released");
  d.events.append(ev.itemReleased(itemId, d.actor, { by: me }));
  return { ...it, status: "open", claimed_by: null, claimed_at: null, claim_expires_at: null };
}
/** `work.item.close{disposition, reason, evidence_document_id?}` — by the person holding its role. */
export async function closeItem(d: ItemDeps, held: readonly string[], i: { item_id: string; disposition: string; reason?: string | null; evidence_document_id?: string | null }): Promise<WorkItem> {
  const it = await getItem(d.db, i.item_id); if (!it) throw new WorkRefused(404, "NOT_FOUND", `no work item ${i.item_id}`);
  if (it.status === "closed" || it.status === "cancelled") throw new WorkRefused(409, "ITEM_CLOSED", `item ${i.item_id} is ${it.status}`, { item_id: i.item_id, status: it.status });
  if (!held.includes(it.required_role) && d.actor.role !== it.required_role) throw new WorkRefused(403, "ROLE_REQUIRED", `item ${i.item_id} needs ${it.required_role}`, { role: it.required_role, held: [...held], act_as: [] });
  if (!i.disposition) throw new RangeError("disposition is required");
  if (i.evidence_document_id && !isUuid(i.evidence_document_id)) throw new RangeError("evidence_document_id is a document id (uuid)");
  return closeRow(d, it, i.disposition, i.reason ?? null, i.evidence_document_id ?? null);
}
/** The close itself (the person's, or the source's own closing from the pass with `source_closed`). */
export async function closeRow(d: ItemDeps, it: WorkItem, disposition: string, reason: string | null, evidence: string | null): Promise<WorkItem> {
  d.deferWrite(async (q) => { await q.query(`UPDATE work_items SET status = 'closed', closed_at = $2::timestamptz, closed_by = $3, disposition = $4, claimed_by = NULL, claim_expires_at = NULL, updated_at = $2::timestamptz WHERE id = $1`, [it.id, d.now, staffId(d.actor), disposition]); });
  logEvent(d, it.id, "closed", reason);
  d.events.append(ev.itemClosed(it.id, d.actor, { by: byOf(d.actor), disposition, reason, evidence_document_id: evidence }));
  return { ...it, status: "closed", closed_at: d.now, closed_by: staffId(d.actor), disposition };
}
/** `work.item.cancel{reason}` — ops_analyst, for a source that is gone (Q4); the next queue pass re-opens a source still open. */
export async function cancelItem(d: ItemDeps, i: { item_id: string; reason: string }): Promise<WorkItem> {
  const it = await getItem(d.db, i.item_id); if (!it) throw new WorkRefused(404, "NOT_FOUND", `no work item ${i.item_id}`);
  if (it.status === "closed" || it.status === "cancelled") throw new WorkRefused(409, "ITEM_CLOSED", `item ${i.item_id} is ${it.status}`, { item_id: i.item_id, status: it.status });
  if (!i.reason) throw new RangeError("reason is required");
  d.deferWrite(async (q) => { await q.query(`UPDATE work_items SET status = 'cancelled', closed_at = $2::timestamptz, closed_by = $3, disposition = 'cancelled', updated_at = $2::timestamptz WHERE id = $1`, [it.id, d.now, staffId(d.actor)]); });
  logEvent(d, it.id, "cancelled", i.reason);
  d.events.append(ev.itemCancelled(it.id, d.actor, { by: byOf(d.actor), reason: i.reason }));
  return { ...it, status: "cancelled", closed_at: d.now, disposition: "cancelled" };
}
/** The item enters `waiting_approval` on a money-field proposal (rule 5); `declined` / expiry return it to `claimed`. */
export async function setItemStatus(d: ItemDeps, itemId: string, status: "waiting_approval" | "claimed" | "closed", kind: "approval_waiting" | "claimed" | "closed", reason: string | null = null): Promise<void> {
  d.deferWrite(async (q) => { await q.query(`UPDATE work_items SET status = $2, updated_at = $3::timestamptz${status === "closed" ? ", closed_at = $3::timestamptz, disposition = 'approved'" : ""} WHERE id = $1`, [itemId, status, d.now]); });
  logEvent(d, itemId, kind, reason);
}

// ---------------------------------------------------------------- the queue pass (rule 8), run by the sweep
export interface QueuePassReport { readonly opened: number; readonly closed: number; readonly sources: number; readonly cancelled_reopened: number }
type Source = OpenItemInput;
/** Every source that should have an open item now, from the console's five kinds and the four new ones. */
export async function collectSources(rt: Runtime, q: Queryable, now: string, ports: Required<WorkPorts>): Promise<Source[]> {
  const store = new PgConsoleStore(rt.db, rt.registry, rt.agents);
  const out: Source[] = [];
  // SM_SWEEP_HEARTBEAT_DAILY is the running sweep's own clock (35.1 edge case 7, src/runtime/app.ts breach pass): the run that completes satisfies it minutes after this pass sees it breached — never a person's item
  // this process's own clocks (SM_WORK_*) and the escalations they open are the queue's bookkeeping, never a new source: an item whose age clock breached would otherwise breed an item per breach per sweep
  for (const r of await store.queue({ now })) { if (r.kind === "breached_timer" && /^SM_SWEEP_HEARTBEAT_DAILY breached/.test(r.title)) continue; if (isOwnBookkeeping(r)) continue; out.push(itemOfConsoleRow(rt, r)); }
  for (const j of await ports.jobs.dead(q)) out.push({ screen_code: j.screen_code ?? (j.loan_id ? "payment_post" : "escalation"), subject_kind: j.loan_id ? "loan" : j.application_id ? "application" : "job", subject_id: j.loan_id ?? j.application_id ?? j.id, loan_id: j.loan_id, application_id: j.application_id, source_kind: "job_dead", source_id: j.id, required_role: j.role, opened_at: j.since, due_at: null });
  for (const h of await ports.orchestration.held(q)) out.push({ screen_code: "funding_release", subject_kind: "application", subject_id: h.application_id, loan_id: null, application_id: h.application_id, source_kind: "orchestration_held", source_id: h.id, required_role: h.role, opened_at: h.since, due_at: null });
  for (const m of await ports.caseMilestones.due(q)) out.push({ screen_code: m.screen_code, subject_kind: m.loan_id ? "loan" : "case", subject_id: m.loan_id ?? m.id, loan_id: m.loan_id, application_id: null, source_kind: "case_milestone", source_id: m.id, required_role: m.role, opened_at: m.since, due_at: null });
  for (const p of await q.query<Row>(`SELECT id::text AS id, screen_code, subject_kind, subject_id, loan_id::text AS loan_id, application_id::text AS application_id, created_at::text AS created_at FROM work_actions WHERE status = 'proposed'`)) out.push({ screen_code: String(p["screen_code"]), subject_kind: String(p["subject_kind"]), subject_id: String(p["subject_id"]), loan_id: (p["loan_id"] as string | null) ?? null, application_id: (p["application_id"] as string | null) ?? null, source_kind: "approval_pending", source_id: String(p["id"]), required_role: "officer", opened_at: String(p["created_at"]), due_at: null });
  return out.sort((a, b) => (a.opened_at ?? now).localeCompare(b.opened_at ?? now));
}
/** A console row that is this process's own clock or the escalation such a clock opened (its payload names a `SM_WORK_` timer_code). */
export function isOwnBookkeeping(r: { kind: string; title: string; detail?: unknown }): boolean {
  if (r.kind === "breached_timer" && /^SM_WORK_/.test(r.title)) return true;
  if (r.kind === "escalation") { const d = obj(r.detail); const code = String(d["timer_code"] ?? obj(d["payload"])["timer_code"] ?? ""); if (/^SM_WORK_/.test(code)) return true; }
  return false;
}
const SWEEP_ACTOR: Actor = { kind: "system", id: "work-35-8" };
/** The pass: open an item per new source, close the items whose source closed (`source_closed`). One global unit of work per change set. */
export async function queuePass(rt: Runtime, now: string, o: { ports?: WorkPorts } = {}): Promise<QueuePassReport> {
  const ports = portsOf(o.ports);
  const sources = await collectSources(rt, rt.db, now, ports);
  const openRows = (await rt.db.query<Row>(`SELECT ${ITEM_COLS} FROM work_items WHERE status NOT IN ('closed', 'cancelled')`)).map(toItem);
  const key = (k: string, id: string): string => `${k}:${id}`;
  const have = new Set(openRows.map((r) => key(r.source_kind, r.source_id)));
  const want = new Set(sources.map((x) => key(x.source_kind, x.source_id)));
  // a source whose earlier item was closed or cancelled while the source stayed open is re-opened (Q4) from now: the item's age is the item's, not the source's first instant
  const priorClosed = new Set((await rt.db.query<{ source_kind: string; source_id: string }>(`SELECT DISTINCT source_kind, source_id FROM work_items WHERE status IN ('closed', 'cancelled')`)).map((r) => key(r.source_kind, r.source_id)));
  const toOpen = sources.filter((x) => !have.has(key(x.source_kind, x.source_id)) && x.source_kind !== "manual").map((x) => (priorClosed.has(key(x.source_kind, x.source_id)) ? { ...x, opened_at: now } : x));
  const toClose = openRows.filter((r) => !want.has(key(r.source_kind, r.source_id)) && r.source_kind !== "manual" && r.source_kind !== "approval_pending" ? true : r.source_kind === "approval_pending" && !want.has(key(r.source_kind, r.source_id)));
  let opened = 0; let closed = 0;
  const writes: ((q: Queryable) => Promise<void>)[] = [];   // the deferred row writes of this pass (the commit hook drains them)
  if (toOpen.length || toClose.length) {
    await rt.uow.run({}, async (ctx) => {
      const d: ItemDeps = { db: ctx.q!, events: ctx.events, now, actor: SWEEP_ACTOR, deferWrite: (fn) => { writes.push(fn); } };
      for (const x of toOpen) { const r = await openItem(d, x); if (r.opened) opened += 1; }
      for (const r of toClose) { await closeRow(d, r, "source_closed", null, null); closed += 1; }
    }, { clock: rt.clock, commit: async (q) => { for (const fn of writes) await fn(q); writes.length = 0; } });
  }
  return { opened, closed, sources: sources.length, cancelled_reopened: 0 };
}
export const itemActorId = byOf;
export const itemStaffId = staffId;
export { obj, s };
