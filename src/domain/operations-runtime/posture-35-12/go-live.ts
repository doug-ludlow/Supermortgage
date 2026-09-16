/**
 * §35.12 rule 10 — the go-live checklist (GL-01…GL-12), computed, never typed. `go_live.check{op: check}` derives each item's status from
 * rows and answers the evidence reference (a `go_live_checklists` row is written whenever an item's status or evidence changed; the
 * checklist_id is stable per environment attempt — a new one after an attestation). `op: waive` (compliance, a reason) is possible for
 * GL-08 and GL-10 only; the money and identity items cannot be waived. `go_live.attest` is GL-00: the ciso requests (an event —
 * `go_live.attest.requested{request_id, expires_at}`; refused GO_LIVE_GATE{not_before} before the gate's day and GO_LIVE_ITEM_OPEN{code}
 * while any item is open), a compliance member other than the requester confirms within 10 minutes (TWO_PERSON_GO_LIVE): one
 * `go_live_checklists{GL-00, attested}` row naming both people and the manifest, `go_live.attested` (SM_PROD_GO_LIVE_ATTEST_GATE
 * satisfied); an unconfirmed request expires on the sweep (`go_live.attest.request.expired`). A later manifest with a different
 * env_hash re-opens GL-01/GL-02 on the next check (the attestation stands; the report shows the manifest it was made against).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { evaluateGate } from "../../../app/evaluators.ts";
import { HUMAN_ROLES } from "../../../app/roles.ts";
import { handoverBoard } from "../roles-35-7/handover.ts";
import { latestFindings } from "./check.ts";
import { byOf } from "./decision.ts";
import { decisionFor, personId, refuse, requireRole, requireRoleOrService, type PostureDeps } from "./deps.ts";
import { latestManifest } from "./manifests.ts";
import { latestRunOf } from "./parallel-run.ts";
import { posturePortsOf, UNVERIFIED_ITEMS } from "./ports.ts";
import { switchesInForce } from "./switches.ts";
import { CONFIRM_MINUTES, ET, GO_LIVE_ITEMS, GO_LIVE_VENDORS, P, WAIVABLE_ITEMS, addCalendarDays, environmentOf, isUuid, minutesAfter, s, type Row } from "./types.ts";

export interface ChecklistItem { readonly item_code: string; readonly status: "open" | "satisfied" | "waived"; readonly evidence_ref: string | null; readonly detail: Row; readonly waived_by?: string | null; readonly reason?: string | null }
export interface ChecklistResult { readonly environment: string; readonly checklist_id: string; readonly as_of: string; readonly items: readonly ChecklistItem[]; readonly open: readonly string[]; readonly attested: { by: string | null; confirmed_by: string | null; manifest_id: string | null; attested_at: string } | null; readonly manifest_id: string | null; readonly rows_written: number; readonly by: string }
export const CHECK_ROLES: readonly string[] = ["compliance", "ciso", "officer", "admin"];
export const WAIVE_ROLES: readonly string[] = ["compliance"];
const REQUESTED = "go_live.attest.requested"; const ATTESTED = "go_live.attested"; const EXPIRED = "go_live.attest.request.expired";
interface ChecklistRow { readonly checklist_id: string; readonly item_code: string; readonly status: string; readonly evidence_ref: string | null; readonly reason: string | null; readonly by: string | null; readonly confirmed_by: string | null; readonly manifest_id: string | null; readonly created_at: string }
const CL_COLS = `checklist_id::text AS checklist_id, item_code, status, evidence_ref, reason, by::text AS by, confirmed_by::text AS confirmed_by, manifest_id::text AS manifest_id, created_at::text AS created_at`;

/** The current checklist_id of the environment: the latest rows' unless GL-00 is attested (then a new attempt begins). */
export async function currentChecklist(q: Queryable, environment: string): Promise<{ checklist_id: string; rows: Map<string, ChecklistRow>; attested: ChecklistRow | null; fresh: boolean }> {
  const [last] = await q.query<{ checklist_id: string }>(`SELECT checklist_id::text AS checklist_id FROM go_live_checklists WHERE environment = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [environment]);
  if (!last) return { checklist_id: randomUUID(), rows: new Map(), attested: null, fresh: true };
  const rows = await q.query<ChecklistRow & Record<string, unknown>>(`SELECT DISTINCT ON (item_code) ${CL_COLS} FROM go_live_checklists WHERE environment = $1 AND checklist_id = $2 ORDER BY item_code, created_at DESC, id DESC`, [environment, last.checklist_id]);
  const attested = rows.find((r) => r.item_code === "GL-00" && r.status === "attested") ?? null;
  return { checklist_id: last.checklist_id, rows: new Map(rows.map((r) => [r.item_code, r])), attested, fresh: false };
}

/** GL-01 … GL-12 from rows (rule 10). */
export async function computeItems(rt: Runtime, q: Queryable, environment: string, nowIso: string): Promise<ChecklistItem[]> {
  const ports = posturePortsOf(rt); const items: ChecklistItem[] = []; const dayAgo = new Date(Date.parse(nowIso) - 86_400_000).toISOString();
  const item = (code: string, ok: boolean, evidence: string | null, detail: Row): void => { items.push({ item_code: code, status: ok ? "satisfied" : "open", evidence_ref: evidence, detail }); };
  // GL-01 a production manifest recorded in the last 24 h
  const m = await latestManifest(q, environment);
  item("GL-01", !!m && Date.parse(m.created_at) >= Date.parse(dayAgo), m?.id ?? null, { manifest_created_at: m?.created_at ?? null });
  // GL-02 the latest run has failed = 0 and no open finding
  const [run] = await q.query<{ run_id: string; bad: string }>(`SELECT run_id::text AS run_id, count(*) FILTER (WHERE result IN ('fail', 'unverifiable'))::text AS bad FROM posture_checks WHERE environment = $1 AND manifest_id IS NOT NULL GROUP BY run_id ORDER BY max(checked_at) DESC LIMIT 1`, [environment]);
  const openFindings = [...(await latestFindings(q, environment)).values()].filter((f) => f.action === "opened" || f.action === "acknowledged");
  item("GL-02", !!run && Number(run.bad) === 0 && openFindings.length === 0, run?.run_id ?? null, { failed: run ? Number(run.bad) : null, open_findings: openFindings.map((f) => f.control_code) });
  // GL-03 a passed restore drill in the last 90 days
  const [drill] = await q.query<{ id: string; completed_at: string }>(`SELECT id::text AS id, completed_at::text AS completed_at FROM restore_drills WHERE environment = $1 AND result = 'passed' AND completed_at >= $2::timestamptz ORDER BY completed_at DESC LIMIT 1`, [environment, new Date(Date.parse(nowIso) - 90 * 86_400_000).toISOString()]);
  item("GL-03", !!drill, drill?.id ?? null, { completed_at: drill?.completed_at ?? null });
  // GL-04 35.7's board: every kernel role staffed (holders ≥ 1, fake = false), the dual-control pairs distinct
  let boardOk = false; let boardScan: string | null = null; let boardDetail: Row = {};
  try { const b = await handoverBoard(rt, { environment }); const unstaffed = b.roles.filter((r) => r.fake || r.holders.length < 1).map((r) => r.role); const pairs = ["officer", "funding_approver", "qc_officer"].filter((role) => new Set(b.roles.find((r) => r.role === role)?.holders ?? []).size < 2); boardOk = unstaffed.length === 0 && pairs.length === 0 && b.roles.length === HUMAN_ROLES.length; boardScan = b.scan.scan_run_id; boardDetail = { unstaffed, pairs_not_distinct: pairs, fake_current: b.fake_current }; } catch (e) { boardDetail = { error: (e as Error).message }; }
  item("GL-04", boardOk && !!boardScan, boardScan, boardDetail);
  // GL-05 INTEGRATIONS = real and every vendor the book needs real + live with a canary in the last 24 h
  const inForce = await switchesInForce(q, environment, nowIso);
  const canaries = new Set((await q.query<{ vendor: string }>(`SELECT DISTINCT payload->>'vendor' AS vendor FROM loan_events WHERE type = 'integration.canary' AND payload->>'environment' = $1 AND (payload->>'ok')::boolean = true AND occurred_at >= $2::timestamptz`, [environment, dayAgo])).map((r) => r.vendor));
  const notReal = GO_LIVE_VENDORS.filter((v) => { const r = inForce.get(v); return !r || r.mode !== "real" || r.endpoint_class !== "live"; }); const noCanary = GO_LIVE_VENDORS.filter((v) => !notReal.includes(v) && !canaries.has(v));
  const integrationsReal = rt.env["INTEGRATIONS"] === "real";
  item("GL-05", integrationsReal && notReal.length === 0 && noCanary.length === 0, notReal.length === 0 && integrationsReal ? GO_LIVE_VENDORS.map((v) => inForce.get(v)!.id).join(",") : null, { integrations: rt.env["INTEGRATIONS"] ?? "fake", not_real_live: notReal, no_canary_24h: noCanary });
  // GL-06 the parallel run closed passed
  const pr = await latestRunOf(q, environment);
  item("GL-06", !!pr && pr.action === "closed" && pr.outcome === "passed", pr?.parallel_run_id ?? null, { status: pr ? (pr.action === "closed" ? `closed:${pr.outcome}` : "open") : "none" });
  // GL-07 the retention matrix signed by counsel and the bucket lock applied
  const rm = await ports.retentionMatrix.signed(q);
  item("GL-07", !!rm && rm.bucket_lock_applied, rm?.document_id ?? null, { signed_by_role: rm?.signed_by_role ?? null, bucket_lock_applied: rm?.bucket_lock_applied ?? false });
  // GL-08 a clean nonprod scan every day for the last 30 days
  const today = wallClock(Date.parse(nowIso), ET).date; const need: string[] = []; for (let k = 0; k < 30; k++) need.push(addCalendarDays(today, -k));
  const scans = await q.query<{ id: string; d: string }>(`SELECT DISTINCT ON ((scanned_at AT TIME ZONE 'America/New_York')::date) id::text AS id, ((scanned_at AT TIME ZONE 'America/New_York')::date)::text AS d FROM data_scans WHERE environment IN ('nonprod', 'staging') AND kind = 'nonprod_real_data' AND real_data_found = false AND scanned_at >= $1::timestamptz ORDER BY (scanned_at AT TIME ZONE 'America/New_York')::date DESC, scanned_at DESC`, [new Date(Date.parse(nowIso) - 31 * 86_400_000).toISOString()]);
  const byDay = new Map(scans.map((x) => [x.d, x.id])); const missingDays = need.filter((dd) => !byDay.has(dd));
  item("GL-08", missingDays.length === 0, missingDays.length === 0 ? need.map((dd) => byDay.get(dd)!).join(",") : null, { days_missing: missingDays.length, missing: missingDays.slice(0, 5) });
  // GL-09 per-loan zone and servicer identity from configuration
  const cfg = await ports.servicingConfig.status(q);
  item("GL-09", cfg.missing_tables.length === 0 && cfg.profile_rows >= 1 && cfg.loans_without_config === 0, cfg.missing_tables.length ? null : `loan_servicing_configs:${cfg.config_rows};servicer_profiles:${cfg.profile_rows}`, cfg as unknown as Row);
  // GL-10 two month-end closes attested in the run
  const att = await ports.closeAttestations.attestations(q, environment, pr ? `${pr.opened_on}T00:00:00Z` : new Date(Date.parse(nowIso) - 62 * 86_400_000).toISOString());
  item("GL-10", att.length >= 2, att.length ? att.map((a) => a.id).join(",") : null, { attestations: att.length });
  // GL-11 35.11's daily reports show fake_approvals = 0 for the last 7 days
  const reps = await ports.opsDailyReports.reports(q, environment, addCalendarDays(today, -6)); const last7 = reps.filter((r) => r.as_of_date >= addCalendarDays(today, -6) && r.as_of_date <= today);
  item("GL-11", last7.length >= 7 && last7.every((r) => r.fake_approvals === 0), last7.length >= 7 ? last7.map((r) => r.id).join(",") : null, { days: last7.length, fake_approvals: last7.reduce((sum, r) => sum + r.fake_approvals, 0) });
  // GL-12 every [UNVERIFIED] item has a signed confirmation
  const conf = await ports.unverifiedConfirmations.confirmations(q); const have = new Map(conf.map((c) => [c.item_key, c.document_id])); const missingKeys = UNVERIFIED_ITEMS.filter((k) => !have.has(k));
  item("GL-12", missingKeys.length === 0, missingKeys.length === 0 ? UNVERIFIED_ITEMS.map((k) => have.get(k)!).join(",") : null, { missing: missingKeys });
  return items;
}
export interface CheckInput { readonly op?: string | null; readonly environment: string; readonly item_code?: string | null; readonly reason?: string | null }
export async function goLiveCheck(d: PostureDeps, i: CheckInput): Promise<ChecklistResult> {
  const environment = environmentOf(i.environment); const op = s(i.op) || "check";
  const cl = await currentChecklist(d.db, environment); const checklist_id = cl.attested ? randomUUID() : cl.checklist_id; const rows = cl.attested ? new Map<string, ChecklistRow>() : cl.rows;
  const now = d.now; const by = personId(d.actor); const manifest = await latestManifest(d.db, environment);
  if (op === "waive") {
    const compliance = await requireRole(d, WAIVE_ROLES, "go_live.check:waive", environment);
    const code = s(i.item_code); const reason = s(i.reason).trim();
    if (!GO_LIVE_ITEMS.includes(code)) throw new RangeError("item_code ∈ GL-01 … GL-12");
    if (!WAIVABLE_ITEMS.includes(code)) refuse(409, "GO_LIVE_ITEM_NOT_WAIVABLE", `${code} cannot be waived: only GL-08 and GL-10 may be, by compliance with a reason; the money and identity items are satisfied by evidence (35.12 rule 10)`, { item_code: code, waivable: WAIVABLE_ITEMS });
    if (!reason) throw new RangeError("a waiver needs a reason");
    d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "checklist", checklist_id); await q.query(`INSERT INTO go_live_checklists (checklist_id, environment, item_code, status, evidence_ref, reason, by, by_role, manifest_id, decision_id, created_at) VALUES ($1, $2, $3, 'waived', $4, $5, $6, $7, $8, $9, $10::timestamptz)`, [checklist_id, environment, code, `waived_by:${compliance.id}`, reason, by, d.actor.role ?? null, manifest?.id ?? null, decision_id, now]); });
    d.events.append({ type: "go_live.item.waived", aggregate: { kind: "go_live_checklist", id: checklist_id }, actor: d.actor, payload: P({ checklist_id, environment, item_code: code, reason, by: compliance.id }) });
    const items = await computeItems(d.runtime, d.db, environment, now);
    const merged = items.map((it) => (it.item_code === code ? { ...it, status: "waived" as const, evidence_ref: `waived_by:${compliance.id}`, waived_by: compliance.id, reason } : applyWaiver(it, rows.get(it.item_code))));
    return { environment, checklist_id, as_of: now, items: merged, open: merged.filter((x) => x.status === "open").map((x) => x.item_code), attested: null, manifest_id: manifest?.id ?? null, rows_written: 1, by: byOf(d.actor) };
  }
  if (op !== "check") throw new RangeError("go_live.check op ∈ {check, waive}");
  await requireRoleOrService(d, CHECK_ROLES, "go_live.check", environment);
  const items = (await computeItems(d.runtime, d.db, environment, now)).map((it) => applyWaiver(it, rows.get(it.item_code)));
  const changed = items.filter((it) => { const prev = rows.get(it.item_code); return it.status !== "waived" && (!prev || prev.status !== it.status || (prev.evidence_ref ?? null) !== (it.evidence_ref ?? null)); });
  if (changed.length) d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "checklist", checklist_id); for (const it of changed) await q.query(`INSERT INTO go_live_checklists (checklist_id, environment, item_code, status, evidence_ref, by, by_role, manifest_id, decision_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`, [checklist_id, environment, it.item_code, it.status, it.evidence_ref, by, d.actor.role ?? null, manifest?.id ?? null, decision_id, now]); });
  const att = cl.attested && !cl.fresh && cl.checklist_id === checklist_id ? { by: cl.attested.by, confirmed_by: cl.attested.confirmed_by, manifest_id: cl.attested.manifest_id, attested_at: cl.attested.created_at } : null;
  return { environment, checklist_id, as_of: now, items, open: items.filter((x) => x.status === "open").map((x) => x.item_code), attested: att, manifest_id: manifest?.id ?? null, rows_written: changed.length, by: byOf(d.actor) };
}
const applyWaiver = (it: ChecklistItem, prev: ChecklistRow | undefined): ChecklistItem => (prev && prev.status === "waived" && it.status === "open" ? { ...it, status: "waived", evidence_ref: prev.evidence_ref, waived_by: prev.by, reason: prev.reason } : it);

// ---- GL-00 the attestation -----------------------------------------------------------------------------------------
export interface AttestInput { readonly op?: string | null; readonly environment: string; readonly request_id?: string | null; readonly reason?: string | null }
export interface AttestResult { readonly status: "requested" | "attested"; readonly environment: string; readonly checklist_id: string; readonly request_id: string; readonly manifest_id: string | null; readonly by: string; readonly confirmed_by: string | null; readonly attested_at: string | null; readonly expires_at: string | null; readonly not_before: string }
interface AttestRequest { readonly request_id: string; readonly environment: string; readonly checklist_id: string; readonly manifest_id: string | null; readonly by: string; readonly requested_at: string; readonly expires_at: string; readonly resolved: "attested" | "expired" | null }
async function attestRequest(q: Queryable, id: string): Promise<AttestRequest | undefined> {
  if (!isUuid(id)) return undefined;
  const [r] = await q.query<{ payload: Row; resolved: string | null }>(`SELECT r.payload, (SELECT x.type FROM loan_events x WHERE x.type IN ($2, $3) AND x.payload->>'request_id' = r.payload->>'request_id' ORDER BY x.sequence LIMIT 1) AS resolved FROM loan_events r WHERE r.type = $4 AND r.payload->>'request_id' = $1 ORDER BY r.sequence DESC LIMIT 1`, [id, ATTESTED, EXPIRED, REQUESTED]);
  if (!r) return undefined; const p = r.payload;
  return { request_id: s(p["request_id"]), environment: s(p["environment"]), checklist_id: s(p["checklist_id"]), manifest_id: p["manifest_id"] ? s(p["manifest_id"]) : null, by: s(p["by"]), requested_at: s(p["requested_at"]), expires_at: s(p["expires_at"]), resolved: r.resolved === ATTESTED ? "attested" : r.resolved === EXPIRED ? "expired" : null };
}
/** The gate (rule 9/10) and the items (rule 10) — checked at the request and again at the confirmation. */
async function assertAttestable(d: PostureDeps, environment: string): Promise<{ not_before: string; checklist_id: string; items: ChecklistItem[] }> {
  const run = await latestRunOf(d.db, environment); const asOf = wallClock(Date.parse(d.now), ET).date;
  const notBefore = run ? run.planned_end_on : null;
  const gate = run ? evaluateGate("35.12.goLiveGate", { opened_on: run.opened_on, planned_end_on: run.planned_end_on, as_of_date: asOf }) : { open: false, reason: "no parallel run opened" };
  if (!gate.open) refuse(409, "GO_LIVE_GATE", `go_live.attest holds until the parallel run's 28th day${notBefore ? ` (${notBefore})` : ""}: ${gate.reason ?? "closed"} (35.12 rule 9; SM_PROD_GO_LIVE_ATTEST_GATE)`, { environment, not_before: notBefore, as_of_date: asOf });
  const cl = await currentChecklist(d.db, environment); const checklist_id = cl.attested ? randomUUID() : cl.checklist_id; const rows = cl.attested ? new Map<string, ChecklistRow>() : cl.rows;
  const items = (await computeItems(d.runtime, d.db, environment, d.now)).map((it) => applyWaiver(it, rows.get(it.item_code)));
  const open = items.filter((it) => it.status === "open");
  if (open.length) refuse(409, "GO_LIVE_ITEM_OPEN", `${open.map((x) => x.item_code).join(", ")} open: every item is satisfied or waived before the attestation (35.12 rule 10)`, { environment, code: open[0]!.item_code, items: open.map((x) => ({ item_code: x.item_code, detail: x.detail })) });
  return { not_before: notBefore!, checklist_id, items };
}
export async function goLiveAttest(d: PostureDeps, i: AttestInput): Promise<AttestResult> {
  const op = s(i.op) || (i.request_id ? "confirm" : "request");
  if (op === "request") {
    const environment = environmentOf(i.environment);
    const ciso = await requireRole(d, ["ciso"], "go_live.attest:request", environment);
    const { not_before, checklist_id } = await assertAttestable(d, environment);
    const manifest = await latestManifest(d.db, environment); const request_id = randomUUID(); const expires_at = minutesAfter(d.now, CONFIRM_MINUTES);
    d.events.append({ type: REQUESTED, aggregate: { kind: "go_live_checklist", id: checklist_id }, actor: d.actor, payload: P({ request_id, environment, checklist_id, manifest_id: manifest?.id ?? null, by: ciso.id, requested_at: d.now, expires_at, reason: s(i.reason) || null }) });
    return { status: "requested", environment, checklist_id, request_id, manifest_id: manifest?.id ?? null, by: ciso.id, confirmed_by: null, attested_at: null, expires_at, not_before };
  }
  if (op !== "confirm") throw new RangeError("go_live.attest op ∈ {request, confirm}");
  const req = await attestRequest(d.db, s(i.request_id));
  if (!req) refuse(404, "REQUEST_NOT_FOUND", `no attestation request ${s(i.request_id) || "(none)"}`, { request_id: i.request_id ?? null });
  const r = req!;
  if (r.resolved === "attested") refuse(409, "REQUEST_ALREADY_CONFIRMED", `request ${r.request_id} was already attested`, { request_id: r.request_id });
  if (r.resolved === "expired" || Date.parse(r.expires_at) <= Date.parse(d.now)) refuse(409, "REQUEST_EXPIRED", `attestation request ${r.request_id} expired at ${r.expires_at}; nothing was attested (35.12 rule 10)`, { request_id: r.request_id, expires_at: r.expires_at });
  if (d.actor.kind === "human" && r.by === d.actor.id) refuse(403, "TWO_PERSON_GO_LIVE", `the attestation is two people's decision: ${d.actor.id} requested it and may not confirm it (35.12 rule 10)`, { request_id: r.request_id });
  const compliance = await requireRole(d, ["compliance"], "go_live.attest:confirm", r.environment);
  if (compliance.id === r.by) refuse(403, "TWO_PERSON_GO_LIVE", "the requester may not confirm (35.12 rule 10)", { request_id: r.request_id });
  const { not_before, checklist_id } = await assertAttestable(d, r.environment);
  const now = d.now; const manifest_id = r.manifest_id ?? (await latestManifest(d.db, r.environment))?.id ?? null;
  d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "checklist", checklist_id); await q.query(`INSERT INTO go_live_checklists (checklist_id, environment, item_code, status, evidence_ref, by, by_role, confirmed_by, manifest_id, request_id, decision_id, created_at) VALUES ($1, $2, 'GL-00', 'attested', $3, $4, 'ciso', $5, $6, $7, $8, $9::timestamptz)`, [checklist_id, r.environment, `manifest:${manifest_id ?? "none"}`, r.by, compliance.id, manifest_id, r.request_id, decision_id, now]); });
  d.events.append({ type: ATTESTED, aggregate: { kind: "go_live_checklist", id: checklist_id }, actor: d.actor, payload: P({ environment: r.environment, checklist_id, request_id: r.request_id, by: r.by, confirmed_by: compliance.id, attested_at: now, manifest_id, not_before }) });
  return { status: "attested", environment: r.environment, checklist_id, request_id: r.request_id, manifest_id, by: r.by, confirmed_by: compliance.id, attested_at: now, expires_at: null, not_before };
}
/** The sweep: attestation requests past 10 minutes → `go_live.attest.request.expired` (a stale request never attests). */
export async function expireAttestRequests(rt: Runtime, nowIso: string): Promise<number> {
  const rows = await rt.db.query<{ payload: Row }>(`SELECT r.payload FROM loan_events r WHERE r.type = $2 AND (r.payload->>'expires_at')::timestamptz <= $1::timestamptz AND NOT EXISTS (SELECT 1 FROM loan_events x WHERE x.type IN ($3, $4) AND x.payload->>'request_id' = r.payload->>'request_id') ORDER BY r.sequence`, [nowIso, REQUESTED, ATTESTED, EXPIRED]);
  if (rows.length) await rt.uow.run({}, (ctx) => { for (const r of rows) ctx.events.append({ type: EXPIRED, aggregate: { kind: "go_live_checklist", id: s(r.payload["checklist_id"]) }, actor: { kind: "system", id: "posture-35-12" }, payload: P({ request_id: r.payload["request_id"], environment: r.payload["environment"], checklist_id: r.payload["checklist_id"], requested_by: r.payload["by"], expires_at: r.payload["expires_at"], expired_at: nowIso, reason: `no compliance confirmation within ${CONFIRM_MINUTES} minutes (35.12 rule 10); nothing was attested` }) }); }, { clock: rt.clock });
  return rows.length;
}
