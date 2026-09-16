/**
 * §35.8 rule 10 — the daily reconciliation of the action log (`work.log.recon{as_of_date}`): every `work_actions` row of
 * the day is checked — an `executed` row has its `staff_actions` row (the console's, keyed to the act by
 * subject_kind = work_action), its `agent_decisions` row and its `command_event_id`; a `refused` row has its `staff_actions`
 * row and no event; every `derivation_id` resolves to a stored document whose sha-256 equals `input_sha256` (35.2's
 * `documents.verify`); every current `work_screen_versions` row still matches the registry now loaded (a mismatch is a
 * stale screen) and, for a row whose `staff_actions` row exists, fills `staff_action_id` once (0201). The run also counts the day's `sole_officer_money_acts` — executed money-field actions with no
 * `approval_of`, an officer acting alone under rule 5 (34.1 rule 6's access review lists them for the quarter). One
 * `work_log_recon_runs` row, a report document, `work.log.recon.run_completed{…}` (SM_WORK_LOG_RECON_DAILY's satisfier and
 * re-trigger on the global subject) and, when orphans or stale screens > 0, a sev 3 `compliance` escalation with the report.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { Actor, EventStore } from "../../../kernel/events/index.ts";
import type { EscalationService } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { currentScreens, isStale, snapshotAction } from "./registry.ts";
import { SCREENS } from "./screens.ts";
import { canonicalJson } from "../../../app/canonical.ts";
import { portsOf, type WorkPorts } from "./ports.ts";
import * as ev from "./events.ts";
import { RECON_DOCUMENT_KIND, type Row } from "./types.ts";

export interface ReconDeps { readonly rt: Runtime; readonly q: Queryable; readonly events: EventStore; readonly now: string; readonly actor: Actor; readonly escalations: EscalationService; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; readonly ports?: WorkPorts }
export interface ReconResult { readonly run_id: string; readonly as_of_date: string; readonly actions_checked: number; readonly orphans: number; readonly orphan_action_ids: readonly string[]; readonly orphan_details: readonly { action_id: string; why: string }[]; readonly stale_screens: number; readonly stale_codes: readonly string[]; readonly sole_officer_money_acts: number; readonly report_document_id: string; readonly escalation_id: string | null; readonly outcome: "completed" }

export async function logRecon(d: ReconDeps, i: { as_of_date: string }): Promise<ReconResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.as_of_date)) throw new RangeError("as_of_date is a date (YYYY-MM-DD)");
  const ports = portsOf(d.ports);
  const rows = await d.q.query<Row>(`SELECT id::text AS id, status, screen_code, screen_version, action_code, derivation_id::text AS derivation_id, command_event_id::text AS command_event_id, agent_decision_id::text AS agent_decision_id, approval_of::text AS approval_of, staff_action_id::text AS staff_action_id, role, actor_id FROM work_actions WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1::date ORDER BY created_at, id`, [i.as_of_date]);
  const orphans: { action_id: string; why: string }[] = [];
  const versions = await currentScreens(d.q);
  const moneyOf = (code: string, version: number, action: string): boolean => { const v = versions.find((x) => x.code === code); const a = (v && v.version === version ? v : null)?.actions.find((x) => x.code === action); return a?.money === true; };
  let soleOfficer = 0; let linked = 0;
  for (const r of rows) {
    const id = String(r["id"]); const status = String(r["status"]);
    // the console keys the request's row to the act (routes.ts: the answer's action_id); an approved proposal's executed row has no request of its own — it is the decide request's, keyed to the proposal (approval_of) by the decide route, the later of the two rows the proposal id carries (the propose request's is the proposal's own)
    let staffRows = await d.q.query<{ id: string }>(`SELECT id::text AS id FROM staff_actions WHERE subject_kind = 'work_action' AND subject_id = $1 ORDER BY at LIMIT 1`, [id]);
    if (!staffRows.length && r["approval_of"]) staffRows = await d.q.query<{ id: string }>(`SELECT id::text AS id FROM staff_actions WHERE subject_kind = 'work_action' AND subject_id = $1 AND route LIKE '%/decide' ORDER BY at DESC LIMIT 1`, [String(r["approval_of"])]);
    const hasStaff = staffRows.length > 0;
    // the link the act could not carry at insert (the console's row lands after the answer): filled once, here (0201 admits NULL → value)
    if (hasStaff && !r["staff_action_id"]) { const said = staffRows[0]!.id; d.deferWrite(async (q) => { await q.query(`UPDATE work_actions SET staff_action_id = $2 WHERE id = $1 AND staff_action_id IS NULL`, [id, said]); }); linked += 1; }
    if (status === "executed") {
      if (!hasStaff) orphans.push({ action_id: id, why: "no staff_actions row" });
      if (!r["agent_decision_id"]) orphans.push({ action_id: id, why: "no agent_decisions row" });
      else { const [dec] = await d.q.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_decisions WHERE id = $1`, [r["agent_decision_id"]]); if (Number(dec?.n ?? 0) === 0) orphans.push({ action_id: id, why: "agent_decisions row missing" }); }
      if (!r["command_event_id"]) orphans.push({ action_id: id, why: "no command_event_id" });
      if (moneyOf(String(r["screen_code"]), Number(r["screen_version"]), String(r["action_code"])) && !r["approval_of"]) soleOfficer += 1;
    } else if (status === "refused" || status === "error") {
      if (!hasStaff) orphans.push({ action_id: id, why: "no staff_actions row" });
      if (r["command_event_id"]) orphans.push({ action_id: id, why: "a refused act has an event" });
    }
    if (r["derivation_id"]) {
      const [dv] = await d.q.query<{ document_id: string | null; input_sha256: string }>(`SELECT document_id::text AS document_id, input_sha256 FROM work_derivations WHERE id = $1`, [r["derivation_id"]]);
      if (!dv?.document_id) orphans.push({ action_id: id, why: "derivation without a document" });
      else { const v = await ports.documents.verify(d.q, dv.document_id); if (!v.ok || v.sha256 !== dv.input_sha256) orphans.push({ action_id: id, why: "derivation document hash mismatch" }); }
    }
  }
  // a stale screen per rule 10; `stale_screens` counts the tool registrations that moved (one changed tool marks every screen registered on it stale — T12: one change to 2.1's payments.read/write is one), `stale_codes` lists the screens
  const staleVersions = versions.filter((v) => isStale(d.rt, v));
  const stale = staleVersions.map((v) => v.code);
  const staleTools = new Set<string>();
  for (const v of staleVersions) for (const a of v.actions) { const now = snapshotAction(d.rt, SCREENS.find((x) => x.code === v.code)!.actions.find((x) => x.code === a.code)!); if (canonicalJson([...a.roles].sort()) !== canonicalJson([...now.roles].sort()) || canonicalJson([...a.tool_money_fields].sort()) !== canonicalJson([...now.tool_money_fields].sort())) staleTools.add(`${a.process} ${a.tool}`); }
  const staleCount = staleTools.size || stale.length;
  const orphanIds = [...new Set(orphans.map((o) => o.action_id))];
  const run_id = randomUUID(); const report_document_id = randomUUID();
  const report = { run_id, as_of_date: i.as_of_date, actions_checked: rows.length, orphans: orphanIds.length, orphan_details: orphans, stale_screens: staleCount, stale_codes: stale, stale_tools: [...staleTools], sole_officer_money_acts: soleOfficer, staff_actions_linked: linked, checked: rows.map((r) => ({ action_id: String(r["id"]), status: String(r["status"]), screen_code: String(r["screen_code"]), action_code: String(r["action_code"]) })), produced_at: d.now };
  d.deferWrite(async (q) => {
    await ports.documents.store(q, { id: report_document_id, kind: RECON_DOCUMENT_KIND, text: toJson(report), loan_id: null, application_id: null, retention_class: "security_logs_5y", metadata: { run_id, as_of_date: i.as_of_date }, now: d.now });
    await q.query(`INSERT INTO work_log_recon_runs (id, as_of_date, actions_checked, orphans, stale_screens, sole_officer_money_acts, outcome, report_document_id, created_at) VALUES ($1, $2::date, $3, $4, $5, $6, 'completed', $7, $8::timestamptz)`, [run_id, i.as_of_date, rows.length, orphanIds.length, staleCount, soleOfficer, report_document_id, d.now]);
  });
  let escalation_id: string | null = null;
  if (orphanIds.length || stale.length) escalation_id = d.escalations.open({ kind: "sev3", ownerRole: "compliance", severity: "3", payload: { run_id, as_of_date: i.as_of_date, orphans: orphanIds.length, orphan_action_ids: orphanIds, stale_screens: staleCount, stale_codes: stale, report_document_id, breach: "35.8 rule 10: orphans or stale screens in the day's action log" } }, d.actor).id;
  d.events.append(ev.reconCompleted(run_id, d.actor, { as_of_date: i.as_of_date, actions_checked: rows.length, orphans: orphanIds.length, stale_screens: staleCount, sole_officer_money_acts: soleOfficer }));
  return { run_id, as_of_date: i.as_of_date, actions_checked: rows.length, orphans: orphanIds.length, orphan_action_ids: orphanIds, orphan_details: orphans, stale_screens: staleCount, stale_codes: stale, sole_officer_money_acts: soleOfficer, report_document_id, escalation_id, outcome: "completed" };
}
/** Has the day's reconciliation run? */
export async function reconRanOn(q: Queryable, asOfDate: string): Promise<boolean> { const [r] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_log_recon_runs WHERE as_of_date = $1::date AND outcome = 'completed'`, [asOfDate]); return Number(r?.n ?? 0) > 0; }
