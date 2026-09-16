/**
 * §35.12 rule 4 — the vendor ports under `INTEGRATIONS`. `fake` (every build stage, docs/DEPLOY.md §7): every port its in-repo FAKE
 * (src/runtime/app.ts fakePorts). `real`: for each vendor the adapter named by the latest `integration_switches` row of
 * (environment, vendor) — `real` → the adapter over its `secret_ref` (the secret is resolved through the SecretsPort at call time,
 * never at construction, never logged); `off` or no row → an OffPort whose every call answers the typed refusal `VENDOR_OFF{vendor}`
 * before any write; `fake` → the FAKE outside production and NO_FAKE_IN_PRODUCTION in production (a start refusal — the runtime
 * itself refuses to serve a request with fakes, edge case 2). A `real` switch for a vendor this repository has no real adapter for
 * yields an OffPort answering `REAL_ADAPTER_MISSING{vendor}` per call (never a start refusal: a confirmed switch must not
 * crash-loop production; `integrations.status` shows `adapter: missing` and the canary logs ok = false). Running instances
 * re-read the table within one sweep (`refreshPorts`, the demo-clock `follow` pattern).
 *
 * Real adapters in this repository: `RealLockbox` (lockbox_bai2 — the bank portal's HTTPS file list under the secret's `{url, token}`
 * payload; [UNVERIFIED endpoint/fields], set with the bank). Every other vendor's real adapter belongs to its owning section.
 * The secrets vault is a vendor too: `FakeSecretManager` is the FAKE (a deterministic payload per ref); `GcpSecretManager` reads
 * Secret Manager's REST API under the runtime service account's metadata token and is wired only under INTEGRATIONS=real.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { LockboxFile, LockboxPort } from "../../../infra/integrations/banking.ts";
import { AdapterUnavailable } from "../../../infra/integrations/failures.ts";
import { fakePorts, type Runtime } from "../../../runtime/app.ts";
import type { Ports } from "../../../app/tools.ts";
import type { Logger } from "../../../runtime/log.ts";
import { VendorOff } from "./refusals.ts";
import { switchesInForce, type SwitchRow } from "./switches.ts";
import { VENDORS, isProduction, type EndpointClass, type SwitchMode } from "./types.ts";

export interface SecretsPort { readonly vendorName: string; resolve(secretRef: string): Promise<string> }
/** The FAKE vault: a deterministic payload per reference — `{url, token}` for a lockbox, the ref itself otherwise. Never a real value. */
export class FakeSecretManager implements SecretsPort {
  readonly vendorName = "FAKE";
  private readonly payloads = new Map<string, string>();
  set(ref: string, payload: string): void { this.payloads.set(ref, payload); }
  async resolve(ref: string): Promise<string> { return this.payloads.get(ref) ?? JSON.stringify({ url: `https://fake-vendor.invalid/${encodeURIComponent(ref)}`, token: `FAKE-${ref.length}` }); }
}
/** Google Secret Manager over REST under the metadata server's token (Cloud Run's runtime service account). [UNVERIFIED — the API shape at HEAD of Google's docs; wired only under INTEGRATIONS=real.] */
export class GcpSecretManager implements SecretsPort {
  readonly vendorName = "gcp-secret-manager";
  private readonly fetchFn: typeof fetch;
  constructor(fetchFn: typeof fetch = fetch) { this.fetchFn = fetchFn; }
  async resolve(ref: string): Promise<string> {
    const tok = await this.fetchFn("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
    if (!tok.ok) throw new AdapterUnavailable("gcp-secret-manager", "metadata_token");
    const { access_token } = (await tok.json()) as { access_token: string };
    const name = /\/versions\//.test(ref) ? ref : `${ref}/versions/latest`;
    const r = await this.fetchFn(`https://secretmanager.googleapis.com/v1/${name}:access`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!r.ok) throw new AdapterUnavailable("gcp-secret-manager", `access:${r.status}`);
    const body = (await r.json()) as { payload?: { data?: string } };
    return Buffer.from(body.payload?.data ?? "", "base64").toString("utf8");
  }
}

/** The real lockbox: the bank portal's file list and downloads over HTTPS under the secret's `{url, token}` (SFTP/PGP in the bank's own terms — [UNVERIFIED endpoint/fields]). */
export class RealLockbox implements LockboxPort {
  readonly vendor = "lockbox_bai2"; readonly secretRef: string; readonly endpointClass: EndpointClass;
  private readonly secrets: SecretsPort; private readonly fetchFn: typeof fetch;
  constructor(secretRef: string, endpointClass: EndpointClass, secrets: SecretsPort, fetchFn: typeof fetch = fetch) { this.secretRef = secretRef; this.endpointClass = endpointClass; this.secrets = secrets; this.fetchFn = fetchFn; }
  async fetch(now: string): Promise<readonly LockboxFile[]> {
    const { url, token } = JSON.parse(await this.secrets.resolve(this.secretRef)) as { url: string; token: string };
    const list = await this.fetchFn(`${url.replace(/\/$/, "")}/files?since=${encodeURIComponent(now)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!list.ok) throw new AdapterUnavailable("lockbox", `bank_portal_download:${list.status}`);
    const files = (await list.json()) as { name: string; content: string; received_at: string }[];
    return files.map((f) => ({ name: f.name, content: f.content, receivedAt: f.received_at }));
  }
}

/** Every call answers the typed refusal — VENDOR_OFF{vendor} (mode off / no row) or REAL_ADAPTER_MISSING{vendor} (a real switch with no adapter here). */
export class RealAdapterMissing extends Error {
  readonly code = "REAL_ADAPTER_MISSING"; readonly vendor: string; readonly method: string;
  constructor(vendor: string, method: string) { super(`REAL_ADAPTER_MISSING{${vendor}}: the ${vendor} switch is real but this build carries no real adapter for it (35.12 rule 4); ${method} was not attempted and nothing was written`); this.name = "RealAdapterMissing"; this.vendor = vendor; this.method = method; }
}
export function offPort<T extends object>(vendor: string, reason: "off" | "missing" = "off"): T {
  const tag = { vendor, reason };
  return new Proxy({} as T, { get: (_t, prop) => { if (prop === PORT_TAG) return tag; if (prop === "then" || typeof prop === "symbol") return undefined; return () => { throw reason === "off" ? new VendorOff(vendor, String(prop)) : new RealAdapterMissing(vendor, String(prop)); }; }, has: (_t, prop) => prop === PORT_TAG });
}
export const PORT_TAG = Symbol.for("supermortgage.port.tag");
export const REAL_ADAPTER_VENDORS: readonly string[] = ["lockbox_bai2"];
/** Which runtime ports each switchable vendor constructs (a port not named by any vendor is `off` under INTEGRATIONS=real: nothing real exists for it here). */
export const VENDOR_PORTS: Readonly<Record<string, readonly (keyof Ports)[]>> = { lockbox_bai2: ["lockbox"], ach_nacha: ["nacha", "custodialBank"], eoscar: ["eoscar"], credit_bureau: ["metro2"], fnma_p360: ["p360"], fnma_smdu: ["smdu"], fnma_lsdu: ["lsdu", "servicingEvents"], fnma_du: ["connect"], print_mail: ["printMail"], edelivery: ["edelivery"], telephony_sms_email: ["telephony"], evault: ["evault", "custodian"], mers: ["mers"], google_oidc: ["oidc"], tavus: ["tavus"] };
const UNSWITCHED_PORTS: readonly (keyof Ports)[] = ["pacer", "dmdc", "erecording", "lpi", "flood", "taxService", "mi"];

export interface PortDescription { readonly port: string; readonly vendor: string | null; readonly adapter: "FAKE" | "real" | "off" | "missing"; readonly secret_ref: string | null; readonly endpoint_class: EndpointClass | null }
export interface BuildPortsOptions { readonly integrations: "fake" | "real"; readonly environment: string; readonly db: Queryable; readonly secrets?: SecretsPort; readonly logger?: Logger; readonly fetchFn?: typeof fetch }
export interface BuiltPorts { readonly ports: Ports; readonly description: readonly PortDescription[]; readonly modes: ReadonlyMap<string, SwitchRow> }

function realAdapter(vendor: string, row: SwitchRow, secrets: SecretsPort, fetchFn: typeof fetch): Partial<Ports> | null {
  switch (vendor) {
    case "lockbox_bai2": return { lockbox: new RealLockbox(row.secret_ref ?? "", row.endpoint_class, secrets, fetchFn) };
    default: return null;
  }
}
/** The ports for the environment under `integrations` — rule 4. Throws `NO_FAKE_IN_PRODUCTION` for `fake` in production (or a production `fake` row). */
export async function buildPorts(o: BuildPortsOptions): Promise<BuiltPorts> {
  const production = isProduction(o.environment);
  if (o.integrations === "fake") {
    if (production) throw new Error("NO_FAKE_IN_PRODUCTION: INTEGRATIONS=fake never serves production (35.12 rule 4; 35.7 rule 6) — set INTEGRATIONS=real and throw each vendor's switch");
    const ports = fakePorts();
    return { ports, description: describePorts(ports), modes: new Map() };
  }
  const modes = await switchesInForce(o.db, o.environment);
  const fake = fakePorts(); const secrets = o.secrets ?? new GcpSecretManager(o.fetchFn); const fetchFn = o.fetchFn ?? fetch;
  const out: Partial<Ports> = {};
  for (const vendor of VENDORS) {
    const names = VENDOR_PORTS[vendor]; if (!names) continue;
    const row = modes.get(vendor); const mode: SwitchMode = row?.mode ?? "off";
    if (mode === "fake") {
      if (production) throw new Error(`NO_FAKE_IN_PRODUCTION: the ${vendor} switch is fake in production (35.12 rule 4; 35.7 rule 6)`);
      for (const n of names) (out as Record<string, unknown>)[n] = fake[n];
    } else if (mode === "real") {
      const real = realAdapter(vendor, row!, secrets, fetchFn);
      for (const n of names) (out as Record<string, unknown>)[n] = real && real[n] ? real[n] : tagged(offPort<object>(vendor, "missing"), { vendor, adapter: "missing", secret_ref: row!.secret_ref, endpoint_class: row!.endpoint_class });
      if (!real) o.logger?.warn("integration real adapter missing", { vendor, environment: o.environment, ports: names });
    } else for (const n of names) (out as Record<string, unknown>)[n] = offPort<object>(vendor, "off");
  }
  for (const n of UNSWITCHED_PORTS) (out as Record<string, unknown>)[n] = offPort<object>(n, "off");
  const ports = out as Ports;
  return { ports, description: describePorts(ports, modes), modes };
}
const tags = new WeakMap<object, Partial<PortDescription>>();
const tagged = <T extends object>(p: T, d: Partial<PortDescription>): T => { tags.set(p, d); return p; };
/** What each port is: FAKE (a Fake* class), real (an adapter with a secret_ref), off or missing (an OffPort). Never a secret. */
export function describePorts(ports: Partial<Ports>, modes?: ReadonlyMap<string, SwitchRow>): PortDescription[] {
  const vendorOfPort = new Map<string, string>(); for (const [v, names] of Object.entries(VENDOR_PORTS)) for (const n of names) vendorOfPort.set(n, v);
  const out: PortDescription[] = [];
  for (const [name, p] of Object.entries(ports)) {
    if (!p || typeof p !== "object") continue;
    const tag = (p as unknown as Record<symbol, unknown>)[PORT_TAG] as { vendor: string; reason: "off" | "missing" } | undefined;
    const vendor = vendorOfPort.get(name) ?? null; const row = vendor ? modes?.get(vendor) : undefined;
    if (tag) out.push({ port: name, vendor: tag.vendor, adapter: tag.reason === "off" ? "off" : "missing", secret_ref: row?.secret_ref ?? tags.get(p)?.secret_ref ?? null, endpoint_class: row?.endpoint_class ?? null });
    else if ((p as { vendorName?: string }).vendorName === "FAKE" || /^Fake/.test(p.constructor?.name ?? "")) out.push({ port: name, vendor, adapter: "FAKE", secret_ref: null, endpoint_class: null });
    else out.push({ port: name, vendor, adapter: "real", secret_ref: (p as { secretRef?: string }).secretRef ?? row?.secret_ref ?? null, endpoint_class: (p as { endpointClass?: EndpointClass }).endpointClass ?? row?.endpoint_class ?? null });
  }
  return out;
}
/** Rule 4: running instances re-read the table within one sweep — the runtime's ports are rebuilt from the switches in force and swapped in place. */
export async function refreshPorts(rt: Runtime, o: { secrets?: SecretsPort; logger?: Logger } = {}): Promise<BuiltPorts | null> {
  if ((rt.env["INTEGRATIONS"] ?? "fake") !== "real") return null;
  const built = await buildPorts({ integrations: "real", environment: rt.environment, db: rt.db, ...(o.secrets ? { secrets: o.secrets } : {}), ...(o.logger ? { logger: o.logger } : {}) });
  const target = rt.ports as Record<string, unknown>;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, built.ports);
  return built;
}
