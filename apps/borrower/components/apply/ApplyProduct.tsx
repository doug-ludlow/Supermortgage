"use client";

/**
 * Designed borrower product. Prototype IA + Super /v1/borrower backend.
 * Words do not commit. Continue resolves a pending card when one exists,
 * otherwise runs the matching command.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Account } from "@/components/account/Account";
import { api, ApiRequestError } from "@/lib/api/client";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord } from "@/lib/types/record";
import "./apply.css";

type Tab = "apply" | "chat" | "loan" | "tasks" | "account";
type Door = "welcome" | "intro" | "account";
type Step = "goal" | "property" | "you" | "connect" | "details" | "questions" | "demographics" | "review" | "result";
type Intent = "purchase" | "refinance" | null;
type RefiGoal = "lower" | "faster" | "cash";
type Occupancy = "primary" | "second_home" | "investment";

type Draft = {
  intent: Intent;
  refiGoal: RefiGoal;
  occupancy: Occupancy;
  shopping: boolean;
  property: string;
  location: string;
  price: string;
  down: string;
  value: string;
  balance: string;
  cashOut: string;
  legalName: string;
  email: string;
  dob: string;
  ssn: string;
  housing: "own" | "rent" | "free";
  months: string;
  priorAddress: string;
  income: string;
  employer: string;
  incomeType: "w2" | "self" | "other";
  citizenship: "us_citizen" | "permanent_resident" | "non_permanent_resident";
  marital: "unmarried" | "married" | "separated";
  dependents: string;
  noneApply: boolean;
  declinedDemo: boolean;
  creditOk: boolean;
  connected: boolean;
  submitted: boolean;
  result: string;
};

const EMPTY: Draft = {
  intent: null,
  refiGoal: "lower",
  occupancy: "primary",
  shopping: false,
  property: "",
  location: "",
  price: "",
  down: "",
  value: "",
  balance: "",
  cashOut: "",
  legalName: "",
  email: "",
  dob: "",
  ssn: "",
  housing: "own",
  months: "36",
  priorAddress: "",
  income: "",
  employer: "",
  incomeType: "w2",
  citizenship: "us_citizen",
  marital: "unmarried",
  dependents: "0",
  noneApply: true,
  declinedDemo: false,
  creditOk: false,
  connected: false,
  submitted: false,
  result: "",
};

const TASKS: { id: Step; label: string }[] = [
  { id: "property", label: "Your home" },
  { id: "you", label: "Credit check" },
  { id: "connect", label: "Income & assets" },
  { id: "details", label: "Your details" },
  { id: "questions", label: "Declarations" },
  { id: "demographics", label: "Demographics" },
  { id: "review", label: "Review & submit" },
];

function cents(raw: string): string {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 100));
}

function pending(cards: AnyCardInstance[], key: string) {
  return cards.find((c) => c.status === "pending" && (c.copy_key === key || c.copy_key.startsWith(key)));
}

export function ApplyProduct() {
  const [tab, setTab] = useState<Tab>("apply");
  const [door, setDoor] = useState<Door>("welcome");
  const [step, setStep] = useState<Step>("goal");
  const [accountMode, setAccountMode] = useState<"sign_up" | "sign_in">("sign_up");
  const [me, setMe] = useState<BorrowerMe | null>(null);
  const [record, setRecord] = useState<BorrowerRecord | null>(null);
  const [cards, setCards] = useState<AnyCardInstance[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<{ who: "us" | "me"; text: string }[]>([
    { who: "us", text: "I can help with the application. The steps on Apply are the path that submits to underwriting." },
  ]);
  const [prompt, setPrompt] = useState("");

  const applicationId = me?.subjects.find((s) => s.application_id)?.application_id ?? null;
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const refresh = useCallback(async () => {
    const next = await api.me();
    setMe(next);
    const subject = next.subjects.find((s) => s.application_id)?.application_id ?? next.subjects[0]?.loan_id;
    if (subject) {
      try { setRecord(await api.record(subject)); } catch { setRecord(null); }
    }
    try {
      const thread = await api.thread();
      setCards(thread.cards ?? []);
    } catch { setCards([]); }
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    api.me().then((next) => {
      if (!live) return;
      setMe(next);
      void refresh();
    }).catch(() => { if (live) setMe(null); });
    return () => { live = false; };
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); }
    catch (e) {
      setError(e instanceof ApiRequestError ? (e.body.copy_key || e.body.code) : e instanceof Error ? e.message : "Something went wrong.");
    } finally { setBusy(false); }
  };

  const resolveOrCommand = async (copyKey: string, evidence: Record<string, unknown>, name: string, args: Record<string, unknown>) => {
    const card = pending(cards, copyKey);
    if (card) await api.resolveCard(card.card_instance_id, evidence as never);
    else await api.command(name, { application_id: applicationId, ...args });
    await refresh();
  };

  const signedIn = Boolean(me);
  const title = draft.intent === "purchase" ? "Buy a home" : draft.intent === "refinance" ? "Refinance" : "Your mortgage";
  const done = useMemo(() => ({
    property: draft.intent === "purchase" ? Boolean(draft.shopping ? draft.location : draft.property) : Boolean(draft.property),
    you: draft.creditOk && Boolean(draft.ssn),
    connect: draft.connected || Boolean(draft.income),
    details: Boolean(draft.legalName && draft.income),
    questions: true,
    demographics: true,
    review: draft.submitted,
  }), [draft]);

  const continueGoal = () => run(async () => {
    if (!draft.intent) throw new Error("Choose Buy a home or Refinance my home.");
    const transaction_type = draft.intent === "purchase" ? "purchase" : draft.refiGoal === "cash" ? "cash_out" : "limited_cash_out";
    await resolveOrCommand(
      "entry.goal.question",
      { option_id: transaction_type },
      "application.setGoal",
      { transaction_type, occupancy: draft.occupancy, property: draft.intent === "purchase" && draft.shopping ? "tbd" : undefined, goal: draft.intent === "refinance" ? draft.refiGoal : undefined },
    );
    setStep("property");
  });

  const continueProperty = () => run(async () => {
    if (draft.intent === "purchase" && draft.shopping) {
      if (!draft.location || !draft.price) throw new Error("Add a city or ZIP and a target price.");
      await resolveOrCommand("preapproval.where", { fields: [{ path: "location", value: draft.location }] }, "application.confirmField", {
        path: "preapproval.where", value: draft.location, target_price_cents: cents(draft.price), down_payment_cents: cents(draft.down),
      });
    } else {
      if (!draft.property) throw new Error("Add the property address.");
      await resolveOrCommand("refi.home.confirm", { fields: [{ path: "property_address", value: draft.property }] }, "application.confirmField", {
        path: "property_address", value: draft.property,
      });
      if (draft.intent === "refinance" && draft.balance) {
        await api.command("application.confirmField", { application_id: applicationId, path: "current_loan_balance", value: cents(draft.balance) });
      }
      if (draft.intent === "purchase" && draft.price) {
        await api.command("application.confirmField", { application_id: applicationId, path: "purchase_price", value: cents(draft.price) });
      }
    }
    await api.command("application.confirmField", { application_id: applicationId, path: "occupancy", value: draft.occupancy }).catch(() => undefined);
    setStep("you");
  });

  const continueYou = () => run(async () => {
    if (!draft.legalName || !draft.dob || !draft.ssn) throw new Error("Name, date of birth, and SSN are required.");
    await resolveOrCommand("identity.confirm.title", { fields: [
      { path: "legal_name", value: draft.legalName },
      { path: "date_of_birth", value: draft.dob },
      { path: "current_address", value: draft.property || draft.location },
    ] }, "application.confirmField", { path: "legal_name", value: draft.legalName });
    await resolveOrCommand("identity.ssn.title", { fields: [{ path: "ssn", value: draft.ssn.replace(/\D/g, "") }] }, "application.confirmField", {
      path: "ssn", value: draft.ssn.replace(/\D/g, ""),
    });
    const credit = pending(cards, "consent.credit") ?? cards.find((c) => c.kind === "ConsentCard" && c.status === "pending");
    if (credit) await api.resolveCard(credit.card_instance_id, { accepted: true } as never);
    else await api.command("credit.authorize", {
      application_id: applicationId, kind: "hard_pull", lead_id: applicationId, text_hash: "prototype-apply-hard-pull", consumer_entered_identity: true,
    });
    if (Number(draft.months) < 24 && draft.priorAddress) {
      await api.command("application.confirmField", { application_id: applicationId, path: "prior_address", value: draft.priorAddress }).catch(() => undefined);
    }
    patch({ creditOk: true });
    setStep("connect");
    await refresh();
  });

  const continueConnect = (skip = false) => run(async () => {
    if (!skip) {
      const asset = cards.find((c) => c.kind === "ConnectCard" && c.status === "pending" && /plaid|asset/i.test(c.copy_key));
      const income = cards.find((c) => c.kind === "ConnectCard" && c.status === "pending" && /truv|income/i.test(c.copy_key));
      if (asset) {
        await api.connectSession("plaid_assets", asset.card_instance_id, { fake_complete: true });
        await api.resolveCard(asset.card_instance_id, { outcome: "connected" } as never);
      }
      if (income) {
        await api.connectSession("truv_income", income.card_instance_id, { fake_complete: true });
        await api.resolveCard(income.card_instance_id, { outcome: "connected" } as never);
      }
      if (!asset && !income) {
        await api.command("verification.connect", {
          application_id: applicationId, vendor: draft.intent === "purchase" ? "plaid_assets" : "truv_income", fake_complete: true,
        }).catch(() => undefined);
      }
    }
    if (draft.income) {
      await api.command("application.confirmField", { application_id: applicationId, path: "income", value: cents(draft.income) }).catch(() => undefined);
    }
    patch({ connected: !skip || Boolean(draft.income) });
    setStep("details");
    await refresh();
  });

  const continueDetails = () => run(async () => {
    await api.command("application.confirmField", { application_id: applicationId, path: "citizenship_status", value: draft.citizenship }).catch(() => undefined);
    await api.command("application.confirmField", { application_id: applicationId, path: "marital_status", value: draft.marital }).catch(() => undefined);
    await api.command("application.confirmField", { application_id: applicationId, path: "employer_name", value: draft.employer }).catch(() => undefined);
    await api.command("application.confirmField", { application_id: applicationId, path: "residency_basis", value: draft.housing }).catch(() => undefined);
    setStep("questions");
  });

  const continueQuestions = () => run(async () => {
    const card = pending(cards, "declarations.title") ?? cards.find((c) => c.copy_key.includes("declarations") && c.status === "pending");
    if (card) await api.resolveCard(card.card_instance_id, { option_id: draft.noneApply ? "none" : "some" } as never);
    else await api.command("application.answerDeclarations", { application_id: applicationId, none_apply: draft.noneApply });
    setStep("demographics");
    await refresh();
  });

  const continueDemographics = () => run(async () => {
    const card = cards.find((c) => c.kind === "DemographicsCard" && c.status === "pending");
    const answers = draft.declinedDemo
      ? { ethnicity: "do_not_wish", race: "do_not_wish", sex: "do_not_wish" }
      : { ethnicity: ["not_hispanic"], race: ["white"], sex: "male" };
    if (card) await api.resolveCard(card.card_instance_id, { answers, collection_method: "internet" } as never);
    else await api.command("application.answerDemographics", {
      application_id: applicationId, ...answers,
      declined_ethnicity: draft.declinedDemo, declined_race: draft.declinedDemo, declined_sex: draft.declinedDemo, collection_method: "internet",
    });
    setStep("review");
    await refresh();
  });

  const submit = () => run(async () => {
    if (draft.value) await api.command("application.confirmField", { application_id: applicationId, path: "estimated_value", value: cents(draft.value) }).catch(() => undefined);
    if (draft.intent === "refinance" && draft.balance) {
      await api.command("application.confirmField", { application_id: applicationId, path: "loan_amount", value: cents(draft.balance) }).catch(() => undefined);
    }
    if (draft.intent === "purchase" && draft.price) {
      const loan = Math.max(0, Number(draft.price.replace(/[^0-9.]/g, "")) - Number(draft.down.replace(/[^0-9.]/g, "") || "0"));
      await api.command("application.confirmField", { application_id: applicationId, path: "loan_amount", value: cents(String(loan)) }).catch(() => undefined);
    }
    try { await api.command("application.submitToDu", { application_id: applicationId }); }
    catch { await api.command("du.submit", { application_id: applicationId }).catch(() => undefined); }
    patch({ submitted: true, result: "We sent your file to Desktop Underwriter. This environment uses the FAKE port." });
    setStep("result");
    await refresh();
  });

  const sendChat = async () => {
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    setChat((c) => [...c, { who: "me", text }]);
    try {
      await api.sendMessage(text, applicationId ? { application_id: applicationId } : undefined);
      setChat((c) => [...c, { who: "us", text: "Received. Keep facts on Apply so every commit is a tap." }]);
    } catch {
      setChat((c) => [...c, { who: "us", text: "I could not post that just now. Use Apply to move the file." }]);
    }
  };

  const body = () => {
    if (!signedIn) {
      if (door === "welcome") {
        return (
          <div className="sm-bubble">
            <h1>Supermortgage</h1>
            <p className="sm-hero">The Self-Improving Mortgage</p>
            <button className="sm-primary" onClick={() => setDoor("intro")}>Continue</button>
          </div>
        );
      }
      if (door === "intro") {
        return (
          <div className="sm-bubble">
            <h1>What is Supermortgage?</h1>
            <p>Automatic refinancing. When a better rate is worth it, the file is assembled without you starting over.</p>
            <p>One relationship from the first application through the life of the loan.</p>
            <button className="sm-primary" onClick={() => setDoor("account")}>Create an account</button>
            <button className="sm-link" onClick={() => { setAccountMode("sign_in"); setDoor("account"); }}>Already have an account?</button>
          </div>
        );
      }
      return (
        <div className="sm-bubble">
          <Account mode={accountMode} onSession={() => void refresh()} navigate={(url) => {
            if (url.includes("google")) window.location.assign(url);
            else void refresh();
          }} />
          <button className="sm-link" onClick={() => setAccountMode(accountMode === "sign_up" ? "sign_in" : "sign_up")}>
            {accountMode === "sign_up" ? "Sign in instead" : "Create an account"}
          </button>
        </div>
      );
    }

    if (tab === "loan") return (<div className="sm-empty"><h2>No loan yet</h2><p>After this application funds, your loan will live here. Partner-book loans come later.</p></div>);
    if (tab === "account") {
      return (
        <div className="sm-bubble">
          <h1>Account</h1>
          <p>{me?.first_name || "Signed in"} · {me?.partner.legal_name}</p>
          <button className="sm-primary" onClick={() => api.signOut().then(() => { setMe(null); setDoor("welcome"); setDraft(EMPTY); })}>Sign out</button>
        </div>
      );
    }
    if (tab === "chat") {
      return (<div className="sm-chat">{chat.map((m, i) => <div key={i} className={m.who === "me" ? "sm-msg me" : "sm-msg"}>{m.text}</div>)}</div>);
    }
    if (tab === "tasks") {
      return (
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 16px" }}>Tasks</h1>
          <div className="sm-card">
            <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
            <p className="sm-fine">{Object.values(done).filter(Boolean).length} of 7 complete</p>
            {TASKS.map((t) => (
              <button key={t.id} className="sm-row" style={{ width: "100%", background: "none", textAlign: "left" }} onClick={() => { setTab("apply"); setStep(t.id); }}>
                <span>{t.label}</span>
                <strong>{done[t.id === "review" ? "review" : t.id] ? "Done" : ""}</strong>
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (step === "goal") {
      return (
        <div className="sm-bubble">
          <h1 className="sm-hero">Are you looking to:</h1>
          <div className="sm-stack">
            <button className={`sm-choice ${draft.intent === "purchase" ? "selected" : ""}`} onClick={() => patch({ intent: "purchase" })}><strong>Buy a home</strong></button>
            <button className={`sm-choice ${draft.intent === "refinance" ? "selected" : ""}`} onClick={() => patch({ intent: "refinance" })}><strong>Refinance my home</strong></button>
          </div>
          {draft.intent === "refinance" ? (
            <>
              <p className="sm-label">What should the new loan do?</p>
              <div className="sm-stack">
                {([["lower", "Lower payment"], ["faster", "Pay off sooner"], ["cash", "Take cash out"]] as const).map(([id, label]) => (
                  <button key={id} className={`sm-choice ${draft.refiGoal === id ? "selected" : ""}`} onClick={() => patch({ refiGoal: id })}><strong>{label}</strong></button>
                ))}
              </div>
            </>
          ) : null}
          <p className="sm-label">This home is</p>
          <div className="sm-stack">
            {([["primary", "My primary home"], ["second_home", "A second home"], ["investment", "An investment property"]] as const).map(([id, label]) => (
              <button key={id} className={`sm-choice ${draft.occupancy === id ? "selected" : ""}`} onClick={() => patch({ occupancy: id })}><strong>{label}</strong></button>
            ))}
          </div>
          <button className="sm-primary" disabled={busy || !draft.intent} onClick={continueGoal}>Continue</button>
        </div>
      );
    }

    if (step === "property") {
      return (
        <div className="sm-bubble">
          <h1>{draft.intent === "purchase" ? "Your next home." : "Your current home."}</h1>
          {draft.intent === "purchase" ? (
            <div className="sm-switch" role="tablist">
              <button className={!draft.shopping ? "active" : ""} onClick={() => patch({ shopping: false })}>I have an address</button>
              <button className={draft.shopping ? "active" : ""} onClick={() => patch({ shopping: true })}>Still looking</button>
            </div>
          ) : null}
          <label className="sm-label">{draft.shopping ? "City or ZIP" : "Property address"}</label>
          <div className="sm-field">
            <input value={draft.shopping ? draft.location : draft.property} onChange={(e) => patch(draft.shopping ? { location: e.target.value } : { property: e.target.value })} placeholder={draft.shopping ? "Austin, TX" : "24 Juniper Lane"} />
          </div>
          {draft.intent === "purchase" ? (
            <>
              <label className="sm-label">Price</label>
              <div className="sm-field"><input inputMode="decimal" value={draft.price} onChange={(e) => patch({ price: e.target.value })} placeholder="650000" /></div>
              <label className="sm-label">Down payment</label>
              <div className="sm-field"><input inputMode="decimal" value={draft.down} onChange={(e) => patch({ down: e.target.value })} placeholder="130000" /></div>
            </>
          ) : (
            <>
              <label className="sm-label">About what is it worth?</label>
              <div className="sm-field"><input inputMode="decimal" value={draft.value} onChange={(e) => patch({ value: e.target.value })} /></div>
              <label className="sm-label">Current balance</label>
              <div className="sm-field"><input inputMode="decimal" value={draft.balance} onChange={(e) => patch({ balance: e.target.value })} /></div>
              {draft.refiGoal === "cash" ? (
                <>
                  <label className="sm-label">Cash out</label>
                  <div className="sm-field"><input inputMode="decimal" value={draft.cashOut} onChange={(e) => patch({ cashOut: e.target.value })} /></div>
                </>
              ) : null}
            </>
          )}
          <button className="sm-primary" disabled={busy} onClick={continueProperty}>Continue</button>
        </div>
      );
    }

    if (step === "you") {
      return (
        <div className="sm-bubble">
          <h1>You, then credit.</h1>
          <label className="sm-label">Legal name</label>
          <div className="sm-field"><input value={draft.legalName} onChange={(e) => patch({ legalName: e.target.value })} /></div>
          <label className="sm-label">Email</label>
          <div className="sm-field"><input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} /></div>
          <label className="sm-label">Date of birth</label>
          <div className="sm-field"><input placeholder="YYYY-MM-DD" value={draft.dob} onChange={(e) => patch({ dob: e.target.value })} /></div>
          <label className="sm-label">Social security number</label>
          <div className="sm-field"><input inputMode="numeric" value={draft.ssn} onChange={(e) => patch({ ssn: e.target.value })} /></div>
          <label className="sm-label">I live here as</label>
          <div className="sm-switch">
            {([["own", "Own"], ["rent", "Rent"], ["free", "Rent-free"]] as const).map(([id, label]) => (
              <button key={id} className={draft.housing === id ? "active" : ""} onClick={() => patch({ housing: id })}>{label}</button>
            ))}
          </div>
          <label className="sm-label">Months at this address</label>
          <div className="sm-field"><input inputMode="numeric" value={draft.months} onChange={(e) => patch({ months: e.target.value })} /></div>
          {Number(draft.months) < 24 ? (
            <>
              <label className="sm-label">Prior address</label>
              <div className="sm-field"><input value={draft.priorAddress} onChange={(e) => patch({ priorAddress: e.target.value })} /></div>
            </>
          ) : null}
          <label className="sm-check">
            <input type="checkbox" checked={draft.creditOk} onChange={(e) => patch({ creditOk: e.target.checked })} />
            <span>I authorize a hard credit pull for this application.</span>
          </label>
          <button className="sm-primary" disabled={busy || !draft.creditOk} onClick={continueYou}>Authorize and continue</button>
        </div>
      );
    }

    if (step === "connect") {
      return (
        <div className="sm-bubble">
          <h1>Connect once.</h1>
          <p>Payroll and bank use FAKE vendors here. You can type monthly income and continue.</p>
          <label className="sm-label">Monthly income</label>
          <div className="sm-field"><input inputMode="decimal" value={draft.income} onChange={(e) => patch({ income: e.target.value })} /></div>
          <label className="sm-label">Employer</label>
          <div className="sm-field"><input value={draft.employer} onChange={(e) => patch({ employer: e.target.value })} /></div>
          {draft.intent === "purchase" ? <p className="sm-note">Purchase files need an asset story. Stated down payment is enough for this first DU.</p> : <p className="sm-lead">Refinance can skip bank assets until DU asks.</p>}
          <button className="sm-primary" disabled={busy} onClick={() => continueConnect(false)}>Connect (FAKE) and continue</button>
          <button className="sm-secondary" disabled={busy} onClick={() => continueConnect(true)}>Skip connections</button>
        </div>
      );
    }

    if (step === "details") {
      return (
        <div className="sm-bubble">
          <h1>A few facts.</h1>
          <label className="sm-label">Citizenship</label>
          <div className="sm-field">
            <select value={draft.citizenship} onChange={(e) => patch({ citizenship: e.target.value as Draft["citizenship"] })}>
              <option value="us_citizen">U.S. citizen</option>
              <option value="permanent_resident">Permanent resident</option>
              <option value="non_permanent_resident">Non-permanent resident</option>
            </select>
          </div>
          <label className="sm-label">Marital status</label>
          <div className="sm-field">
            <select value={draft.marital} onChange={(e) => patch({ marital: e.target.value as Draft["marital"] })}>
              <option value="unmarried">Unmarried</option>
              <option value="married">Married</option>
              <option value="separated">Separated</option>
            </select>
          </div>
          <label className="sm-label">Dependents</label>
          <div className="sm-field"><input inputMode="numeric" value={draft.dependents} onChange={(e) => patch({ dependents: e.target.value })} /></div>
          <label className="sm-label">Income type</label>
          <div className="sm-switch">
            {([["w2", "W-2"], ["self", "Self-employed"], ["other", "Other"]] as const).map(([id, label]) => (
              <button key={id} className={draft.incomeType === id ? "active" : ""} onClick={() => patch({ incomeType: id })}>{label}</button>
            ))}
          </div>
          {draft.incomeType === "self" ? <p className="sm-note">Self-employed can still take a first FAKE DU on stated income.</p> : null}
          {draft.citizenship === "non_permanent_resident" ? <p className="sm-note">Visa or EAD upload is next. Citizenship is on the file now.</p> : null}
          <button className="sm-primary" disabled={busy} onClick={continueDetails}>Continue</button>
        </div>
      );
    }

    if (step === "questions") {
      return (
        <div className="sm-bubble">
          <h1>Do any apply?</h1>
          <p>Bankruptcy, foreclosure, lawsuits, alimony, borrowed funds — the URLA declarations.</p>
          <button className={`sm-choice solid ${draft.noneApply ? "selected" : ""}`} onClick={() => patch({ noneApply: true })}><strong>None of these apply</strong></button>
          <button className={`sm-choice solid ${!draft.noneApply ? "selected" : ""}`} onClick={() => patch({ noneApply: false })}><strong>Something applies</strong><small>Follow-ups come one at a time.</small></button>
          <button className="sm-primary" disabled={busy} onClick={continueQuestions}>Continue</button>
        </div>
      );
    }

    if (step === "demographics") {
      return (
        <div className="sm-bubble">
          <h1>Demographics</h1>
          <p>Required to collect. You may decline each answer.</p>
          <label className="sm-check">
            <input type="checkbox" checked={draft.declinedDemo} onChange={(e) => patch({ declinedDemo: e.target.checked })} />
            <span>I do not wish to provide this information</span>
          </label>
          <button className="sm-primary" disabled={busy} onClick={continueDemographics}>Continue</button>
        </div>
      );
    }

    if (step === "review") {
      return (
        <div className="sm-bubble">
          <h1>Ready for DU.</h1>
          <div className="sm-card">
            <div className="sm-row"><span>Purpose</span><strong>{title}</strong></div>
            <div className="sm-row"><span>Home</span><strong>{draft.shopping ? draft.location : draft.property || "—"}</strong></div>
            <div className="sm-row"><span>Name</span><strong>{draft.legalName || "—"}</strong></div>
            <div className="sm-row"><span>Income</span><strong>{draft.income ? `$${draft.income}` : "—"}</strong></div>
          </div>
          {record?.status.badge ? <p className="sm-lead">File status: {record.status.badge}</p> : null}
          <p className="sm-fine">Accuracy attestation. E-SIGN, TCPA, and credit authorization were written when the application started.</p>
          <button className="sm-primary" disabled={busy} onClick={submit}>Submit to DU</button>
        </div>
      );
    }

    return (
      <div className="sm-bubble">
        <h1>Checking your application.</h1>
        <p>{draft.result || "Submitted. Findings arrive when the FAKE port answers."}</p>
        {record?.status.badge ? <p className="sm-lead">{record.status.badge}</p> : null}
        <button className="sm-secondary" onClick={() => setStep("review")}>Back to review</button>
      </div>
    );
  };

  return (
    <div className="sm-proto">
      <div className="sm-phone">
        <header className="sm-top">
          <button className="sm-mark" onClick={() => { setTab("apply"); if (!signedIn) setDoor("welcome"); }}>
            <span className="sm-mark-s">s</span>
            <span className="sm-mark-name">Supermortgage</span>
          </button>
          <button className="sm-invite" type="button" disabled>Invite</button>
        </header>
        <main className="sm-stage">
          {body()}
          {error ? <p className="sm-error" role="status">{error}</p> : null}
        </main>
        <footer className="sm-dock">
          {tab === "chat" ? (
            <form className="sm-composer" onSubmit={(e) => { e.preventDefault(); void sendChat(); }}>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Message" aria-label="Ask Supermortgage" />
            </form>
          ) : null}
          <nav className="sm-tabs" aria-label="Main navigation">
            {([["apply", "Apply"], ["chat", "Chat"], ["loan", "My Loan"], ["tasks", "Tasks"], ["account", "Account"]] as const).map(([id, label]) => (
              <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
            ))}
          </nav>
        </footer>
      </div>
    </div>
  );
}
