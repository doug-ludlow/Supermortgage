/**
 * The evaluation runner (docs/ux/17 §6, DELTA-28): drives a persona through the borrower API — an account through
 * POST /v1/borrower/auth/account, its utterances through POST /v1/borrower/messages, the taps a borrower simulator makes on the
 * cards (POST /v1/borrower/cards/{id}/resolve) — then collects the thread (`messages`), the turn log (`agent_turns`, null when
 * 0119 is not in the database), the events (`loan_events` of the party's subjects), the cards and the record, runs the five checks
 * (checks.ts) and writes one `ai_evaluations` row per suite run {suite_code: "borrower-conversation-v1", dataset_hash, metrics,
 * pass} on the 18.1 tables of db/migrations/0021_qc_audit.sql (an `ai_systems{borrower-conversation}` row and one
 * `ai_system_versions` row per prompt/model pair — `prompt_hash` the sha256 of the prompt text — are ensured first; the run's row
 * becomes the version's `eval_run_id`, the one 32.16 §5 / T23 gate promotion on — docs/ux/17 §3.6 governance). The pass gate is 18.1's
 * aiEvalGateFacts over the personas as mandatory suites.
 *
 * Every instant the checks order by is the database's (`created_at`, DEFAULT now()): the runtime clock behind `messages.at`,
 * `loan_events.occurred_at` and `card_instances.resolved_at` is one instant for the whole run under the harness's FixedClock.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../../../infra/db/index.ts";
import { aiEvalGateFacts } from "../../qc-audit/ops-18-1.ts";
import { allPass, runChecks } from "./checks.ts";
import type { Persona, Step } from "./personas.ts";
import type { CheckResult, EvalCard, EvalCardEvent, EvalEvent, EvalMessage, EvalRecord, EvalTemplate, EvalTurn, Transcript } from "./types.ts";

type P = Record<string, unknown>;
export const SUITE_CODE = "borrower-conversation-v1";
export const AI_SYSTEM_CODE = "borrower-conversation";
export const AI_TIER = "T2_borrower_facing";
export const EVAL_PASSWORD = "correct horse battery staple";

export interface RunnerDeps {
  /** The API's base URL (http://127.0.0.1:port). */
  readonly base: string;
  readonly db: Db;
  /** Wait for the agent's queued turns and the flows' reactions (router.agent.settle + router.flows.settle) — every step awaits it. */
  readonly settle?: (() => Promise<void>) | undefined;
  readonly model: string;
  readonly promptVersion: string;
  /** sha256 of the prompt text the runtime sends (agent/context.ts SYSTEM_PROMPT): `ai_system_versions.prompt_hash`. */
  readonly promptHash: string;
  readonly templates: readonly EvalTemplate[];
  readonly log?: ((line: string, extra?: P) => void) | undefined;
  /** Runs before each persona (the harness swaps the scripted model's scenes to the persona's here). */
  readonly beforePersona?: ((persona: Persona) => void | Promise<void>) | undefined;
  /** 32.17 T14: a `say` step through another surface than POST /v1/borrower/messages (the video agent's chat-completions endpoint); the taps stay the rail's. */
  readonly say?: ((text: string, auth: Record<string, string>, partyId: string) => Promise<void>) | undefined;
}
export interface Account { readonly email: string; readonly password: string }
export interface PersonaMetrics { readonly pass: boolean; readonly checks: Record<string, { pass: boolean; violations: number }>; readonly messages: number; readonly borrower_messages: number; readonly agent_messages: number; readonly model_replies: number; readonly turns: number | null; readonly guard_rejections: number; readonly fallbacks: number; readonly tool_calls: number; readonly resolved_cards: number; readonly events: number; readonly errors: number; readonly skipped: string | null }
export interface PersonaRun { readonly persona_id: string; readonly label: string; readonly party_id: string | null; readonly subjects: readonly { application_id: string | null; loan_id: string | null }[]; readonly checks: readonly CheckResult[]; readonly pass: boolean; readonly metrics: PersonaMetrics; readonly transcript: Transcript; readonly errors: readonly string[] }
export interface SuiteRun { readonly suite_code: string; readonly dataset_hash: string; readonly pass: boolean; readonly runs: readonly PersonaRun[]; readonly metrics: P; readonly evaluation: { id: string; run_at: string; version_id: string } | null }

// ---------------------------------------------------------------- HTTP
type Reply = { status: number; body: P };
/** An error reply's words for the run's error list: the API's code and message, else the body's first 300 characters. */
const describe = (body: P): string => { const code = String(body["code"] ?? ""); const message = String(body["message"] ?? body["error"] ?? body["detail"] ?? ""); return `${code} ${message}`.trim() || JSON.stringify(body).slice(0, 300); };
async function call(base: string, method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let parsed: P = {};
  try { parsed = text ? (JSON.parse(text) as P) : {}; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

// ---------------------------------------------------------------- the dataset hash: the personas as data (regexes by source, a scene's function by its source text)
export function datasetHash(personas: readonly Persona[]): string {
  const fn = (v: unknown): unknown => (typeof v === "function" ? { fn: v.toString() } : v ?? null);
  const canon = personas.map((p) => ({ id: p.id, label: p.label, stage: p.stage, target: { ...p.target, ...("after" in p.target ? { after: p.target.after.source } : {}) }, steps: p.steps, requires: p.requires ?? null,
    scenes: p.scenes.map((s) => ({ when: s.when.source, calls: fn(s.calls ?? []), text: fn(s.text), regenerate: s.regenerate ?? null })) }));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

// ---------------------------------------------------------------- the 18.1 rows (0021): ai_systems{borrower-conversation}, one ai_system_versions row per prompt/model pair, one ai_evaluations row per run
/** The version row for a prompt/model pair: `version` = `<promptVersion>@<model>`, `prompt_hash` = the sha256 of the prompt text (a pair already on file keeps its row). */
export async function ensureAiVersion(db: Db, i: { model: string; promptVersion: string; promptHash: string }): Promise<string> {
  await db.query(`INSERT INTO ai_systems (code, name, kind, purpose, risk_tier, owner_role, consumer_facing, domain, agent_package, sr11_7_model_class, model_version, prompt_version, eval_suite_id) VALUES ($1, 'Borrower conversation', 'agent', 'the borrower thread: the agent turn on the 32.16 bus tools (docs/ux/17)', $2, 'ai_governance_owner', true, 'origination', 'intake', 'llm_agent', $3, $4, $5) ON CONFLICT (code) DO NOTHING`, [AI_SYSTEM_CODE, AI_TIER, i.model, i.promptVersion, SUITE_CODE]);
  const version = `${i.promptVersion}@${i.model}`;
  await db.query(`INSERT INTO ai_system_versions (system_code, version, model_id, prompt_hash, change_kind, status) VALUES ($1, $2, $3, $4, 'new', 'evaluated') ON CONFLICT (system_code, version) DO NOTHING`, [AI_SYSTEM_CODE, version, i.model, i.promptHash]);
  return (await db.query<{ id: string }>(`SELECT id FROM ai_system_versions WHERE system_code = $1 AND version = $2`, [AI_SYSTEM_CODE, version]))[0]!.id;
}
/**
 * The run's `ai_evaluations` row, and the version it evaluated points at it (`ai_system_versions.eval_run_id` — the 0021 FK; 32.16 §5 "per
 * prompt/model pair with eval_run_id", T23's promotion gate reads the row's `pass`); `ai_systems.last_eval_at` follows. `ai_system_versions`
 * is a governance row (status moves evaluated → deployed → …), not an append-only log: the pointer moves to the latest run.
 */
export async function writeEvaluation(db: Db, i: { version_id: string; suite_code: string; dataset_hash: string; metrics: P; pass: boolean }): Promise<{ id: string; run_at: string }> {
  const row = (await db.query<{ id: string; run_at: string }>(`INSERT INTO ai_evaluations (version_id, suite_code, dataset_hash, metrics, pass) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id, run_at::text AS run_at`, [i.version_id, i.suite_code, i.dataset_hash, JSON.stringify(i.metrics), i.pass]))[0]!;
  await db.query(`UPDATE ai_system_versions SET eval_run_id = $2 WHERE id = $1`, [i.version_id, row.id]);
  await db.query(`UPDATE ai_systems SET last_eval_at = (SELECT run_at FROM ai_evaluations WHERE id = $2) WHERE code = (SELECT system_code FROM ai_system_versions WHERE id = $1)`, [i.version_id, row.id]);
  return { id: row.id, run_at: row.run_at };
}
/** True when 0119's `agent_turns` is in the database (the turn builder's migration); the runner reads null turns otherwise. */
export async function agentTurnsAvailable(db: Db): Promise<boolean> {
  return (await db.query<{ t: string | null }>(`SELECT to_regclass('public.agent_turns')::text AS t`))[0]?.t !== null;
}

// ---------------------------------------------------------------- collecting the tables (ordered by the database's instants: the append order, whatever the runtime clock says)
export async function collectTranscript(db: Db, partyId: string, subjects: readonly { application_id: string | null; loan_id: string | null }[], record: EvalRecord | null): Promise<Transcript> {
  const messages = (await db.query<P>(`SELECT m.message_id::text AS message_id, m.sender, m.body_text, m.at::text AS at, m.created_at::text AS created_at, m.card_instance_id::text AS card_instance_id, m.copy_tokens FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.party_id = $1 ORDER BY m.created_at, m.at`, [partyId])) as unknown as EvalMessage[];
  const turns = (await agentTurnsAvailable(db))
    ? ((await db.query<P>(`SELECT turn_id::text AS turn_id, message_id::text AS message_id, reply_message_id::text AS reply_message_id, safe_classification, guard_result, tool_calls, created_at::text AS created_at, model_version, prompt_version FROM agent_turns WHERE party_id = $1 ORDER BY created_at`, [partyId])) as unknown as EvalTurn[])
    : null;
  const apps = subjects.map((s) => s.application_id).filter((x): x is string => !!x); const loans = subjects.map((s) => s.loan_id).filter((x): x is string => !!x);
  const events = (await db.query<P>(`SELECT type, occurred_at::text AS occurred_at, created_at::text AS created_at, payload, application_id::text AS application_id, loan_id::text AS loan_id FROM loan_events WHERE application_id = ANY($1::uuid[]) OR loan_id = ANY($2::uuid[]) OR payload->>'party_id' = $3 ORDER BY sequence`, [apps, loans, partyId])) as unknown as EvalEvent[];
  const cards = (await db.query<P>(`SELECT card_instance_id::text AS card_instance_id, kind, status, copy_key, command_ref, props, evidence, created_at::text AS created_at, resolved_at::text AS resolved_at FROM card_instances WHERE party_id = $1 ORDER BY created_at`, [partyId])) as unknown as EvalCard[];
  const card_events = (await db.query<P>(`SELECT e.card_instance_id::text AS card_instance_id, e.to_status, e.at::text AS at, e.created_at::text AS created_at FROM card_instance_events e JOIN card_instances c ON c.card_instance_id = e.card_instance_id WHERE c.party_id = $1 ORDER BY e.created_at`, [partyId])) as unknown as EvalCardEvent[];
  return { messages: messages.map((m) => ({ ...m, copy_tokens: (m.copy_tokens as P | null) ?? null })), turns: turns ? turns.map((t) => ({ ...t, guard_result: (t.guard_result as P | null) ?? {}, tool_calls: Array.isArray(t.tool_calls) ? t.tool_calls : [] })) : null, events, cards, card_events, record };
}

// ---------------------------------------------------------------- one persona
let ipCounter = 0;
const nextIp = (): string => { ipCounter = (ipCounter + 1) % 60_000; return `10.${7 + Math.floor(ipCounter / 250)}.${ipCounter % 250}.${(ipCounter * 7) % 250 + 1}`; };

export async function runPersona(deps: RunnerDeps, persona: Persona, opts: { account?: Account | undefined } = {}): Promise<PersonaRun> {
  const errors: string[] = []; const log = deps.log ?? (() => undefined);
  await deps.beforePersona?.(persona);   // the persona's own scenes on the scripted model before its first turn (the greeting)
  const ip = nextIp(); const account = opts.account ?? { email: `eval-${persona.id}-${randomUUID().slice(0, 8)}@example.com`, password: EVAL_PASSWORD };
  // the account: create (an e-mail on file for no one opens the session at once), else sign in (a seeded servicing borrower's account)
  let session = await call(deps.base, "POST", "/v1/borrower/auth/account", { action: "create", email: account.email, password: account.password }, { "x-forwarded-for": ip });
  if (session.status === 409 || !session.body["token"]) session = await call(deps.base, "POST", "/v1/borrower/auth/account", { action: "sign_in", email: account.email, password: account.password }, { "x-forwarded-for": ip });
  const token = typeof session.body["token"] === "string" ? (session.body["token"] as string) : null;
  const empty: Transcript = { messages: [], turns: null, events: [], cards: [], record: null };
  if (!token) {
    errors.push(`no session for ${persona.id}: ${session.status} ${JSON.stringify(session.body).slice(0, 200)}`);
    return { persona_id: persona.id, label: persona.label, party_id: null, subjects: [], checks: [], pass: false, metrics: metricsOf(empty, [], errors, "no session"), transcript: empty, errors };
  }
  const auth = { authorization: `Bearer ${token}` };
  const partyId = String((session.body["party"] as P | undefined)?.["party_id"] ?? "");
  await deps.settle?.();
  const me = await call(deps.base, "GET", "/v1/borrower/me", undefined, auth);
  const subjects = (Array.isArray(me.body["subjects"]) ? (me.body["subjects"] as P[]) : []).map((s) => ({ application_id: (s["application_id"] as string | null) ?? null, loan_id: (s["loan_id"] as string | null) ?? null }));
  if (persona.requires === "serviced_loan" && !subjects.some((s) => s.loan_id)) errors.push(`${persona.id} needs a serviced loan on the party; pass a seeded servicing account (EVAL_SERVICING_ACCOUNT=email:password)`);
  log("eval.persona.start", { persona: persona.id, party_id: partyId, subjects: subjects.length });
  // the steps
  for (const step of persona.steps) {
    try { await runStep(deps, step, auth, partyId); }
    catch (e) { errors.push(`${persona.id} step ${JSON.stringify(step).slice(0, 80)}: ${e instanceof Error ? e.message : String(e)}`); }
    await deps.settle?.();
  }
  await deps.settle?.();
  const recordReply = await call(deps.base, "GET", "/v1/borrower/record", undefined, auth);
  const record = recordReply.status === 200 ? (recordReply.body as EvalRecord) : null;
  const transcript = await collectTranscript(deps.db, partyId, subjects, record);
  const checks = runChecks({ transcript, templates: deps.templates, target: persona.target, promptVersion: deps.promptVersion });
  const pass = allPass(checks) && errors.length === 0;
  log("eval.persona.done", { persona: persona.id, pass, checks: Object.fromEntries(checks.map((c) => [c.name, c.pass])), errors: errors.length });
  return { persona_id: persona.id, label: persona.label, party_id: partyId, subjects, checks, pass, metrics: metricsOf(transcript, checks, errors, null), transcript, errors };
}

async function runStep(deps: RunnerDeps, step: Step, auth: Record<string, string>, partyId: string): Promise<void> {
  if ("say" in step) {
    if (deps.say) { await deps.say(step.say, auth, partyId); return; }
    const r = await call(deps.base, "POST", "/v1/borrower/messages", { text: step.say }, auth);
    if (r.status !== 200) throw new Error(`POST /v1/borrower/messages ${r.status} ${describe(r.body)}`);
    return;
  }
  const cards = await deps.db.query<{ card_instance_id: string; copy_key: string; props: P }>(`SELECT card_instance_id::text AS card_instance_id, copy_key, props FROM card_instances WHERE party_id = $1 AND status = 'pending' ORDER BY created_at`, [partyId]);
  const resolveCard = async (card: { card_instance_id: string; copy_key: string }, body: P): Promise<Reply> => {
    const r = await call(deps.base, "POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, body, auth);
    if (r.status !== 200 && r.status !== 201) throw new Error(`resolve ${card.copy_key} ${r.status} ${describe(r.body)}`);
    return r;
  };
  if ("connect" in step) {
    // R3, the FAKE payroll connector as the app drives it: the ConnectCard's tap (verification.connect orders the report), the vendor session, the vendor's webhook with the report
    const card = cards.find((c) => c.copy_key === step.connect.copy_key);
    if (!card) throw new Error(`connect: no pending ConnectCard ${step.connect.copy_key}`);
    // paced as the app is: the tap, then (the flows' reactions to it settled) the vendor session the app opens, then the vendor's callback — the report arrives after the tap's own reactions, never racing them
    await resolveCard(card, { evidence: { vendor: step.connect.vendor, started_at: new Date().toISOString() } }); await deps.settle?.();
    const vs = await call(deps.base, "POST", `/v1/borrower/connect/${step.connect.vendor}/session`, { card_instance_id: card.card_instance_id }, auth);
    if (vs.status !== 200) throw new Error(`connect session ${step.connect.vendor} ${vs.status} ${describe(vs.body)}`); await deps.settle?.();
    const hook = await call(deps.base, "POST", "/v1/webhooks/truv", { type: "voie.report.ready", data: { vendor_session_id: vs.body["vendor_session_id"], report: step.connect.report ?? {} } }, { "x-truv-signature": "FAKE" });
    if (hook.status !== 200) throw new Error(`truv webhook ${hook.status} ${describe(hook.body)}`);
    return;
  }
  if ("confirm" in step) {
    const card = cards.find((c) => c.props["proposal"] && typeof c.props["proposal"] === "object");
    if (!card && step.confirm === "if_proposed") return;   // nothing was read back: the simulator has nothing to tap
    if (!card) throw new Error("confirm: no pending card carries a proposal to confirm");
    const proposal = card.props["proposal"] as P;
    const fields = Array.isArray(proposal["fields"]) ? (proposal["fields"] as P[]).map((f) => ({ path: String(f["path"]), value: String(f["value"]) })) : [];
    await resolveCard(card, { ...(typeof proposal["option_id"] === "string" ? { option_id: proposal["option_id"] } : {}), evidence: { source: "borrower_stated", fields, confirmed_proposal: true } });
    return;
  }
  const card = cards.find((c) => c.copy_key === step.resolve.copy_key);
  if (!card) throw new Error(`resolve: no pending card ${step.resolve.copy_key}`);
  // `as_shown`: the Confirm tap on a ConfirmCard's prefilled fields as the card shows them (each with the source the platform holds), any explicit field an edit
  const shown = step.resolve.as_shown && Array.isArray(card.props["fields"]) ? (card.props["fields"] as P[]).filter((f) => f["value"] !== undefined && f["value"] !== null && String(f["value"]) !== "").map((f) => ({ path: String(f["path"]), value_confirmed: String(f["value"]), source: String(f["source"] ?? "borrower") })) : [];
  const edits = step.resolve.fields ?? [];
  const fields = [...shown.filter((f) => !edits.some((e) => e.path === f.path)), ...edits];
  const evidence: P = step.resolve.as_shown ? { fields, edited: edits.length > 0 } : { source: "borrower", fields };
  await resolveCard(card, { ...(step.resolve.option_id ? { option_id: step.resolve.option_id } : {}), evidence });
}

function metricsOf(t: Transcript, checks: readonly CheckResult[], errors: readonly string[], skipped: string | null): PersonaMetrics {
  const turns = t.turns;
  return {
    pass: checks.length > 0 && allPass(checks) && errors.length === 0,
    checks: Object.fromEntries(checks.map((c) => [c.name, { pass: c.pass, violations: c.violations.length }])),
    messages: t.messages.length, borrower_messages: t.messages.filter((m) => m.sender === "borrower").length, agent_messages: t.messages.filter((m) => m.sender === "agent").length,
    model_replies: t.messages.filter((m) => m.sender === "agent" && m.body_text !== null && !/^\s*\{\{copy:/.test(m.body_text)).length,
    turns: turns ? turns.length : null, guard_rejections: turns ? turns.filter((x) => x.reply_message_id === null).length : 0, fallbacks: turns ? turns.filter((x) => x.reply_message_id !== null && x.guard_result["fallback"] === "default_copy").length : 0,
    tool_calls: turns ? turns.reduce((n, x) => n + x.tool_calls.length, 0) : 0, resolved_cards: t.cards.filter((c) => c.status === "resolved").length, events: t.events.length, errors: errors.length, skipped,
  };
}

// ---------------------------------------------------------------- the suite: every persona, one ai_evaluations row
export async function runSuite(deps: RunnerDeps, personas: readonly Persona[], opts: { suite_code?: string; write?: boolean; accounts?: Readonly<Record<string, Account>> } = {}): Promise<SuiteRun> {
  const suite_code = opts.suite_code ?? SUITE_CODE; const dataset_hash = datasetHash(personas);
  const runs: PersonaRun[] = [];
  for (const p of personas) runs.push(await runPersona(deps, p, { account: opts.accounts?.[p.id] }));
  const gate = aiEvalGateFacts({ tier: AI_TIER, suites: runs.map((r) => ({ suite_code: `${suite_code}:${r.persona_id}`, mandatory: true, pass: r.pass })), approved_by: null });
  const pass = gate.failed_mandatory.length === 0;
  const metrics: P = {
    suite_code, model: deps.model, prompt_version: deps.promptVersion, personas: runs.length, passed: runs.filter((r) => r.pass).length, failed: gate.failed_mandatory,
    gate: { open: gate.open, approval_required: gate.approval_required, reason: gate.reason },
    by_persona: Object.fromEntries(runs.map((r) => [r.persona_id, { ...r.metrics, violations: Object.fromEntries(r.checks.map((c) => [c.name, c.violations.slice(0, 5)])), errors: r.errors.slice(0, 5) }])),
    totals: { messages: runs.reduce((n, r) => n + r.metrics.messages, 0), model_replies: runs.reduce((n, r) => n + r.metrics.model_replies, 0), guard_rejections: runs.reduce((n, r) => n + r.metrics.guard_rejections, 0), fallbacks: runs.reduce((n, r) => n + r.metrics.fallbacks, 0), tool_calls: runs.reduce((n, r) => n + r.metrics.tool_calls, 0), resolved_cards: runs.reduce((n, r) => n + r.metrics.resolved_cards, 0) },
  };
  let evaluation: SuiteRun["evaluation"] = null;
  if (opts.write !== false) { const version_id = await ensureAiVersion(deps.db, { model: deps.model, promptVersion: deps.promptVersion, promptHash: deps.promptHash }); const row = await writeEvaluation(deps.db, { version_id, suite_code, dataset_hash, metrics, pass }); evaluation = { ...row, version_id }; }
  return { suite_code, dataset_hash, pass, runs, metrics, evaluation };
}
