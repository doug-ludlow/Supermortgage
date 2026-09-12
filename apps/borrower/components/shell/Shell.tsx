"use client";

/**
 * The one shell (01 §1): Thread (left) · Record (right) · Action bar. Breakpoints per
 * 01 §1.2. Data comes from the 02 §7 API through lib/api, or — with NEXT_PUBLIC_FIXTURES=1 —
 * from apps/borrower/fixtures/*.json (FAKE: recorded, no agent, no vendors).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { api, ApiRequestError } from "@/lib/api/client";
import { openStream, type StreamStatus } from "@/lib/api/sse";
import { loadFixture } from "@/lib/fixtures";
import { copy } from "@/lib/copy";
import { Thread } from "./Thread";
import { ActionBar } from "./ActionBar";
import { StatusStrip } from "./StatusStrip";
import { Header } from "./Header";
import { Account } from "@/components/account/Account";   // 32.16 §2.0 (DELTA-29): the account form on any 401 — Shell decides, Account renders
import { AddMobilePrompt, isAddMobileDone } from "./AddMobile";
import { PARTNER_LEGAL_NAME } from "@/lib/env";
import { Record } from "@/components/record/Record";
import { Card } from "@/components/cards";
import { nowIso } from "@/components/cards/CardFrame";

export type ShellProps = {
  fixturesMode: boolean;
  fixtureName?: string;
  initialSubject?: string;
  /** 32.14 S5: `?card=` — that card is pinned and scrolled into view (a deep link or a vendor return lands here). */
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

/** Timestamp for a locally appended message: now, but never earlier than the thread's last message (fixtures are recorded in the future). */
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
  const [busyCardId, setBusyCardId] = useState<string | undefined>();
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | undefined>();
  const [stream, setStream] = useState<StreamStatus>("closed");
  // 32.16 §2.0 (DELTA-29): a 401 from me, or the header's Sign in, renders the sign-in form under auth.welcome_back in place of the thread (the anonymous minute of docs/ux/15 is not built — docs/ux/17 §0.4)
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [addMobileDone, setAddMobileDone] = useState(true);
  useEffect(() => setAddMobileDone(isAddMobileDone()), []); // after hydration: the dismissal lives in this browser only
  const wide = useMedia("(min-width: 1024px)");
  const streamRef = useRef<ReturnType<typeof openStream> | null>(null);

  const timezone = record?.timezone ?? "America/Phoenix";
  const partner = me?.partner.legal_name || PARTNER_LEGAL_NAME;   // the API names the record's partner; "" (none on file yet) → the build's configured partner, never Supermortgage

  // ---- load ---------------------------------------------------------------
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
      setCards(Object.fromEntries(t.cards.map((c) => [c.card_instance_id, c])));
      setLoadError(undefined);
      if (initialCard) setScrollTo(initialCard);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) {
        // no session (or it expired and the proxy dropped the cookie): the sign-in form — never the auth.sign_in notice
        streamRef.current?.close(); streamRef.current = null; setStream("closed");   // no session: nothing to stream (the label would read "reconnecting…" forever)
        setNeedsSignIn(true);
        setLoadError(undefined);
        return;
      }
      setLoadError(e instanceof ApiRequestError ? copy(e.body.copy_key) : "We can't reach your loan right now. Nothing is lost — try again in a moment.");
    }
  }, [subject, initialCard]);

  useEffect(() => {
    // `?fixture=api` in a fixtures build takes the live path (the e2e drives the root of the host with routed API answers)
    if (fixturesMode && fixtureName !== "api") {
      const f = loadFixture(fixtureName);
      setMe(f.me);
      setRecord(f.record);
      setMessages(f.messages);
      setCards(Object.fromEntries(f.cards.map((c) => [c.card_instance_id, c])));
      if (initialCard) setScrollTo(initialCard);
      return;
    }
    void loadFromApi();
    streamRef.current = openStream(() => void loadFromApi(), setStream);
    return () => streamRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixturesMode, fixtureName]);

  // ---- actions ------------------------------------------------------------
  const resolveCard = useCallback(
    async (card: AnyCardInstance, req: ResolveRequest) => {
      setBusyCardId(card.card_instance_id);
      setCardErrors((e) => ({ ...e, [card.card_instance_id]: "" }));
      try {
        if (fixturesMode) {
          // FAKE resolution: the API would run the mapped command (02 §2); here the fixture mutates in memory.
          const resolved: AnyCardInstance = { ...card, status: card.kind === "ConnectCard" && req.option_id === "connect" ? "pending" : "resolved", resolved_at: nowIso(), evidence: req.evidence } as AnyCardInstance;
          if (card.kind === "ConnectCard" && req.option_id === "connect") {
            (resolved as AnyCardInstance & { props: { state: string } }).props = { ...card.props, state: "in_progress" } as never;
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
      } catch {
        appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: "Your message didn't send — it's marked unsent. We'll retry when the connection is back." });
      }
    },
    [appendLocal, fixturesMode, record?.subject],
  );

  const talkToPerson = useCallback(async () => {
    // 01 §1.1: emits human.transfer.requested (command human.request), one action away on every screen.
    if (fixturesMode) {
      const id = localId("card");
      const personCard: AnyCardInstance = {
        card_instance_id: id,
        conversation_id: messages[0]?.conversation_id ?? "local",
        party_id: me?.party_id ?? "local",
        subject: record?.subject ?? {},
        kind: "PersonCard",
        status: "resolved",
        created_by: "system",
        copy_key: "team.assigned",
        created_at: nowIso(),
        props: { role: "human_agent", name: "Sam Ortega", credentials: "FAKE human agent (fixtures mode)", intro: "Hi — I'm here. What can I help with?" },
      };
      setCards((c) => ({ ...c, [id]: personCard }));
      setMessages((ms) => {
        const at = stampAfter(ms);
        const at2 = new Date(new Date(at).getTime() + 1000).toISOString();
        return [
          ...ms,
          { message_id: localId("m"), conversation_id: ms[0]?.conversation_id ?? "local", at, sender: "system", sender_label: "Supermortgage", channel: "app", body_text: "Bringing a person in now. (FAKE fixtures mode: human.transfer.requested → human.transfer.completed is simulated.)", subject: {}, voice_turn: false, delivery: { sent: true, delivered: true, read: false } },
          { message_id: localId("m"), conversation_id: ms[0]?.conversation_id ?? "local", at: at2, sender: "human", sender_label: "Sam · Loan specialist", channel: "app", card_instance_id: id, subject: {}, voice_turn: false, delivery: { sent: true, delivered: true, read: false } },
        ];
      });
      return;
    }
    try {
      await api.requestHuman();
      appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: "Bringing a person in now." });
    } catch {
      appendLocal({ sender: "system", sender_label: "Supermortgage", channel: "app", body_text: "We couldn't reach a person just now — call the number on your statement, or try again." });
    }
  }, [appendLocal, fixturesMode, me?.party_id, messages, record?.subject]);

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
      if (fixturesMode) return { vendor_session_id: `FAKE-${vendor}-${card_instance_id}` }; // FAKE vendor session
      if (vendor === "stripe_identity") return api.identitySession();
      return api.connectSession(vendor, card_instance_id);
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

  const link = useCallback((target: { message_id?: string; card_instance_id?: string; document_id?: string }) => {
    if (target.document_id && !target.card_instance_id && !target.message_id) {
      window.location.assign(`/app/doc/${encodeURIComponent(target.document_id)}`);
      return;
    }
    setRecordOpen(false);
    setScrollTo(target.card_instance_id ?? target.message_id);
  }, []);

  const cardProps = useMemo(() => ({ onOpen: link, onLaunchVendor: launchVendor, onUpload: upload, onMessage: sendMessage }), [link, launchVendor, upload, sendMessage]);

  const comparisonInRecord = useMemo(() => (wide ? Object.values(cards).filter((c) => c.kind === "ComparisonCard" && c.status === "pending") : []), [cards, wide]);

  const subjects = me?.subjects ?? [];
  const showSignIn = needsSignIn || signInOpen;

  return (
    <div className="sm-shell" data-testid="shell" data-fixtures={fixturesMode ? "1" : undefined}>
      <Header
        fixturesMode={fixturesMode}
        me={me}
        subject={subject}
        onSubjectChange={setSubject}
        streamLabel={!fixturesMode && stream !== "open" && stream !== "closed" ? (stream === "reconnecting" ? "reconnecting…" : "connecting…") : undefined}
        onOpenRecord={() => setRecordOpen(true)}
        showSignIn={!me || fixturesMode}
        onSignIn={() => setSignInOpen(true)}
      />
      <StatusStrip record={record} onOpen={() => setRecordOpen(true)} />
      <div className="sm-body">
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
              pinnedId={initialCard}
              messages={messages}
              cards={cards}
              timezone={timezone}
              partnerLegalName={partner}
              showSubjectLabels={subjects.length > 1}
              wide={wide}
              scrollTo={scrollTo}
              cardProps={cardProps}
              resolve={resolveCard}
              busyCardId={busyCardId}
              cardErrors={cardErrors}
            />
          )}
          {showSignIn ? null : (   // signed out there is no session to send to or hand off from: no action bar until sign-in
            <ActionBar onSend={(t) => void sendMessage(t)} onAttach={(f) => void attach(f)} onTalkToPerson={() => void talkToPerson()} />
          )}
        </main>
        <Record record={record} link={link} open={recordOpen} onClose={() => setRecordOpen(false)}>
          {comparisonInRecord.map((c) => (
            <Card key={c.card_instance_id} card={c} timezone={timezone} {...cardProps} onResolve={(req) => resolveCard(c, req)} busy={busyCardId === c.card_instance_id} error={cardErrors[c.card_instance_id]} />
          ))}
        </Record>
      </div>
    </div>
  );
}
