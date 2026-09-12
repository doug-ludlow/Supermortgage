# 32.17 — The video agent: the same conversation, face to face, with the cards on the rail

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | b — the model of 32.16 speaks through a Tavus replica instead of typing; every fact is still a card the borrower taps; every tool call is still a bus command; the utterance guard still runs before a word is spoken |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the conversation; the system of record stays with the owning process |
| Trigger & frequency | On the borrower opening `/video` (the account door of 32.16 §2.0 first); then on every spoken turn for the length of the call; per party, any number of calls |
| Governing source | 32.16 (the agent turn, the guard, the rail, the four card cases) unchanged; 20.3 (disclosure of an automated system; the lender named); Reg Z §1026.24 (a spoken rate carries its APR); Reg B / ECOA §1002.4 (no inference from appearance: the replica's perception layer is off); 19.x records (the transcript is the record, kept by Supermortgage, not the vendor) |
| Key deadlines | none of its own; `timer.due` renders the same allow-listed clocks as 32.16 |
| Timers | — |

### Blueprint row
The borrower experience of 32.16 is a thread on the left and a rail of cards on the right. `/video` replaces the thread with a live video agent: a Tavus Conversational Video Interface replica the borrower talks to, face to face, that speaks the same words the 32.16 turn would have typed. The rail is the same rail: the current ask open, the rest waiting behind one line, a card appearing when the rules need one. Nothing is committed by speech; a tap is the answer. The brain does not move to the vendor: Tavus is the face and the voice, Supermortgage is the model, the tools, the guard and the record.

### Verified requirement (as of 2026-09-12)
**One brain (32.16 §3, DELTA-23/24/25).** The Tavus persona's language-model layer is configured as a *custom LLM* whose base URL is Supermortgage's own OpenAI-compatible chat-completions endpoint, keyed per video session. Every spoken borrower turn therefore arrives at the same `AgentTurnRunner` as a typed one — context rebuilt from the record, the nine bus tools, the six-check guard with one regeneration, an `agent_turns` row — with `channel = video`. The words Tavus receives to speak are the guarded reply with its `{{tokens}}` filled server-side (a text-to-speech engine cannot fill a token; a raw figure never leaves the guard). **[PARTIALLY VERIFIED — the persona `layers.llm` fields (`model`, `base_url`, `api_key`, `speculative_inference`) and the appended `/chat/completions` path are taken from the vendor's published examples and SDK; the vendor's exact first-token latency budget is not published and is treated as an operational input]**

**The transcript is Supermortgage's (19.x; 18.1).** The borrower's words reach the turn through the custom-LLM request and are written to `messages{channel=video, sender=borrower}`; the reply is written as `messages{sender=agent}` before it is returned to be spoken. The vendor's own transcript, when its `application.transcription_ready` callback arrives, is stored as a reference (`video_sessions.transcript_ref`), never as the record. Recording is off; the borrower's camera is never stored by Supermortgage.

**No inference from appearance (Reg B §1002.4(a)–(b); 19.x fair lending).** The persona's perception layer is off. The model never receives an image, a frame description or a visual-trait analysis of the borrower; the context contract of 32.16 §3.2 (T-17-02) is unchanged.

**Disclosure (Utah Code §13-2-12; Cal. Bus. & Prof. Code §17941; 20.3).** The disclosure footer of 32.16 principle 8 is on the video screen. The replica's first words are the guarded first turn (32.16 §2.0), which says in its own words that it is an automated assistant of the partner; the partner is named as the lender; Supermortgage is never named as the lender.

**A spoken rate carries its APR (Reg Z §1026.24(c)).** The rates element of 32.16 T-17-07 renders under Numbers on the rail, and the spoken sentence names each rate with its APR — the guard's provenance and compliance checks apply to the spoken text exactly as to the typed one.

**Discrepancies vs blueprint**: (1) 32.16 §3.4's confirm chip lives in the thread; there is no thread here, so the proposal-and-confirm loop confirms on the rail: the pending card shows the borrower's stated values with a Confirm and an Edit, and the tap resolves the card with `evidence.source = borrower_stated`. (2) 32.16 §2.1's reference chip has no thread to live in; `card.request` in a video turn focuses the card on the rail (the `card.sent` event over the session's SSE stream does the focusing, 32.16 §2.2) and writes no chip. (3) Every vendor is a FAKE in every build stage (32 README): `FakeTavus` (`FAKE`) stands in when `TAVUS_API_KEY` is unset; it hands out a local `conversation_url` whose page takes typed or spoken words and posts them through the same custom-LLM endpoint, and it sends the same callbacks, so every test below runs without a vendor credential and a swap to the live client changes no card, command or test.

### Operational prerequisites
- A Tavus account and API key in Secret Manager as `supermortgage-tavus-api-key`, mounted as `TAVUS_API_KEY` on `supermortgage-api` (product owner; minutes).
- A replica: `TAVUS_REPLICA_ID` when the partner has a branded one; otherwise the first stock replica the API lists **[UNVERIFIED — the stock-replica listing filter]**.
- The public callback URL `https://<api host>/v1/video/tavus/callback/<callback_secret>` reachable from the vendor; `VIDEO_CALLBACK_SECRET` in Secret Manager (ops).
- The load balancer path `/video` → 302 `/app/video` beside the existing `/` → `/app` redirect (ops; the deploy workflow's smoke test covers it).

### Build spec
#### Inputs and triggers
- `GET /video` at the demo host → 302 `/app/video`; `/app/video` without an L1 session shows the account door (32.16 §2.0), then the video screen.
- `POST /v1/borrower/video/sessions` (an L1+ session) — opens a video session: creates the persona and the conversation at the vendor (or the FAKE), writes `video_sessions{status=created}`, returns `{video_session_id, conversation_url}`.
- `POST /v1/video/llm/{video_session_token}/chat/completions` — the vendor's custom-LLM call, one per spoken borrower turn: an OpenAI chat-completions request (`messages[]`, `stream: true`); the last `user` message is the utterance; the reply is streamed as `chat.completion.chunk` events ending in `[DONE]`.
- `POST /v1/video/tavus/callback/{callback_secret}` — the vendor's callbacks: `system.replica_joined`, `system.shutdown`, `application.transcription_ready`.
- `POST /v1/borrower/video/sessions/{id}/end` — the borrower leaves; the conversation is ended at the vendor and the persona deleted.
- Vendor interaction events on the call (`conversation.utterance` with `role ∈ {user, replica}`, `conversation.started_speaking`, `conversation.stopped_speaking`) are the page's only view of the call; the page never sends `conversation.echo` or `conversation.respond` (the brain is the endpoint, never the page).

#### Data model
New tables (append-only where noted; retention follows the owning record's class; PII columns encrypted):
- **`video_sessions`** (new; append-only): `video_session_id uuid pk`, `party_id` → `parties`, `session_id` → `sessions`, `conversation_id` → `conversations`, `subject_application_id?`, `subject_loan_id?`, `vendor` enum {tavus, FAKE}, `vendor_conversation_id`, `vendor_persona_id`, `replica_id`, `conversation_url`, `token_hash` (sha-256 of the per-session bearer the custom-LLM path carries), `status` enum {created, joined, ended, failed}, `end_reason?`, `transcript_ref?`, `created_at`, `joined_at?`, `ended_at?`. Status changes are new rows keyed on `video_session_id` (append-only); the current row is the newest.
- Baseline tables written: `messages` (`channel = video`, sender `borrower` for the utterance, `agent` for the reply, `system` for the rates element), `agent_turns` (`channel = video`), `card_instances` (`props.proposal`, 32.16 §3.4), `agent_decisions` (every tool call), `loan_events` / the event spine (`video.session.opened`, `video.session.joined`, `video.session.ended`, `card.sent`).

#### State machine
Object-level (`video_sessions.status`): `created` —(`system.replica_joined` callback, or the FAKE page's join)→ `joined` —(`system.shutdown` callback, or `POST …/end`, or `max_call_duration`)→ `ended`; `created` —(vendor error on create; callback never arrives within `VIDEO_JOIN_TIMEOUT_S`)→ `failed`. Terminal: `ended`, `failed`. The borrower performs open and end; the vendor's callbacks perform join and shutdown; no human transition exists.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **The turn is the turn.** A video turn is `AgentTurnRunner.run` with `channel = video`: the same context (32.16 §3.2), the same nine tools (§3.3), the same capture loop (§3.4), the same guard (§3.5) and the same `agent_turns` row. No prompt, tool or check is added for video; the only difference is the delivery (spoken) and the confirm surface (the rail).
2. **Tokens are filled before speech.** The endpoint returns the reply's rendered text (`copy_tokens` applied server-side through the copy library), never a `{{token}}`; a reply the guard rejected twice returns the step's default copy, rendered, exactly as a typed turn would show it.
3. **Words commit nothing.** A spoken affirmative that answers a pending card is routed to the turn (32.16 §3.4; commands.ts `affirmativeFor` is bypassed on the `video` channel as on `app`): the model proposes the values into the card, the rail shows them with Confirm and Edit, and only the tap resolves. A ConsentCard is never resolved by speech (32.1 §3.5).
4. **The vendor never holds the brain.** The persona is created with a custom LLM only; no Tavus-side tools, no vendor knowledge base, no `conversational_context` beyond the borrower's first name and the partner's name (both already public to the borrower); the system prompt at the vendor is a one-line pointer (the real prompt is assembled per turn by `context.ts` and never sent to the vendor).
5. **Perception off, recording off.** `layers.perception.perception_model = off`; `enable_recording = false`; `apply_greenscreen = false`. A build that turns either on fails the contract test (T7).
6. **The per-session bearer.** `video_session_token` is 32 random bytes, base64url, in the custom-LLM base URL; the row stores its sha-256; a request whose token matches no row with `status ∈ {created, joined}` is refused `401` before any turn; a token is single-session and dies with `ended`/`failed`.
7. **The call's window.** The turn's message window (32.16 §3.7) is read from `messages{channel=video}` for the current `conversation_id` — the vendor's `messages[]` history is ignored except for its last `user` entry. Supermortgage's transcript is the record.
8. **Call limits.** `max_call_duration = 1800` s, `participant_left_timeout = 60` s, `participant_absent_timeout = 120` s, `language = english`. A shutdown for any reason ends the session with `end_reason` = the vendor's reason string.
9. **The rail is the rail.** `/app/video` renders the 32.16 §2.2 rail beside the call, with the current ask open and the rest behind "n more after this" (32.16 T-17-11); the disclosure footer of 32.16 principle 8; no composer, no microphone control of Supermortgage's own (the call has its own), no "Talk to a person".
10. **Latency is measured, not assumed.** `agent_turns.latency_ms` for `channel = video` is the time from request receipt to the last chunk; the eval harness (32.16 §6) reports p50 and p95 per persona run so the operational budget in "Open questions" is decided on data.

#### Integrations
- **`tavus`** (outbound; HTTPS JSON, `x-api-key`; `POST https://tavusapi.com/v2/personas` → `persona_id`, `POST /v2/conversations` → `{conversation_id, conversation_url}`, `POST /v2/conversations/{id}/end`, `DELETE /v2/personas/{id}`; idempotency key = `video_session_id` kept in the row so a retry never creates two conversations; retry ×3 with backoff on 5xx; on outage the session is `failed` and the page says the video agent is unavailable and offers the thread at `/app` — in the copy library's words, never a raw error) **[PARTIALLY VERIFIED — persona `layers` field names; the conversation body fields `replica_id`, `persona_id`, `callback_url`, `custom_greeting`, `conversational_context`, `max_call_duration`, `participant_left_timeout`, `participant_absent_timeout`, `apply_greenscreen`, `language` are those in the vendor's SDK]**.
- **`tavus` custom LLM** (inbound; the vendor POSTs an OpenAI chat-completions request to `{base_url}/chat/completions` with `stream: true`; the response is `text/event-stream` of `chat.completion.chunk` objects then `data: [DONE]`).
- **`tavus` callbacks** (inbound; JSON POST to the `callback_url` given at conversation creation; unsigned — the URL's secret path segment is the authentication; a POST to a wrong secret is `404`).
- **`FakeTavus`** (`FAKE`; in-repo): `createPersona`/`createConversation`/`endConversation`/`deletePersona` write to memory and return a local `conversation_url` = `/app/video/fake/{video_session_token}`; the fake page renders a `FAKE video agent` marker, a text box and a Web Speech input, posts each utterance as the same chat-completions request the vendor would send, shows the streamed reply as the replica's words, and calls the same callbacks (`system.replica_joined` on open, `system.shutdown` on leave). The fake is the default in every test.
- **Daily.co** (the vendor's call is a Daily room; the page embeds it with `@daily-co/daily-js` / the vendor's `@tavus/cvi-ui` components; camera and microphone permissions are requested by the page before the conversation is created).

#### Outputs and artifacts
- Rows: `video_sessions`; `messages{channel=video}`; `agent_turns{channel=video}`; `card_instances.props.proposal`; `agent_decisions`.
- Events: `video.session.opened{video_session_id, vendor}`, `video.session.joined`, `video.session.ended{end_reason}`, `video.session.failed{reason}`; the 32.16 events unchanged (`card.sent`, `card.resolved`, `agent.turn.completed`).
- Documents: none; the vendor transcript reference on the session row.

#### AI agent design (AI-first)
`borrower-app` agent (tools: `video.open`, `video.turn`, `video.end`, `video.callback`) — `video.open` creates the persona and conversation at the vendor or the FAKE and writes the session row; `video.turn` is the chat-completions endpoint's command: it authenticates the token, appends the utterance, runs the 32.16 turn with `channel = video`, renders the reply and streams it; `video.end` ends the conversation and deletes the persona; `video.callback` applies a vendor callback to the session row. The `intake` and `borrower-comms` agents of 32.16 run the turn itself with their nine tools unchanged. Decision record: every `video.turn` writes the 32.16 `agent_turns` row; every tool call an `agent_decisions` row. Guardrails: the agent never sends `conversation.echo` or `conversation.respond` (no unguarded speech), never enables perception or recording, never passes the record to the vendor, never resolves a card from speech. Escalations: as 32.16 (three misses → `human.request`; the FAKE reviewer answers).

#### Edge cases and failure modes
- The vendor is down at open → `video_sessions{status=failed, end_reason=vendor_unavailable}`; the page offers `/app` in the copy library's words.
- The custom-LLM request arrives after the session ended → `401`; nothing is written.
- Two requests for one session arrive together → the per-party serialized queue of 32.16 runs them in order; the second sees the first's reply in its window.
- The guard rejects twice → the default copy is spoken (rendered); the `agent_turns` row carries `fallback = default_copy`.
- The borrower says "yes" to a pending ConsentCard → the turn answers in words that the tap on the rail is the consent; no proposal is written for a ConsentCard.
- The callback secret is wrong → `404`; the row is untouched; the attempt is logged.
- `max_call_duration` reached → `ended{end_reason=max_call_duration}`; the page shows the rail still live and offers a new call.
- The kill switch of 18.1 is tripped → the endpoint speaks the placeholder copy and makes no model call (32.16 T-17-10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.17-T1 | Given an L1 session, when `POST /v1/borrower/video/sessions`, then a `video_sessions` row exists with `status = created`, the persona sent to the vendor (or the FAKE) has a custom LLM whose `base_url` ends in `/v1/video/llm/{token}` with `sha256(token) = token_hash`, perception off and recording off, and the response carries `conversation_url`. |
| 32.17-T2 | Given the vendor posts a chat-completions request with the borrower's utterance to the session's endpoint, then an `agent_turns` row with `channel = video` exists, the reply streams as `chat.completion.chunk` events ending in `[DONE]`, and the spoken text contains no `{{` and no figure the guard did not pass. |
| 32.17-T3 | Given "I make about eight thousand two hundred a month" in a video turn with the R3 income card pending, then `card_instances.props.proposal.fields[0] = {path: "monthly_income", value: "820000", source: "borrower_stated_unconfirmed"}`, the rail's card row shows the value with Confirm and Edit, and Confirm resolves the card with `evidence.source = borrower_stated` — nothing is committed by the words. |
| 32.17-T4 | Given a video turn in which the model calls `card.request`, then no reference chip is written, a `card.sent` event reaches the session's SSE stream, and the rail focuses and expands that card. |
| 32.17-T5 | Given a new video session, then `custom_greeting` is the guarded first turn's rendered text: it says in its own words that it is automated, names the partner as the lender, and never names Supermortgage as the lender. |
| 32.17-T6 | Given a video turn in which the model shows rates, then the spoken text names each rate with its APR and the rail's Numbers carries the rates element (32.16 32.16-T7 unchanged). |
| 32.17-T7 | Given the persona and conversation bodies sent to the vendor for any session, then `layers.perception.perception_model = off`, `enable_recording = false`, no `tools`, no knowledge base, and `conversational_context` contains no record field beyond the borrower's first name and the partner's name (contract test). |
| 32.17-T8 | Given a chat-completions request whose token matches no session in `created` or `joined`, then `401` and no `messages` or `agent_turns` row is written. |
| 32.17-T9 | Given the vendor's `system.replica_joined` then `system.shutdown` callbacks on the secret path, then the session is `joined` then `ended` with `end_reason`; given `application.transcription_ready`, then `transcript_ref` is set; given the wrong secret, then `404` and no change. |
| 32.17-T10 | Given `GET /video` at the demo host, then `302` to `/app/video`; given `/app/video` without a session, then the account door of 32.16 §2.0, then the video screen with the disclosure footer, no composer, no microphone control of Supermortgage's own and no "Talk to a person" control. |
| 32.17-T11 | Given `TAVUS_API_KEY` unset, then `FakeTavus` (`FAKE`) opens the session, its `conversation_url` is local, its page posts each utterance through the same chat-completions endpoint and shows the streamed reply, and 32.17-T1 … 32.17-T9 pass against it. |
| 32.17-T12 | Given `/app/video` at ≥ 1024 px with the refinance fixture at R8, then the rail sits beside the call with only the current ask open and the other pending cards behind one "n more after this" line (32.16 32.16-T11), and no card component renders inside the call pane. |
| 32.17-T13 | Given a chat-completions request whose `messages[]` carries a fabricated earlier assistant line, then the turn's window is Supermortgage's `messages{channel=video}` and the fabricated line is absent from the context (contract test over `context.ts` input). |
| 32.17-T14 | Given the cooperative refinance persona run through `/app/video` against the FAKE from account creation, then the run reaches the same milestone as 32.16 32.16-T21 with every fact resolved by a tap on the rail and `agent_turns.latency_ms` reported as p50 and p95 for `channel = video`. |

#### Audit and evidence
An examiner is shown, per call: the `video_sessions` rows (open, join, end, the vendor ids, the transcript reference), the `messages{channel=video}` transcript with each reply's `agent_turns` row (model, prompt version, guard result, latency), the `agent_decisions` for every tool call, the `card_instances` the call proposed and the taps that resolved them (`evidence.source = borrower_stated`), the persona and conversation bodies as sent (perception off, recording off), and the callback log. Exported with the 32.16 evidence through the same trace endpoint (`GET /api/ai/conversation?party_id=`), filtered on `channel = video`.

### Open questions / decisions
1. What is the vendor's first-token budget before the replica fills the silence? **Default: the turn runs at `LLM_EFFORT = low` for `channel = video`; the harness reports p50/p95; the budget is set from the first persona run, and if it is missed the reply's first sentence is streamed as soon as the guard passes the whole text (no partial, unguarded speech, ever).**
2. Does the borrower's own video need to reach the replica at all? **Default: the camera is on for presence (the call feels face to face) but perception is off and nothing is recorded; a `VIDEO_BORROWER_CAMERA = off` setting joins audio-only.**
3. Pre-account video (a `/video` Talk)? **Default: no — the account door first, as 32.16 §2.0; camera and microphone consent belong behind an account.**

### Sources
- Tavus Conversational Video Interface — developer examples (github.com/Tavus-Engineering/tavus-examples, 2026) and `@tavus/cvi-ui` 0.2.2 (npm) — conversation creation body, interaction event names, component embedding.
- Tavus developer documentation, "Create conversation", "Persona layers: LLM" (docs.tavus.io; not reachable from the build container on 2026-09-12 — the field names above are from the SDK and examples, marked as such).
- 12 CFR §1026.24(c) (Reg Z advertising: a rate stated orally or in writing is accompanied by the APR).
- 12 CFR §1002.4 (Reg B general rule against discrimination; no inference from appearance).
- Utah Code §13-2-12 (Artificial Intelligence Policy Act, disclosure on request); Cal. Bus. & Prof. Code §17941 (bot disclosure).
- docs/ux/17 — the conversational product (32.16), principles 1–10; §2.0–2.3; §3.
