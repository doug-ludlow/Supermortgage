"use client";
/**
 * The console shell: the partner's legal name and NMLSR id (GLBA — the partner's book, never a Supermortgage funnel), the nav in
 * its fixed order (§7: Home, Book, Eligibility, Pipeline, Reports, Admin — Admin for partner_admin only), who is signed in under
 * which role, Sign out. `GET /v1/partner/me` opens the shell; a 401 sends the page to /partners/sign-in with the return path.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { api, ApiRequestError, BASE_PATH, signInUrl } from "@/lib/api/client";
import type { PartnerMe } from "@/lib/types";

const MeContext = createContext<PartnerMe | null>(null);
export const useMe = (): PartnerMe => { const me = useContext(MeContext); if (!me) throw new Error("useMe outside the shell"); return me; };

/** The nav, in the fixed order of §7. `href` is relative to the base path (Next prefixes /partners). */
const NAV: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/", label: "Home" },
  { href: "/book", label: "Book" },
  { href: "/eligibility", label: "Eligibility" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/reports", label: "Reports" },
  { href: "/admin", label: "Admin", adminOnly: true },
];
export const ROLE_WORDS: Record<string, string> = { partner_admin: "Admin", partner_ops: "Ops", partner_auditor: "Auditor" };

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<PartnerMe | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    let alive = true;
    api.me().then((m) => { if (alive) setMe(m); }).catch((e: unknown) => {
      if (!alive) return;
      if (e instanceof ApiRequestError && e.status === 401) { window.location.replace(signInUrl(`${BASE_PATH}${pathname === "/" ? "" : pathname}`)); return; }   // a full path: Next's router would prefix the base path again
      setFailed(e instanceof ApiRequestError ? `${e.status} ${e.body.code}` : String(e));
    });
    return () => { alive = false; };
  }, [pathname]);
  const signOut = async (): Promise<void> => { try { await api.signOut(); } finally { window.location.replace(signInUrl(null)); } };
  if (failed) return <div className="main"><div className="error" role="alert">The portal could not open: {failed}</div></div>;
  if (!me) return <div className="main" data-testid="shell-loading"><p className="note">Opening…</p></div>;
  const isAdmin = me.roles.includes("partner_admin");
  return (
    <MeContext.Provider value={me}>
      <div className="shell" data-testid="partner-shell" data-role={me.role}>
        <header className="topbar">
          <div className="brand">
            <strong data-testid="partner-legal-name">{me.partner.legal_name ?? "Partner portal"}</strong>
            <span>{me.partner.nmlsr_id ? `NMLSR ID ${me.partner.nmlsr_id} · ` : ""}Servicing partner portal</span>
          </div>
          <nav className="nav" aria-label="Sections" data-testid="nav">
            {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
              <Link key={n.href} href={n.href} aria-current={(n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)) ? "page" : undefined}>{n.label}</Link>
            ))}
          </nav>
          <div className="who">
            <span data-testid="who">{me.name ?? "Partner user"} · {me.roles.map((r) => ROLE_WORDS[r] ?? r).join(", ")}</span>
            <button type="button" className="btn secondary" onClick={() => { void signOut(); }} data-testid="sign-out">Sign out</button>
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </MeContext.Provider>
  );
}

/** A section's error line: a refusal's code and reason, never a stack. */
export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const text = error instanceof ApiRequestError ? `${error.body.code}${error.body.reason ? ` — ${error.body.reason}` : ""}` : error instanceof Error ? error.message : String(error);
  return <div className="error" role="alert">{text}</div>;
}
