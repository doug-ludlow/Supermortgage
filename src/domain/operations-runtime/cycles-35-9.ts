/**
 * §35.9 — what this process supplies to 35.3's registry (35.3 rule 2: "A cycle owned by … 35.9 is registered here with its runner
 * name; that process supplies the runner"; 35.9 Inputs and triggers: the cycle units and their receipts). Every runner is a
 * `pass`-shaped unit (cycles.ts Runner): the owner's bus tool through `rt.execute` as the 35.9 agent — its own hosted command,
 * one transaction under 35.1's lease (rule 2), the decision record the tool's own — then 35.3's bookkeeping in the executor's
 * global unit of work (service.ts runClaimed). The `delinquency_counters` runner is runners.ts's (11.1's counter body in
 * `cycles.run_unit`'s command, delinquency.ts delinquencyUnitIn — 35.3 rule 2 assigns it to this process).
 *
 *   docketSyncRunner      `bk_docket_sync_daily` (loan): `docket.sync{loan_id, as_of_date}` — PACER's new entries per open case (rule 6)
 *   draImportRunner       `dra_import_daily` (global): the `law-firm` port's DRA rows for the day, one loan-scoped
 *                         `firm.inbound{kind: dra_snapshot}` per (firm, loan) → 13.6 `dra.snapshot.import` under the loan (rule 8)
 *   caseProgressRunner    `default_case_daily` (loan): `case.progress{loan_id, as_of_date}` — rule 2's steps in order
 *   claimsSweepRunner     `claims_sweep_daily` (loan): `claims.sweep{loan_id, as_of_date}` then `claims.package` per `opened` candidate (rule 9)
 *
 * The units run as `foreclosure-ops` (the 35.9 tools' agent — spec/registry/agents.json's allowlist; the bus refuses another agent):
 * the registry row's `owner_agent` (35.3's table: `bankruptcy-ops` for the docket sync, `claims-reo` for the claims sweep) names
 * the receipt's and the 35.3 decision's actor, as 35.3 rule 8 states; the 35.9 spec names `foreclosure-ops` for the same units —
 * the two tables disagree on those two rows and the runner follows the tool's allowlist.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Runtime } from "../../runtime/app.ts";
import { ENGINE_ACTOR, PROCESS_35_9 } from "./default-35-9.ts";
import { messagePayload, type DispatchRow } from "./default-35-9/firm.ts";
import type { NamedRunner, UnitContext } from "./cycles.ts";

type Row = Record<string, unknown>;
const loanOf = (unit: UnitContext): string => { if (!unit.loan_id) throw new RangeError(`unit ${unit.cycle_code}:${unit.unit_id} carries no loan_id`); return unit.loan_id; };
/** One 35.9 bus tool as the engine's agent with the unit's ids and dates (35.3 rule 8: ids and dates only). */
async function exec(rt: Runtime, name: string, loanId: string, input: Row): Promise<Row> {
  const r = await rt.execute({ process: PROCESS_35_9, name, loanId, actor: ENGINE_ACTOR, input });
  return { ...((r.output ?? {}) as Row), decision_id: r.decisionId ?? null };
}
const unitInput = (unit: UnitContext): Row => ({ loan_id: unit.loan_id, as_of_date: unit.as_of_date, period_key: unit.period_key, run_id: unit.run_id, job_id: unit.job_id });

export const docketSyncRunner: NamedRunner = { name: "docketSyncRunner", runner: { mode: "pass", run: async (rt, unit) => {
  const out = await exec(rt, "docket.sync", loanOf(unit), unitInput(unit));
  return { outcome: out["synced"] === false ? "docket_sync_failed" : `docket_synced_${String((out["applied"] as unknown[] | undefined)?.length ?? 0)}_applied_${String((out["stored"] as unknown[] | undefined)?.length ?? 0)}_stored`, ...out };
} } };

export const caseProgressRunner: NamedRunner = { name: "caseProgressRunner", runner: { mode: "pass", run: async (rt, unit) => {
  const out = await exec(rt, "case.progress", loanOf(unit), unitInput(unit));
  const errors = Array.isArray(out["errors"]) ? (out["errors"] as unknown[]).length : 0;
  return { outcome: errors ? `progressed_with_${errors}_step_error(s)` : "progressed", ...out };
} } };

export const claimsSweepRunner: NamedRunner = { name: "claimsSweepRunner", runner: { mode: "pass", run: async (rt, unit) => {
  const loanId = loanOf(unit);
  const swept = await exec(rt, "claims.sweep", loanId, unitInput(unit));
  const opened = await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM claim_candidates WHERE loan_id = $1::uuid AND status = 'opened' ORDER BY opened_at, id`, [loanId]);
  const packaged: string[] = [];
  for (const c of opened) { await exec(rt, "claims.package", loanId, { candidate_id: c.id, as_of_date: unit.as_of_date, run_id: unit.run_id, job_id: unit.job_id }); packaged.push(c.id); }
  const n = ((swept["opened"] as Row[] | undefined) ?? []).length;
  return { outcome: `claims_swept_${n}_opened_${packaged.length}_packaged`, opened: n, packaged, decision_id: swept["decision_id"] ?? null };
} } };

/** The `law-firm` port's DRA rows for the day: every milestone the port has reported on a delivered referral by `asOf`, grouped by `<firm_id>|<loan_id>` (13.6's snapshot is per firm; its matters, exceptions and prior rows live under the loan, so the import runs loan-scoped). */
export async function draRowsByFirm(rt: Runtime, asOf: PlainDate): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  const port = rt.ports.lawFirm; if (!port) return out;
  const SEL = `id::text AS id, loan_id::text AS loan_id, case_id::text AS case_id, firm_id, kind, owning_event_id::text AS owning_event_id, integration_message_id::text AS integration_message_id, document_id::text AS document_id, sent_at::text AS sent_at, acknowledged_at::text AS acknowledged_at, ack_source, created_at::text AS created_at`;
  const dispatches = await rt.db.query<DispatchRow>(`SELECT ${SEL} FROM firm_dispatches WHERE kind = 'referral_package' AND sent_at IS NOT NULL ORDER BY created_at, id`);
  for (const d of dispatches) {
    const m = await messagePayload(rt.db, d); if (!m) continue;
    const key = `${d.firm_id}|${d.loan_id}`; const rows = out.get(key) ?? [];
    for (const r of port.repliesFor(m, asOf)) {
      if (r.kind === "milestone") rows.push({ loan_id: d.loan_id, event_name: String(r.payload["code"] ?? "").toLowerCase(), event_date: String(r.payload["occurred_on"] ?? r.due_on), entered_by_firm: d.firm_id });
      if (r.kind === "sale") rows.push({ loan_id: d.loan_id, event_name: "sale_scheduled", event_date: String(r.payload["scheduled_on"] ?? r.due_on), entered_by_firm: d.firm_id });
    }
    out.set(key, rows);
  }
  return out;
}
export const draImportRunner: NamedRunner = { name: "draImportRunner", runner: { mode: "pass", run: async (rt, unit) => {
  const asOf = unit.as_of_date;
  const byFirmLoan = await draRowsByFirm(rt, asOf); const imports: Row[] = [];
  // one loan-scoped `firm.inbound{kind: dra_snapshot}` per (firm, loan) → 13.6 `dra.snapshot.import` under the loan, where its matters and exceptions live (rule 6's reconciliation, the `ack_source: dra` edge case)
  for (const [key, rows] of byFirmLoan) {
    const [firmId, loanId] = key.split("|") as [string, string];
    imports.push(await exec(rt, "firm.inbound", loanId, { loan_id: loanId, firm_id: firmId, kind: "dra_snapshot", source: "fake", reply_id: `firm:${firmId}:dra_snapshot:${loanId}:${asOf}`, payload: { id: `dra-${firmId}-${loanId}-${asOf}`, as_of: asOf, source: "portal_export", rows, today: asOf } }));
  }
  const firms = new Set([...byFirmLoan.keys()].map((k) => k.split("|")[0])).size;
  return { outcome: `dra_imported_${imports.length}`, firms, loans: byFirmLoan.size, rows: [...byFirmLoan.values()].reduce((a, r) => a + r.length, 0), imports: imports.length };
} } };

export const RUNNERS_35_9: Readonly<Record<string, NamedRunner>> = { bk_docket_sync_daily: docketSyncRunner, dra_import_daily: draImportRunner, default_case_daily: caseProgressRunner, claims_sweep_daily: claimsSweepRunner };
