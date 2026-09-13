"use client";

/**
 * 32.17 — /app/video: the one shell of 32.16 with the thread replaced by the call pane (VideoCall) and the rail unchanged beside it
 * (Progress, Needed from you with the current ask open and the rest behind "n more after this", Connections, Documents, …, Numbers).
 * There is no account door here (32.17 rule 11): a visitor with no session sees the call pane at once, and starting the call opens
 * an account on the spot (POST /v1/borrower/video/sessions answers the session token once; the proxy keeps it in the cookie) — the
 * rail and the stream follow as soon as the session exists, and Michelle asks the name and the e-mail on the call. "Sign in" in
 * the header stays for someone who already has an account. No composer, no microphone control of Supermortgage's own, no
 * "Talk to a person"; the disclosure footer under everything (§1 principle 8).
 *
 * The screen is the call (32.17 rule 16): the stage is the whole body, the rail is a drawer behind the header's "Your record",
 * and one card rises over the stage only when a tap is needed — Michelle proposed into it, asked for it, or it is a kind no
 * words can answer (lib/video/ask.ts). "Not now" sets it aside until she proposes or asks again.
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
import { Card } from "@/components/cards";
import { CardBoundary } from "@/components/flows/13-cross-cutting/CardBoundary";
import { cardTitle, ConfirmChip } from "@/components/shell/chips";
import { askRises, askStamp, pickAsk } from "@/lib/video/ask";
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
const STREAM_EVENTS = ["card.sent", "card.resolved", "message.appended", "video.session.opened", "video.session.joined", "video.session.ended", "video.session.failed", "video.session.greeting"] as const;
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
  const [cardErrorCodes, setCardErrorCodes] = useState<globalThis.Record<string, string>>({});
  // 32.17 rule 12: the identity card's address is on file for another account — the sign-in form opens with it, a code proves it is theirs
  const [signInEmail, setSignInEmail] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [stream, setStream] = useState<StreamStatus>("closed");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [statusTick, setStatusTick] = useState(0);
  const [session, setSession] = useState<VideoSession | null>(null);
  const [setAside, setSetAside] = useState<Set<string>>(() => new Set());
  // 32.17 rule 16: the card Michelle asked for herself (card.request → card.sent) is the thing she is talking about — it rises ahead of the record's current ask while it is pending
  const [requestedId, setRequestedId] = useState<string | undefined>();
  // 32.17 rule 16: under a proposal the confirm chip is the one Confirm on the screen; Edit opens the card beneath it (keyed by the ask's stamp, so a new proposal closes it)
  const [editingAsk, setEditingAsk] = useState<string | null>(null);
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
      if (fresh) { focusCard(fresh.card_instance_id); if ((fresh.props as { requested_by?: string }).requested_by === "card.request") setRequestedId(fresh.card_instance_id); }
      knownCards.current = new Set(t.cards.map((c) => c.card_instance_id));
      loaded.current = true;
      setLoadError(undefined);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) {
        // no session yet: the call pane opens the account (32.17 rule 11); nothing to load until it has
        streamRef.current?.close(); streamRef.current = null; setStream("closed");
        setMe(undefined); setNeedsSignIn(false); setLoadError(undefined);
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
    return () => streamRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixturesMode, fixtureName]);
  // the stream opens once a session exists (the account door, or the one the call just opened): a stream before that would only reconnect on 401
  const openTheStream = useCallback(() => {
    if (fixturesMode || streamRef.current) return;
    streamRef.current = openStream((ev) => {
      if (ev.event_name.startsWith("video.session.")) setStatusTick((t) => t + 1);
      void loadFromApi(ev.event_name);
    }, (s) => { setStream(s); if (s === "open" && loaded.current) void loadFromApi("stream.open"); }, STREAM_EVENTS);   // a (re)connect re-reads what a closed stream may have missed
  }, [fixturesMode, loadFromApi]);
  useEffect(() => { if (me) openTheStream(); }, [me, openTheStream]);
  // the call opened the account (or reopened on the existing one): re-read me, the record and the cards now that the cookie carries the session
  const onSession = useCallback((s: VideoSession | null) => { setSession(s); if (s && s.status !== "failed" && !fixturesMode) void loadFromApi("video.session.opened"); }, [fixturesMode, loadFromApi]);

  const resolveCard = useCallback(async (card: AnyCardInstance, req: ResolveRequest) => {
    setBusyCardId(card.card_instance_id);
    setCardErrors((e) => ({ ...e, [card.card_instance_id]: "" })); setCardErrorCodes((e) => ({ ...e, [card.card_instance_id]: "" }));
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
      setCardErrorCodes((codes) => ({ ...codes, [card.card_instance_id]: e instanceof ApiRequestError ? e.body.code : "" }));
    } finally { setBusyCardId(undefined); }
  }, [fixturesMode, subject]);
  /** The way out a refusal names: the identity card's address on file for another account → sign in with it (the form, the address filled in). */
  const chipAction = useCallback((card: AnyCardInstance): { label: string; onClick: () => void } | undefined => {
    if (cardErrorCodes[card.card_instance_id] !== "IDENTITY_EMAIL_ON_FILE") return undefined;
    const email = (proposalOf(card)?.fields ?? []).find((f) => f.path === "email")?.value ?? "";
    return { label: copy("identity.contact.sign_in"), onClick: () => { setSignInEmail(email); setSignInOpen(true); } };
  }, [cardErrorCodes]);

  const launchVendor = useCallback(async (vendor: string, card_instance_id: string) => {
    if (fixturesMode) return { vendor_session_id: `FAKE-${vendor}-${card_instance_id}` };
    // 32.17 rule 19: every build stage's vendor is the FAKE — it finishes on the tap; a real vendor ignores the flag
    if (vendor === "stripe_identity") return api.identitySession({ fake_complete: true });
    return api.connectSession(vendor, card_instance_id, { fake_complete: true });
  }, [fixturesMode]);
  const upload = useCallback(async (file: File, document_class: string) => (fixturesMode ? { document_id: `FAKE-doc-${file.name}` } : api.uploadDocument(file, document_class)), [fixturesMode]);
  const link = useCallback((target: { message_id?: string; card_instance_id?: string; document_id?: string }) => {
    if (target.card_instance_id) { focusCard(target.card_instance_id); return; }
    if (target.document_id) window.location.assign(`/app/doc/${encodeURIComponent(target.document_id)}`);
  }, [focusCard]);
  // no composer here: a card's "message" action has no thread to land in — it focuses the card instead
  const cardProps = useMemo(() => ({ onOpen: link, onLaunchVendor: launchVendor, onUpload: upload, onMessage: async () => undefined }), [link, launchVendor, upload]);
  // 32.17 discrepancy (1): a pending card the call proposed into is the thing to confirm now — it is the current ask (its row open, Confirm · Edit on it); else the record's current ask
  // 32.17 rule 16: the one card for the stage — the newest proposal, else the card Michelle asked for, else the first of the record's needs that rises and is not set aside ("Not now" moves to the next)
  const ask = useMemo(() => pickAsk(cards, (record?.needed_from_you ?? []).map((n) => n.card_instance_id).filter((id): id is string => !!id), requestedId, setAside) ?? undefined, [cards, record?.needed_from_you, requestedId, setAside]);
  // the drawer is the full rail (32.16 T11): its open row is the record's own current ask — the proposal, else the card Michelle asked for, else the record's first need — whatever the stage shows
  const railAsk = useMemo(() => {
    const proposed = Object.values(cards).filter((c) => c.status === "pending" && !!proposalOf(c)).sort((a, b) => ((proposalOf(a)?.proposed_at ?? "") < (proposalOf(b)?.proposed_at ?? "") ? 1 : -1))[0];
    const requested = requestedId ? cards[requestedId] : undefined;
    return proposed ?? (requested && requested.status === "pending" ? requested : undefined) ?? currentAsk(cards, record?.needed_from_you[0]?.card_instance_id);
  }, [cards, record?.needed_from_you, requestedId]);
  // 32.17 rule 16: the one card over the stage, and why it is there
  const rise = askRises(ask, setAside);
  const askAside = useCallback(() => { if (ask) setSetAside((s) => new Set([...s, askStamp(ask)])); }, [ask]);
  // the latest rates element the call produced (32.16 T7): drawn under the rail's Numbers
  const rates = useMemo(() => [...messages].filter((m) => m.channel === "video" && isRatesElement(m.copy_tokens)).sort((a, b) => (a.at < b.at ? 1 : -1))[0], [messages]);

  const subjects = me?.subjects ?? [];
  const showSignIn = signInOpen;   // only an explicit tap on Sign in: without a session the call pane is the door (32.17 rule 11)

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
                <Account mode="sign_in" titleKey="auth.welcome_back" partnerLegalName={me?.partner.legal_name} initialEmail={signInEmail} onSession={() => window.location.reload()} onCancel={signInOpen && !needsSignIn ? () => setSignInOpen(false) : undefined} />
              </div>
            </>
          ) : (
            <>
              {loadError ? (
                <p className="sm-error" role="alert" style={{ margin: 0, padding: "8px 16px" }}>{loadError}</p>
              ) : null}
              <VideoCall fixturesMode={fixturesMode} firstName={me?.first_name} statusTick={statusTick} onSession={onSession} />
              {ask && rise ? (
                <div className="sm-ask-overlay" data-testid="ask-overlay" data-card-id={ask.card_instance_id} data-reason={rise} role="dialog" aria-label={cardTitle(ask)}>
                  {rise === "proposal" && proposalOf(ask) ? (
                    <div className="sm-rail-proposal" data-testid="ask-proposal">
                      <p className="sm-muted sm-rail-proposal-hint">{copy("video.rail_confirm.hint")}</p>
                      <ConfirmChip card={ask} proposal={proposalOf(ask)!} busy={busyCardId === ask.card_instance_id} error={cardErrors[ask.card_instance_id]} action={chipAction(ask)} onConfirm={(req) => void resolveCard(ask, req)} onEdit={() => setEditingAsk(askStamp(ask))} />
                    </div>
                  ) : null}
                  {rise !== "proposal" || editingAsk === askStamp(ask) ? (
                    <CardBoundary card={ask}>
                      <Card key={askStamp(ask)} card={ask} timezone={timezone} {...cardProps} onResolve={(req) => resolveCard(ask, req)} busy={busyCardId === ask.card_instance_id} error={cardErrors[ask.card_instance_id]} />
                    </CardBoundary>
                  ) : null}
                  <div className="sm-ask-overlay-actions">
                    <button type="button" className="sm-btn sm-btn-quiet" data-testid="ask-not-now" onClick={askAside}>{copy("ask.not_now")}</button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </main>
        {showSignIn ? null : (
          <Record
            record={record} cards={cards} timezone={timezone} cardProps={cardProps} resolve={resolveCard} busyCardId={busyCardId} cardErrors={cardErrors} currentAskId={railAsk?.card_instance_id} focus={focus} link={link} open={recordOpen} onClose={() => setRecordOpen(false)}
            proposalStrip drawer
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
