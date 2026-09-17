import { describe, expect, it } from "vitest";
import { COOKIE_PATH, SESSION_COOKIE, SESSION_ROUTES, SIGN_OUT_ROUTE, clearedSessionCookie, sessionCookie, upstreamPathAllowed } from "@/lib/proxy-allow";

describe("the cookie proxy forwards only to /v1/partner/* (§6)", () => {
  it("allows the partner prefix", () => {
    for (const p of [["v1", "partner", "me"], ["v1", "partner", "home"], ["v1", "partner", "auth", "code"], ["v1", "partner", "book", "imports"], ["v1", "partner", "loans", "abc", "serviced"], ["v1", "partner", "reports", "daily", "export"]]) expect(upstreamPathAllowed(p), p.join("/")).toBe(true);
  });
  it("never forwards to /v1/partner-book/*, /ops or /v1/borrower/*", () => {
    for (const p of [["v1", "partner-book", "imports"], ["v1", "partner-book", "holds"], ["ops"], ["ops", "api", "partner-book", "loans"], ["v1", "borrower", "me"], ["v1", "video", "llm", "x"], ["v1", "tools"], ["v1", "sweep"], ["healthz"]]) expect(upstreamPathAllowed(p), p.join("/")).toBe(false);
  });
  it("refuses the bare prefix, empty and dot segments", () => {
    for (const p of [[], ["v1", "partner"], ["v1", "partner", ""], ["v1", "partner", ".."], ["v1", "partner", "..", "partner-book"], ["v1", "partner", "a/b"], ["v1", "partner", "a\\b"]]) expect(upstreamPathAllowed(p), p.join("/")).toBe(false);
  });
  it("turns a session answer into the cookie on the two session routes only", () => {
    expect([...SESSION_ROUTES].sort()).toEqual(["v1/partner/auth/passkey/assert", "v1/partner/auth/signin"]);
    expect(SESSION_ROUTES.has("v1/partner/auth/verify")).toBe(false);   // the enrol/step token must reach the browser
    expect(SIGN_OUT_ROUTE).toBe("v1/partner/auth/signout");
  });
  it("sets sm_partner_session HttpOnly, SameSite=Lax, Path=/partners, Secure in production", () => {
    expect(SESSION_COOKIE).toBe("sm_partner_session"); expect(COOKIE_PATH).toBe("/partners");
    const prod = sessionCookie("tok en", true);
    expect(prod).toMatch(/^sm_partner_session=tok%20en; HttpOnly; Secure; SameSite=Lax; Path=\/partners; Max-Age=43200$/);
    const dev = sessionCookie("t", false);
    expect(dev).not.toContain("Secure"); expect(dev).toContain("HttpOnly"); expect(dev).toContain("SameSite=Lax"); expect(dev).toContain("Path=/partners");
    expect(clearedSessionCookie(false)).toMatch(/^sm_partner_session=; HttpOnly; SameSite=Lax; Path=\/partners; Max-Age=0$/);
  });
});
