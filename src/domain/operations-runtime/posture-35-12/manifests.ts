/**
 * §35.12 rule 1 — `posture.record`: the deploy workflow's last step before the smoke posts the environment as it is (Terraform and
 * runtime facts, secret names and version dates — never a payload). The tool validates the shape, refuses a value-shaped secret
 * field NO_PII_IN_EVIDENCE before any write (guards.ts refuses it on the bus too), computes `env_hash` (sha-256 over the canonical
 * JSON of terraform, secret names and ages bucketed by day, runtime), writes the `environment_manifests` row, a hashed `documents`
 * row and 19.2's `assets` rows (one per instance, bucket, key, service and secret with classification and data classes — inserted
 * when absent), logs `posture.recorded`, and runs `posture.check` in the same request (check.ts). Idempotency: the same facts give
 * the same `env_hash`; a repeat is a new manifest row (append-only) with no new finding.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { sha256Hex } from "../../../runtime/controls/common.ts";
import { runPostureCheck, type CheckRunResult } from "./check.ts";
import type { ManifestFacts, SecretEntry } from "./controls.ts";
import { byOf } from "./decision.ts";
import { hashedDocument, refuse, requireRoleOrService, writeDocument, type PostureDeps } from "./deps.ts";
import { manifestCarriesValue } from "./guards.ts";
import { ENVIRONMENTS, P, arr, canonicalJson, environmentOf, isUuid, obj, s, type Row } from "./types.ts";

export interface ManifestInput { readonly environment: string; readonly project_id: string; readonly region: string; readonly image_digest: string; readonly migration_head: string; readonly terraform: Row; readonly secrets: readonly SecretEntry[]; readonly runtime: Row; readonly deploy_run_id: string | null }
export interface RecordResult { readonly manifest_id: string; readonly environment: string; readonly env_hash: string; readonly document_id: string; readonly image_digest: string; readonly migration_head: string; readonly deploy_run_id: string | null; readonly check: CheckRunResult; readonly by: string }
export interface ManifestRow extends ManifestFacts { readonly id: string; readonly project_id: string; readonly region: string; readonly env_hash: string; readonly deploy_run_id: string | null; readonly document_id: string | null }
export const MANIFEST_COLS = `id::text AS id, environment, project_id, region, image_digest, migration_head, terraform, secrets, runtime, env_hash, deploy_run_id, recorded_by::text AS recorded_by, document_id::text AS document_id, created_at::text AS created_at`;
export const RECORD_ROLES: readonly string[] = ["ciso", "compliance", "admin"];

/** The manifest as the tool receives it — every value a name, a flag, a count or a date; a payload-shaped field is refused. */
export function parseManifest(i: Row): ManifestInput {
  const environment = environmentOf(i["environment"]);
  if (!ENVIRONMENTS.includes(environment)) throw new RangeError(`environment must be one of ${ENVIRONMENTS.join(", ")}`);
  for (const k of ["project_id", "region", "image_digest", "migration_head"]) if (typeof i[k] !== "string" || !(i[k] as string).trim()) throw new RangeError(`${k} is required`);
  const pii = manifestCarriesValue(i);
  if (pii) refuse(409, "NO_PII_IN_EVIDENCE", `posture.record: ${pii}; the manifest records secret names and version dates only (35.12 Inputs: values only — never a secret's payload)`, { field: pii });
  const secrets: SecretEntry[] = arr(i["secrets"]).map((e) => { const o = obj(e); return { name: s(o["name"]), version_created_at: typeof o["version_created_at"] === "string" ? o["version_created_at"] : null, placeholder: o["placeholder"] === true }; });
  return { environment, project_id: s(i["project_id"]), region: s(i["region"]), image_digest: s(i["image_digest"]), migration_head: s(i["migration_head"]), terraform: obj(i["terraform"]), secrets, runtime: obj(i["runtime"]), deploy_run_id: typeof i["deploy_run_id"] === "string" && i["deploy_run_id"].trim() ? i["deploy_run_id"] : null };
}
/** sha-256 over the canonical JSON of terraform, the secrets' names + version day + placeholder flag, and runtime. */
export const envHashOf = (m: ManifestInput): string => sha256Hex(canonicalJson({ terraform: m.terraform, secrets: [...m.secrets].sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({ name: e.name, version_day: e.version_created_at ? e.version_created_at.slice(0, 10) : null, placeholder: e.placeholder })), runtime: m.runtime }));

export async function latestManifest(q: Queryable, environment: string): Promise<ManifestRow | undefined> { return (await q.query<ManifestRow & Record<string, unknown>>(`SELECT ${MANIFEST_COLS} FROM environment_manifests WHERE environment = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [environment]))[0]; }
export async function manifestById(q: Queryable, id: string): Promise<ManifestRow | undefined> { return isUuid(id) ? (await q.query<ManifestRow & Record<string, unknown>>(`SELECT ${MANIFEST_COLS} FROM environment_manifests WHERE id = $1`, [id]))[0] : undefined; }

/** 19.2's asset inventory rows the manifest names — inserted when absent (a classification the posture check then measures, PST-15). */
export interface AssetRow { readonly kind: string; readonly name: string; readonly classes: string[] }
export function assetRowsOf(m: ManifestInput): AssetRow[] {
  const sql = obj(m.terraform["sql"]); const rows: AssetRow[] = [];
  rows.push({ kind: "database", name: `${m.environment}:cloudsql`, classes: ["npi", "financial"] });
  rows.push({ kind: "service", name: `${m.environment}:cloudrun-api`, classes: ["npi"] });
  if (s(sql["cmek_key"]).trim()) rows.push({ kind: "key", name: `${m.environment}:kms:${s(sql["cmek_key"])}`, classes: ["npi", "key_material"] });
  for (const b of arr(m.terraform["buckets"]).map(obj)) if (s(b["name"]).trim()) rows.push({ kind: "bucket", name: `${m.environment}:bucket:${s(b["name"])}`, classes: ["npi", "documents"] });
  for (const e of m.secrets) rows.push({ kind: "key", name: `${m.environment}:secret:${e.name}`, classes: ["npi", "secret"] });
  return rows;
}
async function writeAssets(q: Queryable, m: ManifestInput): Promise<number> {
  const rows = assetRowsOf(m);
  let inserted = 0;
  for (const r of rows) {
    const done = await q.query<{ id: string }>(`INSERT INTO assets (kind, name, owner, location, classification, data_classes, tier, rto_hours, rpo_minutes) SELECT $1, $2, 'ciso', $3, 'restricted', $4::text[], 1, 4, 5 WHERE NOT EXISTS (SELECT 1 FROM assets WHERE kind = $1 AND name = $2) RETURNING id`, [r.kind, r.name, m.region, r.classes]);
    inserted += done.length;
  }
  return inserted;
}

/** `posture.record` — a 35.7 service principal (the deploy workflow) or a ciso/compliance/admin session. */
export async function recordManifest(d: PostureDeps, raw: Row): Promise<RecordResult> {
  const m = parseManifest(raw);
  await requireRoleOrService(d, RECORD_ROLES, "posture.record", m.environment);
  const manifest_id = randomUUID(); const env_hash = envHashOf(m);
  const doc = hashedDocument("manifest", { environment: m.environment, project_id: m.project_id, region: m.region, image_digest: m.image_digest, migration_head: m.migration_head, terraform: m.terraform, secrets: m.secrets, runtime: m.runtime, deploy_run_id: m.deploy_run_id, env_hash });
  const recorded_by = d.actor.kind !== "human" ? await principalIdOf(d.db, d.actor.id) : null;
  d.deferWrite(async (q) => {
    await writeDocument(q, doc, { kind: "environment_manifest", retention: "security_logs_5y", metadata: { environment: m.environment, env_hash, image_digest: m.image_digest, migration_head: m.migration_head, deploy_run_id: m.deploy_run_id, manifest_id }, created_at: d.now });
    await q.query(`INSERT INTO environment_manifests (id, environment, project_id, region, image_digest, migration_head, terraform, secrets, runtime, env_hash, deploy_run_id, recorded_by, document_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14::timestamptz)`,
      [manifest_id, m.environment, m.project_id, m.region, m.image_digest, m.migration_head, toJson(m.terraform), toJson(m.secrets), toJson(m.runtime), env_hash, m.deploy_run_id, recorded_by, doc.id, d.now]);
    await writeAssets(q, m);
  });
  d.events.append({ type: "posture.recorded", aggregate: { kind: "environment_manifest", id: manifest_id }, actor: d.actor, payload: P({ manifest_id, environment: m.environment, image_digest: m.image_digest, migration_head: m.migration_head, env_hash, deploy_run_id: m.deploy_run_id, document_id: doc.id, sha256: doc.sha256, by: byOf(d.actor) }) });
  // the check follows within the same request, over the facts just posted (the rows land in this transaction's commit; the check reads the facts from memory)
  const facts: ManifestFacts = { id: manifest_id, environment: m.environment, image_digest: m.image_digest, migration_head: m.migration_head, terraform: m.terraform, secrets: m.secrets, runtime: m.runtime, created_at: d.now };
  // the assets rows land in this transaction's commit; the check reads them from the manifest (PST-15) as the rows it is about to write
  const check = await runPostureCheck(d, { environment: m.environment, manifest: facts, trigger: "manifest", pendingAssets: assetRowsOf(m).map((r) => ({ kind: r.kind, name: r.name, classification: "restricted", data_classes: r.classes })) });
  return { manifest_id, environment: m.environment, env_hash, document_id: doc.id, image_digest: m.image_digest, migration_head: m.migration_head, deploy_run_id: m.deploy_run_id, check, by: byOf(d.actor) };
}
async function principalIdOf(q: Queryable, name: string): Promise<string | null> {
  const [r] = await q.query<{ id: string }>(`SELECT id::text AS id FROM api_principals WHERE name = $1 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`, [name]);
  return r?.id ?? null;
}
