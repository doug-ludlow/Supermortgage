-- 0119_agent_turns.sql — 32.16 DELTA-25, the agent turn's log and the proposal-and-confirm loop (docs/ux/17-the-conversational-product.md §3.4, §3.5, §5).
--   agent_turns        one row per agent turn attempt (src/runtime/borrower/agent/turn.ts): the borrower message it answered, the reply it
--                      appended (null when the guard rejected the attempt — every rejection is a row of its own), the channel, the model
--                      and prompt versions, the tier, the sha256 of the context the model saw (never the context itself), the tool calls
--                      as {name, args_hash, decision_id, is_error} (every call was a bus command with its agent_decisions row), the SAFE
--                      classification, the guard's result, latency and token counts. Append-only.
--   card_instances     `misses int` — the proposal-and-confirm loop's counter per card (§3.7: a re-proposal or an edit is a miss; the third
--                      transfers to a human). `props.proposal` (§3.4) lives in the existing jsonb column.
-- Append-only: 0118 holds the account schema; nothing there is edited.
BEGIN;

CREATE TABLE agent_turns (
  turn_id               uuid PRIMARY KEY,
  conversation_id       uuid NOT NULL REFERENCES conversations(conversation_id),
  party_id              uuid NOT NULL REFERENCES parties(id),
  session_id            uuid REFERENCES sessions(session_id),
  message_id            uuid REFERENCES messages(message_id),                    -- the borrower message answered; null for the first turn of a session (no borrower text)
  reply_message_id      uuid REFERENCES messages(message_id),                    -- null: the attempt was rejected by the guard (or the turn was bypassed)
  channel               text NOT NULL CHECK (channel IN ('app', 'sms', 'email', 'voice')),
  ai_system_version_id  uuid,                                                    -- 18.1 ai_system_versions (borrower-conversation); null until Phase 4 promotes one
  model_version         text NOT NULL,
  prompt_version        text NOT NULL,
  tier                  text NOT NULL,                                           -- T2_borrower_facing
  context_hash          text NOT NULL,                                           -- sha256 of the system prompt + situation the model saw
  tool_calls            jsonb NOT NULL DEFAULT '[]'::jsonb,                      -- [{name, args_hash, decision_id, is_error, refused}]
  safe_classification   text,
  guard_result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms            int,
  tokens_in             int,
  tokens_out            int,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_turns_party_idx ON agent_turns(party_id, created_at);
CREATE INDEX agent_turns_conversation_idx ON agent_turns(conversation_id, created_at);
CREATE TRIGGER agent_turns_immutable BEFORE UPDATE OR DELETE ON agent_turns FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE agent_turns IS 'UI-owned (02 §1.6; 32.16 DELTA-25): the agent turn log — one append-only row per attempt, the context as a hash, the tool calls with their decision ids, the guard result.';

ALTER TABLE card_instances ADD COLUMN misses int NOT NULL DEFAULT 0;
COMMENT ON COLUMN card_instances.misses IS '32.16 §3.4/§3.7: proposals rejected or edited on this card; the third transfers to a human (human.request with the transcript reference)';

COMMIT;
