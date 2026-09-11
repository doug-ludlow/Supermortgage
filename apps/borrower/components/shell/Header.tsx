"use client";

/**
 * 32.14 S0 header (DELTA-14): the brand, the FAKE-mode banner, the loan switch, the partner's phone number and Sign in (S6 —
 * opens the sign-in screen under `auth.welcome_back`). The Record opener stays for the drawer breakpoint.
 *
 * No partner phone number in the header: the FAKE placeholder number was removed; a real one arrives with the telephony vendor.
 */
import type { BorrowerMe } from "@/lib/types/record";
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
};

export function Header({ fixturesMode, me, subject, onSubjectChange, streamLabel, onOpenRecord, showSignIn, onSignIn }: HeaderProps) {
  const subjects = me?.subjects ?? [];
  return (
    <header className="sm-header" data-testid="header">
      <span className="sm-brand">Supermortgage</span>
      {SHOW_FAKE_MARKERS ? (
        <span className="sm-fake-banner" data-testid="fake-banner" title="Fixtures/dev mode: recorded data, FAKE vendors and agents">
          FAKE {fixturesMode ? "fixtures" : "dev"} mode
        </span>
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
      {me ? (
        <span className="sm-source">
          {me.first_name} · {me.level}
        </span>
      ) : null}
      {showSignIn ? (
        <button type="button" className="sm-btn" data-testid="sign-in-button" onClick={onSignIn}>
          Sign in
        </button>
      ) : null}
      <button type="button" className="sm-btn sm-drawer-btn" onClick={onOpenRecord} aria-haspopup="dialog">
        Your record
      </button>
    </header>
  );
}
