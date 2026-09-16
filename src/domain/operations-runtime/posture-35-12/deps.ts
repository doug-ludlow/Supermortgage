/**
 * §35.12 — what every act of the process runs with, on the bus or from the sweep: the runtime (the command view inside a
 * command — 35.1 rule 7), the transaction-bound `db`, the unit of work's event store, the clock and the instant, the actor,
 * the escalations service, `deferWrite` (a row committed with the command's events) and `decide`. `runGlobal` builds the same
 * deps over `rt.uow.run({}, …)` for the sweep's own passes (the FAKE reviewers' and 35.7's precedent) — never inside a command.
 * Also here: the hashed-document writer every artefact of the process uses (a `documents` row with sha-256 over the canonical
 * JSON, `fake-blob://posture/…` storage in every build stage — the blob store is a FAKE, docs/DEPLOY.md §7), the staff-role check
 * (35.7's requireActiveStaff) and the decision-id lookup for a row's `decision_id`.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { Actor, Clock, MemoryEventStore } from "../../../kernel/events/index.ts";
import { EscalationService } from "../../../app/escalations.ts";
import type { DecisionInput } from "../../../infra/db/decisions.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { sha256Hex } from "../../../runtime/controls/common.ts";
import { requireActiveStaff, type StaffActorRow } from "../roles-35-7/actors.ts";
import { decisionIdOf } from "../roles-35-7/grants.ts";
import { PostureRefused } from "./refusals.ts";
import { POSTURE_AGENT, POSTURE_RULE_SET_VERSION, canonicalJson, isUuid, s } from "./types.ts";

export interface PostureDeps {
  readonly runtime: Runtime; readonly db: Queryable; readonly events: MemoryEventStore; readonly clock: Clock; readonly now: string; readonly actor: Actor;
  readonly escalations: EscalationService; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; readonly decide: (d: Omit<DecisionInput, "agent" | "ruleSetVersion"> & Partial<Pick<DecisionInput, "agent" | "ruleSetVersion">>) => void;
}
export const SYSTEM_ACTOR: Actor = { kind: "agent", id: POSTURE_AGENT };

/** The sweep's own unit of work with the process's deps (the rows in the commit hook, the escalations saved, the decisions queued). */
export async function runGlobal<T>(rt: Runtime, actor: Actor, fn: (d: PostureDeps) => Promise<T>, o: { commit?: (q: Queryable) => Promise<void> } = {}): Promise<T> {
  const deferred: ((q: Queryable) => Promise<void>)[] = [];
  let esc: EscalationService | undefined; let out!: T;
  await rt.uow.run({}, async (ctx) => {
    esc = new EscalationService(ctx.events, ctx.clock);
    const d: PostureDeps = { runtime: rt, db: ctx.q ?? rt.db, events: ctx.events, clock: ctx.clock, now: ctx.clock.now(), actor, escalations: esc, deferWrite: (f) => { deferred.push(f); }, decide: (x) => ctx.decide({ agent: POSTURE_AGENT, ruleSetVersion: POSTURE_RULE_SET_VERSION, ...x }) };
    out = await fn(d);
  }, { clock: rt.clock, commit: async (q) => { for (const e of esc?.list() ?? []) await rt.escalationRepo.save(e, q); for (const f of deferred) await f(q); if (o.commit) await o.commit(q); } });
  return out;
}

/** The actor as a verified active staff row holding one of `roles` — 35.7's check; a `ROLE_REQUIRED{role}` refusal otherwise (34.1 rule 3). */
export const requireRole = (d: PostureDeps, roles: readonly string[], what: string, environment: string): Promise<StaffActorRow> => requireActiveStaff(d.db, d.actor, roles, what, environment);
/** A service or agent actor (the deploy workflow's principal, the cycle) or a person holding one of `roles`. */
export async function requireRoleOrService(d: PostureDeps, roles: readonly string[], what: string, environment: string): Promise<{ staff: StaffActorRow | null }> {
  if (d.actor.kind === "system" || d.actor.kind === "agent") return { staff: null };
  return { staff: await requireRole(d, roles, what, environment) };
}
export const personId = (a: Actor): string | null => (a.kind === "human" && isUuid(a.id) ? a.id : null);
export const decisionFor = (q: Queryable, kind: string, id: string): Promise<string | null> => decisionIdOf(q, kind, id);

export interface HashedDocument { readonly id: string; readonly sha256: string; readonly byte_size: number; readonly storage_uri: string }
/** A hashed `documents` row over the canonical JSON of `body` (retention per the spec's artefact class); the id is minted first so events can name it. */
export function hashedDocument(kind: string, body: unknown, id: string = randomUUID()): HashedDocument & { readonly text: string } {
  const text = canonicalJson(body);
  return { id, sha256: sha256Hex(text), byte_size: Buffer.byteLength(text), storage_uri: `fake-blob://posture/${kind}/${id}.json`, text };
}
export async function writeDocument(q: Queryable, doc: HashedDocument, i: { kind: string; retention: "security_logs_5y" | "corporate_7y"; metadata: Record<string, unknown>; created_at: string; loan_id?: string | null }): Promise<void> {
  await q.query(`INSERT INTO documents (id, loan_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'application/json', $7, $8::jsonb, $9::timestamptz)`,
    [doc.id, i.loan_id ?? null, i.kind, doc.sha256, doc.byte_size, doc.storage_uri, i.retention, toJson({ ...i.metadata, blob_store: "fake-blob" }), i.created_at]);
}
export const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): never => { throw new PostureRefused(status, code, message, extra); };
export const str = s;
