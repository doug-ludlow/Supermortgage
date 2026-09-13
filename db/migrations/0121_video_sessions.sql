-- 0121_video_sessions.sql — 32.17 The video agent (spec/sections/32-borrower-experience/32-17-the-video-agent-the-same-conversation-face-to-face.md, Data model).
--   video_sessions   one append-only row per status of a video session (src/runtime/borrower/video-routes.ts; src/app/tools/section32-17.ts):
--                    `created` when POST /v1/borrower/video/sessions opened it at the vendor (or the FAKE), `joined` on the vendor's
--                    system.replica_joined callback (or the FAKE page's join), `ended` on system.shutdown / POST …/end / max_call_duration,
--                    `failed` on a vendor error at open. Status changes are NEW rows keyed on video_session_id; the current row is the newest
--                    (v_video_sessions_current). `token_hash` is the sha-256 of the per-session bearer the custom-LLM path carries (the token
--                    itself is never stored); `transcript_ref` is a reference to the vendor's transcript, never the record (messages{channel=video} is).
--   messages         `channel` gains 'video' (the utterance as sender borrower, the reply as sender agent, the rates element as sender system).
--   agent_turns      `channel` gains 'video' (every spoken turn is a 32.16 turn with channel = video).
-- Append-only: 0120 holds the demo clock; nothing there is edited.
BEGIN;

CREATE TABLE video_sessions (
  id                      bigserial PRIMARY KEY,
  video_session_id        uuid NOT NULL,
  party_id                uuid NOT NULL REFERENCES parties(id),
  session_id              uuid NOT NULL REFERENCES sessions(session_id),
  conversation_id         uuid NOT NULL REFERENCES conversations(conversation_id),
  subject_application_id  uuid,
  subject_loan_id         uuid,
  vendor                  text NOT NULL CHECK (vendor IN ('tavus', 'FAKE')),
  vendor_conversation_id  text,
  vendor_persona_id       text,
  replica_id              text,
  conversation_url        text,
  token_hash              text NOT NULL,                                   -- sha256(video_session_token); the token is single-session and dies with ended/failed
  status                  text NOT NULL CHECK (status IN ('created', 'joined', 'ended', 'failed')),
  end_reason              text,
  transcript_ref          text,
  created_at              timestamptz NOT NULL,
  joined_at               timestamptz,
  ended_at                timestamptz,
  row_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_sessions_session_idx ON video_sessions(video_session_id, id DESC);
CREATE INDEX video_sessions_party_idx ON video_sessions(party_id, id DESC);
CREATE INDEX video_sessions_token_idx ON video_sessions(token_hash, id DESC);
CREATE INDEX video_sessions_vendor_conversation_idx ON video_sessions(vendor_conversation_id, id DESC);
CREATE TRIGGER video_sessions_immutable BEFORE UPDATE OR DELETE ON video_sessions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE video_sessions IS 'UI-owned (02 §1.6; 32.17 Data model): the video agent sessions — one append-only row per status (created → joined → ended | failed); the newest row per video_session_id is current; token_hash never the token; transcript_ref a reference, never the record.';

-- the current row per session: the newest by id
CREATE VIEW v_video_sessions_current AS
  SELECT DISTINCT ON (video_session_id) * FROM video_sessions ORDER BY video_session_id, id DESC;

-- the video channel on the thread and the turn log (32.17 rules 1 and 7)
ALTER TABLE messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check CHECK (channel IN ('app', 'sms', 'email', 'voice', 'mail', 'video'));
ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_channel_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_channel_check CHECK (channel IN ('app', 'sms', 'email', 'voice', 'video'));

COMMIT;
