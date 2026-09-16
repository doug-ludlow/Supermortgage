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
  let vendor = { down: false, proposed: 0 };
  try { vendor = await probeMailVendor(runtime, nowIso); } catch (e) { runtime.logger?.error("print vendor probe failed", { at: nowIso, error: e }); }
  const line = `documents: ${drained} drained, ${drainFailed} not yet, over ${scopes} subject(s); ${envelopesExpired} envelope(s) expired; print vendor ${vendor.down ? "unreachable" : "reachable"}, ${vendor.proposed} fallback(s) proposed`;
  return { at: nowIso, drained, drain_failed: drainFailed, scopes, envelopes_expired: envelopesExpired, mail_vendor_down: vendor.down, fallback_proposed: vendor.proposed, line };
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
export async function probeMailVendor(runtime: Runtime, nowIso: string): Promise<{ down: boolean; proposed: number }> {
  const pm = runtime.ports.printMail;
  if (!pm?.manifests) return { down: false, proposed: 0 };
  try { await pm.manifests(nowIso); return { down: false, proposed: 0 }; }
  catch (e) { if (!(e instanceof AdapterUnavailable)) throw e; }
  const previously = (await runtime.db.query(`SELECT 1 FROM loan_events WHERE type = 'mail.vendor.unreachable' AND payload->>'at' < $1 LIMIT 1`, [nowIso])).length > 0;
  await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "mail.vendor.unreachable", aggregate: { kind: "mail_vendor", id: PRINT_MAIL_VENDOR }, actor: SYSTEM_DOCUMENTS, payload: { at: nowIso, adapter: PRINT_MAIL_VENDOR, consecutive: previously } }), { clock: runtime.clock });
  if (!previously) return { down: true, proposed: 0 };
  const stuck = await runtime.db.query<{ id: string; notice_batch_id: string }>(`SELECT m.id, m.notice_batch_id FROM mail_manifests m WHERE m.direction = 'outbound' AND m.vendor <> 'in_house' AND m.status = 'submitted' AND m.notice_batch_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM mail_manifests i WHERE i.notice_batch_id = m.notice_batch_id AND i.direction = 'inbound')
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
  return { down: true, proposed };
}
