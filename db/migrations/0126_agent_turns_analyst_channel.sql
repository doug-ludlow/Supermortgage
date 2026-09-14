-- 0126 — §33.2 rule 4: the refinance analyst's turn is an agent_turns row with channel = 'analyst'
--   (spec/sections/33-partner-book/33-2-*.md "Data model": agent_turns (the analyst's turn, channel = analyst)).
--   No borrower, no session, no message: the party's conversation carries it (conversationFor), the guard result holds the
--   provenance outcome, tool_calls the two model tools. Append-only: the check is widened, nothing else changes.
ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_channel_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_channel_check CHECK (channel IN ('app', 'sms', 'email', 'voice', 'video', 'analyst'));
COMMENT ON COLUMN agent_turns.channel IS 'app | sms | email | voice | video (32.16/32.17: the borrower thread) | analyst (33.2 rule 4: the refinance analyst''s turn over a monitored loan, no borrower message)';
