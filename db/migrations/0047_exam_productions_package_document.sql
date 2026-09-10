-- 18.2 Fannie Mae MORA reviews — what the exam module persists on a production once the officer signature is an act
-- on record rather than a field the upload task asserts (src/app/tools/section18-2.ts, ops-18-2 recordPackageApproval):
--   package_document_id   the compiled single-PDF review file stored in `documents` (rule 2: "Page-count and hash manifest
--                         stored in `exam_productions.manifest`" — the manifest's hash is checked against this stored copy,
--                         never against the in-memory string it was computed from); mirrors exam_requests.package_document_id
--   approver_entity       whose officer approved (guardrail: "the partner's officer signs anything submitted under the
--                         partner's servicer number") — stamped from `exam.package.approved{approver_entity}`
-- Append-only: new file, nothing applied is edited.
ALTER TABLE exam_productions
  ADD COLUMN package_document_id uuid REFERENCES documents(id),
  ADD COLUMN approver_entity     text CHECK (approver_entity IN ('partner', 'supermortgage'));
COMMENT ON COLUMN exam_productions.package_document_id IS '§18.2 rule 2: the stored review-file PDF the manifest hash is verified against (documents.compile_pdf)';
COMMENT ON COLUMN exam_productions.approver_entity IS '§18.2 guardrails: the entity whose officer approved the package (exam.package.approved.approver_entity); partner under the partner''s servicer number';
