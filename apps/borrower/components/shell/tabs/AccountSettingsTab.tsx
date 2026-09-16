"use client";

import type { BorrowerMe } from "@/lib/types/record";

/** Party glance from GET /me. Not Account.tsx (that file is the sign-in door). Edits land in a later PR. */
export function AccountSettingsTab({ me }: { me?: BorrowerMe }) {
  return (
    <div className="sm-tab-page" data-testid="tab-page-account">
      <h1 className="sm-tab-title">Account</h1>
      {!me ? (
        <p className="sm-tab-muted">Sign in to see your account.</p>
      ) : (
        <>
          <section className="sm-record-section">
            <h2>You</h2>
            <dl className="sm-kv">
              <dt>Name</dt>
              <dd>{me.first_name}</dd>
              <dt>Identity</dt>
              <dd>{me.level}</dd>
              {me.auth_method ? (
                <>
                  <dt>Sign-in</dt>
                  <dd>{me.auth_method}</dd>
                </>
              ) : null}
            </dl>
          </section>
          <section className="sm-record-section">
            <h2>Partner</h2>
            <dl className="sm-kv">
              <dt>Servicer</dt>
              <dd>{me.partner.legal_name}</dd>
              <dt>NMLS</dt>
              <dd>{me.partner.nmlsr_id}</dd>
            </dl>
          </section>
          <section className="sm-record-section">
            <h2>Files</h2>
            {me.subjects.length === 0 ? (
              <p className="sm-tab-muted">No application or loan on this account yet.</p>
            ) : (
              <ul className="sm-list">
                {me.subjects.map((s, i) => (
                  <li key={s.loan_id ?? s.application_id ?? String(i)}>
                    <span>{s.label}</span>
                    <span className="sm-muted">{s.transaction_type}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="sm-tab-muted">Contact and consent changes ship in a later PR. Sign out is in the header.</p>
        </>
      )}
    </div>
  );
}
