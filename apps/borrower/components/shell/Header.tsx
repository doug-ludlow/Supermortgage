"use client";

/**
 * Header: brand, Dual Mode nav (Home / Guide — docs/ux/18), FAKE banner, subject switcher,
 * Sign in / out. The AI disclosure is the footer. The rail opener stays for the drawer breakpoint
 * and for Workspace Home (the Record is a drawer on that surface at every width).
 */
import Link from "next/link";
import type { BorrowerMe } from "@/lib/types/record";
import { copy } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

export type HeaderProps = {
  fixturesMode: boolean;
  me?: BorrowerMe;
  subject?: string;
  onSubjectChange: (subject: string) => void;
  /** "connecting…" / "reconnecting…" while the SSE stream is not open. */
  streamLabel?: string;
  onOpenRecord: () => void;
  /** No session (or FAKE fixtures mode, so the screen can be demoed): show Sign in. */
  showSignIn: boolean;
  onSignIn: () => void;
  /** A session exists: Sign out revokes it and drops the cookies (32.16 §2.0 — a shared browser never carries one person's account to the next). */
  onSignOut?: (() => void) | undefined;
  /** docs/ux/18: which Dual Mode surface this shell is. */
  surface?: "workspace" | "guide";
  /** Workspace: Guide in the header opens the drawer (the conversation stays one tap away). */
  onOpenGuide?: () => void;
  /** Preserve fixture/subject/card across Home ↔ Guide (docs/ux/18). */
  querySuffix?: string;
};

export function Header({ fixturesMode, me, subject, onSubjectChange, streamLabel, onOpenRecord, showSignIn, onSignIn, onSignOut, surface = "workspace", onOpenGuide, querySuffix = "" }: HeaderProps) {
  const subjects = me?.subjects ?? [];
  const suffix = querySuffix;
  return (
    <header className="sm-header" data-testid="header">
      <Link href={`/${suffix}`} className="sm-brand" data-testid="brand">
        Supermortgage
      </Link>
      {SHOW_FAKE_MARKERS ? (
        <span className="sm-fake-banner" data-testid="fake-banner" title="Fixtures/dev mode: recorded data, FAKE vendors and agents">
          FAKE {fixturesMode ? "fixtures" : "dev"} mode
        </span>
      ) : null}
      {me ? (
        <nav className="sm-header-nav" aria-label={copy("workspace.home.title")} data-testid="workspace-nav">
          <Link href={`/${suffix}`} className="sm-nav-link" data-testid="nav-home" data-current={surface === "workspace" ? "true" : undefined} aria-current={surface === "workspace" ? "page" : undefined}>
            {copy("workspace.nav.home")}
          </Link>
          {surface === "workspace" && onOpenGuide ? (
            <button type="button" className="sm-nav-link sm-nav-link-btn" data-testid="nav-guide" onClick={onOpenGuide}>
              {copy("workspace.nav.guide")}
            </button>
          ) : (
            <Link href={`/guide${suffix}`} className="sm-nav-link" data-testid="nav-guide" data-current={surface === "guide" ? "true" : undefined} aria-current={surface === "guide" ? "page" : undefined}>
              {copy("workspace.nav.guide")}
            </Link>
          )}
        </nav>
      ) : null}
      {subjects.length > 1 ? (
        <label className="sm-visually-hidden" htmlFor="subject-switch">
          Which loan
        </label>
      ) : null}
      {subjects.length > 1 ? (
        <select id="subject-switch" className="sm-select" style={{ width: "auto", minHeight: 36 }} value={subject ?? ""} onChange={(e) => onSubjectChange(e.target.value)}>
          {subjects.map((s) => {
            const v = s.loan_id ? `loan:${s.loan_id}` : `application:${s.application_id}`;
            return (
              <option key={v} value={v}>
                {s.label}
              </option>
            );
          })}
        </select>
      ) : null}
      <span className="sm-header-spacer" />
      {streamLabel ? <span className="sm-source">{streamLabel}</span> : null}
      {me?.first_name ? (
        <span className="sm-source" data-testid="header-name">
          {me.first_name}
        </span>
      ) : null}
      {showSignIn ? (
        <button type="button" className="sm-btn" data-testid="sign-in-button" onClick={onSignIn}>
          Sign in
        </button>
      ) : null}
      {me && onSignOut ? (
        <button type="button" className="sm-linkbtn" data-testid="sign-out-button" onClick={onSignOut}>
          Sign out
        </button>
      ) : null}
      <button type="button" className="sm-btn sm-drawer-btn" onClick={onOpenRecord} aria-haspopup="dialog">
        Your record
      </button>
    </header>
  );
}
