"use client";

/**
 * 32.19 — the Apply product (docs/ux/18; restored from dadc606 and split: door.tsx, steps.tsx, wire.ts, apply-model.ts).
 * Prototype IA over the /v1/borrower backend. Words do not commit: Continue resolves the pending card when one
 * exists, otherwise runs the one command the plan names (the addressed purchase's `application.confirmField`),
 * otherwise holds the values in the draft (wire.ts `flush`). `api.me()` runs on mount, so a cookie holder never sees
 * the door; a loan-only party lands on My Loan; `?card=` lands on the step that owns the card's copy key.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { FooterDisclosure } from "@/components/shell/FooterDisclosure";
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { EMPTY, doneFrom, stepOfCopyKey, type Door, type Draft, type Step, type Tab } from "./apply-model";
import { DoorScreens, TabScreens } from "./door";
import { StepScreen } from "./steps";
import { flush, loadCards, messageOf } from "./wire";
import "./apply.css";

const TABS: readonly Tab[] = ["apply", "chat", "loan", "tasks", "account"];
const APPLICATION_POLL_MS = 30_000;

const applicationOf = (me: BorrowerMe | null): string | null => me?.subjects.find((s) => s.application_id)?.application_id ?? null;
const loanOf = (me: BorrowerMe | null): string | null => me?.subjects.find((s) => s.loan_id)?.loan_id ?? null;

export function ApplyProduct({ initialCard }: { initialCard?: string }) {
  const [booted, setBooted] = useState(false);
  const [tab, setTab] = useState<Tab>("apply");
  const [door, setDoor] = useState<Door>("welcome");
  const [step, setStep] = useState<Step>("goal");
  const [accountMode, setAccountMode] = useState<"sign_up" | "sign_in">("sign_up");
  const [me, setMe] = useState<BorrowerMe | null>(null);
  const [record, setRecord] = useState<BorrowerRecord | null>(null);
  const [cards, setCards] = useState<AnyCardInstance[]>([]);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const [cardToFocus, setCardToFocus] = useState<string | undefined>(initialCard);

  const applicationId = applicationOf(me);
  const signedIn = me !== null;
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  /** `me` + `record(subject)` + `thread()` — the page's whole view of the file; the record is absent (not an error) before the file has one. */
  const refresh = useCallback(async (): Promise<BorrowerMe> => {
    const next = await api.me();
    setMe(next);
    const subject = applicationOf(next) ?? loanOf(next);
    if (subject) {
      let rec: BorrowerRecord | null = null;
      try { rec = await api.record(subject); } catch (e) { if (!(e instanceof ApiRequestError)) throw e; rec = null; }   // a subject with no record yet (the API's refusal before the interview) is not an error to show; anything else is
      setRecord(rec);
    } else setRecord(null);
    const thread = await api.thread();
    setCards(thread.cards);
    setMessages(thread.messages);
    return next;
  }, []);

  /** After the account door: the organic application is created by `landSession`; poll `me` until the subject appears (docs/ux/18 §3.0). */
  const landed = useCallback(async () => {
    const deadline = Date.now() + APPLICATION_POLL_MS;
    let next = await refresh();
    while (!applicationOf(next) && !loanOf(next) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      next = await refresh();
    }
    setTab(applicationOf(next) ? "apply" : loanOf(next) ? "loan" : "apply");
    setStep("goal");
  }, [refresh]);

  useEffect(() => {
    let live = true;
    api.me()
      .then(async (next) => {
        if (!live) return;
        setMe(next);
        setTab(applicationOf(next) ? "apply" : loanOf(next) ? "loan" : "apply");
        try { await refresh(); } catch (e) { if (live) setError(messageOf(e)); }   // a session whose record/thread read fails keeps its tabs and sees the copy — never the door
      })
      .catch((e: unknown) => { if (!live) return; setMe(null); if (!(e instanceof ApiRequestError && e.status === 401)) setError(messageOf(e)); })   // no session (401): the door, silently; any other `me` failure shows its copy on the door
      .finally(() => { if (live) setBooted(true); });
    return () => { live = false; };
  }, [refresh]);

  // `?card=`: once the cards are loaded, the step that owns the card's copy key, or Tasks with the card expanded; an unknown id is ignored (docs/ux/18 §3.3)
  useEffect(() => {
    if (!cardToFocus || !signedIn || cards.length === 0) return;
    const card = cards.find((c) => c.card_instance_id === cardToFocus);
    setCardToFocus(undefined);
    if (!card) return;
    const owner = stepOfCopyKey(card.copy_key);
    if (owner) { setTab("apply"); setStep(owner); } else { setTab("tasks"); }
    setFocusedCard(card.card_instance_id);
  }, [cardToFocus, signedIn, cards]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  };

  const onContinue = () => run(async () => {
    const fresh = signedIn ? await loadCards() : cards;
    const r = await flush(step, { draft, cards: fresh, applicationId });
    if (r.patch) patch(r.patch);   // the SSN leaves the draft once its card is written (never echoed, never kept)
    setStep(r.next);
    if (r.outcomes.length) await refresh();
  });

  /** A card hosted inside a step (a caution row's lift card): the same resolve call as the steps' taps, then the page's view of the file re-read. */
  const onResolveCard = async (cardInstanceId: string, req: ResolveRequest): Promise<void> => {
    await run(async () => { await api.resolveCard(cardInstanceId, req); await refresh(); });
  };

  const onSignOut = () => run(async () => {
    await api.signOut();
    setMe(null); setRecord(null); setCards([]); setMessages([]); setDraft(EMPTY);
    setTab("apply"); setStep("goal"); setDoor("welcome"); setAccountMode("sign_up");
  });

  const sendChat = (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    void run(async () => {
      await api.sendMessage(text, applicationId ? { application_id: applicationId } : undefined);   // 32.19 §2.3: POST /v1/borrower/messages only; never a card, never a command from Chat
      await refresh();
    });
  };

  const done = useMemo(() => doneFrom(cards, record), [cards, record]);
  const tabLabels = copyOptions("apply.tabs");
  const showStep = signedIn && tab === "apply" && applicationId !== null;

  const body = () => {
    if (!booted) return null;
    if (!me) return <DoorScreens door={door} accountMode={accountMode} setDoor={setDoor} setAccountMode={setAccountMode} onSession={() => void run(landed)} />;
    if (tab !== "apply") return <TabScreens tab={tab} me={me} record={record} cards={cards} messages={messages} draft={draft} done={done} focusedCard={focusedCard} setTab={setTab} setStep={setStep} onSignOut={onSignOut} />;
    if (!applicationId) return null;   // a loan-only party (33.x): no step and no goal card on Apply (owner decision 6)
    return <StepScreen step={step} draft={draft} cards={cards} record={record} busy={busy} patch={patch} onContinue={onContinue} setStep={setStep} onResolveCard={onResolveCard} />;
  };

  return (
    <div className="sm-proto" data-testid="apply" data-door={booted && !signedIn ? door : undefined} data-tab={signedIn ? tab : undefined} data-step={showStep ? step : undefined}>
      <div className="sm-phone">
        <header className="sm-top">
          <button type="button" className="sm-mark" aria-label={copy("apply.door.title")} onClick={() => { setTab("apply"); if (!signedIn) setDoor("welcome"); }}>
            <span className="sm-mark-s" aria-hidden="true">s</span>
            <span className="sm-mark-name">{copy("apply.door.title")}</span>
          </button>
          {signedIn ? <button type="button" className="sm-invite" data-copy-key="apply.invite" disabled>{copy("apply.invite")}</button> : null}
        </header>
        <main className="sm-stage">
          {body()}
          {error ? <p className="sm-error" role="status" data-testid="apply-error">{error}</p> : null}
        </main>
        <FooterDisclosure partner={me?.partner} />
        {signedIn ? (
          <footer className="sm-dock">
            {tab === "chat" ? (
              <form className="sm-composer" onSubmit={sendChat}>
                <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={copy("apply.chat.placeholder")} aria-label={copyExtra("apply.chat.placeholder", "helper")} />
              </form>
            ) : null}
            <nav className="sm-tabs" aria-label={copy("apply.tabs")}>
              {TABS.map((id, i) => (
                <button key={id} type="button" data-testid={`apply-tab-${id}`} aria-pressed={tab === id} onClick={() => { setError(null); setTab(id); }}>{tabLabels[i] ?? id}</button>
              ))}
            </nav>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
