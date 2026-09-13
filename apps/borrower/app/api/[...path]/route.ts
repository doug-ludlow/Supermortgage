/**
 * Same-origin proxy: /app/api/v1/borrower/* → ${API_BASE_URL}/v1/borrower/*.
 *
 * Credentials (src/runtime/server.ts, src/runtime/borrower/routes.ts): the borrower API is
 * authenticated by a borrower *session* token as `Authorization: Bearer <session>` — never by
 * the ops API_TOKEN. This proxy keeps that session token in an HttpOnly, Secure cookie
 * (`sm_borrower_session`) that only this server process reads, and forwards it as the bearer;
 * the browser never sees a bearer of any kind. The ops `API_TOKEN` (Secret Manager → env) is
 * likewise server-side only and is never forwarded on borrower routes.
 *
 * Only /v1/borrower/* is reachable through here — the ops console and the rest of the API are
 * not. SSE (/v1/borrower/stream) is streamed through untouched.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_PREFIX = "v1/borrower/";
// 32.17: the FAKE video page posts the vendor's own calls (the custom-LLM request; the token in the path authenticates it) through this origin
const ALLOWED_VIDEO_PREFIX = "v1/video/llm/";
const SESSION_COOKIE = "sm_borrower_session";
const SESSION_MAX_AGE_S = 7 * 24 * 3600; // 7 days with a passkey (01 §5); the API enforces the real idle expiry
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"]);
// 32.14 DELTA-12: auth/oidc's callback answers the same session body as OTP verify, so the cookie is set here too; the
// `x-fake-oidc: FAKE` header the callback page sends in FAKE/dev mode is forwarded like any other non-hop-by-hop header.
// 32.16 DELTA-29: auth/account (create → verify_email, sign_in) answers the same session body — the cookie is set here too.
const AUTH_ROUTES = new Set(["v1/borrower/auth/otp", "v1/borrower/auth/passkey", "v1/borrower/auth/l2", "v1/borrower/auth/oidc", "v1/borrower/auth/account", "v1/borrower/talk"]);   // talk: verify_code answers the same `token` once
// The /app/talk lead token lives in its own HttpOnly cookie (30 days) and rides to the API as `x-borrower-lead` on every
// proxied request — the auth verify routes link the lead to the party from it. (docs/ux/15 DELTA-11, the anonymous minute
// on /v1/borrower/lead, is superseded by docs/ux/17 §0.4 and not built: only talk starts a lead here.)
const LEAD_COOKIE = "sm_borrower_lead";
const LEAD_HEADER = "x-borrower-lead";
const LEAD_ROUTES = new Set(["v1/borrower/talk"]);   // starts a lead and answers `lead_token` once
const LEAD_MAX_AGE_S = 30 * 24 * 3600;

function upstreamBase(): string | null {
  const base = process.env.API_BASE_URL;
  return base ? base.replace(/\/$/, "") : null;
}

function sessionCookie(token: string, req: NextRequest): string {
  const secure = req.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/app; Max-Age=${SESSION_MAX_AGE_S}`;
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!joined.startsWith(ALLOWED_PREFIX) && !joined.startsWith(ALLOWED_VIDEO_PREFIX)) {
    return Response.json({ code: "not_found", copy_key: "error.generic" }, { status: 404 });
  }
  const base = upstreamBase();
  if (!base) {
    // Fixtures/dev mode without an API: make the absence explicit rather than 500.
    return Response.json({ code: "api_not_configured", copy_key: "error.generic", detail: "API_BASE_URL not set" }, { status: 503 });
  }
  const url = new URL(`${base}/${joined}`);
  url.search = req.nextUrl.search;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (!HOP_BY_HOP.has(key) && key !== "authorization" && key !== "cookie" && key !== LEAD_HEADER) headers.set(k, v);
  });
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  if (session) headers.set("authorization", `Bearer ${session}`);
  const lead = req.cookies.get(LEAD_COOKIE)?.value;
  if (lead) headers.set(LEAD_HEADER, lead);
  // WebAuthn (BORROWER_ORIGINS / BORROWER_RP_ID) checks the browser's origin, which the proxy preserves.
  const origin = req.headers.get("origin") ?? req.nextUrl.origin;
  headers.set("origin", origin);
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) headers.set("x-forwarded-for", fwd);

  const isSse = joined === "v1/borrower/stream";   // the chat-completions reply of the video path streams too, with the upstream's own event-stream headers copied above
  const res = await fetch(url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    // @ts-expect-error -- Node fetch needs duplex for a streamed request body
    duplex: "half",
    redirect: "manual",
    cache: "no-store",
    signal: req.signal,
  });

  const out = new Headers();
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (!HOP_BY_HOP.has(key) && key !== "set-cookie") out.set(k, v);
  });

  // A successful auth step returns `{ token, … }`: keep the token server-side in the cookie
  // and hand the browser the rest (level, party, expiry) — never the token itself.
  if ((AUTH_ROUTES.has(joined) || LEAD_ROUTES.has(joined)) && (res.headers.get("content-type") ?? "").includes("application/json")) {
    let body = (await res.json()) as Record<string, unknown>;
    const cookies: string[] = [];
    // a lead start returns `{ lead_token, … }` once — kept server-side in its own cookie, stripped from the body.
    if (LEAD_ROUTES.has(joined) && res.ok && typeof body.lead_token === "string" && body.lead_token) {
      const secure = req.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
      cookies.push(`${LEAD_COOKIE}=${encodeURIComponent(body.lead_token)}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/app; Max-Age=${LEAD_MAX_AGE_S}`);
      const { lead_token: _leadToken, ...rest } = body; body = rest;
    }
    if (LEAD_ROUTES.has(joined) && res.status === 404 && lead) cookies.push(`${LEAD_COOKIE}=; HttpOnly; SameSite=Strict; Path=/app; Max-Age=0`);   // a stale lead cookie (LEAD_UNKNOWN): the app starts over
    if (AUTH_ROUTES.has(joined) && res.ok && typeof body.token === "string" && body.token) {
      cookies.push(sessionCookie(body.token, req));
      const { token: _token, ...rest } = body; body = { ...rest, session: "cookie" };
    }
    for (const c of cookies) out.append("set-cookie", c);
    return Response.json(body, { status: res.status, headers: out });
  }

  if (res.status === 401 && session) {
    // The session expired upstream: drop the cookie so the shell asks for a fresh code.
    out.set("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/app; Max-Age=0`);
  }
  if (isSse) {
    out.set("content-type", "text/event-stream");
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
