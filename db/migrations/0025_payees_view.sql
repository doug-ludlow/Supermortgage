-- 0025: `payees` (3.7 data model: "in `parties` with party_type='payee'") — the payee entity is a
-- view over parties so the disbursement scheduler, positive pay and the instruction-change control
-- read one shape: payee_kind, validated remittance instructions (encrypted at rest), tax-service agency.
CREATE VIEW payees AS
SELECT p.id, p.legal_name, p.payee_kind, p.remittance_instructions_encrypted, p.remittance_validated_at, p.tax_service_agency_id, p.contact, p.created_at,
       (SELECT max(h.changed_at) FROM payee_instruction_history h WHERE h.party_id = p.id) AS instructions_last_changed_at
FROM parties p
WHERE p.payee_kind IS NOT NULL;
COMMENT ON VIEW payees IS '3.7: payees live in parties (payee_kind not null); remittance_instructions_encrypted is pii';
