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
  /** 32.14 DELTA-15: the Phase I partner (a `parties` row id) the organic entry names when no application names one; empty → the newest servicer party. */
  readonly borrowerDefaultPartnerId: string;
  /** 32.14 DELTA-12: the Google OAuth client for Sign in with Google (Secret Manager `supermortgage-google-oauth-client-id` / `-secret`); empty under INTEGRATIONS=fake, where FakeGoogleOidc is the only provider. A placeholder version reads as unset. */
  readonly googleOauth: { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string };
}

/** Secret Manager needs a first version before Cloud Run can start the service; Terraform writes this placeholder and a human replaces it. */
export const SECRET_PLACEHOLDER = "unset";
const secret = (v: string | undefined): string => (v === undefined || v.trim() === SECRET_PLACEHOLDER ? "" : v.trim());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const databaseUrl = env["DATABASE_URL"] ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const apiToken = env["API_TOKEN"] ?? "";
  if (!apiToken && env["ALLOW_INSECURE_NO_TOKEN"] !== "1") throw new Error("API_TOKEN is not set (set ALLOW_INSECURE_NO_TOKEN=1 only for local development)");
  const integrations = env["INTEGRATIONS"] ?? "fake";
  if (integrations !== "fake") throw new Error(`INTEGRATIONS=${integrations} is not implemented; only "fake" (in-memory test doubles) exists`);
  const port = Number(env["PORT"] ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT=${env["PORT"]} is not a port`);
  const borrowerDefaultPartnerId = (env["BORROWER_DEFAULT_PARTNER_ID"] ?? "").trim();
  if (borrowerDefaultPartnerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(borrowerDefaultPartnerId)) throw new Error("BORROWER_DEFAULT_PARTNER_ID must be a parties row id (uuid) or empty");
  const googleOauth = { clientId: secret(env["GOOGLE_OAUTH_CLIENT_ID"]), clientSecret: secret(env["GOOGLE_OAUTH_CLIENT_SECRET"]), redirectUri: (env["GOOGLE_OAUTH_REDIRECT"] ?? "").trim() };
  return { databaseUrl, apiToken, host: env["HOST"] ?? "0.0.0.0", port, integrations, logFormat: env["LOG_FORMAT"] === "text" ? "text" : "json", environment: env["ENVIRONMENT"] ?? "nonprod", borrowerDefaultPartnerId, googleOauth };
}
