"use client";

/**
 * The one shell (32.16 §2.1–2.2) plus P0 mobile tabs (Doug 2026-09-15):
 * <768 Apply / Chat / My Loan / Tasks / Account; ≥768 Thread + Record two-pane.
 * Data from the 02 §7 API through lib/api, or NEXT_PUBLIC_FIXTURES=1 fixtures.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { api, ApiRequestError } from "@/lib/api/client";
import { openStream, type StreamStatus } from "@/lib/api/sse";
import { loadFixture } from "@/lib/fixtures";
import { copy } from "@/lib/copy";
import { Thread, currentAsk } from "./Thread";
import { ActionBar } from "./ActionBar";
import { StatusStrip } from "./StatusStrip";
import { Header } from "./Header";
import { FooterDisclosure } from "./FooterDisclosure";
import { Account } from "@/components/account/Account";
import { AddMobilePrompt, isAddMobileDone } from "./AddMobile";
import { PARTNER_LEGAL_NAME } from "@/lib/env";
import { Record } from "@/components/record/Record";
import { nowIso } from "@/components/cards/CardFrame";
import { BottomNav, type TabId } from "./BottomNav";
import { ApplyTab } from "./tabs/ApplyTab";
import { MyLoanTab } from "./tabs/MyLoanTab";
import { TasksTab } from "./tabs/TasksTab";
import { AccountSettingsTab } from "./tabs/AccountSettingsTab";

export type ShellProps = {
  fixturesMode: boolean;
  fixtureName?: string;
  initialSubject?: string;
  initialCard?: string;
};

function useMedia(query: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

let seq = 0;
const localId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

function stampAfter(messages: ThreadMessage[]): string {
  const last = messages.reduce((m, x) => (x.at > m ? x.at : m), "");
  const t = Math.max(Date.now(), last ? new Date(last).getTime() + 1000 : 0);
  return new Date(t).toISOString();
}

export function Shell({ fixturesMode, fixtureName, initialSubject, initialCard }: ShellProps) {
  const [me, setMe] = useState<BorrowerMe | undefined>();
  const [record, setRecord] = useState<BorrowerRecord | undefined>();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [cards, setCards] = useState<Record<string, AnyCardInstance>>({});
  const [subject, setSubject] = useState<string | undefined>(initialSubject);
  const [recordOpen, setRecordOpen] = useState(false);
  const [scrollTo, setScrollTo] = useState<string | undefined>();
  const [focus, setFocus] = useState<{ card_instance_id: string; seq: number } | undefined>();
  const [busyCardId, setBusyCardId] = useState<string | undefined>();
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | undefined>();
  const [stream, setStream] = useState<StreamStatus>("closed");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [pinnedId, setPinnedId] = useState<string | undefined>(undefined);
  const [addMobileDone, setAddMobileDone] = useState(true);
  const [tab, setTab] = useState<TabId>("chat");
  useEffect(() => setAddMobileDone(isAddMobileDone()), []);
  const desktop = useMedia("(min-width: 768px)");
  const streamRef = useRef<ReturnType<typeof openStream> | null>(null);

  const timezone = record?.timezone ?? "America/Phoenix";
  const partner = me?.partner.legal_name || PARTNER_LEGAL_NAME;

  const focusCard = useCallback(
    (card_instance_id: string) => {
      setFocus({ card_instance_id, seq: (seq += 1) });
      if (!desktop) {
        setTab("chat");
        setRecordOpen(true);
      }
    },
    [desktop],
  );

  const openTask = useCallback(
    (card_instance_id: string) => {
      setTab("chat");
      focusCard(card_instance_id);
    },
    [focusCard],
  );

  const loadFromApi = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      setNeedsSignIn(false);
      const subj = subject ?? (m.subjects[0]?.loan_id ? `loan:${m.subjects[0].loan_id}` : m.subjects[0]?.application_id ? `application:${m.subjects[0].application_id}` : undefined);
      if (subj) {
        setSubject(subj);
        setRecord(await api.record(subj));
      }
      const t = await api.thread();
      setMessages(t.messages);
      setPinnedId(t.pinned_card_id);
      setCards(Object.fromEntries(t.cards.map((c) => [c.card_instance_id, c])));
      setLoadError(undefined);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) {
        streamRef.current?.close(); streamRef.current = null; setStream("closed");
        setNeedsSignIn(true);
        setLoadError(undefined);
        return;
      }
      setLoadError(e instanceof ApiRequestError ? copy(e.body.copy_key) : "We can't reach your loan right now. Nothing is lost — try again in a moment.");
    }
  }, [subject]);

  useEffect(() => {
    if (fixturesMode && fixtureName !== "api") {
      const f = loadFixture(fixtureName);
      setMe(f.me);
      setRecord(f.record);
      setMessages(f.messages);
      setCards(Object.fromEntries(f.cards.map((c) => [c.card_instance_id, c])));
      return;
    }
    void loadFromApi();
    streamRef.current = openStream(() => void loadFromApi(), setStream);
    return () => streamRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixturesMode, fixtureName]);

  const initialFocused = useRef(false);
  useEffect(() => {
    if (!initialCard || initialFocused.current || !cards[initialCard]) return;
    initialFocused.current = true;
    focusCard(initialCard);
  }, [initialCard, cards, focusCard]);

  const resolveCard = useCallback(
    async (card: AnyCardInstance, req: ResolveRequest) => {
      setBusyCardId(card.card_instance_id);
      setCardErrors((e) => ({ ...e, [card.card_instance_id]: "" }));
      try {
        if (fixturesMode) {
          const resolved: AnyCardInstance = { ...card, status: card.kind === "ConnectCard" && req.option_id === "connect" ? "pending" : "resolved", resolved_at: nowIso(), evidence: req.evidence } as AnyCardInstance;
          if (card.kind === "ConnectCard" && req.option_id === "connect") {
            (resolved as AnyCardInstance & { props: { state: string } }).props = { ...card.props, state: "in_progress" } as never;
          }
          if (resolved.status === "resolved" && "proposal" in resolved.props) {
            const { proposal: _proposal, ...rest } = resolved.props as Record<string, unknown>;
            (resolved as { props: unknown }).props = rest;
          }
          setCards((c) => ({ ...c, [card.card_instance_id]: resolved }));
          setRecord((r) => (r ? { ...r, needed_from_you: r.needed_from_you.filter((n) => n.card_instance_id !== card.card_instance_id) } : r));
          return;
        }
        const res = await api.resolveCard(card.card_instance_id, req);
        setCards((c) => ({ ...c, [card.card_instance_id]: res.card }));
        if (subject) setRecord(await api.record(subject));
      } catch (e) {
        const msg = e instanceof ApiRequestError ? copy(e.body.copy_key) : "That didn't go through. Nothing was changed — try again.";
        setCardErrors((errs) => ({ ...errs, [card.card_instance_id]: msg }));
      } finally {
        setBusyCardId(undefined);
      }
    },
    [fixturesMode, subject],
  );

  const appendLocal = useCallback((m: Omit<ThreadMessage, "message_id" | "conversation_id" | "at" | "delivery" | "voice_turn" | "subject">) => {
    setMessages((ms) => [...ms, { ...m, message_id: localId("m"), conversation_id: ms[0]?.conversation_id ?? "local", at: stampAfter(ms), delivery: { sent: true, delivered: true, read: false }, voice_turn: false, subject: {} }]);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      appendLocal({ sender: "borrower", sender_label: "You", channel: "app", body_text: text });
      if (fixturesMode) {
        appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: "(FAKE fixtures mode — no assistant is connected; your message was recorded locally only.)" });
        return;
      }
      try {
        await api.sendMessage(text, record?.subject);
        await loadFromApi();
      } catch {
        appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: "Your message didn't send — it's marked unsent. We'll retry when the connection is back." });
      }
    },
    [appendLocal, fixturesMode, record?.subject, loadFromApi],
  );

  const firstReplyPolls = useRef(0);
  useEffect(() => {
    if (fixturesMode) return;
    const haveAgentLine = messages.some((m) => m.sender === "agent");
    const waitingForFirst = !!me && !haveAgentLine && firstReplyPolls.current < 60;
    if (stream === "open" && !waitingForFirst) return;
    const t = setInterval(() => { if (waitingForFirst) firstReplyPolls.current += 1; void loadFromApi(); }, waitingForFirst ? 3000 : 5000);
    return () => clearInterval(t);
  }, [fixturesMode, stream, me, messages, loadFromApi]);

  const attach = useCallback(
    async (file: File) => {
      if (fixturesMode) {
        appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: `Received ${file.name}. (FAKE fixtures mode — document.upload is not sent.)` });
        return;
      }
      try {
        await api.uploadDocument(file);
        appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: `Received ${file.name}. We'll sort it into your file.` });
      } catch {
        appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: copy("upload.unreadable") });
      }
    },
    [appendLocal, fixturesMode],
  );

  const launchVendor = useCallback(
    async (vendor: string, card_instance_id: string) => {
      if (fixturesMode) return { vendor_session_id: `FAKE-${vendor}-${card_instance_id}` };
      if (vendor === "stripe_identity") return api.identitySession({ fake_complete: true });
      return api.connectSession(vendor, card_instance_id, { fake_complete: true });
    },
    [fixturesMode],
  );

  const upload = useCallback(
    async (file: File, document_class: string) => {
      if (fixturesMode) return { document_id: `FAKE-doc-${file.name}` };
      return api.uploadDocument(file, document_class);
    },
    [fixturesMode],
  );

  const link = useCallback(
    (target: { message_id?: string; card_instance_id?: string; document_id?: string }) => {
      if (target.card_instance_id) {
        focusCard(target.card_instance_id);
        return;
      }
      if (target.document_id) {
        window.location.assign(`/app/doc/${encodeURIComponent(target.document_id)}`);
        return;
      }
      if (target.message_id) {
        setRecordOpen(false);
        setTab("chat");
        setScrollTo(target.message_id);
      }
    },
    [focusCard],
  );

  const cardProps = useMemo(() => ({ onOpen: link, onLaunchVendor: launchVendor, onUpload: upload, onMessage: sendMessage }), [link, launchVendor, upload, sendMessage]);
  const ask = useMemo(() => currentAsk(cards, record?.needed_from_you[0]?.card_instance_id, initialCard ?? pinnedId), [cards, record?.needed_from_you, initialCard, pinnedId]);

  const subjects = me?.subjects ?? [];
  const showSignIn = needsSignIn || signInOpen;
  const mobileTabs = !desktop && !showSignIn;
  const showChat = desktop || !mobileTabs || tab === "chat";

  return (
    <div className="sm-shell" data-testid="shell" data-fixtures={fixturesMode ? "1" : undefined} data-mobile-shell={mobileTabs ? "1" : undefined} data-tab={tab}>
      <Header
        fixturesMode={fixturesMode}
        me={me}
        subject={subject}
        onSubjectChange={setSubject}
        streamLabel={!fixturesMode && stream !== "open" && stream !== "closed" ? (stream === "reconnecting" ? "reconnecting…" : "connecting…") : undefined}
        onOpenRecord={() => setRecordOpen(true)}
        showSignIn={!me || fixturesMode}
        onSignIn={() => setSignInOpen(true)}
        onSignOut={() => { void api.signOut().catch(() => undefined).then(() => window.location.assign("/app")); }}
      />
      {showSignIn ? <div className="sm-strip-slot" /> : <StatusStrip record={record} onOpen={() => (desktop ? setRecordOpen(true) : setTab("tasks"))} />}
      <div className="sm-body">
        {showChat ? (
          <main className="sm-thread" aria-label="Conversation">
            {showSignIn ? (
              <>
                <div className="sm-thread-top" />
                <div className="sm-thread-scroll">
                  <Account mode="sign_in" titleKey="auth.welcome_back" partnerLegalName={me?.partner.legal_name} onSession={() => window.location.reload()} onCancel={signInOpen && !needsSignIn ? () => setSignInOpen(false) : undefined} />
                </div>
              </>
            ) : (
              <Thread
                notice={loadError}
                banner={me?.auth_method === "oidc_google" && !addMobileDone ? <AddMobilePrompt onDone={() => setAddMobileDone(true)} /> : null}
                messages={messages}
                cards={cards}
                timezone={timezone}
                partnerLegalName={partner}
                showSubjectLabels={subjects.length > 1}
                scrollTo={scrollTo}
                currentAskId={ask?.card_instance_id}
                onOpenCard={focusCard}
                resolve={resolveCard}
                busyCardId={busyCardId}
                cardErrors={cardErrors}
              />
            )}
            {showSignIn ? null : (
              <ActionBar onSend={(t) => void sendMessage(t)} onAttach={(f) => void attach(f)} />
            )}
          </main>
        ) : tab === "apply" ? (
          <ApplyTab record={record} onOpenTask={openTask} />
        ) : tab === "loan" ? (
          <MyLoanTab record={record} />
        ) : tab === "tasks" ? (
          <TasksTab record={record} onOpenTask={openTask} />
        ) : (
          <AccountSettingsTab me={me} />
        )}
        {showSignIn || (mobileTabs && tab !== "chat") ? null : (
          <Record record={record} cards={cards} timezone={timezone} cardProps={cardProps} resolve={resolveCard} busyCardId={busyCardId} cardErrors={cardErrors} currentAskId={ask?.card_instance_id} focus={focus} link={link} open={recordOpen} onClose={() => setRecordOpen(false)} />
        )}
      </div>
      {mobileTabs ? <BottomNav tab={tab} onTab={setTab} taskCount={record?.needed_from_you.length ?? 0} /> : null}
      <FooterDisclosure partner={me?.partner} />
    </div>
  );
}
