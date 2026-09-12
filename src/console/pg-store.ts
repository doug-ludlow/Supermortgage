/** ConsoleStore over Postgres — the production console reads the same tables the agents write. */
import type { Actor } from "../kernel/events/index.ts";
import type { Db } from "../infra/db/client.ts";
import { toJson, isUuid } from "../infra/db/client.ts";
import type { TimerRegistry } from "../kernel/timers/index.ts";
import type { AgentRegistry } from "../app/agents.ts";
import type { ConsoleStore, QueueItem, LoanSummary, LoanDetail, Dashboard, AccessEntry, Funnel } from "./store.ts";
import { queueKindsFor, FUNNEL_STAGES, funnelRows } from "./store.ts";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export class PgConsoleStore implements ConsoleStore {
  private readonly db: Db;
  private readonly registry: TimerRegistry;
  private readonly agents: AgentRegistry;
  /** DELTA-30: the FAKE reviewers the runtime runs (roles they fill, the delay) — a pending queue row one of them will fill says so; null when they are off. */
  private readonly fakeReviewers: { readonly roles: readonly string[]; readonly delaySeconds: number } | null;
  constructor(db: Db, registry: TimerRegistry, agents: AgentRegistry, opts: { fakeReviewers?: { readonly roles: readonly string[]; readonly delaySeconds: number } | null } = {}) { this.db = db; this.registry = registry; this.agents = agents; this.fakeReviewers = opts.fakeReviewers ?? null; }

  private async items(now: string, loanId?: string): Promise<QueueItem[]> {
    const lf = loanId ? " AND loan_id = $1" : "";
    const p = loanId ? [loanId] : [];
    const out: QueueItem[] = [];
    // DELTA-30: a pending item whose owner role a FAKE reviewer fills says so on the queue row (the FAKE approves it after the delay; FAKE_REVIEWERS=off leaves it to a person)
    const fakeRoles = this.fakeReviewers?.roles ?? []; const fakeDelay = this.fakeReviewers?.delaySeconds ?? 0;
    for (const r of await this.db.query<Row>(`SELECT id, kind, owner_role, loan_id, severity, opened_at, payload FROM escalations WHERE completed_at IS NULL${lf} ORDER BY opened_at`, p)) {
      const fake = fakeRoles.includes(s(r["owner_role"])) && !/^sev[1-4]$/.test(s(r["kind"]));
      out.push({ id: s(r["id"]), kind: "escalation", title: `${s(r["kind"])} escalation${(r["payload"] as Row)["command"] ? ` — ${s((r["payload"] as Row)["command"])}` : ""}${fake ? " — FAKE reviewer" : ""}`, ownerRole: s(r["owner_role"]), openedAt: s(r["opened_at"]), detail: fake ? { ...(r["payload"] as Row), fake_reviewer: { role: s(r["owner_role"]), approves_after_s: fakeDelay, marker: "FAKE" } } : (r["payload"] as Row), ...(r["loan_id"] ? { loanId: s(r["loan_id"]) } : {}), ...(r["severity"] ? { severity: s(r["severity"]) } : {}) });
    }
    for (const r of await this.db.query<Row>(`SELECT id, kind, adapter, owner_role, loan_id, package, due_at, opened_at FROM human_portal_tasks WHERE status IN ('open','in_progress')${lf} ORDER BY due_at NULLS LAST, opened_at`, p))
      out.push({ id: s(r["id"]), kind: "portal_task", title: `${s(r["kind"])} (${s(r["adapter"])})`, ownerRole: s(r["owner_role"]), openedAt: s(r["opened_at"]), detail: r["package"] as Row, ...(r["loan_id"] ? { loanId: s(r["loan_id"]) } : {}), ...(r["due_at"] ? { dueAt: s(r["due_at"]) } : {}) });
    for (const r of await this.db.query<Row>(`SELECT n.id, n.template_code, n.loan_id, n.held_reason, n.produced_at FROM notices n WHERE n.status = 'held'${lf.replace("loan_id", "n.loan_id")} ORDER BY n.produced_at`, p))
      out.push({ id: s(r["id"]), kind: "held_notice", title: `${s(r["template_code"])} held`, ownerRole: "ops_analyst", openedAt: s(r["produced_at"]), detail: { reason: r["held_reason"] }, ...(r["loan_id"] ? { loanId: s(r["loan_id"]) } : {}) });
    for (const r of await this.db.query<Row>(`SELECT id, adapter, idempotency_key, error, attempts, loan_id, last_attempt_at, created_at FROM integration_messages WHERE status = 'dead'${lf} ORDER BY created_at`, p))
      out.push({ id: s(r["id"]), kind: "dead_letter", title: `${s(r["adapter"])} dead letter`, ownerRole: "fnma_portal_operator", openedAt: s(r["last_attempt_at"] ?? r["created_at"]), detail: { idempotency_key: r["idempotency_key"], error: r["error"], attempts: r["attempts"] }, ...(r["loan_id"] ? { loanId: s(r["loan_id"]) } : {}) });
    for (const r of await this.db.query<Row>(`SELECT id, code, loan_id, due_at, due_date, breached_at FROM timers WHERE status = 'breached'${lf} ORDER BY breached_at`, p)) {
      const def = this.registry.get(s(r["code"]));
      out.push({ id: s(r["id"]), kind: "breached_timer", title: `${s(r["code"])} breached`, ownerRole: def?.severity.escalateTo.find((x) => /officer|attorney|human_agent|operator|reviewer/.test(x)) ?? "compliance", openedAt: s(r["breached_at"] ?? now), severity: def?.severity.level ? `sev-${def.severity.level}` : "unrated", detail: { process: def?.process, breach: def?.breach, due_date: r["due_date"] }, ...(r["loan_id"] ? { loanId: s(r["loan_id"]) } : {}), ...(r["due_at"] ? { dueAt: s(r["due_at"]) } : {}) });
    }
    return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }
  async queue(o: { role?: string; kind?: QueueItem["kind"]; loanId?: string; now: string }): Promise<QueueItem[]> {
    let items = await this.items(o.now, o.loanId);
    if (o.kind) items = items.filter((i) => i.kind === o.kind);
    else if (o.role) { const kinds = queueKindsFor(o.role); items = items.filter((i) => kinds.includes(i.kind) && (i.kind !== "escalation" && i.kind !== "portal_task" || i.ownerRole === o.role || o.role === "auditor" || o.role === "examiner")); }
    return items;
  }
  async searchLoans(q: string, limit = 20): Promise<LoanSummary[]> {
    const like = `%${q.trim()}%`;
    const rows = await this.db.query<Row>(`SELECT id, fnma_loan_number, servicer_loan_number, status, partner_party_id, boarded_at FROM loans WHERE $1 = '%%' OR fnma_loan_number ILIKE $1 OR servicer_loan_number ILIKE $1 OR id::text ILIKE $1 ORDER BY created_at DESC LIMIT $2`, [like, limit]);
    return rows.map((r) => ({ id: s(r["id"]), fnmaLoanNumber: s(r["fnma_loan_number"]).trim(), servicerLoanNumber: s(r["servicer_loan_number"]), status: s(r["status"]), partnerPartyId: s(r["partner_party_id"]), boardedAt: r["boarded_at"] ? s(r["boarded_at"]) : null }));
  }
  async loan(id: string, _now: string): Promise<LoanDetail | undefined> {
    const [l] = await this.db.query<Row>(`SELECT id, fnma_loan_number, servicer_loan_number, status, partner_party_id, boarded_at FROM loans WHERE id::text = $1`, [id]);
    if (!l) return undefined;
    const events = (await this.db.query<Row>(`SELECT id, sequence, type, occurred_at, actor_kind, actor_id, payload FROM loan_events WHERE loan_id = $1 ORDER BY sequence`, [id])).map((r) => ({ id: s(r["id"]), sequence: Number(r["sequence"]), type: s(r["type"]), occurredAt: s(r["occurred_at"]), actor: `${s(r["actor_kind"])}:${s(r["actor_id"])}`, payload: r["payload"] as Row }));
    const balances = (await this.db.query<Row>(`SELECT account, sum(amount_cents)::bigint AS cents FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 GROUP BY account HAVING sum(amount_cents) <> 0 ORDER BY account`, [id])).map((r) => ({ account: s(r["account"]), cents: s(r["cents"]) }));
    const timers = (await this.db.query<Row>(`SELECT id, code, status, due_at, due_date, note FROM timers WHERE loan_id = $1 ORDER BY armed_at`, [id])).map((r) => ({ id: s(r["id"]), code: s(r["code"]), status: s(r["status"]), dueAt: r["due_at"] ? s(r["due_at"]) : undefined, dueDate: r["due_date"] ? s(r["due_date"]) : undefined, note: r["note"] ? s(r["note"]) : undefined }));
    const decisions = (await this.db.query<Row>(`SELECT id, agent, action, rule_code, rationale, confidence, approved_by, approved_role, created_at FROM agent_decisions WHERE loan_id = $1 ORDER BY created_at`, [id])).map((r) => ({ id: s(r["id"]), agent: s(r["agent"]), action: s(r["action"]), ruleCode: r["rule_code"] ? s(r["rule_code"]) : undefined, rationale: s(r["rationale"]), confidence: r["confidence"] === null ? null : Number(r["confidence"]), approvedBy: r["approved_by"] ? s(r["approved_by"]) : undefined, approvedRole: r["approved_role"] ? s(r["approved_role"]) : undefined, createdAt: s(r["created_at"]) }));
    const notices = (await this.db.query<Row>(`SELECT id, template_code, template_version, status, held_reason, produced_at, sent_at FROM notices WHERE loan_id = $1 ORDER BY produced_at`, [id])).map((r) => ({ id: s(r["id"]), template: s(r["template_code"]), version: s(r["template_version"]), status: s(r["status"]), heldReason: r["held_reason"] ? s(r["held_reason"]) : undefined, producedAt: s(r["produced_at"]), sentAt: r["sent_at"] ? s(r["sent_at"]) : undefined }));
    return { id: s(l["id"]), fnmaLoanNumber: s(l["fnma_loan_number"]).trim(), servicerLoanNumber: s(l["servicer_loan_number"]), status: s(l["status"]), partnerPartyId: s(l["partner_party_id"]), boardedAt: l["boarded_at"] ? s(l["boarded_at"]) : null, events, balances, timers, decisions, notices };
  }
  async dashboard(now: string): Promise<Dashboard> {
    const [t] = await this.db.query<Row>(`SELECT count(*) FILTER (WHERE status = 'armed')::int AS armed, count(*) FILTER (WHERE status = 'breached')::int AS breached, count(*) FILTER (WHERE status = 'armed' AND due_at > $1::timestamptz AND due_at <= $1::timestamptz + interval '24 hours')::int AS due24 FROM timers`, [now]);
    const bySev: Record<string, number> = {}, bySec: Record<string, number> = {};
    for (const r of await this.db.query<Row>(`SELECT code, count(*)::int AS c FROM timers WHERE status = 'breached' GROUP BY code`)) { const def = this.registry.get(s(r["code"])); const sev = def?.severity.level ? `sev-${def.severity.level}` : "unrated"; bySev[sev] = (bySev[sev] ?? 0) + Number(r["c"]); const sec = def?.process.split(".")[0] ?? "?"; bySec[sec] = (bySec[sec] ?? 0) + Number(r["c"]); }
    const items = await this.items(now);
    const queues = { escalation: 0, portal_task: 0, held_notice: 0, dead_letter: 0, breached_timer: 0 } as Record<QueueItem["kind"], number>;
    for (const i of items) queues[i.kind]++;
    const [n] = await this.db.query<Row>(`SELECT count(*) FILTER (WHERE status = 'held')::int AS held, count(*) FILTER (WHERE sent_at >= $1::timestamptz - interval '7 days')::int AS sent, count(*) FILTER (WHERE status = 'returned')::int AS returned FROM notices`, [now]);
    const dec = await this.db.query<Row>(`SELECT agent, count(*)::int AS c FROM agent_decisions WHERE created_at >= $1::timestamptz - interval '7 days' GROUP BY agent`, [now]);
    const decBy = new Map(dec.map((r) => [s(r["agent"]), Number(r["c"])]));
    return { asOf: now, timers: { armed: Number(t?.["armed"] ?? 0), breached: Number(t?.["breached"] ?? 0), dueNext24h: Number(t?.["due24"] ?? 0), breachedBySeverity: bySev, breachedBySection: bySec }, queues,
      notices: { held: Number(n?.["held"] ?? 0), sentLast7d: Number(n?.["sent"] ?? 0), returnedLast7d: Number(n?.["returned"] ?? 0) },
      agents: this.agents.agents().map((a) => { const st = this.agents.aiState(a.agent); return { agent: a.agent, off: st.off, why: st.why, tier: st.tier, decisionsLast7d: decBy.get(a.agent) ?? 0 }; }) };
  }
  async completeEscalation(id: string, actor: Actor, evidence: string | null, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [e] = await this.db.query<Row>(`SELECT owner_role, completed_at FROM escalations WHERE id::text = $1`, [id]);
    if (!e) return { ok: false, reason: `no escalation ${id}` };
    if (e["completed_at"]) return { ok: false, reason: "already completed" };
    if (actor.kind !== "human" || actor.role !== s(e["owner_role"])) return { ok: false, reason: `escalation is completed by role ${s(e["owner_role"])}` };
    if (evidence !== null && !isUuid(evidence)) return { ok: false, reason: "evidence must be a stored document id (uuid)" };
    await this.db.query(`UPDATE escalations SET completed_at = $2, completed_evidence_document_id = $3 WHERE id::text = $1`, [id, now, evidence]);
    await this.db.query(`INSERT INTO loan_events (type, loan_id, actor_kind, actor_id, actor_role, payload) SELECT 'escalation.completed', loan_id, 'human', $2, $3, $4::jsonb FROM escalations WHERE id::text = $1`, [id, actor.id, actor.role ?? null, toJson({ escalation_id: id, evidence_document_id: evidence })]);
    return { ok: true };
  }
  async completePortalTask(id: string, actor: Actor, evidence: string | null, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [t] = await this.db.query<Row>(`SELECT owner_role, status FROM human_portal_tasks WHERE id::text = $1`, [id]);
    if (!t) return { ok: false, reason: `no task ${id}` };
    if (s(t["status"]) === "completed") return { ok: false, reason: "already completed" };
    if (actor.kind !== "human" || actor.role !== s(t["owner_role"])) return { ok: false, reason: `task is worked by ${s(t["owner_role"])}` };
    if (evidence !== null && !isUuid(evidence)) return { ok: false, reason: "evidence must be a stored document id (uuid)" };
    await this.db.query(`UPDATE human_portal_tasks SET status = 'completed', completed_at = $2, completed_by = $3, evidence_document_id = $4 WHERE id::text = $1`, [id, now, actor.id, evidence]);
    return { ok: true };
  }
  async releaseHeldNotice(id: string, actor: Actor, replacementId: string, _now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (actor.kind !== "human") return { ok: false, reason: "superseding a held notice is a human act" };
    const [n] = await this.db.query<Row>(`SELECT status FROM notices WHERE id::text = $1`, [id]);
    if (!n || s(n["status"]) !== "held") return { ok: false, reason: `notice ${id} is not held` };
    if (!isUuid(replacementId)) return { ok: false, reason: "replacement must be a notice id (uuid)" };
    await this.db.query(`UPDATE notices SET status = 'superseded', superseded_by = $2 WHERE id::text = $1`, [id, replacementId]);
    return { ok: true };
  }
  async requeueDeadLetter(id: string, actor: Actor, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (actor.kind !== "human") return { ok: false, reason: "requeue is a human act" };
    const rows = await this.db.query<Row>(`UPDATE integration_messages SET status = 'queued', attempts = 0, next_attempt_at = $2, error = NULL WHERE id::text = $1 AND status = 'dead' RETURNING id`, [id, now]);
    return rows.length ? { ok: true } : { ok: false, reason: `message ${id} is not dead-lettered` };
  }
  async setAiOff(agent: string, why: string | null, actor: Actor, _now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (actor.kind !== "human" || !["officer", "compliance", "ciso"].includes(actor.role ?? "")) return { ok: false, reason: "AI-off toggles are set by officer, compliance or ciso" };
    try { this.agents.get(agent); } catch { return { ok: false, reason: `unknown agent ${agent}` }; }
    this.agents.setAiOff(agent, why);
    await this.db.query(`INSERT INTO loan_events (type, actor_kind, actor_id, actor_role, payload) VALUES ($1, 'human', $2, $3, $4::jsonb)`, [why === null ? "agent.ai_path.enabled" : "agent.ai_path.disabled", actor.id, actor.role ?? null, toJson({ agent, why })]);
    return { ok: true };
  }
  async logAccess(e: AccessEntry): Promise<void> {
    await this.db.query(`INSERT INTO access_log (table_name, actor_kind, actor_id, purpose) VALUES ('ops_console', $1, $2, $3)`, [e.actor.kind, e.actor.id, `${e.method} ${e.path}${e.purpose ? ` — ${e.purpose}` : ""}`]);
  }
  /** 32.14 T18: the funnel — one count per stage from `loan_events` alone (no lead row, no UI table), events that occurred in [from, to). */
  async funnel(range: { from: string; to: string }): Promise<Funnel> {
    const rows = await this.db.query<Row>(`SELECT type, count(*)::text AS n FROM loan_events WHERE type = ANY($1::text[]) AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz GROUP BY type`, [[...FUNNEL_STAGES], range.from, range.to]);
    return { from: range.from, to: range.to, stages: funnelRows(new Map(rows.map((r) => [s(r["type"]), Number(r["n"])]))) };
  }
}
