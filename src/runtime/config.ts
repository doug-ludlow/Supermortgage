/**
 * Runtime configuration from the environment (Cloud Run sets PORT; the rest
 * come from Secret Manager or the service definition — see infra/terraform).
 */
export interface RuntimeConfig {
  readonly databaseUrl: string;
  /** Bearer token every route except /healthz and /readyz requires. Empty only with ALLOW_INSECURE_NO_TOKEN=1 (local development). */
  readonly apiToken: string;
  readonly host: string;
  readonly port: number;
  /** `fake` wires the in-memory test doubles for every vendor port; the only value that exists today. */
  readonly integrations: "fake";
  readonly logFormat: "json" | "text";
  readonly environment: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const databaseUrl = env["DATABASE_URL"] ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const apiToken = env["API_TOKEN"] ?? "";
  if (!apiToken && env["ALLOW_INSECURE_NO_TOKEN"] !== "1") throw new Error("API_TOKEN is not set (set ALLOW_INSECURE_NO_TOKEN=1 only for local development)");
  const integrations = env["INTEGRATIONS"] ?? "fake";
  if (integrations !== "fake") throw new Error(`INTEGRATIONS=${integrations} is not implemented; only "fake" (in-memory test doubles) exists`);
  const port = Number(env["PORT"] ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT=${env["PORT"]} is not a port`);
  return { databaseUrl, apiToken, host: env["HOST"] ?? "0.0.0.0", port, integrations, logFormat: env["LOG_FORMAT"] === "text" ? "text" : "json", environment: env["ENVIRONMENT"] ?? "nonprod" };
}
