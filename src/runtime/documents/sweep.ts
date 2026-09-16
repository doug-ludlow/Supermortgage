/**
 * §35.2's sweep hook — `documentsSweepPass(runtime, nowIso)`, called by `Runtime.sweep` after 33.1's tape-late pass. Every
 * step is logged and never throws out of the sweep:
 *   1. the staged-blob drain (rule 4: "the staged-blob drain every sweep") — the `worm_pending:` rows grouped by their subject
 *      (a loan, an application, or keyless) and drained through `documents.store{op: drain}` on that subject, so
 *      `document.stored` satisfies the SM_DOC_WORM_DRAIN_1D armed on the same subject (a global unit of work cannot see a
 *      loan's clock);
 *   2. the e-sign envelope expiry: every SM_ESIGN_ENVELOPE_EXPIRY_30 the breach pass marked breached whose envelope is still
 *      open is voided as `expired` on its own subject (the audit trail, `esign.envelope.expired`) with one sev 3 `ops_analyst`
 *      escalation per envelope (the registry parses the breach cell's first word, so the breach pass's own escalation is
 *      owned by `expired` — the hook opens the analyst's unless one is open on the timer already);
 *   3. the print vendor probe: the proof-of-mailing feed is asked once; an unreachable vendor is one global
 *      `mail.vendor.unreachable{at}`, and when the previous sweep found it unreachable too, every outbound vendor manifest
 *      with no inbound row and no in-house sibling gets one sev 3 `ops_analyst` escalation proposing `mail.fallback`
 *      (rule 10: "adapter down two sweeps"; the analyst runs the fallback — the sweep never prints).
 */
import type { Runtime } from "../app.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { EscalationService } from "../../app/escalations.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import { closeEnvelope } from "../../domain/operations-runtime/documents/esign.ts";
import { AdapterUnavailable } from "../../infra/integrations/failures.ts";

export const SYSTEM_DOCUMENTS: Actor = { kind: "system", id: "documents-sweep" };
export const DRAIN_SCOPES_PER_SWEEP = 500;
export const PRINT_MAIL_VENDOR = "print-mail";

export interface DocumentsSweepReport {
  readonly at: string;
  /** rows `document.stored` this pass / rows whose put or re-read failed (attempts counted, `document.drain.failed`) */
  readonly drained: number; readonly drain_failed: number;
  /** subjects (loans, applications, the keyless set) the drain ran on */
  readonly scopes: number;
  readonly envelopes_expired: number;
  readonly mail_vendor_down: boolean;
  readonly fallback_proposed: number;
  /** outbound manifests whose print-mail message 35.1's dispatcher dead-lettered during an outage, put back to queued once the vendor answers again */
  readonly manifests_requeued: number;
  readonly line: string;
}

interface StagedScope extends Record<string, unknown> { loan_id: string | null; application_id: string | null; n: string; }

export async function documentsSweepPass(runtime: Runtime, nowIso: string): Promise<DocumentsSweepReport> {
  let drained = 0, drainFailed = 0, scopes = 0;
  try {
    const groups = await runtime.db.query<StagedScope>(`SELECT loan_id, application_id, count(*)::text AS n FROM documents WHERE storage_status = 'staged' AND storage_uri LIKE 'worm_pending:%' GROUP BY loan_id, application_id ORDER BY min(created_at) LIMIT $1`, [DRAIN_SCOPES_PER_SWEEP]);
    for (const g of groups) {
      scopes++;
      try {
        const r = await runtime.execute({ process: "35.2", name: "documents.store", loanId: g.loan_id ?? "", ...(g.application_id ? { applicationId: g.application_id } : {}), actor: SYSTEM_DOCUMENTS, input: { op: "drain", limit: 200 } });
        const o = r.output as { drained?: number; failed?: number };
        drained += Number(o.drained ?? 0); drainFailed += Number(o.failed ?? 0);
      } catch (e) { drainFailed += Number(g.n); runtime.logger?.error("documents drain failed for a subject", { at: nowIso, loan_id: g.loan_id, application_id: g.application_id, error: e }); }
    }
  } catch (e) { runtime.logger?.error("documents drain pass failed", { at: nowIso, error: e }); }
  let envelopesExpired = 0;
  try { envelopesExpired = await expireEnvelopes(runtime, nowIso); } catch (e) { runtime.logger?.error("envelope expiry pass failed", { at: nowIso, error: e }); }
  let vendor = { down: false, proposed: 0, requeued: 0 };
  try { vendor = await probeMailVendor(runtime, nowIso); } catch (e) { runtime.logger?.error("print vendor probe failed", { at: nowIso, error: e }); }
  const line = `documents: ${drained} drained, ${drainFailed} not yet, over ${scopes} subject(s); ${envelopesExpired} envelope(s) expired; print vendor ${vendor.down ? "unreachable" : "reachable"}, ${vendor.proposed} fallback(s) proposed, ${vendor.requeued} manifest(s) requeued`;
  return { at: nowIso, drained, drain_failed: drainFailed, scopes, envelopes_expired: envelopesExpired, mail_vendor_down: vendor.down, fallback_proposed: vendor.proposed, manifests_requeued: vendor.requeued, line };
}

interface BreachedEnvelope extends Record<string, unknown> { timer_id: string; envelope_id: string; application_id: string | null; loan_id: string | null; }
/** SM_ESIGN_ENVELOPE_EXPIRY_30's breach action: the envelope is voided as `expired`, the owning process is told by event, sev 3 to ops_analyst. */
export async function expireEnvelopes(runtime: Runtime, nowIso: string): Promise<number> {
  const rows = await runtime.db.query<BreachedEnvelope>(`SELECT t.id AS timer_id, e.id AS envelope_id, e.application_id, e.loan_id FROM timers t JOIN loan_events ev ON ev.id = t.armed_by_event_id JOIN esign_envelopes e ON e.id = (ev.payload->>'envelope_id')::uuid WHERE t.code = 'SM_ESIGN_ENVELOPE_EXPIRY_30' AND t.status = 'breached' AND e.status IN ('sent', 'in_progress') ORDER BY t.breached_at, t.id`);
  let expired = 0;
  for (const r of rows) {
    try {
      // one transaction (the sweep's breach-pass precedent): the `expired` signature event, the audit-trail document, the frozen envelope row, `esign.envelope.expired` and the escalation commit together or not at all
      const key = { ...(r.loan_id ? { loanId: r.loan_id } : {}), ...(r.application_id ? { applicationId: r.application_id } : {}) };
      const persisted = await runtime.db.tx(async (q: Queryable) => {
        const events = new MemoryEventStore(runtime.clock, key);
        await closeEnvelope({ q, blobs: runtime.blobs, events, actor: SYSTEM_DOCUMENTS, now: nowIso }, { envelope_id: r.envelope_id, outcome: "expired", reason: "SM_ESIGN_ENVELOPE_EXPIRY_30", timer_id: r.timer_id });
        const escalations = new EscalationService(events, runtime.clock);
        const open = await q.query(`SELECT 1 FROM escalations WHERE sla_timer_id = $1 AND owner_role = 'ops_analyst' AND status = 'open'`, [r.timer_id]);
        if (!open.length) escalations.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", slaTimerId: r.timer_id, ...key, payload: { kind: "envelope_expired", envelope_id: r.envelope_id, timer_id: r.timer_id, timer_code: "SM_ESIGN_ENVELOPE_EXPIRY_30", breach: "the envelope is voided as expired; the owning process is told by event and falls back to mail or re-issues" } }, SYSTEM_DOCUMENTS);
        const saved = await runtime.uow.events.append(events.since(0), q);
        for (const e of escalations.list()) await runtime.escalationRepo.save(e, q);
        return saved;
      });
      runtime.uow.notifyCommitted(persisted);
      expired++;
    } catch (e) { runtime.logger?.error("envelope expiry failed", { at: nowIso, envelope_id: r.envelope_id, error: e }); }
  }
  return expired;
}

/** Rule 10's trigger: the vendor unreachable on two consecutive sweeps → one `mail.fallback` proposal per stuck batch (the analyst decides; the sweep never prints). */
export async function probeMailVendor(runtime: Runtime, nowIso: string): Promise<{ down: boolean; proposed: number; requeued: number }> {
  const pm = runtime.ports.printMail;
  if (!pm?.manifests) return { down: false, proposed: 0, requeued: 0 };
  const latest = (await runtime.db.query<{ type: string }>(`SELECT type FROM loan_events WHERE type IN ('mail.vendor.unreachable', 'mail.vendor.reachable') AND payload->>'at' < $1 ORDER BY sequence DESC LIMIT 1`, [nowIso]))[0]?.type ?? null;
  let down = false;
  try { await pm.manifests(nowIso); } catch (e) { if (!(e instanceof AdapterUnavailable)) throw e; down = true; }
  if (!down) {
    // a recovery after an outage is marked once, so the next outage's first sweep is a first sweep again
    if (latest === "mail.vendor.unreachable") await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "mail.vendor.reachable", aggregate: { kind: "mail_vendor", id: PRINT_MAIL_VENDOR }, actor: SYSTEM_DOCUMENTS, payload: { at: nowIso, adapter: PRINT_MAIL_VENDOR } }), { clock: runtime.clock });
    let requeued = 0;
    try { requeued = await requeueDeadManifests(runtime, nowIso); } catch (e) { runtime.logger?.error("manifest requeue failed", { at: nowIso, error: e }); }
    return { down: false, proposed: 0, requeued };
  }
  const previously = latest === "mail.vendor.unreachable";   // the sweep before this one found it unreachable too (rule 10: "adapter down two sweeps")
  await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "mail.vendor.unreachable", aggregate: { kind: "mail_vendor", id: PRINT_MAIL_VENDOR }, actor: SYSTEM_DOCUMENTS, payload: { at: nowIso, adapter: PRINT_MAIL_VENDOR, consecutive: previously } }), { clock: runtime.clock });
  if (!previously) return { down: true, proposed: 0, requeued: 0 };
  // stuck: no proof of mailing for any piece yet (an inbound file that matched nothing is not proof) and no in-house manifest
  const stuck = await runtime.db.query<{ id: string; notice_batch_id: string }>(`SELECT m.id, m.notice_batch_id FROM mail_manifests m WHERE m.direction = 'outbound' AND m.vendor <> 'in_house' AND m.status = 'submitted' AND m.notice_batch_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM mail_manifests i JOIN mail_manifest_pieces p ON p.manifest_id = i.id WHERE i.notice_batch_id = m.notice_batch_id AND i.direction = 'inbound' AND p.notice_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM mail_manifests h WHERE h.notice_batch_id = m.notice_batch_id AND h.vendor = 'in_house')
    AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.status = 'open' AND e.payload->>'proposal' = 'mail.fallback' AND e.payload->>'batch_id' = m.notice_batch_id::text) ORDER BY m.submitted_at, m.id`);
  let proposed = 0;
  for (const m of stuck) {
    try {
      let escalations: EscalationService | null = null;
      await runtime.uow.run({}, (ctx) => { escalations = new EscalationService(ctx.events, runtime.clock); escalations.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", payload: { proposal: "mail.fallback", batch_id: m.notice_batch_id, manifest_id: m.id, reason: "print vendor unreachable on two consecutive sweeps (35.2 rule 10); run mail.fallback{batch_id} to print and post in house", at: nowIso } }, SYSTEM_DOCUMENTS); },
        { clock: runtime.clock, commit: async (q) => { for (const e of escalations?.list() ?? []) await runtime.escalationRepo.save(e, q); } });
      proposed++;
    } catch (e) { runtime.logger?.error("mail fallback proposal failed", { at: nowIso, batch_id: m.notice_batch_id, error: e }); }
  }
  return { down: true, proposed, requeued: 0 };
}

export const MANIFEST_REQUEUE_CAP = 3;
interface DeadManifestMessage extends Record<string, unknown> { id: string; batch_id: string; manifest_id: string; loan_id: string | null; error: string | null; requeues: string; }
/**
 * 35.1's dispatcher dead-letters a message on `AdapterUnavailable` at its first attempt (the human portal task `print_mail_secondary_vendor`,
 * no retry), so a manifest submitted during a vendor outage shorter than rule 10's two sweeps would wait on a person for a file the
 * vendor can now take. When the probe finds the vendor reachable, every dead `print-mail` manifest message whose batch is still
 * `submitted` (no piece mailed, no in-house manifest) goes back to `queued` — the next drain resubmits the same file under the same
 * idempotency key (the vendor dedupes), `integration.message.sent` then satisfies the dead-letter clock — and the outage's portal
 * task is completed by the sweep since the outage is over. At most MANIFEST_REQUEUE_CAP times per message (a flapping vendor is
 * a person's problem: the task stays open and SM_MAIL_MANIFEST_2BD breaches); a person's own requeue (34.4) is counted separately.
 */
export async function requeueDeadManifests(runtime: Runtime, nowIso: string): Promise<number> {
  const dead = await runtime.db.query<DeadManifestMessage>(`SELECT m.id, m.payload_summary->>'batch_id' AS batch_id, m.payload_summary->>'manifest_id' AS manifest_id, m.loan_id, m.error,
      (SELECT count(*)::text FROM loan_events r WHERE r.type = 'mail.manifest.requeued' AND r.payload->>'message_id' = m.id::text) AS requeues
    FROM integration_messages m JOIN mail_manifests o ON o.id = (m.payload_summary->>'manifest_id')::uuid
    WHERE m.adapter = $1 AND m.status = 'dead' AND o.direction = 'outbound' AND o.vendor <> 'in_house' AND o.status = 'submitted' AND o.notice_batch_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM mail_manifests i JOIN mail_manifest_pieces p ON p.manifest_id = i.id WHERE i.notice_batch_id = o.notice_batch_id AND i.direction = 'inbound' AND p.notice_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM mail_manifests h WHERE h.notice_batch_id = o.notice_batch_id AND h.vendor = 'in_house')
    ORDER BY m.created_at, m.id`, [PRINT_MAIL_VENDOR]);
  let n = 0;
  for (const m of dead) {
    const requeueNo = Number(m.requeues) + 1;
    if (requeueNo > MANIFEST_REQUEUE_CAP) { runtime.logger?.warn("manifest requeue cap reached", { at: nowIso, message_id: m.id, batch_id: m.batch_id, cap: MANIFEST_REQUEUE_CAP }); continue; }
    try {
      await runtime.uow.run({ ...(m.loan_id ? { loanId: m.loan_id } : {}) }, (ctx) => {
        ctx.events.append({ type: "mail.manifest.requeued", ...(m.loan_id ? { loan_id: m.loan_id } : {}), aggregate: { kind: "mail_batch", id: m.batch_id }, actor: SYSTEM_DOCUMENTS, payload: { message_id: m.id, adapter: PRINT_MAIL_VENDOR, batch_id: m.batch_id, manifest_id: m.manifest_id, requeue_no: requeueNo, cap: MANIFEST_REQUEUE_CAP, dead_error: m.error, reason: "print vendor reachable again after the outage that dead-lettered the manifest (35.2 rule 9; 35.1's dispatcher retries nothing on AdapterUnavailable)", at: nowIso } });
      }, { clock: runtime.clock, commit: async (q) => {
        // the same UPDATE 34.4's hand requeue makes (src/runtime/controls/outbox.ts): queued, attempts reset, due now, error cleared — but only while the row is still dead
        const r = await q.query<{ id: string }>(`UPDATE integration_messages SET status = 'queued', attempts = 0, next_attempt_at = $2, error = NULL WHERE id = $1 AND status = 'dead' RETURNING id`, [m.id, nowIso]);
        if (!r.length) throw new Error(`message ${m.id} is no longer dead`);
        await q.query(`UPDATE human_portal_tasks SET status = 'completed', completed_at = $2, completed_by = $3 WHERE integration_message_id = $1 AND status IN ('open', 'in_progress')`, [m.id, nowIso, `${SYSTEM_DOCUMENTS.kind}:${SYSTEM_DOCUMENTS.id}`]);
      } });
      n++;
    } catch (e) { runtime.logger?.error("manifest requeue failed", { at: nowIso, message_id: m.id, batch_id: m.batch_id, error: e }); }
  }
  return n;
}
