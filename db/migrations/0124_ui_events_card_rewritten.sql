-- 0124_ui_events_card_rewritten.sql — 32.17 rule 21 (words commit) / 32.1 §9 (spec/sections/32-borrower-experience/32-17-the-video-agent-the-same-conversation-face-to-face.md).
--   ui_events.kind gains `card_rewritten`: the corroborating trail of a written fact corrected in words — the turn resolved the
--   same card again with `rewrite`, the command ran with the new values, the card stayed resolved (evidence.rewrites counts it).
--   The table stays append-only; the constraint is widened, never narrowed.
ALTER TABLE ui_events DROP CONSTRAINT ui_events_kind_check;
ALTER TABLE ui_events ADD CONSTRAINT ui_events_kind_check CHECK (kind IN ('card_shown', 'card_resolved', 'card_rewritten', 'document_opened', 'document_scrolled_to_end', 'consent_affirmed', 'connector_started', 'connector_completed', 'deep_link_opened', 'voice_started', 'human_requested'));
