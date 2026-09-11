-- 32.7 T13 / 30.4 HO-009 / 25.4 §1026.39: the borrower's forwarded Fannie Mae loan purchase letter is a 22.1 document class
-- (family `other`, no freshness rule, not a credit document) so the borrower app's upload classifies and evidences
-- `ownership_transfer_notices.evidenced` through 30.4's own event. Append-only: a new row, nothing edited.
INSERT INTO document_classes (code, family, default_freshness_basis, is_credit_document)
VALUES ('fnma_loan_purchase_letter', 'other', 'none', false)
ON CONFLICT (code) DO NOTHING;
