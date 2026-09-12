/**
 * FAKE reviewers — DELTA-30 (docs/ux/BACKEND-DELTAS.md; docs/ux/17 §1 principle 9: "Every human is a FAKE that
 * approves, until a real one is hired"). Under INTEGRATIONS=fake every human role a borrower journey waits on is filled
 * by a FAKE that approves after a short delay, through the SAME bus tools the journey fixture and a person in the ops
 * console use, as the actor `{ kind: "human", id: "FAKE:<role>", role }` — so every event, decision row and escalation
 * receipt says FAKE. Queues, roles, guardrails and decision rows are unchanged; only who fills them.
 *
 *   mlo_of_record          the terms review (20.3 rule 7 / 32.14 S4 / 32.11 §2): `SM_MLO_PREAPP_TERMS_REVIEW_1BH` armed →
 *                          `20.3 requestQuote{op=review, outcome=approved}` (what src/domain/borrower/32-11.spec.test.ts
 *                          `mloApproves` and 32-14's S4 do); the 21.1 application-stage package → `21.1 openEscalation{op=decide}`
 *   underwriting_reviewer  21.6's adverse-decision review → `21.6 openReviewerEscalation{op=decide, outcome=approved}`; any
 *                          other 23.x reviewer work item → `23.3 openEscalation{op=complete}`
 *   qc_officer             the prefunding hold (`SM_QC_PREFUNDING_HOLD`): a `qc_reviews` row selected/in review →
 *                          `28.1 openReview` then `28.1 closeReview{outcome=no_defect}` (the 32.6-T12 path), as the qc_officer
 *                          identity 28.1's independence check accepts
 *   funding_approver       26.3's dual-control wire release → `26.3 prepareWire{op=release}` (the journey's APPROVER step)
 *   human_agent            the person a transfer reaches: a lead's interaction → `20.3 deliverDisclosure{op=human_joined}`
 *                          (`human.transfer.completed` → the PersonCard, 32.13 T-X-08); a serviced loan's / an application's
 *                          4.3 or 32.2 transfer → `4.3 human.transfer{op=complete}` (`escalation.completed{kind=human_agent}`)
 *   signing_officer, …     any other open escalation a FAKE role owns and no tool closes → the console's own completion
 *                          (PgConsoleStore.completeEscalation — the route a person takes from the queue)
 *
 * Every approval carries the FAKE marker where the borrower or the console can see it: the review id `FAKE-MR-…`, the
 * person's name "FAKE reviewer", the actor id on every event, `notes`/`rationale` prefixed "FAKE reviewer", and the
 * console queue row of a pending item whose owner is a FAKE role (PgConsoleStore is built over the runtime's reviewers).
 *
 *   FAKE_REVIEWERS=off          disables every filler (the queue is left to a person)
 *   FAKE_REVIEWER_DELAY_S=20    the delay before a pending item is approved (default 20 s — long enough to see the wait)
 *
 * Runs from the sweep (src/runtime/app.ts Runtime.sweep, every minute in nonprod): `tick(rt, now)` approves every pending
 * item older than the delay, idempotently — an item already decided is skipped by its own record (the review event, the
 * wire status, the escalation's completion), never by memory.
 */
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { Logger } from "../../runtime/log.ts";
import { PgConsoleStore } from "../../console/pg-store.ts";
import { decodeEntityData } from "../db/entities.ts";

export const FAKE_REVIEWER_ROLES: readonly string[] = ["mlo_of_record", "underwriting_reviewer", "qc_officer", "signing_officer", "funding_approver", "human_agent"];
export const FAKE_REVIEWER_DELAY_S_DEFAULT = 20;
export const FAKE_REVIEWER_NAME = "FAKE reviewer";
export const FAKE_HUMAN_AGENT_NAME = "FAKE reviewer (Supermortgage)";
export const TERMS_REVIEW_TIMER = "SM_MLO_PREAPP_TERMS_REVIEW_1BH";
export const fakeReviewNote = (delayS: number): string => `${FAKE_REVIEWER_NAME}: approved automatically after ${delayS}s (INTEGRATIONS=fake, DELTA-30; FAKE_REVIEWERS=off leaves it to a person)`;

type Row = Record<string, unknown>;
type Scope = { loan_id: string | null; application_id: string | null };
export interface FakeReviewerAction { readonly kind: string; readonly role: string; readonly ref: string; readonly tool: string; readonly scope: Scope; readonly outcome: "approved" | "left_open" | "failed"; readonly detail?: string }
export interface FakeReviewerReport { readonly at: string; readonly delay_s: number; readonly cutoff: string; readonly pending: number; readonly actions: readonly FakeReviewerAction[]; readonly line: string }
export interface FakeReviewerOptions { readonly delaySeconds?: number; readonly roles?: readonly string[]; readonly logger?: Logger | undefined }

/** The roles the environment's FAKE reviewers fill (empty when FAKE_REVIEWERS=off) — the console marks their pending queue rows. */
export function fakeReviewerRolesFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  if ((env["FAKE_REVIEWERS"] ?? "").trim().toLowerCase() === "off") return [];
  if ((env["INTEGRATIONS"] ?? "fake") !== "fake") return [];
  return FAKE_REVIEWER_ROLES;
}
export function fakeReviewerDelayFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env["FAKE_REVIEWER_DELAY_S"] ?? FAKE_REVIEWER_DELAY_S_DEFAULT);
  return Number.isFinite(n) && n >= 0 ? n : FAKE_REVIEWER_DELAY_S_DEFAULT;
}
/** The environment's FAKE reviewers, or null when they are off (FAKE_REVIEWERS=off, or INTEGRATIONS other than fake). */
export function fakeReviewersFromEnv(env: NodeJS.ProcessEnv = process.env, logger?: Logger): FakeReviewers | null {
  const roles = fakeReviewerRolesFromEnv(env);
  return roles.length ? new FakeReviewers({ delaySeconds: fakeReviewerDelayFromEnv(env), roles, logger }) : null;
}

const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export class FakeReviewers {
  readonly vendorName = "FAKE" as const;
  readonly delaySeconds: number;
  readonly roles: readonly string[];
  private readonly logger: Logger | undefined;
  constructor(opts: FakeReviewerOptions = {}) { this.delaySeconds = opts.delaySeconds ?? FAKE_REVIEWER_DELAY_S_DEFAULT; this.roles = opts.roles ?? FAKE_REVIEWER_ROLES; this.logger = opts.logger; }
  /** The FAKE person filling a role: a human actor whose id says so on every row it writes. */
  actor(role: string): Actor { return { kind: "human", id: `FAKE:${role}`, role }; }
  fills(role: string): boolean { return this.roles.includes(role); }

  /** One pass: every pending item older than the delay is approved through its owning process's tool. Never throws — a refused item is reported, not retried in a loop. */
  async tick(rt: Runtime, nowIso: string = rt.clock.now()): Promise<FakeReviewerReport> {
    const cutoff = new Date(Date.parse(nowIso) - this.delaySeconds * 1000).toISOString();
    const actions: FakeReviewerAction[] = [];
    let pending = 0;
    const run = async (a: Omit<FakeReviewerAction, "outcome" | "detail">, fn: () => Promise<string | undefined>): Promise<void> => {
      pending += 1;
      try { const detail = await fn(); actions.push({ ...a, outcome: "approved", ...(detail ? { detail } : {}) }); }
      catch (e) { const msg = e instanceof Error ? e.message : String(e); actions.push({ ...a, outcome: "failed", detail: msg }); this.logger?.warn("fake reviewer refused", { ...a, error: msg }); }
    };
    if (this.fills("mlo_of_record")) await this.termsReviews(rt, nowIso, cutoff, run);
    if (this.fills("qc_officer")) await this.prefundingHolds(rt, nowIso, cutoff, run);
    await this.escalations(rt, nowIso, cutoff, run, actions);
    const approved = actions.filter((a) => a.outcome === "approved").length;
    const line = `FAKE reviewers ${nowIso}: pending=${pending} approved=${approved} left_open=${actions.filter((a) => a.outcome === "left_open").length} failed=${actions.filter((a) => a.outcome === "failed").length} delay_s=${this.delaySeconds}${approved ? ` [${actions.filter((a) => a.outcome === "approved").map((a) => `${a.kind}:${a.ref.slice(0, 24)}`).join(" ")}]` : ""}`;
    if (pending) this.logger?.info("fake reviewers", { at: nowIso, delay_s: this.delaySeconds, pending, approved, actions, line });
    return { at: nowIso, delay_s: this.delaySeconds, cutoff, pending, actions, line };
  }

  // ---- the MLO of record's terms review: 20.3's `terms.presentation.requested{quote_id, lead_id}` (the event that arms SM_MLO_PREAPP_TERMS_REVIEW_1BH on the lead's loan or application) with no `mlo.review.completed` for the quote yet
  private async termsReviews(rt: Runtime, nowIso: string, cutoff: string, run: (a: Omit<FakeReviewerAction, "outcome" | "detail">, fn: () => Promise<string | undefined>) => Promise<void>): Promise<void> {
    const rows = await rt.db.query<Row>(
      `SELECT DISTINCT ON (e.payload->>'quote_id') e.payload->>'quote_id' AS quote_id, e.loan_id, e.application_id, e.payload
         FROM loan_events e
        WHERE e.type = 'terms.presentation.requested' AND e.occurred_at <= $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM loan_events r WHERE r.type = 'mlo.review.completed' AND r.payload->>'quote_id' = e.payload->>'quote_id')
        ORDER BY e.payload->>'quote_id', e.sequence DESC`, [cutoff]);
    for (const r of rows) {
      const quoteId = String(r["quote_id"]); const p = (r["payload"] as Row) ?? {}; const leadId = s(p["lead_id"]); const scope: Scope = { loan_id: s(r["loan_id"]), application_id: s(r["application_id"]) };
      if (!leadId) { continue; }
      await run({ kind: "terms_review", role: "mlo_of_record", ref: quoteId, tool: "20.3 requestQuote{op=review}", scope }, async () => {
        const out = await rt.execute({ process: "20.3", name: "requestQuote", loanId: scope.loan_id ?? "", ...(scope.application_id ? { applicationId: scope.application_id } : {}), actor: this.actor("mlo_of_record"),
          input: { op: "review", lead_id: leadId, quote_id: quoteId, review_id: `FAKE-MR-${quoteId}`.slice(0, 200), outcome: "approved", notes: fakeReviewNote(this.delaySeconds), at: nowIso } });
        return `review ${String((out.output as Row)["review"] && ((out.output as Row)["review"] as Row)["review_id"])} approved`;
      });
    }
  }

  // ---- the prefunding QC hold: a selected review is opened and closed no_defect by the qc_officer identity (28.1 independence: never a production agent)
  private async prefundingHolds(rt: Runtime, nowIso: string, cutoff: string, run: (a: Omit<FakeReviewerAction, "outcome" | "detail">, fn: () => Promise<string | undefined>) => Promise<void>): Promise<void> {
    const rows = await rt.db.query<Row>(`SELECT id, data, updated_at FROM entity_current WHERE kind = 'qc_reviews' AND updated_at <= $1::timestamptz ORDER BY updated_at`, [cutoff]);
    for (const r of rows) {
      const d = decodeEntityData(r["data"]) as Row; if (d["kind"] !== "prefunding" || !["selected", "in_review"].includes(String(d["status"]))) continue;
      const reviewId = String(d["review_id"] ?? r["id"]); const appId = s(d["application_id"]); if (!appId) continue;
      await run({ kind: "qc_prefunding_hold", role: "qc_officer", ref: reviewId, tool: "28.1 openReview + closeReview{no_defect}", scope: { loan_id: null, application_id: appId } }, async () => {
        const actor = this.actor("qc_officer");
        if (d["status"] === "selected") await rt.execute({ process: "28.1", name: "openReview", loanId: "", applicationId: appId, actor, input: { review_id: reviewId, run: { run_id: `FAKE-qc-${reviewId}`.slice(0, 200), model_version: FAKE_REVIEWER_NAME, prompt_version: "DELTA-30" }, application_agent_runs: [] } });
        await rt.execute({ process: "28.1", name: "closeReview", loanId: "", applicationId: appId, actor, input: { review_id: reviewId, outcome: "no_defect", rationale: fakeReviewNote(this.delaySeconds) } });
        return "hold released (no_defect)";
      });
    }
  }

  // ---- open escalations a FAKE role owns
  private async escalations(rt: Runtime, nowIso: string, cutoff: string, run: (a: Omit<FakeReviewerAction, "outcome" | "detail">, fn: () => Promise<string | undefined>) => Promise<void>, actions: FakeReviewerAction[]): Promise<void> {
    const rows = await rt.db.query<Row>(`SELECT id, kind, owner_role, loan_id, application_id, payload, opened_at FROM escalations WHERE completed_at IS NULL AND owner_role = ANY($1::text[]) AND opened_at <= $2::timestamptz ORDER BY opened_at`, [[...this.roles], cutoff]);
    for (const r of rows) {
      const id = String(r["id"]); const role = String(r["owner_role"]); const kind = String(r["kind"]); const p = (r["payload"] as Row) ?? {}; const scope: Scope = { loan_id: s(r["loan_id"]), application_id: s(r["application_id"]) };
      const actor = this.actor(role);
      const exec = (process: string, name: string, input: Record<string, unknown>) => rt.execute({ process, name, loanId: scope.loan_id ?? "", ...(scope.application_id ? { applicationId: scope.application_id } : {}), actor, input });
      const leadId = s(p["lead_id"]); const interactionId = s(p["interaction_id"]);
      if ((role === "human_agent" || role === "mlo_of_record") && leadId && interactionId) {
        // 20.3: the person joins the interaction — `human.transfer.completed` (the PersonCard) and the escalation closes under the joiner's own role
        const joined = await rt.db.query<Row>(`SELECT 1 FROM loan_events WHERE type = 'human.transfer.completed' AND payload->>'interaction_id' = $1 LIMIT 1`, [interactionId]);
        if (joined.length) { await this.closeViaConsole(rt, nowIso, id, actor, actions, { kind: "human_transfer", role, ref: id, tool: "console completion (joined earlier)", scope }); continue; }
        await run({ kind: "human_transfer", role, ref: id, tool: "20.3 deliverDisclosure{op=human_joined}", scope }, async () => {
          const out = await exec("20.3", "deliverDisclosure", { op: "human_joined", lead_id: leadId, interaction_id: interactionId, human_agent_id: actor.id, human_agent_name: FAKE_HUMAN_AGENT_NAME, escalation_id: id, at: nowIso });
          const closed = (out.output as Row)["escalation_completed"] === true;
          if (!closed) await this.closeViaConsole(rt, nowIso, id, actor, actions, { kind: "human_transfer", role, ref: id, tool: "console completion (lead in global scope)", scope });
          return `joined interaction ${interactionId}`;
        });
        continue;
      }
      if (role === "human_agent") { await run({ kind: "human_transfer", role, ref: id, tool: "4.3 human.transfer{op=complete}", scope }, async () => { await exec("4.3", "human.transfer", { op: "complete", escalation_id: id, human_agent_name: FAKE_HUMAN_AGENT_NAME }); return "escalation completed"; }); continue; }
      if (role === "mlo_of_record" && s(p["stage"]) && scope.application_id) { await run({ kind: "mlo_stage_review", role, ref: id, tool: "21.1 openEscalation{op=decide}", scope }, async () => { await exec("21.1", "openEscalation", { op: "decide", escalation_id: id, decision: "approved", notes: fakeReviewNote(this.delaySeconds) }); return "stage review approved"; }); continue; }
      if (role === "underwriting_reviewer" && s(p["decision_id"]) && scope.application_id) {
        await run({ kind: "underwriting_review", role, ref: id, tool: "21.6 openReviewerEscalation{op=decide} | 23.3 openEscalation{op=complete}", scope }, async () => {
          try { await exec("21.6", "openReviewerEscalation", { op: "decide", decision_id: s(p["decision_id"]), outcome: "approved", notes: fakeReviewNote(this.delaySeconds) }); return "decision review approved (21.6)"; }
          catch { await exec("23.3", "openEscalation", { op: "complete", escalation_id: id }); return "work item completed (23.3)"; }
        });
        continue;
      }
      if (role === "funding_approver" && s(p["wire_id"]) && s(p["funding_id"]) && scope.application_id) {
        const wire = await rt.db.query<Row>(`SELECT data FROM entity_current WHERE kind = 'funding_wires' AND id = $1`, [s(p["wire_id"])!]);
        const status = wire[0] ? String((decodeEntityData(wire[0]["data"]) as Row)["status"] ?? "") : "";
        if (wire[0] && !["prepared", "pending_release", "checks_passed"].includes(status)) { await this.closeViaConsole(rt, nowIso, id, actor, actions, { kind: "wire_release", role, ref: id, tool: `console completion (wire ${status})`, scope }); continue; }
        await run({ kind: "wire_release", role, ref: id, tool: "26.3 prepareWire{op=release}", scope }, async () => {
          await exec("26.3", "prepareWire", { funding_id: s(p["funding_id"]), op: "release", wire_id: s(p["wire_id"]), bank_ref: `FAKE-${String(s(p["wire_id"])).slice(0, 40)}`, released_at: nowIso });
          await this.closeViaConsole(rt, nowIso, id, actor, actions, { kind: "wire_release", role, ref: id, tool: "console completion (after release)", scope });
          return "wire released (dual control, FAKE approver)";
        });
        continue;
      }
      if (kind === "sev1" || kind === "sev2" || kind === "sev3" || kind === "sev4") { actions.push({ kind: "breach_escalation", role, ref: id, tool: "—", scope, outcome: "left_open", detail: "a timer breach is a person's finding, never auto-closed" }); continue; }
      await this.closeViaConsole(rt, nowIso, id, actor, actions, { kind: `escalation:${kind}`, role, ref: id, tool: "console completion (no closing tool in the owning process)", scope });
    }
  }
  /** The route a person takes from the ops queue (POST /api/escalations/complete → PgConsoleStore.completeEscalation): role-checked, an `escalation.completed` row on the loan's log. */
  private async closeViaConsole(rt: Runtime, nowIso: string, id: string, actor: Actor, actions: FakeReviewerAction[], a: Omit<FakeReviewerAction, "outcome" | "detail">): Promise<void> {
    const store = new PgConsoleStore(rt.db, rt.registry, rt.agents);
    const r = await store.completeEscalation(id, actor, null, nowIso);
    actions.push(r.ok ? { ...a, outcome: "approved", detail: "completed from the queue" } : { ...a, outcome: "failed", detail: r.reason });
  }
}
