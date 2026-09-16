"use client";

/**
 * 32.19 §2.1 / §2.3 (docs/ux/18) — the door for a browser with no session (`welcome` → `intro` → `account`, the
 * existing `Account` form skinned by apply.css) and the four tabs beside Apply (Chat, My Loan, Tasks, Account).
 * `signedIn = Boolean(me)`; `footer.disclosure` is rendered by the chrome on every screen including the door.
 * Every rendered string is a copy key.
 */
import { Account } from "@/components/account/Account";
import { copy, copyOptions } from "@/lib/copy";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { TASKS, stepOfCopyKey, type Door, type Draft, type Step, type Tab, type TaskId } from "./apply-model";

export type DoorProps = {
  door: Door;
  accountMode: "sign_up" | "sign_in";
  setDoor: (d: Door) => void;
  setAccountMode: (m: "sign_up" | "sign_in") => void;
  /** After `POST auth/account` (or the code door) opened the session: poll `me` until the organic application appears. */
  onSession: () => void;
};

export function DoorScreens(p: DoorProps) {
  if (p.door === "welcome") {
    return (
      <div className="sm-bubble">
        <h1 data-copy-key="apply.door.title">{copy("apply.door.title")}</h1>
        <p className="sm-hero" data-copy-key="apply.door.tagline">{copy("apply.door.tagline")}</p>
        <button type="button" className="sm-primary" data-testid="apply-continue" data-copy-key="apply.continue" onClick={() => p.setDoor("intro")}>{copy("apply.continue")}</button>
      </div>
    );
  }
  if (p.door === "intro") {
    return (
      <div className="sm-bubble">
        <h1 data-copy-key="apply.door.what">{copy("apply.door.what")}</h1>
        <p data-copy-key="apply.door.what_body">{copy("apply.door.what_body")}</p>
        <p data-copy-key="apply.door.what_more">{copy("apply.door.what_more")}</p>
        <button type="button" className="sm-primary" data-testid="apply-continue" data-copy-key="apply.door.create" onClick={() => { p.setAccountMode("sign_up"); p.setDoor("account"); }}>{copy("apply.door.create")}</button>
        <button type="button" className="sm-link" data-testid="apply-have-account" data-copy-key="apply.door.have_account" onClick={() => { p.setAccountMode("sign_in"); p.setDoor("account"); }}>{copy("apply.door.have_account")}</button>
      </div>
    );
  }
  return (
    <div className="sm-bubble sm-bubble-account">
      <Account
        mode={p.accountMode}
        onSession={() => p.onSession()}
        navigate={(url) => {
          if (url.includes("google")) window.location.assign(url);
          else p.onSession();
        }}
      />
      <button type="button" className="sm-link" data-testid="apply-account-switch" data-copy-key={p.accountMode === "sign_up" ? "apply.door.sign_in_instead" : "apply.door.create"} onClick={() => p.setAccountMode(p.accountMode === "sign_up" ? "sign_in" : "sign_up")}>
        {p.accountMode === "sign_up" ? copy("apply.door.sign_in_instead") : copy("apply.door.create")}
      </button>
    </div>
  );
}

export type TabProps = {
  tab: Exclude<Tab, "apply">;
  me: BorrowerMe;
  record: BorrowerRecord | null;
  cards: readonly AnyCardInstance[];
  messages: readonly ThreadMessage[];
  draft: Draft;
  done: Record<TaskId, boolean>;
  focusedCard: string | null;
  setTab: (t: Tab) => void;
  setStep: (s: Step) => void;
  onSignOut: () => void;
};

/** The tabs beside Apply. My Loan: the loan record's badge for a loan subject, else `apply.loan.empty` (owner decision 6); Session 3 mounts the record sections. */
export function TabScreens(p: TabProps) {
  if (p.tab === "loan") {
    const loan = p.me.subjects.find((s) => s.loan_id);
    if (!loan) {
      return (
        <div className="sm-empty" data-testid="apply-loan-empty">
          <h2 data-copy-key="apply.loan.title">{copy("apply.loan.title")}</h2>
          <p data-copy-key="apply.loan.empty">{copy("apply.loan.empty")}</p>
        </div>
      );
    }
    return (
      <div className="sm-bubble" data-testid="apply-loan">
        <h1>{loan.label}</h1>
        {p.record && p.record.subject.loan_id === loan.loan_id && p.record.status.badge ? <p className="sm-lead"><strong data-testid="apply-badge">{p.record.status.badge}</strong></p> : null}
      </div>
    );
  }
  if (p.tab === "account") {
    return (
      <div className="sm-bubble">
        <h1 data-copy-key="apply.account.title">{copy("apply.account.title")}</h1>
        <p data-testid="apply-account-who">{p.me.first_name || copy("apply.account.signed_in")} · {p.me.partner.legal_name}</p>
        <button type="button" className="sm-primary" data-testid="apply-sign-out" data-copy-key="apply.account.sign_out" onClick={p.onSignOut}>{copy("apply.account.sign_out")}</button>
      </div>
    );
  }
  if (p.tab === "chat") {
    const lines = p.messages.filter((m) => m.body_text);
    return (
      <div className="sm-chat" data-testid="apply-chat">
        {lines.map((m) => (
          <div key={m.message_id} className={m.sender === "borrower" ? "sm-msg me" : "sm-msg"}>{m.body_text}</div>
        ))}
      </div>
    );
  }
  // tasks: the seven rows with `data-done` derived on every render, then every pending card with no step of its own
  const labels = copyOptions("apply.tasks.rows");
  const [purposeBuy = "", purposeRefi = ""] = copyOptions("apply.tasks.purpose");
  const title = p.draft.intent === "purchase" ? purposeBuy : p.draft.intent === "refinance" ? purposeRefi : copy("apply.tasks.purpose");
  const doneCount = TASKS.filter((t) => p.done[t]).length;
  const orphans = p.cards.filter((c) => c.status === "pending" && !stepOfCopyKey(c.copy_key));
  return (
    <div data-testid="apply-tasks">
      <h1 className="sm-tasks-title" data-copy-key="apply.tasks.title">{copy("apply.tasks.title")}</h1>
      <div className="sm-card">
        <h3 className="sm-tasks-purpose">{title}</h3>
        <p className="sm-fine" data-copy-key="apply.tasks.progress">{copy("apply.tasks.progress", { done: doneCount, total: TASKS.length })}</p>
        {TASKS.map((t, i) => (
          <button key={t} type="button" className="sm-row sm-task" data-testid={`apply-task-${t}`} data-done={p.done[t] ? "true" : "false"} onClick={() => { p.setTab("apply"); p.setStep(t); }}>
            <span>{labels[i] ?? t}</span>
            <strong>{p.done[t] ? copy("apply.tasks.done") : ""}</strong>
          </button>
        ))}
      </div>
      {orphans.length ? (
        <div className="sm-card">
          {orphans.map((c) => (
            <div key={c.card_instance_id} className="sm-row sm-card-host" data-testid={`apply-card-${c.card_instance_id}`} data-expanded={p.focusedCard === c.card_instance_id ? "true" : "false"}>
              <span>{copy(c.copy_key)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
