-- 0008_retention_classes.sql — retention classes referenced by Sections 7–19.
-- Deliberately NOT wrapped in a transaction: new enum values cannot be used in the transaction that adds them.
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'tcpa_consent_4y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'tax_4y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'privacy_notice_5y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'esign_consent_life_of_loan_plus_4y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'unclaimed_property_10y';
