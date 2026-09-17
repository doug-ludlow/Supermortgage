/**
 * Same-origin cookie proxy: /partners/api/v1/partner/* → ${API_BASE_URL}/v1/partner/* (docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §6).
 *
 * The partner API (src/runtime/partner-portal/routes.ts) is authenticated by a partner *session* as `Authorization: Bearer
 * <session>` and by nothing else — never a staff cookie, never the machine API_TOKEN (36.1 rule 7). This proxy keeps that
 * session in an HttpOnly cookie (`sm_partner_session`, Path=/partners, Secure in production, SameSite=Lax) that only this
 * server process reads, and forwards it as the bearer; the browser never sees a bearer of any kind.
 *
 * Only /v1/partner/* is reachable through here (lib/proxy-allow.ts): /v1/partner-book/*, /ops and /v1/borrower/* are not.
 */
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_ROUTES, SIGN_OUT_ROUTE, clearedSessionCookie, sessionCookie, upstreamPathAllowed } from "@/lib/proxy-allow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"]);

function upstreamBase(): string | null {
  const base = process.env.API_BASE_URL;
  return base ? base.replace(/\/$/, "") : null;
}
const isSecure = (req: NextRequest): boolean => req.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (!upstreamPathAllowed(path)) return Response.json({ error: "not_found", code: "NOT_FOUND" }, { status: 404 });
  const joined = path.join("/");
  const base = upstreamBase();
  if (!base) return Response.json({ error: "api_not_configured", code: "API_NOT_CONFIGURED", reason: "API_BASE_URL not set" }, { status: 503 });
  const url = new URL(`${base}/${joined}`);
  url.search = req.nextUrl.search;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    // never a cookie, never a caller's bearer, never a staff / actor header: the session cookie is the only credential that rides (36.1 rule 7)
    if (!HOP_BY_HOP.has(key) && key !== "authorization" && key !== "cookie" && !key.startsWith("x-actor-") && key !== "x-staff-role") headers.set(k, v);
  });
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  if (session) headers.set("authorization", `Bearer ${session}`);
  headers.set("origin", req.headers.get("origin") ?? req.nextUrl.origin);
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) headers.set("x-forwarded-for", fwd);

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

  // a session answer (`{ token, … }` on signin / passkey assert): the token becomes the cookie; the browser gets the rest
  if (SESSION_ROUTES.has(joined) && (res.headers.get("content-type") ?? "").includes("application/json")) {
    let body = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof body.token === "string" && body.token) {
      out.append("set-cookie", sessionCookie(body.token, isSecure(req)));
      const { token: _token, ...rest } = body; body = { ...rest, session: "cookie" };
    }
    return Response.json(body, { status: res.status, headers: out });
  }
  if (joined === SIGN_OUT_ROUTE) {
    out.append("set-cookie", clearedSessionCookie(isSecure(req)));
    return Response.json({ signed_out: true }, { status: 200, headers: out });
  }
  // 36.1 rule 6: the session ended upstream (401 SESSION_EXPIRED / AUTH_REQUIRED) — drop the cookie; the app returns to /partners/sign-in keeping the return path
  if (res.status === 401 && session) out.set("set-cookie", clearedSessionCookie(isSecure(req)));
  return new Response(res.body, { status: res.status, headers: out });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
