-- 0123_card_instances_seq.sql — 32.17 rule 19 / 32.16 §1.3 the record's order of needs (spec/sections/32-borrower-experience/32-17-the-video-agent-the-same-conversation-face-to-face.md).
--   card_instances.seq: the order the cards were sent in. A flow that sends several cards in one reaction stamps them all with the
--   reaction's instant (the consents, the ID scan and the payroll connection on application.received share one created_at), and the
--   clock cannot order them — the record fell back to the uuid, a different order on every run. The sequence is the send order the
--   flow chose; the record and the rail sort a same-instant tie by it. Existing rows are numbered as found (their order was already arbitrary).
ALTER TABLE card_instances ADD COLUMN seq bigserial;
CREATE INDEX card_instances_party_seq_idx ON card_instances(party_id, seq);
