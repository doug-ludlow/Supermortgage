-- 0120_demo_clock.sql — the demo clock (docs/DEPLOY.md "The demo clock"; src/runtime/demo-clock.ts).
--   demo_clock   the append-only history of the offset the hosted demo's OffsetClock adds to the system clock. One row per
--                step the clock took — every America/New_York calendar day a POST /v1/demo/advance crosses (the day's
--                sweep minute runs at noon ET) and then the target instant — written BEFORE that step's passes run, so the
--                persisted offset never runs ahead of a day that was swept. The current offset is the latest row (max id);
--                an empty table is offset zero. demo_now = real_now + offset_ms at the moment the row was written; the
--                offset never decreases (the clock only moves forward). Never written in production: the routes refuse
--                with 403 and main.ts gives production the plain system clock.
-- Append-only: 0119 holds the agent turn log; nothing there is edited.
BEGIN;

CREATE TABLE demo_clock (
  id          bigserial PRIMARY KEY,
  advance_id  uuid NOT NULL,                       -- groups the steps of one POST /v1/demo/advance
  step        int NOT NULL CHECK (step >= 1),      -- 1-based position of this step within its advance
  steps       int NOT NULL CHECK (steps >= step),  -- how many steps the advance planned
  kind        text NOT NULL CHECK (kind IN ('day', 'target')),   -- day: noon ET of a calendar day crossed; target: the requested instant
  offset_ms   bigint NOT NULL CHECK (offset_ms >= 0),            -- demo instant − system instant, milliseconds
  demo_now    timestamptz NOT NULL,                -- what the clock read once this row applied
  real_now    timestamptz NOT NULL,                -- what the base (system) clock read when it was written
  actor       text NOT NULL,                       -- who advanced it, as `kind:id` (the ops caller's actor, or system:…)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_clock_advance_idx ON demo_clock(advance_id, step);
CREATE TRIGGER demo_clock_immutable BEFORE UPDATE OR DELETE ON demo_clock FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE demo_clock IS 'The demo clock''s offset history (src/runtime/demo-clock.ts): one append-only row per step of an advance; the latest row is the current offset; empty = the system clock. Never written in production.';

COMMIT;
