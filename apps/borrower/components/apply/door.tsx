"use client";
import { Account } from "@/components/account/Account";
import type { BorrowerMe } from "@/lib/types/record";
import type { Door, Step, Tab, TaskId } from "./apply-model";
import { TASKS } from "./apply-model";

export function DoorScreens(p: {
  tab: Tab;
  door: Door;
  signedIn: boolean;
  accountMode: "sign_up" | "sign_in";
  me: BorrowerMe | null;
  title: string;
  done: Record<TaskId, boolean>;
  chat: { who: "us" | "me"; text: string }[];
  setDoor: (d: Door) => void;
  setTab: (t: Tab) => void;
  setStep: (s: Step) => void;
  setAccountMode: (m: "sign_up" | "sign_in") => void;
  refresh: () => Promise<unknown>;
  onSignOut: () => void;
}) {
  if (!p.signedIn && p.door === "welcome") {
    return (
      <div className="sm-bubble">
        <h1>Supermortgage</h1>
        <p className="sm-hero">The Self-Improving Mortgage</p>
        <button className="sm-primary" onClick={() => p.setDoor("intro")}>Continue</button>
      </div>
    );
  }
  if (!p.signedIn && p.door === "intro") {
    return (
      <div className="sm-bubble">
        <h1>What is Supermortgage?</h1>
        <p>Automatic refinancing. When a better rate is worth it, the file is assembled without you starting over.</p>
        <button className="sm-primary" onClick={() => p.setDoor("account")}>Create an account</button>
        <button className="sm-link" onClick={() => { p.setAccountMode("sign_in"); p.setDoor("account"); }}>Already have an account?</button>
      </div>
    );
  }
  if (!p.signedIn) {
    return (
      <div className="sm-bubble">
        <Account mode={p.accountMode} onSession={() => void p.refresh()} navigate={(url) => {
          if (url.includes("google")) window.location.assign(url);
          else void p.refresh();
        }} />
        <button className="sm-link" onClick={() => p.setAccountMode(p.accountMode === "sign_up" ? "sign_in" : "sign_up")}>
          {p.accountMode === "sign_up" ? "Sign in instead" : "Create an account"}
        </button>
      </div>
    );
  }
  if (p.tab === "loan") return <div className="sm-empty"><h2>No loan yet</h2><p>After this application funds, your loan will live here.</p></div>;
  if (p.tab === "account") {
    return (
      <div className="sm-bubble">
        <h1>Account</h1>
        <p>{p.me?.first_name || "Signed in"} · {p.me?.partner.legal_name}</p>
        <button className="sm-primary" onClick={p.onSignOut}>Sign out</button>
      </div>
    );
  }
  if (p.tab === "chat") {
    return <div className="sm-chat">{p.chat.map((m, i) => <div key={i} className={m.who === "me" ? "sm-msg me" : "sm-msg"}>{m.text}</div>)}</div>;
  }
  if (p.tab === "tasks") {
    return (
      <div>
        <h1 style={{ fontSize: 24, margin: "0 0 16px" }}>Tasks</h1>
        <div className="sm-card">
          <h3 style={{ margin: "0 0 8px" }}>{p.title}</h3>
          <p className="sm-fine">{Object.values(p.done).filter(Boolean).length} of 7 complete</p>
          {TASKS.map((t) => (
            <button key={t.id} className="sm-row" style={{ width: "100%", background: "none", textAlign: "left" }} onClick={() => { p.setTab("apply"); p.setStep(t.id); }}>
              <span>{t.label}</span><strong>{p.done[t.id] ? "Done" : ""}</strong>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return null;
}
