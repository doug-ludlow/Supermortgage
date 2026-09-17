"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { formatDateTime, words } from "@/lib/format";
import type { PartnerUser } from "@/lib/types";
import { ErrorLine, ROLE_WORDS, useMe } from "@/components/Shell";

const ROLES = ["partner_ops", "partner_auditor", "partner_admin"] as const;

export function AdminView() {
  const me = useMe();
  const [users, setUsers] = useState<PartnerUser[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (): Promise<void> => { try { setUsers((await api.users()).users); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!me.roles.includes("partner_admin") || (error instanceof ApiRequestError && error.status === 403)) return <div data-testid="admin-refused"><div className="page-head"><h1>Admin</h1></div><div className="empty">The Admin area is a partner admin's.</div></div>;
  if (error) return <ErrorLine error={error} />;
  if (!users) return <p className="note">Loading…</p>;
  return (
    <div data-testid="admin">
      <div className="page-head"><h1>Admin</h1><span className="sub">{me.partner.legal_name} · partner users</span></div>
      <div className="table-wrap">
        <table data-testid="admin-users">
          <thead><tr><th>Name</th><th>E-mail</th><th>Roles</th><th>Status</th><th>Invited</th><th>Enrolled</th><th>Disable</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.partner_user_id} data-testid="admin-user" data-status={u.status}>
                <td>{u.name ?? "—"}</td><td>{u.email ?? "—"}</td><td>{u.roles.map((r) => ROLE_WORDS[r] ?? r).join(", ")}</td>
                <td><span className={`chip ${u.status === "active" ? "ok" : u.status === "disabled" ? "bad" : "warn"}`}>{words(u.status)}</span>{u.locked_until ? <> <span className="chip bad">locked</span></> : null}</td>
                <td>{formatDateTime(u.invited_at)}</td><td>{formatDateTime(u.enrolled_at)}</td>
                <td className="wrap"><span className="note" data-testid="disable-pending">Pending DELTA-01 — no disable command in V1; ask Supermortgage staff.</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Invite a colleague</h2>
      <InviteForm onDone={load} />
    </div>
  );
}

function InviteForm({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState(""); const [name, setName] = useState(""); const [roles, setRoles] = useState<string[]>(["partner_ops"]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const toggle = (r: string): void => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  const submit = (ev: FormEvent): void => {
    ev.preventDefault(); setBusy(true); setError(null); setDone(null);
    api.invite({ email: email.trim(), name: name.trim(), roles }).then(async (r) => { setDone(`Invited as ${r.roles.map((x) => ROLE_WORDS[x] ?? x).join(", ")} — a code goes to their e-mail on their first sign-in.`); setEmail(""); setName(""); await onDone(); }).catch(setError).finally(() => setBusy(false));
  };
  return (
    <form className="form panel" onSubmit={submit} data-testid="invite-form">
      <div className="row">
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} data-testid="invite-name" /></label>
        <label>Work e-mail<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" /></label>
      </div>
      <div className="row">
        {ROLES.map((r) => <label key={r} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} /> {ROLE_WORDS[r]}</label>)}
        <button className="btn" type="submit" disabled={busy || !roles.length} data-testid="invite-submit">Invite</button>
      </div>
      <ErrorLine error={error} />
      {done ? <p className="note" data-testid="invite-done">{done}</p> : null}
    </form>
  );
}
