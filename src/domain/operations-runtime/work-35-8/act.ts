/**
 * §35.8 — a screen is two tools (rule 1): `work.screen.read{code, subject}` (the projection and the action list with each
 * action's roles, `money`, `decision_schema`, `derived_fields` and whether the session may take it) and
 * `work.screen.act{code, action, subject, decision}` — derive, dispatch and log in one unit of work under 35.1's per-loan
 * lease. `work.screen.derive` is the dry run (the derivation row and its document, nothing else); `work.action.propose`
 * writes a proposal for a distinct officer; `work.action.decide` is that officer's approval or decline (rules 5–6).
 *
 * The pipeline of an act (rule 4 first — "Roles are the tool's, checked before the read"):
 *   role → the registered screen version (SCREEN_STALE) → the item (ITEM_CLOSED, CLAIMED_BY_OTHER) → the decision schema
 *   (NO_CLIENT_STATE{field}) → the deriver → the derivation row and `work-derivation.json` (rule 3) → a money-field action
 *   by anyone but an officer is `proposed` (rule 5) → otherwise the owning tool runs on the bus through the command view
 *   (its validators, guardrails, money fields and decision record unchanged; a savepoint under this command's transaction)
 *   → one `work_actions` row (executed | proposed | refused | error) and the process's event.
 * A refusal rolls the unit of work back (rule 7: "a refusal writes the work_actions and staff_actions rows and nothing
 * else"): the refused row — and, before dispatch, the derivation and its document, which "remain as evidence of what was
 * attempted" (edge case 1) — is written through the runtime's root pool (34.4's precedent for the rare write that must
 * outlive a refusal), then the refusal is thrown as a WorkRefused (a StaffError the console answers in its shape).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { Actor, EventStore } from "../../../kernel/events/index.ts";
import { EntityStore } from "../../../app/tools.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { canonicalJson, canonicalSha256 } from "../../../app/canonical.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { EscalationService } from "../../../app/escalations.ts";
import { loanCashState } from "../../../runtime/servicing.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import { DERIVERS, type DeriveContext, type Derived } from "../derivers-35-8.ts";
import { actionOf, screenOf, type ScreenSpec } from "./screens.ts";
import { currentScreen, isStale, registerScreens, type RegisteredAction, type ScreenVersion } from "./registry.ts";
import { getItem, setItemStatus, closeRow, type ItemDeps, type WorkItem } from "./items.ts";
import { takeScopeLocks } from "../seam/lock.ts";
import { portsOf, type WorkPorts } from "./ports.ts";
import * as ev from "./events.ts";
import { DERIVATION_DOCUMENT_KIND, ERRORS_BEFORE_ESCALATION, PROCESS_35_8, WorkRefused, actorId, isUuid, obj, s, type ActionStatus, type Row, type Subject } from "./types.ts";

export interface ActDeps { readonly rt: Runtime; readonly q: Queryable; readonly store: EntityStore; readonly events: EventStore; readonly now: string; readonly actor: Actor; readonly escalations: EscalationService; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; readonly sessionId?: string | null; readonly ports?: WorkPorts; readonly held?: readonly string[] }
type Write = (q: Queryable) => Promise<void>;
/** The rows a refusal keeps (rule 7; edge case 1: the derivation "remains as evidence of what was attempted"): written with the command when it commits, or after the rollback through the runtime's hook (src/runtime/app.ts executeDef `afterRollback`) when it refuses — never on a second pool connection while the command holds one. */
interface Outlive { readonly writes: Write[] }
const outliveOf = (): Outlive => ({ writes: [] });
/** A WorkRefused that carries its audit writes for the runtime to run after the rollback. */
const withAfterRollback = (e: WorkRefused, writes: readonly Write[]): WorkRefused => Object.assign(e, { afterRollback: async (db: Queryable) => { for (const w of writes) await w(db); } });
export interface WorkAction { readonly id: string; readonly work_item_id: string | null; readonly screen_code: string; readonly screen_version: number; readonly action_code: string; readonly subject_kind: string; readonly subject_id: string; readonly loan_id: string | null; readonly application_id: string | null; readonly staff_user_id: string | null; readonly actor_id: string; readonly role: string | null; readonly decision_payload: Row; readonly decision_sha256: string; readonly derivation_id: string | null; readonly process: string; readonly tool: string; readonly status: ActionStatus; readonly refusal_code: string | null; readonly command_event_id: string | null; readonly agent_decision_id: string | null; readonly approval_of: string | null; readonly input_sha256: string | null; readonly created_at: string }
export const ACTION_COLS = `id::text AS id, work_item_id::text AS work_item_id, screen_code, screen_version, action_code, subject_kind, subject_id, loan_id::text AS loan_id, application_id::text AS application_id, staff_user_id::text AS staff_user_id, actor_id, role, decision_payload, decision_sha256, derivation_id::text AS derivation_id, process, tool, status, refusal_code, command_event_id::text AS command_event_id, agent_decision_id::text AS agent_decision_id, approval_of::text AS approval_of, input_sha256, created_at::text AS created_at`;
export const toAction = (r: Row): WorkAction => ({ id: String(r["id"]), work_item_id: (r["work_item_id"] as string | null) ?? null, screen_code: String(r["screen_code"]), screen_version: Number(r["screen_version"]), action_code: String(r["action_code"]), subject_kind: String(r["subject_kind"]), subject_id: String(r["subject_id"]), loan_id: (r["loan_id"] as string | null) ?? null, application_id: (r["application_id"] as string | null) ?? null, staff_user_id: (r["staff_user_id"] as string | null) ?? null, actor_id: String(r["actor_id"]), role: (r["role"] as string | null) ?? null, decision_payload: obj(r["decision_payload"]), decision_sha256: String(r["decision_sha256"]), derivation_id: (r["derivation_id"] as string | null) ?? null, process: String(r["process"]), tool: String(r["tool"]), status: String(r["status"]) as ActionStatus, refusal_code: (r["refusal_code"] as string | null) ?? null, command_event_id: (r["command_event_id"] as string | null) ?? null, agent_decision_id: (r["agent_decision_id"] as string | null) ?? null, approval_of: (r["approval_of"] as string | null) ?? null, input_sha256: (r["input_sha256"] as string | null) ?? null, created_at: String(r["created_at"]) });
export async function getAction(q: Queryable, id: string): Promise<WorkAction | null> { if (!isUuid(id)) return null; const [r] = await q.query<Row>(`SELECT ${ACTION_COLS} FROM work_actions WHERE id = $1`, [id]); return r ? toAction(r) : null; }

const staffId = (a: Actor): string | null => (a.kind === "human" && isUuid(a.id) ? a.id : null);
/** The action events are the action's own (aggregate work_action): appended through the undefaulted store beneath a loan-scoped command's (src/runtime/app.ts withDefaultLoan `rawStore`), so SM_WORK_APPROVAL_1BD arms and satisfies per proposal, not per loan; the loan rides in the payload. */
const rawEvents = (d: ActDeps): EventStore => ((d.events as EventStore & { rawStore?: EventStore }).rawStore ?? d.events);
const today = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
/** The roles a staff user holds (34.1 `roles` ∪ 35.7 `reviewer_roles`) — for the ROLE_REQUIRED answer's `held` / `act_as`; a non-staff actor holds its role alone. */
export async function heldRoles(q: Queryable, actor: Actor): Promise<string[]> {
  const id = staffId(actor); if (!id) return actor.role ? [actor.role] : [];
  const [u] = await q.query<{ roles: string[] | null; reviewer_roles: string[] | null }>(`SELECT roles, reviewer_roles FROM staff_users WHERE id = $1`, [id]).catch(() => [] as { roles: string[] | null; reviewer_roles: string[] | null }[]);
  return [...new Set([...(u?.roles ?? []), ...(u?.reviewer_roles ?? []), ...(actor.role ? [actor.role] : [])])];
}

// ---------------------------------------------------------------- the registered screen and its checks
interface Resolved { readonly screen: ScreenSpec; readonly version: ScreenVersion; readonly action: RegisteredAction; readonly stale: boolean }
async function resolveAction(d: ActDeps, code: string, actionCode: string): Promise<Resolved> {
  const screen = screenOf(code); if (!screen) throw new WorkRefused(404, "NOT_FOUND", `no screen ${code}`, { screen_code: code });
  if (!actionOf(screen, actionCode)) throw new WorkRefused(404, "NOT_FOUND", `screen ${code} has no action ${actionCode}`, { screen_code: code, action: actionCode });
  let version = await currentScreen(d.q, code);
  if (!version) { await registerScreens(d.rt, d.q, d.now); version = (await currentScreen(d.q, code))!; }
  const action = version.actions.find((a) => a.code === actionCode)!;
  return { screen, version, action, stale: isStale(d.rt, version) };
}
/** Rule 4: the role sent to the bus is the one the person named for the act; refused ROLE_REQUIRED{role, held, act_as} when the tool does not accept it — before any read. */
async function requireRole(d: ActDeps, action: RegisteredAction): Promise<void> {
  if (d.actor.kind !== "human") return;   // the bus's humanOnly / allowlist gates decide for agents (HUMAN_ONLY_ACT)
  const role = d.actor.role ?? "";
  if (action.roles.includes(role)) return;
  const held = d.held ?? await heldRoles(d.q, d.actor);
  throw new WorkRefused(403, "ROLE_REQUIRED", `${action.process} ${action.tool} needs ${action.roles.join(" or ")}; requires ${action.roles[0] ?? "a role the tool names"}`, { role: action.roles[0] ?? null, held, act_as: held.filter((r) => action.roles.includes(r)) });
}
/** Rule 2 (NO_CLIENT_STATE): a decision payload that contains a derived field, or any field not in `decision_schema`, is refused before the deriver runs. */
export function validateDecision(action: RegisteredAction, decision: Row): void {
  const schema = obj(action.decision_schema);
  for (const k of Object.keys(decision)) {
    if (action.derived_fields.includes(k)) throw new WorkRefused(409, "NO_CLIENT_STATE", `${k} is derived by the platform, never supplied`, { field: k, action: action.code });
    const f = obj(schema[k]);
    if (!schema[k]) throw new WorkRefused(409, "NO_CLIENT_STATE", `${k} is not a field of ${action.code}'s decision`, { field: k, action: action.code });
    if (/_cents$/.test(k) && f["person_source"] !== true) throw new WorkRefused(409, "NO_CLIENT_STATE", `${k} is a figure the person is not the source of`, { field: k, action: action.code });
    const v = decision[k];
    if (f["type"] === "enum" && Array.isArray(f["values"]) && v !== undefined && v !== null && !(f["values"] as unknown[]).includes(v)) throw new RangeError(`${k} must be one of ${(f["values"] as string[]).join(", ")}`);
    if (f["type"] === "date" && v !== undefined && v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new RangeError(`${k} is a date (YYYY-MM-DD)`);
    if (f["type"] === "cents" && v !== undefined && v !== null && !/^-?\d+$/.test(String(v))) throw new RangeError(`${k} is a cents string`);
    if (f["type"] === "boolean" && v !== undefined && v !== null && typeof v !== "boolean") throw new RangeError(`${k} is a boolean`);
  }
  for (const [k, f] of Object.entries(schema)) if (obj(f)["required"] === true && (decision[k] === undefined || decision[k] === null || decision[k] === "")) throw new RangeError(`${k} is required by ${action.code}`);
}
async function subjectExists(d: ActDeps, subject: Subject): Promise<{ loan_id: string | null; application_id: string | null }> {
  if (!isUuid(subject.id)) throw new WorkRefused(404, "NOT_FOUND", "no such subject");
  if (subject.kind === "loan") { const [r] = await d.q.query<{ id: string }>(`SELECT id::text AS id FROM loans WHERE id = $1`, [subject.id]); if (!r) throw new WorkRefused(404, "NOT_FOUND", "no such subject"); return { loan_id: subject.id, application_id: null }; }
  const [r] = await d.q.query<{ id: string; loan_id: string | null }>(`SELECT id::text AS id, loan_id::text AS loan_id FROM applications WHERE id = $1`, [subject.id]); if (!r) throw new WorkRefused(404, "NOT_FOUND", "no such subject");
  return { loan_id: null, application_id: subject.id };
}
async function itemFor(d: ActDeps, itemId: string | null, subject: Subject): Promise<WorkItem | null> {
  if (!itemId) return null;
  const it = await getItem(d.q, itemId); if (!it) throw new WorkRefused(404, "NOT_FOUND", `no work item ${itemId}`);
  if (it.status === "closed" || it.status === "cancelled") throw new WorkRefused(409, "ITEM_CLOSED", `item ${itemId} is ${it.status}`, { item_id: itemId, status: it.status });
  const me = actorId(d.actor);
  if (it.status === "claimed" && it.claimed_by && it.claimed_by !== me && it.claim_expires_at && Date.parse(it.claim_expires_at) > Date.parse(d.now)) throw new WorkRefused(409, "CLAIMED_BY_OTHER", `item ${itemId} is claimed`, { staff_user_id: it.claimed_by });
  if (it.subject_kind !== subject.kind || it.subject_id !== subject.id) throw new WorkRefused(409, "ITEM_SUBJECT", `item ${itemId} is about another subject`, { item_id: itemId });
  return it;
}

// ---------------------------------------------------------------- the derivation (rule 3)
/** The stored form of a derived input (Data model: "PII never stored — ids, codes and cents strings only"): a recipient list is kept as party ids; a name, address, e-mail or phone anywhere in the input is dropped. The tool receives the full input (a notice tool prints the address); the record, the hash and the dry-run answer carry the redacted form. */
const PII_KEYS = /^(name|legal_name|first_name|last_name|email|e_mail|phone|phone_number|mailing_address|mailingAddress|address|address_line1|address_line2|street|ssn|tin|account_number|routing_number)$/;
export function redactForRecord(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactForRecord);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Row; const out: Row = {};
    for (const [k, x] of Object.entries(o)) { if (PII_KEYS.test(k)) continue; out[k] = k === "recipients" && Array.isArray(x) ? x.map((r) => ({ party_id: obj(r)["partyId"] ?? obj(r)["party_id"] ?? null, redacted: true })) : redactForRecord(x); }
    return out;
  }
  return v;
}
export interface StoredDerivation { readonly derivation_id: string; readonly document_id: string; readonly input_sha256: string; readonly canonical: string; readonly derived: Derived }
async function derive(d: ActDeps, r: Resolved, subject: Subject, decision: Row): Promise<Derived> {
  const fn = DERIVERS[r.action.deriver]; if (!fn) throw new WorkRefused(501, "DERIVER_MISSING", `no deriver ${r.action.deriver}`, { action: r.action.code });
  const c: DeriveContext = { rt: d.rt, store: d.store, q: d.q, now: d.now, actor: d.actor, subject, decision, ports: portsOf(d.ports), environment: d.rt.environment };
  return fn(c);
}
/** Rule 3: the canonical JSON the tool will receive (its stored, redacted form), hashed and stored through 35.2 as `work-derivation.json` with its sources — with the command, or after a refusal's rollback (edge case 1: the evidence of what was attempted remains). */
async function storeDerivation(d: ActDeps, o: Outlive, r: Resolved, subject: Subject, keys: { loan_id: string | null; application_id: string | null }, derived: Derived): Promise<StoredDerivation> {
  const stored = redactForRecord(derived.input);
  const canonical = canonicalJson(stored); const input_sha256 = canonicalSha256(stored);
  const derivation_id = randomUUID(); const document_id = randomUUID();
  const ports = portsOf(d.ports);
  const write: Write = async (q) => {
    await ports.documents.store(q, { id: document_id, kind: DERIVATION_DOCUMENT_KIND, text: canonical, loan_id: keys.loan_id, application_id: keys.application_id, retention_class: "life_of_loan_plus_4y", metadata: { derivation_id, screen_code: r.screen.code, action_code: r.action.code, deriver: r.action.deriver, deriver_version: r.action.deriver_version, subject, sources: derived.sources }, now: d.now });
    await q.query(`INSERT INTO work_derivations (id, screen_code, action_code, deriver, deriver_version, subject_kind, subject_id, sources, input_sha256, document_id, derived_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::timestamptz)`,
      [derivation_id, r.screen.code, r.action.code, r.action.deriver, r.action.deriver_version, subject.kind, subject.id, toJson(derived.sources), input_sha256, document_id, d.now]);
  };
  d.deferWrite(write); o.writes.push(write);
  return { derivation_id, document_id, input_sha256, canonical, derived };
}
/** `work.screen.derive` — the dry run: the derived input, its hash and sources; the derivation row and document, nothing else. */
export async function screenDerive(d: ActDeps, i: { code: string; action: string; subject: Subject; decision: Row }): Promise<{ derivation_id: string; document_id: string; input_sha256: string; sources: Row; input: Row; screen_code: string; action_code: string; process: string; tool: string }> {
  const r = await resolveAction(d, i.code, i.action);
  const keys = await subjectExists(d, i.subject);
  validateDecision(r.action, i.decision);
  const derived = await derive(d, r, i.subject, i.decision);
  const st = await storeDerivation(d, outliveOf(), r, i.subject, keys, derived);
  return { derivation_id: st.derivation_id, document_id: st.document_id, input_sha256: st.input_sha256, sources: derived.sources, input: JSON.parse(st.canonical) as Row, screen_code: r.screen.code, action_code: r.action.code, process: r.action.process, tool: r.action.tool };
}

// ---------------------------------------------------------------- the rows
interface RowInput { readonly id?: string; readonly item: WorkItem | null; readonly r: Resolved; readonly subject: Subject; readonly keys: { loan_id: string | null; application_id: string | null }; readonly decision: Row; readonly derivation_id: string | null; readonly input_sha256: string | null; readonly status: ActionStatus; readonly refusal_code?: string | null; readonly command_event_id?: string | null; readonly agent_decision_id?: string | null; readonly approval_of?: string | null; readonly actor?: Actor }
const insertActionSql = `INSERT INTO work_actions (id, work_item_id, screen_code, screen_version, action_code, subject_kind, subject_id, loan_id, application_id, staff_user_id, actor_id, session_id, role, decision_payload, decision_sha256, derivation_id, process, tool, status, refusal_code, command_event_id, agent_decision_id, approval_of, input_sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::timestamptz)`;
function actionParams(d: ActDeps, x: RowInput): unknown[] {
  const actor = x.actor ?? d.actor; const id = x.id ?? randomUUID();
  return [id, x.item?.id ?? null, x.r.screen.code, x.r.version.version, x.r.action.code, x.subject.kind, x.subject.id, x.keys.loan_id, x.keys.application_id, staffId(actor), actorId(actor), d.sessionId ?? null, actor.role ?? null, toJson(x.decision), canonicalSha256(x.decision), x.derivation_id, x.r.action.process, x.r.action.tool, x.status, x.refusal_code ?? null, x.command_event_id ?? null, x.agent_decision_id ?? null, x.approval_of ?? null, x.input_sha256, d.now];
}
/** The refused / errored row, written through the root pool so it outlives the rollback (rule 7), then the refusal itself. */
/** A section's own refusal class (FundingRefused, DecisionRefused, PostClosingRefused, …): an Error carrying its code — the owning tool refused, with its code. */
const sectionCode = (e: unknown): string | null => { if (!(e instanceof Error) || e instanceof WorkRefused || e instanceof CommandRefused) return null; const c = (e as unknown as { code?: unknown }).code; return typeof c === "string" && c ? c : null; };
/** 26.3's four-eyes refusals (rule 7) as the screen answers them — FOUR_EYES{cause}; the row keeps the tool's code (edge case 1). */
const FOUR_EYES_CODES = new Set(["RELEASE_BY_EDITOR", "FOUR_EYES_FAILED", "RELEASE_NEEDS_FUNDING_APPROVER"]);
async function refuse(d: ActDeps, o: Outlive, x: Omit<RowInput, "status">, e: WorkRefused | CommandRefused | Error): Promise<never> {
  const id = randomUUID();
  const sc = sectionCode(e);
  const code = e instanceof WorkRefused ? e.code : e instanceof CommandRefused ? e.code : sc ?? (e.name || "Error");
  const status: ActionStatus = e instanceof WorkRefused || e instanceof CommandRefused || sc !== null ? "refused" : "error";
  const params = actionParams(d, { ...x, id, status, refusal_code: code });
  const rt = d.rt.root;
  const writes: Write[] = [...o.writes, async (q) => { await q.query(insertActionSql, params); }];
  if (status === "error" && x.item) {
    // edge case: a sev 3 ops_analyst escalation after the third error on one item — its own global unit of work after the rollback
    const item = x.item;
    writes.push(async (q) => {
      const [n] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_actions WHERE work_item_id = $1 AND status = 'error'`, [item.id]);
      if (Number(n?.n ?? 0) < ERRORS_BEFORE_ESCALATION) return;
      let es: EscalationService | undefined;
      await rt.uow.run({}, (ctx) => { es = new EscalationService(ctx.events, ctx.clock); es.open({ kind: "sev3", ownerRole: "ops_analyst", ...(x.keys.loan_id ? { loanId: x.keys.loan_id } : {}), ...(x.keys.application_id ? { applicationId: x.keys.application_id } : {}), severity: "3", payload: { work_item_id: item.id, action_id: id, errors: Number(n?.n ?? 0), screen_code: x.r.screen.code, action_code: x.r.action.code, error_class: code } }, d.actor); ctx.events.append(ev.actionRefused(id, d.actor, { code, screen_code: x.r.screen.code, action_code: x.r.action.code, tool: x.r.action.tool })); }, { clock: rt.clock, commit: async (qq) => { for (const esc of es?.list() ?? []) await rt.escalationRepo.save(esc, qq); } });
    });
  }
  if (e instanceof WorkRefused) throw withAfterRollback(new WorkRefused(e.status, e.code, e.message, { ...e.extra, action_id: id }), writes);
  if (e instanceof CommandRefused) throw withAfterRollback(new WorkRefused(409, e.code, e.message, { action_id: id, command: e.command, citation: e.citation, tool_code: e.code }), writes);
  if (sc !== null) throw withAfterRollback(new WorkRefused(409, FOUR_EYES_CODES.has(sc) ? "FOUR_EYES" : sc, e.message, { action_id: id, tool_code: sc, cause: sc, citation: (e as { citation?: string }).citation ?? null }), writes);
  throw withAfterRollback(new WorkRefused(500, "TOOL_ERROR", `${x.r.action.process} ${x.r.action.tool} failed: ${e.name}`, { action_id: id, error_class: e.name }), writes);
}

// ---------------------------------------------------------------- work.screen.read (rule 1)
export async function screenRead(d: ActDeps, i: { code: string; subject: Subject }): Promise<Row> {
  const screen = screenOf(i.code); if (!screen) throw new WorkRefused(404, "NOT_FOUND", `no screen ${i.code}`, { screen_code: i.code });
  const keys = await subjectExists(d, i.subject);
  let version = await currentScreen(d.q, i.code);
  if (!version) { await registerScreens(d.rt, d.q, d.now); version = (await currentScreen(d.q, i.code))!; }
  const stale = isStale(d.rt, version);
  const held = d.held ?? await heldRoles(d.q, d.actor);
  const actions = version.actions.map((a) => { const may = a.roles.some((r) => held.includes(r)) || (d.actor.kind !== "human"); return { code: a.code, process: a.process, tool: a.tool, op: a.op, roles: a.roles, money: a.money, decision_schema: a.decision_schema, derived_fields: a.derived_fields, deriver: a.deriver, deriver_version: a.deriver_version, available: !stale && may && a.registered, needs: stale ? "re-registration" : !a.registered ? "tool registration" : may ? null : a.roles[0] ?? null }; });
  const projection: Row = {};
  const bind = (sql: string, params: unknown[]): Promise<Row[]> => d.q.query<Row>(sql, params);
  if (i.subject.kind === "loan") {
    const loanId = i.subject.id;
    try {
      const f = await loanCashState(d.rt, loanId, today(d.now));
      projection["cash_state"] = { upb_cents: f.state.upb_cents.toString(), lpi_date: f.state.lpi_date, late_charges_due_cents: f.state.late_charges_due_cents.toString(), suspense_unapplied_cents: f.state.suspense_unapplied_cents.toString(), note_rate_pct: f.state.note_rate_pct, escrowed: f.state.escrowed };
      projection["installments"] = f.state.installments.map((x) => ({ due_date: x.due_date, pi_cents: x.pi_cents.toString(), escrow_cents: x.escrow_cents.toString(), status: x.status, ...(x.satisfied_by_payment_id ? { satisfied_by_payment_id: x.satisfied_by_payment_id } : {}), ...(x.credited_as_of ? { credited_as_of: x.credited_as_of } : {}) }));
      projection["balances"] = Object.fromEntries(Object.entries(f.balances).map(([k, v]) => [k, v.toString()]));
      projection["received_payments"] = f.received_payments.map((p) => ({ payment_id: s(p["payment_id"]), amount_cents: s(p["amount_cents"]), received_on: s(p["received_on"]), status: s(p["status"]), channel: s(p["channel"]) }));
      projection["posted_payments"] = f.store.list("payments", (x) => x["loan_id"] === loanId && x["status"] === "posted").map((r) => ({ payment_id: s(r.data["payment_id"] ?? r.id), amount_cents: s(r.data["amount_cents"]), received_on: s(r.data["received_on"]), installments: r.data["installments"] ?? [], ledger_entry_set_ids: r.data["ledger_entry_set_ids"] ?? [] }));
      projection["custodial"] = f.custodial;
    } catch (e) { projection["cash_state"] = null; projection["cash_state_unavailable"] = e instanceof Error ? e.name : "unavailable"; }
    if (screen.code === "payoff_quote") projection["quotes"] = d.store.list("payoff_quotes", (x) => x["loan_id"] === loanId).slice(-3).map((r) => ({ quote_id: r.id, total_cents: s(r.data["total_cents"]), good_through: s(r.data["good_through"]), per_diem_cents: s(r.data["per_diem_cents"]) }));
    if (screen.code === "lossmit_decision") projection["evaluations"] = d.store.list("lossmit_evaluations", (x) => x["loan_id"] === loanId).slice(-3).map((r) => ({ evaluation_id: r.id, status: s(r.data["status"]), outcome: s(r.data["outcome"]), option: s(r.data["option"]), has_denial: r.data["has_denial"] ?? null, reviewer_approval_id: r.data["reviewer_approval_id"] ?? null }));
    if (screen.code === "bankruptcy_case") projection["cases"] = d.store.list("bankruptcy_cases", (x) => x["loan_id"] === loanId).map((r) => ({ case_id: r.id, chapter: s(r.data["chapter"]), status: s(r.data["status"]), case_number_last4: s(r.data["case_number_full"]).slice(-4) }));
    if (screen.code === "foreclosure_case") projection["cases"] = d.store.list("foreclosure_cases", (x) => x["loan_id"] === loanId).map((r) => ({ case_id: r.id, status: s(r.data["status"]), step: s(r.data["step"]) }));
    if (screen.code === "escrow_analysis") projection["analyses"] = d.store.list("escrow_analyses", (x) => x["loan_id"] === loanId).slice(-3).map((r) => ({ analysis_id: r.id, status: s(r.data["status"]), payment_change_cents: s(r.data["payment_change_cents"]) }));
    projection["timers"] = await bind(`SELECT id::text AS id, code, status::text AS status, due_at::text AS due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND status IN ('armed', 'breached') ORDER BY due_at NULLS LAST LIMIT 50`, [loanId]);
    projection["escalations"] = await bind(`SELECT id::text AS id, kind, owner_role, severity, opened_at::text AS opened_at FROM escalations WHERE loan_id = $1 AND completed_at IS NULL ORDER BY opened_at LIMIT 50`, [loanId]);
  } else {
    const appId = i.subject.id;
    if (screen.code === "conditions") projection["conditions"] = d.store.list("conditions", (x) => x["application_id"] === appId).map((r) => ({ condition_id: r.id, template_code: s(r.data["template_code"]), stage: s(r.data["stage"]), status: s(r.data["status"]), category: s(r.data["category"]), evidence_kinds: r.data["evidence_kinds"] ?? [], requires_role: r.data["requires_role"] ?? null }));
    projection["credit_decisions"] = d.store.list("credit_decisions", (x) => x["application_id"] === appId).map((r) => ({ decision_id: r.id, status: s(r.data["status"]), issued_at: s(r.data["issued_at"]) }));
    if (screen.code === "funding_release") {
      projection["fundings"] = d.store.list("fundings", (x) => x["application_id"] === appId).map((r) => ({ funding_id: r.id, status: s(r.data["status"]), funding_type: s(r.data["funding_type"]), disbursement_date: s(r.data["disbursement_date"]) }));
      projection["wires"] = d.store.list("funding_wires", () => true).filter((r) => (projection["fundings"] as Row[]).some((f) => f["funding_id"] === r.data["funding_id"])).map((r) => ({ wire_id: r.id, funding_id: s(r.data["funding_id"]), status: s(r.data["status"]), amount_cents: s(r.data["amount_cents"]), editors: (r.data["editors"] as string[] | undefined) ?? [] }));
      projection["orchestration"] = await portsOf(d.ports).orchestration.forApplication(d.q, appId);
    }
    if (screen.code === "cd_review") projection["disclosures"] = d.store.list("closing_disclosures", (x) => x["application_id"] === appId).map((r) => ({ disclosure_id: r.id, status: s(r.data["status"]), version: r.data["version"] ?? null }));
    if (screen.code === "le_review") projection["disclosures"] = d.store.list("loan_estimates", (x) => x["application_id"] === appId).map((r) => ({ disclosure_id: r.id, status: s(r.data["status"]), data_hash: s(r.data["data_hash"]) }));
    if (screen.code === "closing_schedule") projection["closings"] = d.store.list("closings", (x) => x["application_id"] === appId).map((r) => ({ closing_id: r.id, status: s(r.data["status"]), scheduled_at: s(r.data["scheduled_at"]), earliest_consummation: s(r.data["earliest_consummation"]) }));
    projection["timers"] = await bind(`SELECT id::text AS id, code, status::text AS status, due_at::text AS due_at, due_date::text AS due_date FROM timers WHERE application_id = $1 AND status IN ('armed', 'breached') ORDER BY due_at NULLS LAST LIMIT 50`, [appId]);
    projection["escalations"] = await bind(`SELECT id::text AS id, kind, owner_role, severity, opened_at::text AS opened_at FROM escalations WHERE application_id = $1 AND completed_at IS NULL ORDER BY opened_at LIMIT 50`, [appId]);
  }
  projection["recent_actions"] = (await bind(`SELECT ${ACTION_COLS} FROM work_actions WHERE subject_kind = $1 AND subject_id = $2 ORDER BY created_at DESC, id LIMIT 10`, [i.subject.kind, i.subject.id])).map((r) => { const a = toAction(r); return { action_id: a.id, screen_code: a.screen_code, action_code: a.action_code, status: a.status, refusal_code: a.refusal_code, by: a.actor_id, role: a.role, at: a.created_at, input_sha256: a.input_sha256 }; });
  projection["items"] = await bind(`SELECT id::text AS id, screen_code, source_kind, source_id, required_role, status, claimed_by::text AS claimed_by, opened_at::text AS opened_at, due_at::text AS due_at FROM work_items WHERE subject_kind = $1 AND subject_id = $2 AND status NOT IN ('closed', 'cancelled') ORDER BY opened_at`, [i.subject.kind, i.subject.id]);
  return { code: screen.code, version: version.version, stale, subject: i.subject, subject_kind: screen.subject_kind, owning_process: screen.owning_process, read_tools: screen.read_tools, ...keys, actions, projection };
}

// ---------------------------------------------------------------- work.screen.act (rules 2–7) and work.action.propose
export interface ActInput { readonly code: string; readonly action: string; readonly subject: Subject; readonly decision: Row; readonly work_item_id?: string | null; readonly rationale?: string | null }
export interface ActResult { readonly action_id: string; readonly status: ActionStatus; readonly screen_code: string; readonly screen_version: number; readonly action_code: string; readonly process: string; readonly tool: string; readonly derivation_id: string | null; readonly document_id: string | null; readonly input_sha256: string | null; readonly sources: Row | null; readonly output?: unknown; readonly command_event_id?: string | null; readonly agent_decision_id?: string | null; readonly events?: readonly string[]; readonly work_item_id: string | null; readonly approval_of?: string | null; readonly refusal_code?: string | null; readonly money: boolean; readonly proposed_at?: string }
/** The owning tool on the bus through the command view (a savepoint under this command's transaction, the same lock). */
async function dispatch(d: ActDeps, r: Resolved, keys: { loan_id: string | null; application_id: string | null }, input: Row, actor: Actor, approvedBy?: Actor): Promise<{ output: unknown; command_event_id: string | null; agent_decision_id: string | null; events: string[] }> {
  const orch = portsOf(d.ports).orchestration;
  const viaOrchestration = r.screen.code === "funding_release" && orch.releaseTool && d.rt.tool(orch.releaseTool.process, orch.releaseTool.name);
  const process = viaOrchestration ? orch.releaseTool!.process : r.action.process; const name = viaOrchestration ? orch.releaseTool!.name : r.action.tool;
  const out = await d.rt.execute({ process, name, loanId: keys.loan_id ?? "", ...(keys.application_id ? { applicationId: keys.application_id } : {}), actor, input, ...(approvedBy ? { approvedBy } : {}) });
  return { output: out.output, command_event_id: out.events[0]?.id ?? null, agent_decision_id: out.decisions[0]?.id ?? null, events: out.events.map((e) => e.type) };
}
export async function screenAct(d: ActDeps, i: ActInput, mode: "act" | "propose" = "act"): Promise<ActResult> {
  const o = outliveOf();
  const r = await resolveAction(d, i.code, i.action);
  // rule 4: the role check precedes every read of the subject's rows; its refusal is still a row in the action log (T7: "the refusal precedes the projection query in the action log's timing and no derivation row exists") — keyed to the subject when it exists, unkeyed otherwise
  if (mode === "act") { try { await requireRole(d, r.action); } catch (e) { if (!(e instanceof WorkRefused)) throw e; const keys = await subjectExists(d, i.subject).catch(() => ({ loan_id: null, application_id: null })); return refuse(d, o, { item: null, r, subject: i.subject, keys, decision: i.decision, derivation_id: null, input_sha256: null }, e); } }
  const keys = await subjectExists(d, i.subject);
  const base = { item: null as WorkItem | null, r, subject: i.subject, keys, decision: i.decision, derivation_id: null as string | null, input_sha256: null as string | null };
  if (r.stale) return refuse(d, o, base, new WorkRefused(409, "SCREEN_STALE", `screen ${r.screen.code} version ${r.version.version} is stale: re-register it`, { screen_code: r.screen.code, version: r.version.version }));
  if (!r.action.registered) return refuse(d, o, base, new WorkRefused(501, "TOOL_UNREGISTERED", `${r.action.process} ${r.action.tool} is not on the bus`, { process: r.action.process, tool: r.action.tool }));
  let item: WorkItem | null = null;
  try { item = await itemFor(d, i.work_item_id ?? null, i.subject); } catch (e) { if (e instanceof WorkRefused) return refuse(d, o, base, e); throw e; }
  const x = { ...base, item };
  try { validateDecision(r.action, i.decision); } catch (e) { if (e instanceof WorkRefused) return refuse(d, o, x, e); throw e; }
  let derived: Derived;
  try { derived = await derive(d, r, i.subject, i.decision); } catch (e) { if (e instanceof WorkRefused || e instanceof CommandRefused) return refuse(d, o, x, e); if (e instanceof RangeError) return refuse(d, o, x, new WorkRefused(400, "BAD_REQUEST", e.message)); throw e; }
  const st = await storeDerivation(d, o, r, i.subject, keys, derived);
  const y = { ...x, derivation_id: st.derivation_id, input_sha256: st.input_sha256 };
  const common = { screen_code: r.screen.code, screen_version: r.version.version, action_code: r.action.code, process: r.action.process, tool: r.action.tool, derivation_id: st.derivation_id, document_id: st.document_id, input_sha256: st.input_sha256, sources: derived.sources, work_item_id: item?.id ?? null, money: r.action.money };
  // rule 5: a money-field action executes only for an officer; anyone else — and the agent's propose — writes a proposal for a distinct officer
  if (mode === "propose" || (r.action.money && d.actor.role !== "officer")) {
    const id = randomUUID();
    d.deferWrite(async (q) => { await q.query(insertActionSql, actionParams(d, { ...y, id, status: "proposed" })); });
    rawEvents(d).append(ev.actionProposed(id, d.actor, { tool: `${r.action.process} ${r.action.tool}`, input_sha256: st.input_sha256, proposed_at: d.now, screen_code: r.screen.code, action_code: r.action.code, by: actorId(d.actor) }));
    if (item) await setItemStatus(itemDeps(d), item.id, "waiting_approval", "approval_waiting", `proposal ${id}`);
    return { action_id: id, status: "proposed", ...common, proposed_at: d.now };
  }
  return executeDerived(d, o, y, st, common, d.actor, undefined, null);
}
const itemDeps = (d: ActDeps): ItemDeps => ({ db: d.q, events: d.events, now: d.now, actor: d.actor, deferWrite: d.deferWrite, sessionId: d.sessionId ?? null, registry: d.rt.registry });
async function executeDerived(d: ActDeps, o: Outlive, y: Omit<RowInput, "status">, st: StoredDerivation, common: Omit<ActResult, "action_id" | "status">, actor: Actor, approvedBy: Actor | undefined, approvalOf: string | null): Promise<ActResult> {
  const r = y.r; const id = randomUUID();
  let out: Awaited<ReturnType<typeof dispatch>>;
  try { out = await dispatch(d, r, y.keys, st.derived.input, actor, approvedBy); }
  catch (e) { if (e instanceof CommandRefused || e instanceof WorkRefused) return refuse(d, o, { ...y, actor, approval_of: approvalOf }, e); if (e instanceof RangeError && sectionCode(e) === null) return refuse(d, o, { ...y, actor, approval_of: approvalOf }, new WorkRefused(400, "BAD_REQUEST", e.message)); return refuse(d, o, { ...y, actor, approval_of: approvalOf }, e instanceof Error ? e : new Error(String(e))); }
  // 35.6: the closing orchestration opens on the clear-to-close (T7) — through the port (35.6's own tool once it lands; the seam's literal until then)
  if (r.screen.code === "conditions" && r.action.code === "ctc" && y.keys.application_id) await portsOf(d.ports).orchestration.openOnCtc({ q: d.q, rt: d.rt, events: d.events }, { application_id: y.keys.application_id, at: d.now, by: actorId(actor) });
  d.deferWrite(async (q) => { await q.query(insertActionSql, actionParams(d, { ...y, id, status: "executed", command_event_id: out.command_event_id, agent_decision_id: out.agent_decision_id, approval_of: approvalOf, actor })); });
  rawEvents(d).append(ev.actionExecuted(id, actor, { screen_code: r.screen.code, action_code: r.action.code, process: r.action.process, tool: r.action.tool, by: actorId(actor), role: actor.role ?? null, input_sha256: st.input_sha256, command_event_id: out.command_event_id, approval_of: approvalOf }));
  return { action_id: id, status: "executed", ...common, output: out.output, command_event_id: out.command_event_id, agent_decision_id: out.agent_decision_id, events: out.events, approval_of: approvalOf };
}

// ---------------------------------------------------------------- work.action.decide (rules 5–6)
export interface DecideResult { readonly action_id: string; readonly decision: "approved" | "declined"; readonly refused?: boolean; readonly code?: string | null; readonly executed_action_id: string | null; readonly proposal_sha256: string; readonly current_sha256: string | null; readonly work_item_id: string | null; readonly output?: unknown; readonly events?: readonly string[] }
export async function actionDecide(d: ActDeps, i: { action_id: string; decision: "approved" | "declined"; reason?: string | null }): Promise<DecideResult> {
  if (d.actor.kind !== "human" || d.actor.role !== "officer") throw new WorkRefused(403, "ROLE_REQUIRED", "work.action.decide is a distinct officer's; requires officer", { role: "officer", held: d.held ?? [], act_as: [] });
  const p = await getAction(d.q, i.action_id); if (!p) throw new WorkRefused(404, "NOT_FOUND", `no work action ${i.action_id}`);
  if (p.status !== "proposed") throw new WorkRefused(409, "NOT_PROPOSED", `action ${p.id} is ${p.status}`, { action_id: p.id, status: p.status });
  if (p.actor_id === actorId(d.actor)) throw new WorkRefused(409, "SAME_PERSON", "the approver is never the proposer", { action_id: p.id, staff_user_id: p.actor_id });
  const r = await resolveAction(d, p.screen_code, p.action_code);
  const subject: Subject = { kind: p.subject_kind as Subject["kind"], id: p.subject_id };
  const keys = { loan_id: p.loan_id, application_id: p.application_id };
  // 35.1 rule 7: the subject's lease before the re-derivation — the same advisory lock the owning tool's nested command re-takes on this session (rule 6: two people on one loan serialize here)
  await takeScopeLocks(d.q, { ...(keys.loan_id ? { loanId: keys.loan_id } : {}), ...(keys.application_id ? { applicationId: keys.application_id } : {}) });
  const item = p.work_item_id ? await getItem(d.q, p.work_item_id) : null;
  const approvalRow = (decision: "approved" | "declined", reason: string | null, executed: string | null): void => d.deferWrite(async (q) => {
    await q.query(`UPDATE work_actions SET status = $2, refusal_code = $3 WHERE id = $1`, [p.id, decision, decision === "declined" ? reason : null]);
    await q.query(`INSERT INTO work_approvals (work_action_id, approver_staff_user_id, approver_actor_id, proposer_actor_id, session_id, role, decision, reason, executed_action_id, created_at) VALUES ($1, $2, $3, $4, $5, 'officer', $6, $7, $8, $9::timestamptz)`, [p.id, staffId(d.actor), actorId(d.actor), p.actor_id, d.sessionId ?? null, decision, reason, executed, d.now]);
  });
  if (i.decision === "declined") {
    approvalRow("declined", i.reason ?? "declined", null);
    rawEvents(d).append(ev.actionDecided(p.id, d.actor, { decision: "declined", by: actorId(d.actor), executed_action_id: null, code: null }));
    if (item) await setItemStatus(itemDeps(d), item.id, "claimed", "claimed", `declined ${p.id}`);
    return { action_id: p.id, decision: "declined", executed_action_id: null, proposal_sha256: p.input_sha256 ?? "", current_sha256: null, work_item_id: item?.id ?? null };
  }
  // rule 6: approval re-derives; a changed record refuses STALE_DERIVATION and declines the proposal for a fresh one — over the subject's records loaded now on this transaction (the decide command is global-scoped; its own store holds the global rows)
  const store = new EntityStore(); store.seed(await d.rt.entities.load(keys.loan_id ? { loanId: keys.loan_id } : keys.application_id ? { applicationId: keys.application_id } : {}));
  const dd: ActDeps = { ...d, store };
  const derived = await derive(dd, r, subject, p.decision_payload);
  const current = canonicalSha256(redactForRecord(derived.input));   // the proposal's hash is over the stored (redacted) form — rule 6 compares like with like
  if (current !== p.input_sha256) {
    approvalRow("declined", "STALE_DERIVATION", null);
    rawEvents(d).append(ev.actionDecided(p.id, d.actor, { decision: "declined", by: actorId(d.actor), executed_action_id: null, code: "STALE_DERIVATION" }));
    if (item) await setItemStatus(itemDeps(d), item.id, "claimed", "claimed", `STALE_DERIVATION ${p.id}`);
    return { action_id: p.id, decision: "declined", refused: true, code: "STALE_DERIVATION", executed_action_id: null, proposal_sha256: p.input_sha256 ?? "", current_sha256: current, work_item_id: item?.id ?? null };
  }
  const o = outliveOf();
  const st = await storeDerivation(dd, o, r, subject, keys, derived);
  const y = { item, r, subject, keys, decision: p.decision_payload, derivation_id: st.derivation_id, input_sha256: st.input_sha256 };
  const common = { screen_code: r.screen.code, screen_version: r.version.version, action_code: r.action.code, process: r.action.process, tool: r.action.tool, derivation_id: st.derivation_id, document_id: st.document_id, input_sha256: st.input_sha256, sources: derived.sources, work_item_id: item?.id ?? null, money: r.action.money };
  // the executor is the approver; `approved_by` names both people (rule 5: approved_by = {proposer, approver}) — ids only
  const both: Actor = { kind: "human", id: `${p.actor_id};${actorId(d.actor)}`, role: "officer" };
  let exec: ActResult;
  try { exec = await executeDerived(dd, o, y, st, common, d.actor, both, p.id); }
  catch (e) {
    // the owning tool refused the approved act: the proposal resolves `declined` with the tool's code (edge case 1) — written with the refused row after the rollback
    if (e instanceof WorkRefused) {
      const code = e.code; const prior = (e as WorkRefused & { afterRollback?: (db: Queryable) => Promise<void> }).afterRollback;
      Object.assign(e, { afterRollback: async (db: Queryable) => { if (prior) await prior(db); await db.query(`UPDATE work_actions SET status = 'declined', refusal_code = $2 WHERE id = $1 AND status = 'proposed'`, [p.id, code]); await db.query(`INSERT INTO work_approvals (work_action_id, approver_staff_user_id, approver_actor_id, proposer_actor_id, session_id, role, decision, reason, executed_action_id, created_at) VALUES ($1, $2, $3, $4, $5, 'officer', 'declined', $6, NULL, $7::timestamptz)`, [p.id, staffId(d.actor), actorId(d.actor), p.actor_id, d.sessionId ?? null, code, d.now]); } });
    }
    throw e;
  }
  approvalRow("approved", i.reason ?? null, exec.action_id);
  rawEvents(d).append(ev.actionDecided(p.id, d.actor, { decision: "approved", by: actorId(d.actor), executed_action_id: exec.action_id, code: null }));
  if (item) await closeRow(itemDeps(d), item, "approved", `approved ${p.id} → ${exec.action_id}`, null);
  return { action_id: p.id, decision: "approved", executed_action_id: exec.action_id, proposal_sha256: p.input_sha256 ?? "", current_sha256: current, work_item_id: item?.id ?? null, output: exec.output, events: exec.events ?? [] };
}
export const WORK_PROCESS = PROCESS_35_8;
