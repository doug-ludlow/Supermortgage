/**
 * §35.12 rule 2 — the posture controls (PST-01 … PST-17), each a check the agent computes from the manifest and the environment's
 * own database. `evaluateControl` answers pass | fail | unverifiable (the manifest lacks the fact) with `observed` and `expected`;
 * the caller (check.ts) applies rule 3: required in the environments the catalogue lists, `unverifiable` is a `fail` in production
 * and `not_applicable` elsewhere. Nothing here writes; `gatherDbFacts` reads counts and codes only — never a name, an e-mail or a token.
 *
 * Manifest shape (Inputs and triggers): `terraform: {sql: {ipv4_enabled, private_service_access, availability_type, pitr,
 * log_retention_days, retained_backups, cmek_key, rotation_period_s}, registry: {cmek_key}, buckets: [{name, cmek_key}], run: {env_names[],
 * ingress, vpc_egress, egress_rules[]}, armor: {waf_preview, rate_limit_per_min, allowlist_count}, iam: {deployer_roles[]}, org_policies[],
 * audit_sink: {locked}}`, `secrets: [{name, version_created_at, placeholder}]`, `runtime: {integrations, fake_reviewers, environment,
 * env_names[], demo_clock_status, logs: {sample_lines, email_matches, tin_matches, name_fields}}`.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { HUMAN_ROLES } from "../../../app/roles.ts";
import { enabledHandovers } from "../roles-35-7/env.ts";
import { SECRET_MAX_AGE_DAYS, arr, isProduction, obj, s, type Row } from "./types.ts";

export interface ControlRow { readonly code: string; readonly version: number; readonly name: string; readonly environments: string[]; readonly severity: "sev1" | "sev2" | "sev3"; readonly check_kind: string; readonly expected: Row; readonly citation: string; readonly security_control_code: string | null }
export interface SecretEntry { readonly name: string; readonly version_created_at: string | null; readonly placeholder: boolean }
export interface ManifestFacts { readonly id: string | null; readonly environment: string; readonly image_digest: string; readonly migration_head: string; readonly terraform: Row; readonly secrets: readonly SecretEntry[]; readonly runtime: Row; readonly created_at: string }
export interface DbFacts {
  readonly shared_token_requests_24h: number;
  readonly staff: { active: number; password_credentials: number; without_oidc: number };
  readonly fake_switches: number;
  readonly real_vendors: readonly { vendor: string; endpoint_class: string; secret_ref: string | null }[];
  readonly handovers_not_enabled: readonly string[];
  readonly demo_clock_rows: number;
  readonly synthetic_parties: number;
  readonly assets: readonly { kind: string; name: string; classification: string | null; data_classes: string[] }[];
  readonly staging_promotion: { found: boolean; age_h: number | null; run_passing: boolean | null } | null;
}
export interface ControlResult { readonly result: "pass" | "fail" | "unverifiable"; readonly observed: Row; readonly expected: Row }
export type Facts = { readonly manifest: ManifestFacts; readonly db: DbFacts; readonly now: string };

export const REQUIRED_SECRETS: readonly string[] = ["supermortgage-staff-email-key", "supermortgage-tin-cipher-key", "supermortgage-borrower-url-secret", "supermortgage-database-url"];
export const ORG_POLICIES: readonly string[] = ["sql.restrictPublicIp", "iam.allowedPolicyMemberDomains", "compute.requireShieldedVm"];
export const RESTRICTED_ASSET_KINDS: readonly string[] = ["database", "bucket", "key"];

export async function loadControls(q: Queryable): Promise<ControlRow[]> {
  return q.query<ControlRow & Record<string, unknown>>(`SELECT DISTINCT ON (code) code, version, name, environments, severity, check_kind, expected, citation, security_control_code FROM posture_controls ORDER BY code, version DESC`);
}
export const isRequired = (c: ControlRow, environment: string): boolean => c.environments.includes(environment);

/** The environment's own facts (rule 2 reads them beside the manifest); counts and codes only. */
export async function gatherDbFacts(q: Queryable, environment: string, nowIso: string, manifest?: ManifestFacts): Promise<DbFacts> {
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> => (await q.query<T>(sql, params))[0]!;
  const since = new Date(Date.parse(nowIso) - 86_400_000).toISOString();
  const shared = await one<{ n: string }>(`SELECT count(*)::text AS n FROM staff_actions WHERE surface = 'v1' AND source IN ('shared_token', 'header') AND at >= $1::timestamptz AND at <= $2::timestamptz`, [since, nowIso]);
  const staff = await one<{ active: string; pw: string; no_oidc: string }>(`SELECT count(*)::text AS active,
      (SELECT count(*)::text FROM staff_credentials c JOIN staff_users u2 ON u2.id = c.staff_user_id WHERE u2.status = 'active' AND c.kind = 'password' AND c.revoked_at IS NULL) AS pw,
      (SELECT count(*)::text FROM staff_users u3 WHERE u3.status = 'active' AND NOT EXISTS (SELECT 1 FROM staff_oidc_identities o WHERE o.staff_user_id = u3.id AND o.revoked_at IS NULL)) AS no_oidc
    FROM staff_users u WHERE u.status = 'active'`);
  const inForce = await q.query<{ vendor: string; mode: string; endpoint_class: string; secret_ref: string | null }>(`SELECT DISTINCT ON (vendor) vendor, mode, endpoint_class, secret_ref FROM integration_switches WHERE environment = $1 AND effective_at IS NOT NULL AND effective_at <= $2::timestamptz ORDER BY vendor, effective_at DESC, created_at DESC, id DESC`, [environment, nowIso]);
  const enabled = await enabledHandovers(q, environment);
  const demo = await one<{ n: string }>(`SELECT count(*)::text AS n FROM demo_clock`);
  const synth = await one<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE synthetic = true`);
  const assets = await q.query<{ kind: string; name: string; classification: string | null; data_classes: string[] }>(`SELECT kind, name, classification, data_classes FROM assets WHERE name LIKE $1 ORDER BY kind, name`, [`${environment}:%`]);
  let staging_promotion: DbFacts["staging_promotion"] = null;
  if (manifest && isProduction(environment)) {
    const cutoff = new Date(Date.parse(manifest.created_at) - 24 * 3_600_000).toISOString();
    const [st] = await q.query<{ id: string; created_at: string }>(`SELECT id::text AS id, created_at::text AS created_at FROM environment_manifests WHERE environment = 'staging' AND image_digest = $1 AND created_at <= $2::timestamptz ORDER BY created_at DESC LIMIT 1`, [manifest.image_digest, cutoff]);
    if (!st) staging_promotion = { found: false, age_h: null, run_passing: null };
    else {
      const [run] = await q.query<{ run_id: string; bad: string }>(`SELECT run_id::text AS run_id, count(*) FILTER (WHERE result IN ('fail', 'unverifiable') AND control_code IN (SELECT code FROM posture_controls WHERE 'staging' = ANY(environments)))::text AS bad FROM posture_checks WHERE manifest_id = $1 GROUP BY run_id ORDER BY max(checked_at) DESC LIMIT 1`, [st.id]);
      staging_promotion = { found: true, age_h: Math.floor((Date.parse(manifest.created_at) - Date.parse(st.created_at)) / 3_600_000), run_passing: run ? Number(run.bad) === 0 : false };
    }
  }
  return { shared_token_requests_24h: Number(shared.n), staff: { active: Number(staff.active), password_credentials: Number(staff.pw), without_oidc: Number(staff.no_oidc) }, fake_switches: inForce.filter((r) => r.mode === "fake").length,
    real_vendors: inForce.filter((r) => r.mode === "real").map((r) => ({ vendor: r.vendor, endpoint_class: r.endpoint_class, secret_ref: r.secret_ref })), handovers_not_enabled: HUMAN_ROLES.filter((r) => !enabled.has(r)),
    demo_clock_rows: Number(demo.n), synthetic_parties: Number(synth.n), assets: assets.map((a) => ({ ...a, data_classes: a.data_classes ?? [] })), staging_promotion };
}

const pass = (observed: Row, expected: Row): ControlResult => ({ result: "pass", observed, expected });
const fail = (observed: Row, expected: Row): ControlResult => ({ result: "fail", observed, expected });
const unverifiable = (missing: string[], expected: Row, observed: Row = {}): ControlResult => ({ result: "unverifiable", observed: { ...observed, unverifiable: true, missing }, expected });
const has = (o: Row, k: string): boolean => o[k] !== undefined && o[k] !== null;
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const ageDays = (iso: string | null, nowIso: string): number | null => (iso ? Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 86_400_000) : null);
const envNames = (m: ManifestFacts): string[] => [...new Set([...arr(obj(m.terraform["run"])["env_names"]), ...arr(m.runtime["env_names"])].map(s))];

/** One control over the facts. Unknown code → unverifiable (a catalogue version this build does not compute). */
export function evaluateControl(c: ControlRow, f: Facts): ControlResult {
  const m = f.manifest; const tf = m.terraform; const sql = obj(tf["sql"]); const run = obj(tf["run"]); const armor = obj(tf["armor"]); const iam = obj(tf["iam"]); const exp = c.expected;
  switch (c.code) {
    case "PST-01": {
      if (!has(sql, "ipv4_enabled")) return unverifiable(["terraform.sql.ipv4_enabled"], exp);
      const o = { ipv4_enabled: sql["ipv4_enabled"], private_service_access: sql["private_service_access"] ?? null, vpc_egress: run["vpc_egress"] ?? null };
      return sql["ipv4_enabled"] === false && sql["private_service_access"] === true && typeof run["vpc_egress"] === "string" && run["vpc_egress"].trim() !== "" ? pass(o, exp) : fail(o, exp);
    }
    case "PST-02": { if (!has(sql, "availability_type")) return unverifiable(["terraform.sql.availability_type"], exp); const o = { availability_type: sql["availability_type"] }; return s(sql["availability_type"]).toUpperCase() === "REGIONAL" ? pass(o, exp) : fail(o, exp); }
    case "PST-03": {
      const missing = ["pitr", "log_retention_days", "retained_backups"].filter((k) => !has(sql, k)).map((k) => `terraform.sql.${k}`); if (missing.length) return unverifiable(missing, exp);
      const o = { pitr: sql["pitr"], log_retention_days: num(sql["log_retention_days"]), retained_backups: num(sql["retained_backups"]) };
      return sql["pitr"] === true && (o.log_retention_days ?? 0) >= 7 && (o.retained_backups ?? 0) >= 14 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-04": {
      if (!has(sql, "cmek_key") || !has(sql, "rotation_period_s")) return unverifiable(["terraform.sql.cmek_key", "terraform.sql.rotation_period_s"].filter((k) => !has(sql, k.split(".")[2]!)), exp);
      const buckets = arr(tf["buckets"]).map(obj); const registry = obj(tf["registry"]);
      const unkeyed = buckets.filter((b) => !s(b["cmek_key"]).trim()).map((b) => s(b["name"]));
      const o = { sql_cmek_key: s(sql["cmek_key"]) ? "set" : "unset", rotation_period_s: num(sql["rotation_period_s"]), registry_cmek_key: has(registry, "cmek_key") ? (s(registry["cmek_key"]) ? "set" : "unset") : "unknown", buckets_without_cmek: unkeyed, buckets: buckets.length };
      const ok = s(sql["cmek_key"]).trim() !== "" && (o.rotation_period_s ?? Infinity) <= 7_776_000 && unkeyed.length === 0 && (!has(registry, "cmek_key") || s(registry["cmek_key"]).trim() !== "");
      return ok ? pass(o, exp) : fail(o, exp);
    }
    case "PST-05": { const names = envNames(m); if (!names.length) return unverifiable(["terraform.run.env_names"], exp); const o = { api_token_in_env: names.includes("API_TOKEN"), shared_token_requests_24h: f.db.shared_token_requests_24h }; return !o.api_token_in_env && o.shared_token_requests_24h === 0 ? pass(o, exp) : fail(o, exp); }
    case "PST-06": { const o = { password_credentials: f.db.staff.password_credentials, without_oidc: f.db.staff.without_oidc }; return o.password_credentials === 0 && o.without_oidc === 0 ? pass(o, exp) : fail(o, exp); }
    case "PST-07": { if (!Array.isArray(iam["deployer_roles"])) return unverifiable(["terraform.iam.deployer_roles"], exp); const roles = arr(iam["deployer_roles"]).map(s); const o = { deployer_roles: roles }; return !roles.includes("roles/editor") && !roles.includes("roles/owner") ? pass(o, exp) : fail(o, exp); }
    case "PST-08": { if (!has(armor, "waf_preview")) return unverifiable(["terraform.armor.waf_preview"], exp); const o = { waf_preview: armor["waf_preview"], allowlist_count: num(armor["allowlist_count"]) }; return armor["waf_preview"] === false && (o.allowlist_count ?? 0) >= 1 ? pass(o, exp) : fail(o, exp); }
    case "PST-09": {
      const required = [...REQUIRED_SECRETS, ...f.db.real_vendors.map((v) => v.secret_ref).filter((x): x is string => !!x)];
      const byName = new Map(m.secrets.map((e) => [e.name, e] as const));
      const placeholders = m.secrets.filter((e) => e.placeholder).map((e) => e.name);
      const absent = required.filter((n) => !byName.has(n));
      const o = { placeholders, missing_secrets: absent, secrets: m.secrets.length };
      if (!m.secrets.length) return unverifiable(["secrets"], exp, o);
      return placeholders.length === 0 && absent.length === 0 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-10": {
      const rt = m.runtime; if (!has(rt, "integrations")) return unverifiable(["runtime.integrations"], exp);
      const o = { integrations: rt["integrations"], fake_reviewers: rt["fake_reviewers"] ?? null, fake_switches: f.db.fake_switches, handovers_not_enabled: f.db.handovers_not_enabled.length };
      return rt["integrations"] === "real" && (rt["fake_reviewers"] === "off" || rt["fake_reviewers"] === false) && f.db.fake_switches === 0 && f.db.handovers_not_enabled.length === 0 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-11": {
      const st = num(m.runtime["demo_clock_status"]); if (st === null) return unverifiable(["runtime.demo_clock_status"], exp, { demo_clock_rows: f.db.demo_clock_rows, synthetic_parties: f.db.synthetic_parties });
      const o = { demo_clock_status: st, demo_clock_rows: f.db.demo_clock_rows, synthetic_parties: f.db.synthetic_parties };
      return st === 403 && f.db.demo_clock_rows === 0 && f.db.synthetic_parties === 0 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-12": {
      if (!Array.isArray(tf["org_policies"])) return unverifiable(["terraform.org_policies"], exp);
      const pol = arr(tf["org_policies"]).map(s); const sink = obj(tf["audit_sink"]); const missing = ORG_POLICIES.filter((p) => !pol.includes(p));
      const o = { org_policies_missing: missing, audit_sink_locked: sink["locked"] ?? null };
      return missing.length === 0 && sink["locked"] === true ? pass(o, exp) : fail(o, exp);
    }
    case "PST-13": { const p = f.db.staging_promotion; if (!p) return unverifiable(["staging manifest"], exp); const o = { staging_manifest_found: p.found, age_h: p.age_h, staging_run_passing: p.run_passing }; return p.found && p.run_passing === true ? pass(o, exp) : fail(o, exp); }
    case "PST-14": {
      if (!m.secrets.length) return unverifiable(["secrets"], exp);
      const ages = m.secrets.map((e) => ({ name: e.name, age_days: ageDays(e.version_created_at, f.now) }));
      const stale = ages.filter((a) => a.age_days === null || a.age_days > SECRET_MAX_AGE_DAYS);
      const o = { age_days: Math.max(...ages.map((a) => a.age_days ?? 0)), stale: stale.map((a) => a.name), max_age_days: SECRET_MAX_AGE_DAYS };
      return stale.length === 0 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-15": {
      const a = f.db.assets; if (!a.length) return unverifiable(["assets rows for the environment"], exp);
      const unclassified = a.filter((x) => !x.classification || !x.data_classes.length).map((x) => x.name);
      const notRestricted = a.filter((x) => RESTRICTED_ASSET_KINDS.includes(x.kind) && (x.classification !== "restricted" || !x.data_classes.includes("npi"))).map((x) => x.name);
      const o = { assets: a.length, unclassified, not_restricted_npi: notRestricted };
      return unclassified.length === 0 && notRestricted.length === 0 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-16": {
      if (!Array.isArray(run["egress_rules"])) return unverifiable(["terraform.run.egress_rules"], exp);
      const rules = new Set(arr(run["egress_rules"]).map(s)); const real = new Set(f.db.real_vendors.map((v) => v.vendor));
      const o = { rules_without_switch: [...rules].filter((r) => !real.has(r)), switches_without_rule: [...real].filter((v) => !rules.has(v)) };
      return o.rules_without_switch.length === 0 && o.switches_without_rule.length === 0 ? pass(o, exp) : fail(o, exp);
    }
    case "PST-17": {
      const logs = obj(m.runtime["logs"]); if (!has(logs, "sample_lines")) return unverifiable(["runtime.logs"], exp);
      const o = { sample_lines: num(logs["sample_lines"]), email_matches: num(logs["email_matches"]) ?? 0, tin_matches: num(logs["tin_matches"]) ?? 0, name_fields: num(logs["name_fields"]) ?? 0 };
      return (o.sample_lines ?? 0) > 0 && o.email_matches === 0 && o.tin_matches === 0 && o.name_fields === 0 ? pass(o, exp) : fail(o, exp);
    }
    default: return unverifiable([`no evaluator for ${c.code} v${c.version}`], exp);
  }
}
