-- 0020_retention_classes_2.sql — retention classes for Sections 14, 17, 18, 19 (autocommit; see 0008).
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'court_record_7y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'transfer_out_archive';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ai_governance_7y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_reporting_7y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'nydfs_500_17b_cert_support_5y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fcra';
