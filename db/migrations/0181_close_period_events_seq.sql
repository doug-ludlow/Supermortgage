-- 35.4: the journal's insertion order. `created_at` defaults to the transaction's now(), so every receipt one planning
-- transaction records shares it and the order of the receipts within a pass (35.4-T4: "the receipts appear in the journal in
-- the order eod_cutoff → custodial_day_close → lar → …") was undefined among ties. A generated identity is the order the
-- rows were written in; readers order by (occurred_at, seq). Append-only table: a new column, no row changes.
ALTER TABLE close_period_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX close_period_events_period_seq_idx ON close_period_events (close_period_id, seq);
COMMENT ON COLUMN close_period_events.seq IS '35.4: insertion order of the journal (ties on occurred_at within one planning transaction are ordered by seq).';
