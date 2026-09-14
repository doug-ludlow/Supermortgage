/**
 * 34.2 `directory.activity` — rule 3: "The activity stream is the record's rows." One time-ordered stream over the person's
 * rows, a kind per row, never a synthetic audit line (Discrepancy 2):
 *
 *   message    `messages` of the party's conversation — the body with tokens resolved as the surface resolved them
 *              (`{{copy:key}}` through the copy loader with the row's copy_tokens; a `{{token}}` from the row's tokens; the
 *              party's own tokens the app resolves on every line — `party.first_name`, and `partner.legal_name` from the party's
 *              partner exactly as the borrower API's partnerFor names it: the application's partner, else the loan's, else the
 *              configured entry partner), an SSN shape redacted (NO_FULL_SSN); the sender as actor (borrower · agent:<name> ·
 *              human:<ref> · system)
 *   card       `card_instances` — the kind, copy key and status; its resolution as a second row at resolved_at (`card_instance_events`)
 *   turn       `agent_turns` — the model and prompt versions, the guard result, the tools called BY NAME (Open question 2: the
 *              inputs stay in the row for compliance), latency; never the context hash or an args hash; the actor is the agent
 *              whose turn it is (agent:borrower-app on the borrower channels, agent:refi-analyst on 33.2's analyst channel)
 *   event      `loan_events` on the party's loans and applications (and the party-keyed global events) — the type, the actor
 *   decision   `agent_decisions` on the same scope — the action, the rule, the agent
 *   notice     `notices` addressed to the party (recipient_party_ids) with their deliveries' channels, and the partner-book
 *              invitations / reminders (33.1) — the template and the channel; never the payload
 *   session    `sessions` — the door and the level at created_at
 *   staff_look `staff_actions` whose subject is the party (34.1's log) and the directory's own `directory.viewed / unmasked /
 *              exported` events — the staff member's id as actor
 *
 * Filters: `kind` (one or a comma list), `from` / `to` (ISO instants or dates, inclusive). Every look is
 * `directory.viewed{…, section: activity}`.
 */
import type { Db, Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import { copyText } from "../borrower/channels.ts";
import { entryPartner, isSupermortgage } from "../borrower/partner.ts";
import { ANALYST_CHANNEL } from "../partner-book-analyst.ts";
import { redactSsn, stripSecrets } from "./mask.ts";
import { partyScope, type PartyScope, ownPartyEventPredicate, ownPartyDecisionPredicate } from "./scope.ts";

export const ACTIVITY_KINDS = ["message", "card", "turn", "event", "decision", "notice", "session", "staff_look"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const isActivityKind = (v: unknown): v is ActivityKind => typeof v === "string" && (ACTIVITY_KINDS as readonly string[]).includes(v);

export interface ActivityRow { readonly at: string; readonly kind: ActivityKind; readonly actor: string; readonly summary: string; readonly row_id: string; readonly table: string; readonly detail: Record<string, unknown> }
export interface DirectoryActivityOptions { readonly from?: string | null; readonly to?: string | null; readonly kind?: string | readonly string[] | null; readonly limit?: number }
export interface DirectoryActivity { readonly party_id: string; readonly rows: readonly ActivityRow[]; readonly count: number; readonly kinds: readonly ActivityKind[]; readonly from: string | null; readonly to: string | null; readonly as_of: string }

const KIND_ORDER: Readonly<Record<ActivityKind, number>> = { session: 0, event: 1, notice: 2, message: 3, card: 4, turn: 5, decision: 6, staff_look: 7 };
const tokensOf = (v: unknown): Record<string, string> => { const out: Record<string, string> = {}; if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = String(x); return out; };
/** The body as the borrower saw it: a `{{copy:key}}` line rendered by the copy loader with the row's tokens, then any `{{token}}` the row carries (an unknown token stays, as the surface leaves it), then the SSN redaction. `base` is the party's own tokens (the app's `party.*` / `partner.*`); the row's tokens win over it. */
export function renderBody(body: string | null, copyTokens: unknown, base: Readonly<Record<string, string>> = {}): string {
  const tokens = { ...base, ...tokensOf(copyTokens) };
  // a `{{copy:key}}` the library lacks renders as the key's own name, exactly as the app shows it (apps/borrower/components/flows/3-entry/MessageBody.tsx: "an unknown key renders its own name so a wrong key is visible in review")
  const text = (body ?? "").replace(/\{\{copy:([a-z0-9_.]+)\}\}/g, (_all, k: string) => { const line = copyText(k, tokens); return line === `{{copy:${k}}}` ? k : line; }).replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (all, k: string) => tokens[k] ?? all);
  return redactSsn(text.replace(/\s+/g, " ").trim()) ?? "";
}
const clip = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const inWindow = (at: string, from: string | null, to: string | null): boolean => (!from || at >= from) && (!to || at <= to);
const bound = (v: string | null | undefined, end: boolean): string | null => { if (!v) return null; const t = v.trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return end ? `${t}T23:59:59.999Z` : `${t}T00:00:00.000Z`; const d = Date.parse(t); return Number.isNaN(d) ? null : new Date(d).toISOString(); };
const kindsOf = (v: DirectoryActivityOptions["kind"]): ActivityKind[] => { const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []; const out = arr.filter(isActivityKind); return out.length ? [...new Set(out)] : [...ACTIVITY_KINDS]; };

/** `{{partner.legal_name}}` as the app resolves it on the thread (src/runtime/borrower/routes.ts partnerFor): the partner behind the party's first subject — an application's, else a loan's — never Supermortgage as the lender; the configured entry partner when no subject names one. */
async function partnerNameOf(db: Db, s: PartyScope): Promise<string | null> {
  const app = s.subjects.find((x) => x.application_id)?.application_id ?? null; const loan = s.subjects.find((x) => x.loan_id)?.loan_id ?? null;
  const row = app ? (await db.query<{ legal_name: string }>(`SELECT p.legal_name FROM applications a JOIN parties p ON p.id = a.partner_party_id WHERE a.id = $1`, [app]))[0]
    : loan ? (await db.query<{ legal_name: string }>(`SELECT p.legal_name FROM loans l JOIN parties p ON p.id = l.partner_party_id WHERE l.id = $1`, [loan]))[0] : undefined;
  if (row?.legal_name && !isSupermortgage(row.legal_name)) return row.legal_name;
  return (await entryPartner(db, process.env["BORROWER_DEFAULT_PARTNER_ID"]))?.legal_name ?? null;
}
async function messageRows(db: Db, s: PartyScope, first: string): Promise<ActivityRow[]> {
  if (!s.conversation_id) return [];
  const rows = await db.query<{ message_id: string; at: string; sender: string; sender_ref: string | null; channel: string; body_text: string | null; card_instance_id: string | null; copy_tokens: unknown; subject_loan_id: string | null; subject_application_id: string | null }>(
    `SELECT message_id::text AS message_id, at, sender, sender_ref, channel, body_text, card_instance_id::text AS card_instance_id, copy_tokens, subject_loan_id::text AS subject_loan_id, subject_application_id::text AS subject_application_id FROM messages WHERE conversation_id = $1 ORDER BY at, created_at, message_id`, [s.conversation_id]);
  const partner = rows.some((m) => (m.body_text ?? "").includes("{{")) ? await partnerNameOf(db, s) : null;
  const base: Record<string, string> = { "party.first_name": first, "party.legal_name": s.party.legal_name, ...(partner ? { "partner.legal_name": partner } : {}) };
  // the actor is the row's sender: the borrower; the agent the row names (`sender_ref` — `agent:borrower-comms`, `agent:intake` — already carries the kind, so it is never prefixed twice); a person; the system
  const prefixed = (kind: "agent" | "human", ref: string | null, fallback: string): string => { const r = ref ?? fallback; return r.startsWith(`${kind}:`) ? r : `${kind}:${r}`; };
  return rows.map((m) => { const text = renderBody(m.body_text, m.copy_tokens, base); const actor = m.sender === "borrower" ? "borrower" : m.sender === "agent" ? prefixed("agent", m.sender_ref, "borrower-app") : m.sender === "human" ? prefixed("human", m.sender_ref, "") : "system";
    return { at: m.at, kind: "message" as const, actor, summary: clip(text || (m.card_instance_id ? `(card ${m.card_instance_id})` : `(${m.sender} · ${m.channel})`)), row_id: m.message_id, table: "messages", detail: { sender: m.sender, sender_label: m.sender === "borrower" ? first : m.sender === "agent" ? "Supermortgage" : m.sender === "notice" ? "Notice" : m.sender === "human" ? "Supermortgage (a person)" : "Supermortgage", channel: m.channel, body_text: text, card_instance_id: m.card_instance_id, subject: { loan_id: m.subject_loan_id, application_id: m.subject_application_id } } }; });
}
async function cardRows(db: Queryable, partyId: string): Promise<ActivityRow[]> {
  const cards = await db.query<{ card_instance_id: string; kind: string; status: string; copy_key: string; created_by: string; created_at: string; resolved_at: string | null; command_ref: string | null; subject_loan_id: string | null; subject_application_id: string | null }>(
    `SELECT card_instance_id::text AS card_instance_id, kind, status, copy_key, created_by, created_at, resolved_at, command_ref, subject_loan_id::text AS subject_loan_id, subject_application_id::text AS subject_application_id FROM card_instances WHERE party_id = $1 ORDER BY created_at, card_instance_id`, [partyId]);
  const out: ActivityRow[] = [];
  for (const c of cards) {
    // the row at its creation instant reads `pending` (every card opens pending); its transitions are the card_instance_events rows below; `detail.status` is the status now
    out.push({ at: c.created_at, kind: "card", actor: c.created_by, summary: `${c.kind} ${c.copy_key} · pending`, row_id: c.card_instance_id, table: "card_instances", detail: { card_kind: c.kind, copy_key: c.copy_key, status: c.status, command_ref: c.command_ref, resolved_at: c.resolved_at, subject: { loan_id: c.subject_loan_id, application_id: c.subject_application_id } } });
  }
  if (cards.length) {
    const transitions = await db.query<{ id: string; card_instance_id: string; from_status: string | null; to_status: string; at: string; actor: string; kind: string; copy_key: string }>(
      `SELECT e.id::text AS id, e.card_instance_id::text AS card_instance_id, e.from_status, e.to_status, e.at, e.actor, c.kind, c.copy_key FROM card_instance_events e JOIN card_instances c ON c.card_instance_id = e.card_instance_id WHERE c.party_id = $1 AND e.to_status <> 'pending' ORDER BY e.at, e.id`, [partyId]);
    for (const t of transitions) out.push({ at: t.at, kind: "card", actor: t.actor.startsWith("borrower:") ? "borrower" : t.actor, summary: `${t.kind} ${t.copy_key} · ${t.to_status}`, row_id: t.id, table: "card_instance_events", detail: { card_instance_id: t.card_instance_id, card_kind: t.kind, copy_key: t.copy_key, from_status: t.from_status, to_status: t.to_status } });
  }
  return out;
}
async function turnRows(db: Queryable, partyId: string): Promise<ActivityRow[]> {
  const rows = await db.query<{ turn_id: string; created_at: string; session_id: string | null; message_id: string | null; reply_message_id: string | null; channel: string; model_version: string; prompt_version: string; tier: string; tool_calls: unknown; safe_classification: string | null; guard_result: Record<string, unknown>; latency_ms: number | null }>(
    `SELECT turn_id::text AS turn_id, created_at, session_id::text AS session_id, message_id::text AS message_id, reply_message_id::text AS reply_message_id, channel, model_version, prompt_version, tier, tool_calls, safe_classification, guard_result, latency_ms FROM agent_turns WHERE party_id = $1 ORDER BY created_at, turn_id`, [partyId]);
  return rows.map((t) => { const tools = Array.isArray(t.tool_calls) ? (t.tool_calls as Record<string, unknown>[]).map((c) => ({ name: String(c["name"] ?? ""), refused: c["refused"] === true, is_error: c["is_error"] === true, decision_id: typeof c["decision_id"] === "string" ? c["decision_id"] : null })) : [];
    const guard = t.guard_result ?? {}; const guardWord = typeof guard["result"] === "string" ? String(guard["result"]) : guard["ok"] === true || guard["passed"] === true ? "passed" : guard["ok"] === false || guard["passed"] === false ? "rejected" : t.reply_message_id ? "passed" : "rejected";
    // the actor is the agent whose turn the row is: the borrower-facing assistant on the borrower channels, the refinance analyst (33.2 rule 4 — its turn is written with the homeowner's party_id on the analyst channel) on ANALYST_CHANNEL
    const actor = t.channel === ANALYST_CHANNEL ? "agent:refi-analyst" : "agent:borrower-app";
    return { at: t.created_at, kind: "turn" as const, actor, summary: `turn · model ${t.model_version} · prompt ${t.prompt_version} · guard ${guardWord}${tools.length ? ` · tools ${tools.map((x) => x.name).join(", ")}` : ""}`, row_id: t.turn_id, table: "agent_turns", detail: { model_version: t.model_version, prompt_version: t.prompt_version, tier: t.tier, guard_result: stripSecrets(guard), guard: guardWord, tools, safe_classification: t.safe_classification, channel: t.channel, session_id: t.session_id, message_id: t.message_id, reply_message_id: t.reply_message_id, latency_ms: t.latency_ms } }; });
}
async function eventRows(db: Queryable, s: PartyScope): Promise<ActivityRow[]> {
  const rows = await db.query<{ id: string; type: string; occurred_at: string; actor_kind: string; actor_id: string; actor_role: string | null; loan_id: string | null; application_id: string | null; sequence: string; payload: Record<string, unknown> }>(
    `SELECT id::text AS id, type, occurred_at, actor_kind::text AS actor_kind, actor_id, actor_role, loan_id::text AS loan_id, application_id::text AS application_id, sequence::text AS sequence, payload FROM loan_events
     WHERE (loan_id = ANY($1::uuid[]) OR application_id = ANY($2::uuid[]) OR (loan_id IS NULL AND application_id IS NULL AND payload->>'party_id' = $3)) AND ${ownPartyEventPredicate("$3")} AND type NOT LIKE 'directory.%' ORDER BY loan_events.sequence`, [s.loan_ids, s.application_ids, s.party.id]);   // qualified: a bare `sequence` would resolve to the text alias in the SELECT list (review finding)
  return rows.map((e) => ({ at: e.occurred_at, kind: "event" as const, actor: `${e.actor_kind}:${e.actor_id}${e.actor_role ? ` (${e.actor_role})` : ""}`, summary: e.type, row_id: e.id, table: "loan_events", detail: { type: e.type, sequence: e.sequence, loan_id: e.loan_id, application_id: e.application_id, payload_keys: Object.keys(e.payload ?? {}).sort() } }));
}
async function decisionRows(db: Queryable, s: PartyScope): Promise<ActivityRow[]> {
  const rows = await db.query<{ id: string; agent: string; action: string; rule_code: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; created_at: string; loan_id: string | null; application_id: string | null; subject_kind: string | null; subject_id: string | null; approved_by: string | null; approved_role: string | null }>(
    `SELECT id::text AS id, agent, action, rule_code, rule_set_version, model_version, prompt_version, created_at, loan_id::text AS loan_id, application_id::text AS application_id, subject_kind, subject_id, approved_by, approved_role FROM agent_decisions
     WHERE (loan_id = ANY($1::uuid[]) OR application_id = ANY($2::uuid[]) OR (subject_kind = 'party' AND subject_id = $3)) AND ${ownPartyDecisionPredicate("$3")} ORDER BY created_at, id`, [s.loan_ids, s.application_ids, s.party.id]);
  return rows.filter((d) => !d.action.startsWith("directory.")).map((d) => ({ at: d.created_at, kind: "decision" as const, actor: `agent:${d.agent}`, summary: `${d.action}${d.rule_code ? ` · ${d.rule_code}` : ""} · ${d.rule_set_version}`, row_id: d.id, table: "agent_decisions", detail: { action: d.action, rule_code: d.rule_code, rule_set_version: d.rule_set_version, model_version: d.model_version, prompt_version: d.prompt_version, loan_id: d.loan_id, application_id: d.application_id, subject: { kind: d.subject_kind, id: d.subject_id }, approved_by: d.approved_by, approved_role: d.approved_role } }));
}
async function noticeRows(db: Queryable, s: PartyScope): Promise<ActivityRow[]> {
  const rows = await db.query<{ id: string; template_code: string; template_version: string; status: string; produced_at: string; sent_at: string | null; loan_id: string | null; channels: string[] | null }>(
    `SELECT n.id::text AS id, n.template_code, n.template_version, n.status, n.produced_at, n.sent_at, n.loan_id::text AS loan_id, (SELECT array_agg(d.channel ORDER BY d.attempt_no) FROM notice_deliveries d WHERE d.notice_id = n.id) AS channels FROM notices n WHERE $1::uuid = ANY(n.recipient_party_ids) ORDER BY n.produced_at, n.id`, [s.party.id]);
  const out: ActivityRow[] = rows.map((n) => ({ at: n.sent_at ?? n.produced_at, kind: "notice" as const, actor: "system", summary: `${n.template_code} · ${(n.channels ?? []).join(", ") || n.status}`, row_id: n.id, table: "notices", detail: { template_code: n.template_code, template_version: n.template_version, status: n.status, channels: n.channels ?? [], produced_at: n.produced_at, sent_at: n.sent_at, loan_id: n.loan_id } }));
  const seen = new Set(rows.map((n) => n.id));
  const invitations = await db.query<{ id: string; loan_id: string; kind: string; channel: string; sent_at: string; bounced_at: string | null; notice_id: string | null }>(`SELECT id::text AS id, loan_id::text AS loan_id, kind, channel, sent_at, bounced_at, notice_id::text AS notice_id FROM partner_book_invitations WHERE party_id = $1 ORDER BY sent_at, id`, [s.party.id]);
  for (const i of invitations) if (!i.notice_id || !seen.has(i.notice_id)) out.push({ at: i.sent_at, kind: "notice", actor: "agent:portfolio", summary: `NTC_SM_PARTNER_BOOK_INVITATION · ${i.kind} · ${i.channel}${i.bounced_at ? " · bounced" : ""}`, row_id: i.id, table: "partner_book_invitations", detail: { template_code: "NTC_SM_PARTNER_BOOK_INVITATION", kind: i.kind, channel: i.channel, sent_at: i.sent_at, bounced_at: i.bounced_at, loan_id: i.loan_id, notice_id: i.notice_id } });
  return out;
}
async function sessionRows(db: Queryable, partyId: string): Promise<ActivityRow[]> {
  const rows = await db.query<{ session_id: string; level: string; auth_method: string; created_at: string; revoked_at: string | null; expires_at: string }>(`SELECT session_id::text AS session_id, level, auth_method, created_at, revoked_at, expires_at FROM sessions WHERE party_id = $1 ORDER BY created_at, session_id`, [partyId]);
  return rows.map((x) => ({ at: x.created_at, kind: "session" as const, actor: "borrower", summary: `signed in · ${x.auth_method} · ${x.level}`, row_id: x.session_id, table: "sessions", detail: { level: x.level, auth_method: x.auth_method, expires_at: x.expires_at, revoked_at: x.revoked_at } }));
}
async function staffLookRows(db: Queryable, partyId: string): Promise<ActivityRow[]> {
  const actions = await db.query<{ id: string; staff_user_id: string | null; at: string; route: string; method: string; subject_kind: string | null; command: string | null; result: string; refusal_code: string | null }>(
    `SELECT id::text AS id, staff_user_id::text AS staff_user_id, at, route, method, subject_kind, command, result, refusal_code FROM staff_actions WHERE subject_id = $1 ORDER BY at, id`, [partyId]);
  const out: ActivityRow[] = actions.map((a) => ({ at: a.at, kind: "staff_look" as const, actor: `staff:${a.staff_user_id ?? "?"}`, summary: `${a.method} ${a.route}${a.command ? ` · ${a.command}` : ""} · ${a.result}${a.refusal_code ? ` ${a.refusal_code}` : ""}`, row_id: a.id, table: "staff_actions", detail: { route: a.route, method: a.method, subject_kind: a.subject_kind, command: a.command, result: a.result, refusal_code: a.refusal_code } }));
  const events = await db.query<{ id: string; type: string; occurred_at: string; actor_id: string; actor_role: string | null; payload: Record<string, unknown> }>(`SELECT id::text AS id, type, occurred_at, actor_id, actor_role, payload FROM loan_events WHERE type LIKE 'directory.%' AND payload->>'party_id' = $1 ORDER BY sequence`, [partyId]);
  for (const e of events) out.push({ at: e.occurred_at, kind: "staff_look", actor: `staff:${String(e.payload["staff_user_id"] ?? e.actor_id)}`, summary: `${e.type}${typeof e.payload["section"] === "string" ? ` · ${String(e.payload["section"])}` : ""}${Array.isArray(e.payload["fields"]) ? ` · ${(e.payload["fields"] as unknown[]).join(", ")}` : ""}`, row_id: e.id, table: "loan_events", detail: { type: e.type, section: e.payload["section"] ?? null, fields: e.payload["fields"] ?? null, reason: e.payload["reason"] ?? null, export_id: e.payload["export_id"] ?? null, role: e.actor_role } });
  return out;
}

/** The stream (no log): every kind asked for, in time order. Null when the id is not a borrower party. */
export async function directoryActivity(rt: Runtime, partyId: string, opts: DirectoryActivityOptions = {}): Promise<DirectoryActivity | null> {
  const s = await partyScope(rt.db, partyId);
  if (!s) return null;
  const kinds = kindsOf(opts.kind); const from = bound(opts.from, false); const to = bound(opts.to, true);
  const first = s.party.legal_name.split(/\s+/)[0] ?? s.party.legal_name;
  const want = (k: ActivityKind) => kinds.includes(k);
  const parts = await Promise.all([
    want("message") ? messageRows(rt.db, s, first) : [], want("card") ? cardRows(rt.db, partyId) : [], want("turn") ? turnRows(rt.db, partyId) : [], want("event") ? eventRows(rt.db, s) : [],
    want("decision") ? decisionRows(rt.db, s) : [], want("notice") ? noticeRows(rt.db, s) : [], want("session") ? sessionRows(rt.db, partyId) : [], want("staff_look") ? staffLookRows(rt.db, partyId) : []]);
  const rows = parts.flat().filter((r) => inWindow(r.at, from, to)).sort((a, b) => a.at.localeCompare(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.row_id.localeCompare(b.row_id));
  const limited = opts.limit && opts.limit > 0 ? rows.slice(-opts.limit) : rows;
  return stripSecrets({ party_id: partyId, rows: limited, count: rows.length, kinds, from, to, as_of: rt.clock.now() });
}

/** The stream on the bus's behalf: the rows plus `directory.viewed{staff_user_id, party_id, section: activity}`. */
export async function directoryActivityLogged(rt: Runtime, partyId: string, opts: DirectoryActivityOptions, look: { staff_user_id: string; session_id?: string | null }, actor: Actor): Promise<(DirectoryActivity & { event_id: string | null }) | null> {
  const a = await directoryActivity(rt, partyId, opts);
  if (!a) return null;
  const w = await rt.uow.run({}, async (ctx) => { ctx.events.append({ type: "directory.viewed", aggregate: { kind: "party", id: partyId }, actor, payload: { staff_user_id: look.staff_user_id, ...(look.session_id ? { session_id: look.session_id } : {}), party_id: partyId, section: "activity", kinds: a.kinds } }); }, { clock: rt.clock });
  return { ...a, event_id: w.events[0]?.id ?? null };
}
