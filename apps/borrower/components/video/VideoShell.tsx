"use client";

/**
 * 32.17 — /app/video: the one shell of 32.16 with the thread replaced by the call pane (VideoCall) and the rail unchanged beside it
 * (Progress, Needed from you with the current ask open and the rest behind "n more after this", Connections, Documents, …, Numbers).
 * The account door of 32.16 §2.0 stands in front of it exactly as in front of /app: a 401 renders the sign-in form under
 * auth.welcome_back. No composer, no microphone control of Supermortgage's own, no "Talk to a person"; the disclosure footer
 * under everything (§1 principle 8).
 *
 * The confirm loop confirms on the rail (32.17 discrepancy 1): the pending card the model proposed into shows the stated values
 * with Confirm and Edit on its own row (`proposalStrip`), and Confirm resolves it with evidence.source = borrower_stated. A card
 * the model requested arrives over the same SSE stream as `card.sent` (discrepancy 2): the rail focuses and expands it — no chip.
 * A rates element the call produced (32.16 T7) renders under the rail's Numbers, since there is no thread to draw it in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { api, ApiRequestError } from "@/lib/api/client";
import { openStream, type StreamStatus } from "@/lib/api/sse";
import type { VideoSession } from "@/lib/api/video";
import { loadFixture } from "@/lib/fixtures";
import { copy } from "@/lib/copy";
import { currentAsk } from "@/components/shell/Thread";
import { StatusStrip } from "@/components/shell/StatusStrip";
import { Header } from "@/components/shell/Header";
import { FooterDisclosure } from "@/components/shell/FooterDisclosure";
import { Account } from "@/components/account/Account";
import { RatesElement, isRatesElement } from "@/components/shell/RatesElement";
import { PARTNER_LEGAL_NAME } from "@/lib/env";
import { Record } from "@/components/record/Record";
import { proposalOf } from "@/components/record/Rail";
import { nowIso } from "@/components/cards/CardFrame";
import { VideoCall } from "./VideoCall";

export type VideoShellProps = { fixturesMode: boolean; fixtureName?: string; initialSubject?: string };

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
/** The named SSE frames this page follows (src/runtime/borrower/stream.ts): a card the call put on the rail, a card resolved, a reply appended, the session's own state. */
const STREAM_EVENTS = ["card.sent", "card.resolved", "message.appended", "video.session.opened", "video.session.joined", "video.session.ended", "video.session.failed"] as const;
let seq = 0;

export function VideoShell({ fixturesMode, fixtureName, initialSubject }: VideoShellProps) {
  const [me, setMe] = useState<BorrowerMe | undefined>();
  const [record, setRecord] = useState<BorrowerRecord | undefined>();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [cards, setCards] = useState<globalThis.Record<string, AnyCardInstance>>({});
  const [subject, setSubject] = useState<string | undefined>(initialSubject);
  const [recordOpen, setRecordOpen] = useState(false);
  const [focus, setFocus] = useState<{ card_instance_id: string; seq: number } | undefined>();
  const [busyCardId, setBusyCardId] = useState<string | undefined>();
  const [cardErrors, setCardErrors] = useState<globalThis.Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | undefined>();
  const [stream, setStream] = useState<StreamStatus>("closed");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [statusTick, setStatusTick] = useState(0);
  const [session, setSession] = useState<VideoSession | null>(null);
  const beside = useMedia("(min-width: 1024px)");
  const streamRef = useRef<ReturnType<typeof openStream> | null>(null);
  const knownCards = useRef<Set<string>>(new Set());
  const loaded = useRef(false);

  const timezone = record?.timezone ?? "America/Phoenix";
  const partner = me?.partner.legal_name || PARTNER_LEGAL_NAME;

  const focusCard = useCallback((card_instance_id: string) => { setFocus({ card_instance_id, seq: (seq += 1) }); if (!beside) setRecordOpen(true); }, [beside]);

  const loadFromApi = useCallback(async (reason?: string) => {
    try {
      const m = await api.me();
      setMe(m);
      setNeedsSignIn(false);
      const subj = subject ?? (m.subjects[0]?.loan_id ? `loan:${m.subjects[0].loan_id}` : m.subjects[0]?.application_id ? `application:${m.subjects[0].application_id}` : undefined);
      if (subj) { setSubject(subj); setRecord(await api.record(subj)); }
      const t = await api.thread();
      setMessages(t.messages);
      const next = Object.fromEntries(t.cards.map((c) => [c.card_instance_id, c]));
      setCards(next);
      // 32.17 discrepancy (2): a card the call put on the rail (card.sent over the stream; or one `card.request` raised, seen on any later re-fetch should a frame be missed) is focused and expanded there — the newest pending card this page had not seen
      const fresh = loaded.current ? t.cards.filter((c) => c.status === "pending" && !knownCards.current.has(c.card_instance_id) && (reason === "card.sent" || (c.props as { requested_by?: string }).requested_by === "card.request")).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] : undefined;
      if (fresh) focusCard(fresh.card_instance_id);
      knownCards.current = new Set(t.cards.map((c) => c.card_instance_id));
      loaded.current = true;
      setLoadError(undefined);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) {
        streamRef.current?.close(); streamRef.current = null; setStream("closed");
        setNeedsSignIn(true); setLoadError(undefined);
        return;
      }
      setLoadError(e instanceof ApiRequestError ? copy(e.body.copy_key) : "We can't reach your loan right now. Nothing is lost — try again in a moment.");
    }
  }, [subject, focusCard]);

  useEffect(() => {
    if (fixturesMode && fixtureName !== "api") {
      const f = loadFixture(fixtureName);
      setMe(f.me); setRecord(f.record); setMessages(f.messages);
      setCards(Object.fromEntries(f.cards.map((c) => [c.card_instance_id, c])));
      return;
    }
    void loadFromApi();
    streamRef.current = openStream((ev) => {
      if (ev.event_name.startsWith("video.session.")) setStatusTick((t) => t + 1);
      void loadFromApi(ev.event_name);
    }, (s) => { setStream(s); if (s === "open" && loaded.current) void loadFromApi("stream.open"); }, STREAM_EVENTS);   // a (re)connect re-reads what a closed stream may have missed
    return () => streamRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixturesMode, fixtureName]);

  const resolveCard = useCallback(async (card: AnyCardInstance, req: ResolveRequest) => {
    setBusyCardId(card.card_instance_id);
    setCardErrors((e) => ({ ...e, [card.card_instance_id]: "" }));
    try {
      if (fixturesMode) {
        const resolved: AnyCardInstance = { ...card, status: "resolved", resolved_at: nowIso(), evidence: req.evidence } as AnyCardInstance;
        if ("proposal" in resolved.props) { const { proposal: _proposal, ...rest } = resolved.props as globalThis.Record<string, unknown>; (resolved as { props: unknown }).props = rest; }
        setCards((c) => ({ ...c, [card.card_instance_id]: resolved }));
        setRecord((r) => (r ? { ...r, needed_from_you: r.needed_from_you.filter((n) => n.card_instance_id !== card.card_instance_id) } : r));
        return;
      }
      const res = await api.resolveCard(card.card_instance_id, req);
      setCards((c) => ({ ...c, [card.card_instance_id]: res.card }));
      if (subject) setRecord(await api.record(subject));
    } catch (e) {
      setCardErrors((errs) => ({ ...errs, [card.card_instance_id]: e instanceof ApiRequestError ? copy(e.body.copy_key) : "That didn't go through. Nothing was changed — try again." }));
    } finally { setBusyCardId(undefined); }
  }, [fixturesMode, subject]);

  const launchVendor = useCallback(async (vendor: string, card_instance_id: string) => {
    if (fixturesMode) return { vendor_session_id: `FAKE-${vendor}-${card_instance_id}` };
    if (vendor === "stripe_identity") return api.identitySession();
    return api.connectSession(vendor, card_instance_id);
  }, [fixturesMode]);
  const upload = useCallback(async (file: File, document_class: string) => (fixturesMode ? { document_id: `FAKE-doc-${file.name}` } : api.uploadDocument(file, document_class)), [fixturesMode]);
  const link = useCallback((target: { message_id?: string; card_instance_id?: string; document_id?: string }) => {
    if (target.card_instance_id) { focusCard(target.card_instance_id); return; }
    if (target.document_id) window.location.assign(`/app/doc/${encodeURIComponent(target.document_id)}`);
  }, [focusCard]);
  // no composer here: a card's "message" action has no thread to land in — it focuses the card instead
  const cardProps = useMemo(() => ({ onOpen: link, onLaunchVendor: launchVendor, onUpload: upload, onMessage: async () => undefined }), [link, launchVendor, upload]);
  // 32.17 discrepancy (1): a pending card the call proposed into is the thing to confirm now — it is the current ask (its row open, Confirm · Edit on it); else the record's current ask
  const ask = useMemo(() => {
    const proposed = Object.values(cards).filter((c) => c.status === "pending" && !!proposalOf(c)).sort((a, b) => ((proposalOf(a)?.proposed_at ?? "") < (proposalOf(b)?.proposed_at ?? "") ? 1 : -1))[0];
    return proposed ?? currentAsk(cards, record?.needed_from_you[0]?.card_instance_id);
  }, [cards, record?.needed_from_you]);
  // the latest rates element the call produced (32.16 T7): drawn under the rail's Numbers
  const rates = useMemo(() => [...messages].filter((m) => m.channel === "video" && isRatesElement(m.copy_tokens)).sort((a, b) => (a.at < b.at ? 1 : -1))[0], [messages]);

  const subjects = me?.subjects ?? [];
  const showSignIn = needsSignIn || signInOpen;

  return (
    <div className="sm-shell" data-testid="shell" data-video="1" data-fixtures={fixturesMode ? "1" : undefined}>
      <Header fixturesMode={fixturesMode} me={me} subject={subject} onSubjectChange={setSubject} streamLabel={!fixturesMode && stream !== "open" && stream !== "closed" ? (stream === "reconnecting" ? "reconnecting…" : "connecting…") : undefined} onOpenRecord={() => setRecordOpen(true)} showSignIn={!me || fixturesMode} onSignIn={() => setSignInOpen(true)} />
      {showSignIn ? <div className="sm-strip-slot" /> : <StatusStrip record={record} onOpen={() => setRecordOpen(true)} />}
      <div className="sm-body">
        <main className="sm-thread sm-video-main" aria-label="Video call">
          {showSignIn ? (
            <>
              <div className="sm-thread-top" />
              <div className="sm-thread-scroll">
                <Account mode="sign_in" titleKey="auth.welcome_back" partnerLegalName={me?.partner.legal_name} onSession={() => window.location.reload()} onCancel={signInOpen && !needsSignIn ? () => setSignInOpen(false) : undefined} />
              </div>
            </>
          ) : (
            <>
              {loadError ? (
                <p className="sm-error" role="alert" style={{ margin: 0, padding: "8px 16px" }}>{loadError}</p>
              ) : null}
              <VideoCall fixturesMode={fixturesMode} statusTick={statusTick} onSession={setSession} />
            </>
          )}
        </main>
        {showSignIn ? null : (
          <Record
            record={record} cards={cards} timezone={timezone} cardProps={cardProps} resolve={resolveCard} busyCardId={busyCardId} cardErrors={cardErrors} currentAskId={ask?.card_instance_id} focus={focus} link={link} open={recordOpen} onClose={() => setRecordOpen(false)}
            proposalStrip
            extras={rates?.copy_tokens ? (
              <section className="sm-record-section" data-record-section="rates" data-testid="rail-rates">
                <h2 className="sm-rail-h"><span>Numbers · today's rates</span></h2>
                <RatesElement tokens={rates.copy_tokens as globalThis.Record<string, string>} timezone={timezone} />
              </section>
            ) : null}
          />
        )}
      </div>
      <FooterDisclosure partner={me?.partner} />
      {session ? <span className="sm-visually-hidden" data-testid="video-session-status" data-status={session.status}>{session.status}</span> : null}
      {subjects.length > 1 ? <span className="sm-visually-hidden">{partner}</span> : null}
    </div>
  );
}
