/**
 * §35.12 rule 4 — `INTEGRATIONS` as a real switch per vendor. `integrations.switch` is two people (TWO_PERSON_SWITCH): a `ciso`
 * requests (`integration.switch.requested{request_id, expires_at}` — an event, 35.7's grant-request pattern; no row yet) and a
 * `compliance` member other than the requester confirms the same `request_id` within 10 minutes: ONE `integration_switches` row
 * with both ids and `effective_at` = the confirmation, `integration.switched{from, to, endpoint_class, by, confirmed_by, effective_at}`.
 * Refused before any write: MONEY_VENDOR_SANDBOX_ONLY (a money-or-person vendor `real` with `endpoint_class = live` outside
 * production; production is live only), NO_FAKE_IN_PRODUCTION (`mode: fake` in production is refused unconditionally — 35.7 rule 6 and
 * PST-10 make production person-only and real-or-off; the refusal's message names why: after `go_live.attested`, while a `parties` row
 * exists, or simply because it is production), REQUEST_EXPIRED, REQUEST_NOT_FOUND. The mode in force for
 * (environment, vendor) is the latest row; no row means `off` under INTEGRATIONS=real and `fake` under INTEGRATIONS=fake
 * (`integrations.status`). Running instances re-read the table within one sweep (real-ports.ts `refresh`).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { byOf } from "./decision.ts";
import { decisionFor, personId, refuse, requireRole, type PostureDeps } from "./deps.ts";
import { CONFIRM_MINUTES, ENVIRONMENTS, MONEY_OR_PERSON_VENDORS, P, VENDORS, environmentOf, isProduction, isUuid, minutesAfter, s, type EndpointClass, type Row, type SwitchMode } from "./types.ts";

export interface SwitchRow { readonly id: string; readonly environment: string; readonly vendor: string; readonly mode: SwitchMode; readonly endpoint_class: EndpointClass; readonly secret_ref: string | null; readonly egress_rule: string | null; readonly request_id: string; readonly requested_by: string | null; readonly confirmed_by: string | null; readonly rationale: string | null; readonly effective_at: string; readonly created_at: string }
export const SWITCH_COLS = `id::text AS id, environment, vendor, mode, endpoint_class, secret_ref, egress_rule, request_id::text AS request_id, requested_by::text AS requested_by, confirmed_by::text AS confirmed_by, rationale, effective_at::text AS effective_at, created_at::text AS created_at`;
export interface SwitchRequest { readonly request_id: string; readonly environment: string; readonly vendor: string; readonly mode: SwitchMode; readonly endpoint_class: EndpointClass; readonly secret_ref: string | null; readonly egress_rule: string | null; readonly rationale: string | null; readonly by: string; readonly requested_at: string; readonly expires_at: string; readonly resolved: "switched" | "expired" | null }
export interface SwitchInput { readonly op?: string | null; readonly environment: string; readonly vendor?: string | null; readonly mode?: string | null; readonly endpoint_class?: string | null; readonly secret_ref?: string | null; readonly egress_rule?: string | null; readonly rationale?: string | null; readonly request_id?: string | null }
export interface SwitchResult { readonly status: "requested" | "switched"; readonly environment: string; readonly vendor: string; readonly from: SwitchMode; readonly to: SwitchMode; readonly endpoint_class: EndpointClass; readonly request_id: string; readonly switch_id: string | null; readonly requested_by: string; readonly confirmed_by: string | null; readonly effective_at: string | null; readonly expires_at: string | null; readonly by: string }
export const REQUEST_ROLES: readonly string[] = ["ciso"];
export const CONFIRM_ROLES: readonly string[] = ["compliance"];
const REQUESTED = "integration.switch.requested"; const SWITCHED = "integration.switched"; const EXPIRED = "integration.switch.request.expired";

/** The mode in force per vendor: the latest row of (environment, vendor). */
export async function switchesInForce(q: Queryable, environment: string, nowIso?: string): Promise<Map<string, SwitchRow>> {
  const rows = await q.query<SwitchRow & Record<string, unknown>>(`SELECT DISTINCT ON (vendor) ${SWITCH_COLS} FROM integration_switches WHERE environment = $1 ${nowIso ? "AND effective_at <= $2::timestamptz" : ""} ORDER BY vendor, effective_at DESC, created_at DESC, id DESC`, nowIso ? [environment, nowIso] : [environment]);
  return new Map(rows.map((r) => [r.vendor, r]));
}
/** The default when no row exists: `off` under INTEGRATIONS=real and always in production (never FAKE there), `fake` under INTEGRATIONS=fake elsewhere. */
export const defaultMode = (integrations: string | undefined, environment: string): SwitchMode => (integrations === "real" || isProduction(environment) ? "off" : "fake");
export async function modeOf(q: Queryable, environment: string, vendor: string, integrations: string | undefined): Promise<{ mode: SwitchMode; endpoint_class: EndpointClass | null; row: SwitchRow | null }> {
  const row = (await switchesInForce(q, environment)).get(vendor) ?? null;
  return row ? { mode: row.mode, endpoint_class: row.endpoint_class, row } : { mode: defaultMode(integrations, environment), endpoint_class: null, row: null };
}
export async function switchRequest(q: Queryable, requestId: string): Promise<SwitchRequest | undefined> {
  if (!isUuid(requestId)) return undefined;
  const [r] = await q.query<{ payload: Row; resolved: string | null }>(`SELECT r.payload, (SELECT x.type FROM loan_events x WHERE x.type IN ($2, $3) AND x.payload->>'request_id' = r.payload->>'request_id' ORDER BY x.sequence LIMIT 1) AS resolved FROM loan_events r WHERE r.type = $4 AND r.payload->>'request_id' = $1 ORDER BY r.sequence DESC LIMIT 1`, [requestId, SWITCHED, EXPIRED, REQUESTED]);
  if (!r) return undefined;
  const p = r.payload;
  return { request_id: s(p["request_id"]), environment: s(p["environment"]), vendor: s(p["vendor"]), mode: s(p["to"]) as SwitchMode, endpoint_class: s(p["endpoint_class"]) as EndpointClass, secret_ref: p["secret_ref"] ? s(p["secret_ref"]) : null, egress_rule: p["egress_rule"] ? s(p["egress_rule"]) : null, rationale: p["rationale"] ? s(p["rationale"]) : null, by: s(p["by"]), requested_at: s(p["requested_at"]), expires_at: s(p["expires_at"]), resolved: r.resolved === SWITCHED ? "switched" : r.resolved === EXPIRED ? "expired" : null };
}
export async function staleSwitchRequests(q: Queryable, nowIso: string): Promise<SwitchRequest[]> {
  const rows = await q.query<{ request_id: string }>(`SELECT r.payload->>'request_id' AS request_id FROM loan_events r WHERE r.type = $2 AND (r.payload->>'expires_at')::timestamptz <= $1::timestamptz AND NOT EXISTS (SELECT 1 FROM loan_events x WHERE x.type IN ($3, $4) AND x.payload->>'request_id' = r.payload->>'request_id') ORDER BY r.sequence`, [nowIso, REQUESTED, SWITCHED, EXPIRED]);
  const out: SwitchRequest[] = []; for (const r of rows) { const x = await switchRequest(q, r.request_id); if (x) out.push(x); } return out;
}
export const switchRequestExpiredEvent = (r: SwitchRequest, nowIso: string) => ({ type: EXPIRED, aggregate: { kind: "integration_switch", id: `${r.environment}:${r.vendor}` }, actor: { kind: "system" as const, id: "posture-35-12" }, payload: P({ request_id: r.request_id, environment: r.environment, vendor: r.vendor, to: r.mode, requested_by: r.by, requested_at: r.requested_at, expires_at: r.expires_at, expired_at: nowIso, reason: `no compliance confirmation within ${CONFIRM_MINUTES} minutes (35.12 rule 4); the switch was not thrown` }) });
const goLiveAttested = async (q: Queryable, environment: string): Promise<boolean> => (await q.query(`SELECT 1 FROM go_live_checklists WHERE environment = $1 AND item_code = 'GL-00' AND status = 'attested' LIMIT 1`, [environment])).length > 0;
const anyParty = async (q: Queryable): Promise<boolean> => (await q.query(`SELECT 1 FROM parties LIMIT 1`)).length > 0;

/** The rules a throw must satisfy (checked at request and again at confirmation — the world may have moved in 10 minutes). */
async function assertThrowable(q: Queryable, r: { environment: string; vendor: string; mode: SwitchMode; endpoint_class: EndpointClass }): Promise<void> {
  const production = isProduction(r.environment);
  if (r.mode === "fake" && production) {
    const attested = await goLiveAttested(q, r.environment);
    refuse(409, "NO_FAKE_IN_PRODUCTION", attested ? `production went live (go_live.attested): a vendor is never FAKE in production (35.12 rule 4; 35.7 rule 6)` : (await anyParty(q)) ? `production holds a parties row: a vendor is never FAKE where a person's data is (35.12 rule 4)` : `a vendor is never FAKE in production (35.7 rule 6)`, { environment: r.environment, vendor: r.vendor, attested });
  }
  if (r.mode === "real" && MONEY_OR_PERSON_VENDORS.includes(r.vendor) && !production && r.endpoint_class === "live") refuse(409, "MONEY_VENDOR_SANDBOX_ONLY", `${r.vendor} moves money or reports on a person: in ${r.environment} it may be real only with endpoint_class = sandbox (35.12 rule 4)`, { environment: r.environment, vendor: r.vendor, endpoint_class: r.endpoint_class });
  if (r.mode === "real" && production && r.endpoint_class !== "live") refuse(409, "PRODUCTION_IS_LIVE_ONLY", `production vendors are live only (35.12 rule 4): ${r.vendor} ${r.endpoint_class}`, { environment: r.environment, vendor: r.vendor, endpoint_class: r.endpoint_class });
}

/** `integrations.switch` — request (ciso) | confirm (a different compliance member, within 10 minutes). */
export async function switchVendor(d: PostureDeps, i: SwitchInput): Promise<SwitchResult> {
  const op = s(i.op) || (i.request_id ? "confirm" : "request");
  if (op === "request") {
    const environment = environmentOf(i.environment); const vendor = s(i.vendor); const mode = s(i.mode) as SwitchMode; const endpoint_class = (s(i.endpoint_class) || (isProduction(environment) ? "live" : "sandbox")) as EndpointClass;
    if (!ENVIRONMENTS.includes(environment)) throw new RangeError(`environment must be one of ${ENVIRONMENTS.join(", ")}`);
    if (!VENDORS.includes(vendor)) throw new RangeError(`vendor must be one of the integration_switches vendors`);
    if (!["fake", "real", "off"].includes(mode)) throw new RangeError("mode must be fake, real or off");
    if (!["sandbox", "live"].includes(endpoint_class)) throw new RangeError("endpoint_class must be sandbox or live");
    if (mode === "real" && !s(i.secret_ref).trim()) throw new RangeError("a real vendor needs its secret_ref (a Secret Manager resource name, never a value)");
    if (/[=:]{1}\S{16,}/.test(s(i.secret_ref)) && !/^projects\//.test(s(i.secret_ref))) refuse(409, "NO_PII_IN_EVIDENCE", "secret_ref is a Secret Manager resource name, never a value", { vendor });
    const requester = await requireRole(d, REQUEST_ROLES, "integrations.switch:request", environment);
    await assertThrowable(d.db, { environment, vendor, mode, endpoint_class });
    const cur = await modeOf(d.db, environment, vendor, d.runtime.env["INTEGRATIONS"]);
    const request_id = randomUUID(); const expires_at = minutesAfter(d.now, CONFIRM_MINUTES);
    d.events.append({ type: REQUESTED, aggregate: { kind: "integration_switch", id: `${environment}:${vendor}` }, actor: d.actor, payload: P({ request_id, environment, vendor, from: cur.mode, to: mode, endpoint_class, secret_ref: s(i.secret_ref) || null, egress_rule: s(i.egress_rule) || null, rationale: s(i.rationale) || null, by: requester.id, requested_at: d.now, expires_at }) });
    return { status: "requested", environment, vendor, from: cur.mode, to: mode, endpoint_class, request_id, switch_id: null, requested_by: requester.id, confirmed_by: null, effective_at: null, expires_at, by: byOf(d.actor) };
  }
  if (op !== "confirm") throw new RangeError("integrations.switch op ∈ {request, confirm}");
  const req = await switchRequest(d.db, s(i.request_id));
  if (!req) refuse(404, "REQUEST_NOT_FOUND", `no switch request ${s(i.request_id) || "(none)"}`, { request_id: i.request_id ?? null });
  const r = req!;
  if (r.resolved === "switched") refuse(409, "REQUEST_ALREADY_CONFIRMED", `switch request ${r.request_id} was already confirmed`, { request_id: r.request_id });
  if (r.resolved === "expired" || Date.parse(r.expires_at) <= Date.parse(d.now)) refuse(409, "REQUEST_EXPIRED", `switch request ${r.request_id} expired at ${r.expires_at}; the switch was not thrown (35.12 rule 4)`, { request_id: r.request_id, expires_at: r.expires_at });
  if (d.actor.kind === "human" && r.by === d.actor.id) refuse(403, "TWO_PERSON_SWITCH", `a switch is two people's decision: ${d.actor.id} requested it and may not confirm it (35.12 rule 4)`, { request_id: r.request_id, vendor: r.vendor });
  const confirmer = await requireRole(d, CONFIRM_ROLES, "integrations.switch:confirm", r.environment);
  if (confirmer.id === r.by) refuse(403, "TWO_PERSON_SWITCH", `a switch is two people's decision: the requester may not confirm (35.12 rule 4)`, { request_id: r.request_id, vendor: r.vendor });
  await assertThrowable(d.db, { environment: r.environment, vendor: r.vendor, mode: r.mode, endpoint_class: r.endpoint_class });
  const cur = await modeOf(d.db, r.environment, r.vendor, d.runtime.env["INTEGRATIONS"]);
  const switch_id = randomUUID(); const effective_at = d.now; const requested_by = isUuid(r.by) ? r.by : null; const confirmed_by = personId(d.actor);
  d.deferWrite(async (q) => {
    const decision_id = await decisionFor(q, "switch", switch_id);
    await q.query(`INSERT INTO integration_switches (id, environment, vendor, mode, endpoint_class, secret_ref, egress_rule, request_id, requested_by, confirmed_by, rationale, effective_at, decision_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13)`,
      [switch_id, r.environment, r.vendor, r.mode, r.endpoint_class, r.secret_ref, r.egress_rule, r.request_id, requested_by, confirmed_by, r.rationale, effective_at, decision_id]);
  });
  d.events.append({ type: SWITCHED, aggregate: { kind: "integration_switch", id: `${r.environment}:${r.vendor}` }, actor: d.actor, payload: P({ switch_id, request_id: r.request_id, environment: r.environment, vendor: r.vendor, from: cur.mode, to: r.mode, endpoint_class: r.endpoint_class, secret_ref: r.secret_ref, egress_rule: r.egress_rule, by: r.by, confirmed_by: byOf(d.actor), effective_at }) });
  return { status: "switched", environment: r.environment, vendor: r.vendor, from: cur.mode, to: r.mode, endpoint_class: r.endpoint_class, request_id: r.request_id, switch_id, requested_by: r.by, confirmed_by: byOf(d.actor), effective_at, expires_at: null, by: byOf(d.actor) };
}

export interface VendorStatus { readonly vendor: string; readonly mode: SwitchMode; readonly endpoint_class: EndpointClass | null; readonly source: "switch" | "default"; readonly switch_id: string | null; readonly effective_at: string | null; readonly requested_by: string | null; readonly confirmed_by: string | null; readonly secret_ref: string | null; readonly egress_rule: string | null; readonly adapter: "fake" | "real" | "off" | "missing"; readonly pending_request: { request_id: string; to: SwitchMode; expires_at: string } | null }
/** `integrations.status` (read): the mode in force per vendor, the pending requests, and the adapter the runtime would construct. */
export async function integrationsStatus(q: Queryable, o: { environment: string; integrations: string | undefined; nowIso: string; realAdapters: readonly string[] }): Promise<{ environment: string; integrations: string; vendors: VendorStatus[]; pending: number }> {
  const environment = environmentOf(o.environment); const integrations = o.integrations === "real" ? "real" : "fake";
  const inForce = await switchesInForce(q, environment);
  const pending = await q.query<{ payload: Row }>(`SELECT r.payload FROM loan_events r WHERE r.type = $1 AND r.payload->>'environment' = $2 AND (r.payload->>'expires_at')::timestamptz > $3::timestamptz AND NOT EXISTS (SELECT 1 FROM loan_events x WHERE x.type IN ($4, $5) AND x.payload->>'request_id' = r.payload->>'request_id') ORDER BY r.sequence`, [REQUESTED, environment, o.nowIso, SWITCHED, EXPIRED]);
  const pendingBy = new Map(pending.map((p) => [s(p.payload["vendor"]), { request_id: s(p.payload["request_id"]), to: s(p.payload["to"]) as SwitchMode, expires_at: s(p.payload["expires_at"]) }]));
  const vendors: VendorStatus[] = VENDORS.map((v) => {
    const row = inForce.get(v) ?? null; const mode: SwitchMode = row ? row.mode : defaultMode(integrations, environment);
    const adapter: VendorStatus["adapter"] = integrations === "fake" ? (mode === "off" ? "off" : "fake") : mode === "real" ? (o.realAdapters.includes(v) ? "real" : "missing") : mode === "fake" ? "fake" : "off";
    return { vendor: v, mode, endpoint_class: row?.endpoint_class ?? null, source: row ? "switch" : "default", switch_id: row?.id ?? null, effective_at: row?.effective_at ?? null, requested_by: row?.requested_by ?? null, confirmed_by: row?.confirmed_by ?? null, secret_ref: row?.secret_ref ?? null, egress_rule: row?.egress_rule ?? null, adapter, pending_request: pendingBy.get(v) ?? null };
  });
  return { environment, integrations, vendors, pending: pending.length };
}
