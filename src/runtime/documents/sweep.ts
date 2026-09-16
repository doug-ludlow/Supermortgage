/**
 * §35.2's sweep hook — `documentsSweepPass(runtime, nowIso)`, called by `Runtime.sweep` after 33.1's tape-late pass. Every
 * step is logged and never throws out of the sweep:
 *   1. the staged-blob drain (rule 4: "the staged-blob drain every sweep") — the `worm_pending:` rows grouped by their subject
 *      (a loan, an application, or keyless) and drained through `documents.store{op: drain}` on that subject, so
 *      `document.stored` satisfies the SM_DOC_WORM_DRAIN_1D armed on the same subject (a global unit of work cannot see a
 *      loan's clock);
 *   2. the e-sign envelope expiry (SM_ESIGN_ENVELOPE_EXPIRY_30's breach action) and 3. the print vendor probe — added with
 *      the e-sign and mail commit groups (they report zero until then).
 */
import type { Runtime } from "../app.ts";
import type { Actor } from "../../kernel/events/index.ts";

export const SYSTEM_DOCUMENTS: Actor = { kind: "system", id: "documents-sweep" };
export const DRAIN_SCOPES_PER_SWEEP = 500;

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
  const line = `documents: ${drained} drained, ${drainFailed} not yet, over ${scopes} subject(s)`;
  return { at: nowIso, drained, drain_failed: drainFailed, scopes, envelopes_expired: 0, mail_vendor_down: false, fallback_proposed: 0, line };
}
