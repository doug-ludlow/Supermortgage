-- 0132_journey_progress.sql — 32.16 §2.2 Progress, the `journey_progress` unit of the Data model
-- (spec/sections/32-borrower-experience/32-16-*.md: "`journey_progress` — a projection in `borrower_record`
-- (`{steps[{id, label_copy_key, state, at}], done, total}`), never stored."). A VIEW, so nothing is stored: the same rows
-- src/runtime/borrower/journey-progress.ts reads — the subject's `loan_events` (the event spine, 0001 + 0057
-- application_id) and the party's resolved `card_instances` (0111) — projected to the same shape, one row per borrower
-- party per origination application (`application_borrowers.party_id`, the subject grammar of
-- src/infra/db/borrower-parties.ts; an application with `loan_id` set has become a serviced loan and has no journey,
-- exactly as BorrowerRecordReader returns null once a loan exists). The TypeScript projection stays the one the record,
-- the rail and `journey.get` serve; this view is the SQL reading of it for operator queries, evidence packs and a
-- contract test, and must move with it — the step table below is REFINANCE_STEPS / PURCHASE_STEPS of
-- journey-progress.ts verbatim, the evidence rules its `done` / `started` predicates, the ordering its `.at(-1)` on
-- events (latest by sequence) and `[0]` on resolved cards (earliest by resolved_at, else created_at), and `at` is
-- rendered the way src/infra/db/client.ts renders a timestamptz (ISO-8601, milliseconds, Z). No base table is added
-- (src/infra/db/db.test.ts stays at 765 — a view is not a BASE TABLE); no forbid_mutation trigger — a view has no rows
-- to mutate and Postgres refuses INSERT/UPDATE/DELETE on it. Append-only: 0057 (applications), 0111 (card_instances)
-- and 0001 (loan_events) are not edited.
BEGIN;

CREATE VIEW journey_progress AS
WITH
-- the subjects: a borrower party on an application still in origination (stage = origination ⇔ no loan yet)
subjects AS (
  SELECT DISTINCT ab.party_id, a.id AS application_id, a.transaction_type::text AS transaction_type,
         CASE WHEN a.transaction_type = 'purchase' THEN 'purchase' ELSE 'refinance' END AS journey
    FROM application_borrowers ab
    JOIN applications a ON a.id = ab.application_id
   WHERE ab.party_id IS NOT NULL
     AND a.loan_id IS NULL
),
-- the event spine the projection reads: BorrowerRecordReader.events(appId, null) → loan_events WHERE application_id = appId
spine AS (
  SELECT s.party_id, s.application_id, e.sequence, e.type, e.occurred_at, e.payload
    FROM subjects s
    JOIN loan_events e ON e.application_id = s.application_id
),
-- the cards the projection reads: the party's cards (cardsOf) filtered to the subject, resolved only (journey-progress.ts `resolved`)
cards AS (
  SELECT s.party_id, s.application_id, c.kind, c.copy_key, c.props, coalesce(c.resolved_at, c.created_at) AS at
    FROM subjects s
    JOIN card_instances c ON c.party_id = s.party_id
   WHERE c.status = 'resolved'
     AND (c.subject_application_id IS NULL OR c.subject_application_id = s.application_id)
     AND c.subject_loan_id IS NULL
),
-- one row per subject: every evidence instant the step table needs (a null is "no evidence")
evidence AS (
  SELECT s.party_id, s.application_id, s.transaction_type, s.journey,
         -- events: the latest of a type (journey-progress.ts `ev`)
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'application.field.captured' AND e.payload->>'field' = 'property_address' ORDER BY e.sequence DESC LIMIT 1) AS ev_property_address,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'credit.report.received' ORDER BY e.sequence DESC LIMIT 1) AS ev_credit,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'verification.received' AND (NOT (e.payload ? 'kind') OR coalesce(e.payload->>'kind', e.payload->>'verification_kind', '') ~* '(income|employment|payroll)') ORDER BY e.sequence DESC LIMIT 1) AS ev_verification_income,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'application.field.captured' AND e.payload->>'field' = 'income' ORDER BY e.sequence DESC LIMIT 1) AS ev_field_income,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'application.declarations.answered' ORDER BY e.sequence DESC LIMIT 1) AS ev_declarations,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'application.demographics.collected' ORDER BY e.sequence DESC LIMIT 1) AS ev_demographics,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'application.trid_received' ORDER BY e.sequence DESC LIMIT 1) AS ev_trid,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'decision.issued' ORDER BY e.sequence DESC LIMIT 1) AS ev_decision,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'du.submitted' ORDER BY e.sequence DESC LIMIT 1) AS ev_du_submitted,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'du.findings.received' ORDER BY e.sequence DESC LIMIT 1) AS ev_du_findings,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'mlo.review.completed' ORDER BY e.sequence DESC LIMIT 1) AS ev_mlo_review,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'terms.presented' ORDER BY e.sequence DESC LIMIT 1) AS ev_terms_presented,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'disclosure.le.delivered' ORDER BY e.sequence DESC LIMIT 1) AS ev_le_delivered,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'disclosure.le.received' ORDER BY e.sequence DESC LIMIT 1) AS ev_le_received,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'intent.to_proceed.received' ORDER BY e.sequence DESC LIMIT 1) AS ev_intent_to_proceed,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'lock.executed' ORDER BY e.sequence DESC LIMIT 1) AS ev_lock_executed,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'lock.requested' ORDER BY e.sequence DESC LIMIT 1) AS ev_lock_requested,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'closing.consummated' ORDER BY e.sequence DESC LIMIT 1) AS ev_closing_consummated,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'loan.funded' ORDER BY e.sequence DESC LIMIT 1) AS ev_loan_funded,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'clear_to_close.issued' ORDER BY e.sequence DESC LIMIT 1) AS ev_clear_to_close,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'identity.verified' ORDER BY e.sequence DESC LIMIT 1) AS ev_identity_verified,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'consent.esign.active' ORDER BY e.sequence DESC LIMIT 1) AS ev_esign_active,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'consent.captured' AND e.payload->>'kind' = 'esign' ORDER BY e.sequence DESC LIMIT 1) AS ev_consent_esign,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'verification.received' AND coalesce(e.payload->>'kind', e.payload->>'verification_kind', '') ~* 'asset' ORDER BY e.sequence DESC LIMIT 1) AS ev_verification_assets,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type = 'preapproval.letter.issued' ORDER BY e.sequence DESC LIMIT 1) AS ev_preapproval_letter,
         (SELECT e.occurred_at FROM spine e WHERE e.party_id = s.party_id AND e.application_id = s.application_id AND e.type ~ '^insurance\.(evidence|policy)\.(received|verified)$' ORDER BY e.sequence DESC LIMIT 1) AS ev_insurance,
         -- cards: the earliest resolved card matching (journey-progress.ts `resolved`, `byKey`, `connected`)
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConfirmCard' AND c.copy_key IN ('refi.home.confirm', 'refi.current_loan.confirm') ORDER BY c.at LIMIT 1) AS card_refi_home,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConfirmCard' AND c.copy_key = 'income.confirm.title' ORDER BY c.at LIMIT 1) AS card_income_confirm,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConnectCard' AND c.props->>'vendor' = 'truv_income' ORDER BY c.at LIMIT 1) AS card_truv_income,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ProfileCard' AND c.copy_key = 'profile.title' ORDER BY c.at LIMIT 1) AS card_profile,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ChoiceCard' AND c.copy_key = 'declarations.title' ORDER BY c.at LIMIT 1) AS card_declarations,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'DemographicsCard' ORDER BY c.at LIMIT 1) AS card_demographics,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ComparisonCard' AND c.copy_key = 'lock.compare.title' ORDER BY c.at LIMIT 1) AS card_lock_compare,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConfirmCard' AND c.copy_key = 'preapproval.where' ORDER BY c.at LIMIT 1) AS card_preapproval_where,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConnectCard' AND c.props->>'vendor' = 'plaid_assets' ORDER BY c.at LIMIT 1) AS card_plaid_assets,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConfirmCard' AND c.copy_key = 'preapproval.target' ORDER BY c.at LIMIT 1) AS card_preapproval_target,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConfirmCard' AND c.copy_key = 'contract.confirm' ORDER BY c.at LIMIT 1) AS card_contract,
         (SELECT c.at FROM cards c WHERE c.party_id = s.party_id AND c.application_id = s.application_id AND c.kind = 'ConnectCard' AND c.props->>'vendor' = 'carrier_connect' ORDER BY c.at LIMIT 1) AS card_carrier_connect
    FROM subjects s
),
-- the step table: journey-progress.ts REFINANCE_STEPS (R1–R12) and PURCHASE_STEPS (P1–P9, C1–C7), in order
defs(journey, ord, id, label_copy_key) AS (VALUES
  ('refinance',  1, 'R1',  'journey.refi.home'),
  ('refinance',  2, 'R2',  'journey.refi.credit'),
  ('refinance',  3, 'R3',  'journey.refi.income'),
  ('refinance',  4, 'R4',  'journey.refi.about_you'),
  ('refinance',  5, 'R5',  'journey.refi.declarations'),
  ('refinance',  6, 'R6',  'journey.refi.demographics'),
  ('refinance',  7, 'R7',  'journey.refi.application'),
  ('refinance',  8, 'R8',  'journey.refi.underwriting'),
  ('refinance',  9, 'R9',  'journey.refi.terms'),
  ('refinance', 10, 'R10', 'journey.refi.proceed'),
  ('refinance', 11, 'R11', 'journey.refi.lock'),
  ('refinance', 12, 'R12', 'journey.refi.handoff'),
  ('purchase',   1, 'P1',  'journey.purchase.where'),
  ('purchase',   2, 'P2',  'journey.purchase.identity'),
  ('purchase',   3, 'P3',  'journey.purchase.consents'),
  ('purchase',   4, 'P4',  'journey.purchase.credit'),
  ('purchase',   5, 'P5',  'journey.purchase.income'),
  ('purchase',   6, 'P6',  'journey.purchase.about_you'),
  ('purchase',   7, 'P7',  'journey.purchase.assets'),
  ('purchase',   8, 'P8',  'journey.purchase.target'),
  ('purchase',   9, 'P9',  'journey.purchase.house_hunting'),
  ('purchase',  10, 'C1',  'journey.purchase.contract'),
  ('purchase',  11, 'C2',  'journey.purchase.address'),
  ('purchase',  12, 'C3',  'journey.purchase.terms'),
  ('purchase',  13, 'C4',  'journey.purchase.proceed'),
  ('purchase',  14, 'C5',  'journey.purchase.lock'),
  ('purchase',  15, 'C6',  'journey.purchase.insurance'),
  ('purchase',  16, 'C7',  'journey.purchase.handoff')
),
-- each step's own evidence instant (`done`, first non-null in the TypeScript order) and whether it has started
steps AS (
  SELECT x.party_id, x.application_id, x.transaction_type, d.ord, d.id, d.label_copy_key,
         CASE d.id
           WHEN 'R1'  THEN coalesce(x.card_refi_home, x.ev_property_address)
           WHEN 'R2'  THEN x.ev_credit
           WHEN 'R3'  THEN coalesce(x.card_income_confirm, x.card_truv_income, x.ev_verification_income, x.ev_field_income)
           WHEN 'R4'  THEN x.card_profile
           WHEN 'R5'  THEN coalesce(x.ev_declarations, x.card_declarations)
           WHEN 'R6'  THEN coalesce(x.ev_demographics, x.card_demographics)
           WHEN 'R7'  THEN x.ev_trid
           WHEN 'R8'  THEN x.ev_decision
           WHEN 'R9'  THEN coalesce(x.ev_le_delivered, x.ev_le_received)
           WHEN 'R10' THEN x.ev_intent_to_proceed
           WHEN 'R11' THEN coalesce(x.ev_lock_executed, x.card_lock_compare)
           WHEN 'R12' THEN coalesce(x.ev_closing_consummated, x.ev_loan_funded)
           WHEN 'P1'  THEN x.card_preapproval_where
           WHEN 'P2'  THEN x.ev_identity_verified
           WHEN 'P3'  THEN coalesce(x.ev_esign_active, x.ev_consent_esign)
           WHEN 'P4'  THEN x.ev_credit
           WHEN 'P5'  THEN coalesce(x.card_income_confirm, x.card_truv_income, x.ev_verification_income, x.ev_field_income)
           WHEN 'P6'  THEN coalesce(x.ev_demographics, x.card_demographics, x.ev_declarations, x.card_declarations, x.card_profile)
           WHEN 'P7'  THEN coalesce(x.card_plaid_assets, x.ev_verification_assets)
           WHEN 'P8'  THEN coalesce(x.card_preapproval_target, x.ev_du_findings)
           WHEN 'P9'  THEN x.ev_preapproval_letter
           WHEN 'C1'  THEN x.card_contract
           WHEN 'C2'  THEN x.ev_trid
           WHEN 'C3'  THEN coalesce(x.ev_le_delivered, x.ev_le_received)
           WHEN 'C4'  THEN x.ev_intent_to_proceed
           WHEN 'C5'  THEN coalesce(x.ev_lock_executed, x.card_lock_compare)
           WHEN 'C6'  THEN coalesce(x.card_carrier_connect, x.ev_insurance)
           WHEN 'C7'  THEN coalesce(x.ev_closing_consummated, x.ev_loan_funded)
         END AS at,
         CASE d.id
           WHEN 'R8'  THEN x.ev_du_submitted IS NOT NULL OR x.ev_du_findings IS NOT NULL
           WHEN 'R9'  THEN x.ev_mlo_review IS NOT NULL OR x.ev_terms_presented IS NOT NULL
           WHEN 'C3'  THEN x.ev_mlo_review IS NOT NULL OR x.ev_terms_presented IS NOT NULL
           WHEN 'R11' THEN x.ev_lock_requested IS NOT NULL
           WHEN 'C5'  THEN x.ev_lock_requested IS NOT NULL
           WHEN 'R12' THEN x.ev_clear_to_close IS NOT NULL
           WHEN 'C7'  THEN x.ev_clear_to_close IS NOT NULL
           ELSE false
         END AS started
    FROM evidence x
    JOIN defs d ON d.journey = x.journey
),
-- the journey is ordered: every step before the furthest step with any evidence is done; the first step without done evidence is current
furthest AS (
  SELECT st.*, max(CASE WHEN st.at IS NOT NULL OR st.started THEN st.ord END) OVER (PARTITION BY st.party_id, st.application_id) AS furthest_ord
    FROM steps st
),
flagged AS (
  SELECT f.*, (f.at IS NOT NULL OR f.ord < coalesce(f.furthest_ord, 0)) AS done
    FROM furthest f
),
stated AS (
  SELECT g.*,
         CASE WHEN g.done THEN 'done'
              WHEN g.ord = min(CASE WHEN NOT g.done THEN g.ord END) OVER (PARTITION BY g.party_id, g.application_id) THEN 'current'
              ELSE 'upcoming' END AS state
    FROM flagged g
)
SELECT s.party_id,
       s.application_id,
       s.transaction_type,
       jsonb_agg(jsonb_build_object(
         'id',             s.id,
         'label_copy_key', s.label_copy_key,
         'state',          s.state,
         'at',             CASE WHEN s.state = 'done' THEN to_char(s.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
       ) ORDER BY s.ord)                                   AS steps,
       count(*) FILTER (WHERE s.state = 'done')::int       AS done,
       count(*)::int                                       AS total
  FROM stated s
 GROUP BY s.party_id, s.application_id, s.transaction_type;

COMMENT ON VIEW journey_progress IS '32.16 §2.2 journey_progress: a projection, never stored — per borrower party per origination application, the journey''s steps {id, label_copy_key, state done|current|upcoming, at} and done / total ("n of m"), derived from the subject''s loan_events and the party''s resolved card_instances exactly as src/runtime/borrower/journey-progress.ts derives them for borrower_record; that module is the record, this view never is';

COMMIT;
