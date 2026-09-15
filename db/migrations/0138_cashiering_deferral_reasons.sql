-- 0138_cashiering_deferral_reasons.sql — 2.7 rule 5 (amended after Servicing Guide D2-3.2-04 / D2-3.2-05 verification):
-- completing a payment deferral (or a disaster payment deferral) waives every late charge, penalty and stop-payment fee, and
-- the completion is an overlay of its own while the 12.6 case closes. The 0003 enums predate both: `fee_waiver_reason`
-- gains `deferral_completion` (src/domain/cashiering/latecharges.ts WaiverReason) and `fee_suppression_reason` gains
-- `deferral_completed` (src/domain/cashiering/ops-2-7.ts overlay kind). Append-only: values are added, never removed.
ALTER TYPE fee_waiver_reason ADD VALUE IF NOT EXISTS 'deferral_completion';
ALTER TYPE fee_suppression_reason ADD VALUE IF NOT EXISTS 'deferral_completed';
