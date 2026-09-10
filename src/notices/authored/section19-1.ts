/**
 * §19.1 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section19.ts.
 *
 * None of these is a borrower notice: `NTC_RECORDS_CERTIFICATION` is the business-records certification a
 * `signing_officer` signs for courts/regulators (Fed. R. Evid. 803(6), 902(11); 28 U.S.C. §1746);
 * `NTC_LEGAL_HOLD_INTERNAL` goes to custodians of paper records and vendors (POL-REC-02);
 * `NTC_DISPOSAL_CERTIFICATE` is the officer-attested certificate of a disposal run (16 CFR 682.3;
 * 16 CFR 314.4(c)(6); 23 NYCRR 500.13(b)). They are versioned in the same template store (outputs paragraph),
 * carry hashes rather than content, and E-SIGN consent is not a condition of electronic delivery.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE_RULE = R("date", "document date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the document");
const NO_SSN = R("no-ssn", "Reg P 12 CFR 1016; 19.1 rule 6 (manifests carry hashes, not content)", "absence", "\\d{3}-\\d{2}-\\d{4}", "no Social Security number in the document");
const SHA = "[0-9a-f]{64}";

// ------------------------------------------------------------------ NTC_RECORDS_CERTIFICATION (business-records certification)
const CERT = `{{#block "heading" page=1 y=0.05 pt=14 bold}}CERTIFICATION OF BUSINESS RECORDS{{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date certified_on}}. Records request {{request_id}} from {{requester_name}} ({{requester_type}}){{#if matter_ref}}, matter {{matter_ref}}{{/if}}. Scope: {{scope_description}}.{{/block}}
{{#block "declaration" page=1 y=0.2 pt=11}}I, {{signer_name}}, {{signer_title}} of {{servicer_name}}, am a duly authorized custodian of records and am qualified to make this certification. I certify that the {{object_count}} records identified in production manifest {{manifest_document_id}} (SHA-256 {{manifest_sha256}}) are true and accurate copies of records of {{servicer_name}} and that each such record (A) was made at or near the time of the act, event, condition or transaction it records by, or from information transmitted by, a person with knowledge of those matters; (B) was kept in the course of a regularly conducted activity of {{servicer_name}}; and (C) was made as a regular practice of that activity. {{#if electronic_records}}The records are maintained electronically in a write-once storage system that preserves their integrity and authenticity; the copies produced accurately reflect the information set forth in the original records and remain capable of being accurately reproduced for later reference.{{/if}}{{/block}}
{{#block "ownership" page=1 y=0.5 pt=11}}{{#if fnma_property}}The records relate to mortgage loans serviced for Fannie Mae and are the property of Fannie Mae; {{servicer_name}} holds them solely for the benefit of Fannie Mae and produces them under the conditions Fannie Mae specifies.{{/if}} {{#if redacted}}Third-party nonpublic personal information not pertaining to the requester has been redacted as recorded in redaction log {{redaction_log_id}}.{{else}}No redaction has been applied.{{/if}}{{/block}}
{{#block "perjury" page=1 y=0.65 pt=11 bold}}I declare under penalty of perjury under the laws of the United States of America that the foregoing is true and correct.{{/block}}
{{#block "signature" page=1 y=0.75 pt=11}}Executed on {{date certified_on}} at {{executed_at_city}}. Signature: {{signer_name}}, {{signer_title}} ({{signer_role}}). Contact: {{servicer_name}}, {{servicer_address}}, {{records_phone}}.{{/block}}`;
const CERT_RULES: ContentRule[] = [
  DATE_RULE,
  R("803-6-A", "Fed. R. Evid. 803(6)(A)", "presence", "made at or near the time of the act, event, condition or transaction", "element (A): made at or near the time by a person with knowledge"),
  R("803-6-B", "Fed. R. Evid. 803(6)(B)", "presence", "kept in the course of a regularly conducted activity", "element (B): kept in the course of a regularly conducted activity"),
  R("803-6-C", "Fed. R. Evid. 803(6)(C)", "presence", "made as a regular practice of that activity", "element (C): regular practice"),
  R("902-11-custodian", "Fed. R. Evid. 902(11): certification of the custodian or another qualified person", "presence", "custodian of records and am qualified", "custodian / qualified person statement"),
  R("1746-perjury", "28 U.S.C. §1746", "presence", "under penalty of perjury under the laws of the United States of America that the foregoing is true and correct", "unsworn declaration language"),
  R("manifest-hash", "19.1 outputs: production manifest with hashes", "presence", `SHA-256 ${SHA}`, "manifest SHA-256 present"),
  R("object-count", "19.1 decision record: objects_count", "data_range", "object_count", "at least one record certified", { range: { min: 1 } }),
  R("signing-officer", "19.1 escalations: sworn certifications → signing_officer", "data_equality", "signer_role", "signed by a signing_officer", { predicate: { "==": [{ var: "signer_role" }, "signing_officer"] } }),
  // rendered-text rules gated by the payload: they fail when the template drops the sentence the payload calls for
  R("fnma-ownership", "Selling Guide A2-4.1-02: records are Fannie Mae's property, held solely for its benefit", "presence", "are the property of Fannie Mae; [A-Za-z ]+ holds them solely for the benefit of Fannie Mae", "Fannie Mae ownership statement rendered on loan-linked productions", { when: { "==": [{ var: "fnma_property" }, true] } }),
  R("no-fnma-claim-on-non-fnma", "Selling Guide A2-4.1-02 applies to records of loans sold to or serviced for Fannie Mae only", "absence", "property of Fannie Mae", "no Fannie Mae ownership claim on a production of non-Fannie Mae records", { when: { "==": [{ var: "fnma_property" }, false] } }),
  R("redaction-statement", "12 CFR 1024.36(d)(3)-style redaction; Reg P 1016.15", "presence", "has been redacted as recorded in redaction log", "redaction statement rendered when redacted", { when: { "==": [{ var: "redacted" }, true] } }),
  R("no-redaction-statement", "19.1 rule 6: Fannie Mae, regulators, courts and the partner receive unredacted files", "presence", "No redaction has been applied", "unredacted statement rendered when not redacted", { when: { "==": [{ var: "redacted" }, false] } }),
  // the E-SIGN statement is a sentence of the rendered text: dropping it from the template fails the rule whenever the payload says the records are electronic
  R("esign-7001d", "15 U.S.C. 7001(d)(1): electronic record accurately reflects the information and remains accessible for later reference", "presence", "accurately reflect the information set forth in the original records and remain capable of being accurately reproduced for later reference", "electronic-record accuracy statement when records are electronic", { when: { "==": [{ var: "electronic_records" }, true] } }),
  R("no-esign-claim-on-paper", "15 U.S.C. 7001(d)(1) describes electronic records only", "absence", "maintained electronically in a write-once storage system", "no electronic-record statement on a production of paper originals", { when: { "==": [{ var: "electronic_records" }, false] } }),
  R("redaction-log", "12 CFR 1024.36(d)(3)-style redaction; Reg P 1016.15 exceptions for Fannie Mae/regulators/courts", "conditional", "redaction_log_id", "redaction log id present when redacted", { when: { "==": [{ var: "redacted" }, true] }, predicate: { present: "redaction_log_id" } }),
  NO_SSN,
  R("perjury-bold", "signature block conventions", "layout", "perjury", "perjury declaration in bold", { layout: { bold: true, minPt: 11 } }),
];
const CERT_SAMPLE = { certified_on: "2026-11-24", request_id: "RR-2026-0417", requester_name: "Supreme Court of the State of New York, County of Kings", requester_type: "court_subpoena", matter_ref: "Index No. 512345/2026", scope_description: "loan ending 1234: transaction schedule 2021-10-01 through 2026-11-19, security instrument, personnel and agent notes, data-field report, borrower-submitted loss mitigation documents", signer_name: "R. Custodian", signer_title: "Vice President, Records", signer_role: "signing_officer", servicer_name: "Supermortgage", servicer_address: "PO Box 1, Testville TX 75001", records_phone: "(800) 555-0177", object_count: 214, manifest_document_id: "doc-manifest-RR-2026-0417", manifest_sha256: "3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a", electronic_records: true, fnma_property: true, redacted: false, redaction_log_id: null, executed_at_city: "Testville, Texas" };

// ------------------------------------------------------------------ NTC_LEGAL_HOLD_INTERNAL (hold notice to custodians / vendors)
const HOLD = `{{#block "heading" page=1 y=0.05 pt=14 bold}}LEGAL HOLD NOTICE — PRESERVE RECORDS — DO NOT DESTROY{{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date issued_on}}. Hold {{hold_id}} ({{reason}}), matter {{matter_ref}}. To: {{recipient_name}}, {{recipient_kind}}. From: {{servicer_name}} Records ({{placed_by}}).{{/block}}
{{#block "scope" page=1 y=0.2 pt=11}}Scope of hold: {{scope_kind}} {{scope_ref}}{{#if date_range}}, records dated {{date_range}}{{/if}}. Record types covered: {{#each record_types}}{{this}}; {{/each}}{{#if storage_locations}}Locations/media: {{storage_locations}}.{{/if}}{{/block}}
{{#block "instructions" page=1 y=0.35 pt=11 bold}}Effective immediately and until you receive a written release: (1) do not destroy, discard, alter, overwrite, shred or return to routine disposal any record within the scope of this hold, including paper originals, microfilm, backup media, call recordings and e-mail; (2) suspend every retention schedule, disposal run and vendor destruction order that would otherwise dispose of these records; (3) preserve the records in place with their metadata and chain of custody; (4) return or make available any covered record to {{servicer_name}} within five business days of a request.{{/block}}
{{#block "release" page=1 y=0.6 pt=11}}This hold is released only in writing by an officer and an attorney of {{servicer_name}} acting jointly (policy POL-REC-02). No automated process, retention schedule, contract expiry or verbal instruction releases it. The hold is reviewed every 180 days; next review {{date next_review_on}}.{{/block}}
{{#block "ack" page=1 y=0.72 pt=11}}Acknowledge receipt and confirm the preservation steps taken by {{date acknowledge_by}} to {{records_contact}}. Questions: {{records_phone}}. Records subject to this hold remain the property of Fannie Mae where they relate to loans serviced for Fannie Mae.{{/block}}`;
const HOLD_REASONS = ["litigation", "litigation_anticipated", "subpoena", "regulator_exam", "fannie_mae_request", "mora", "complaint_escalated", "internal_investigation", "audit", "incident"];
const HOLD_RULES: ContentRule[] = [
  DATE_RULE,
  R("do-not-destroy", "19.1 legal_holds; Fed. R. Civ. P. 37(e) preservation duty", "presence", "do not destroy, discard, alter, overwrite, shred", "preservation instruction"),
  R("suspend-disposal", "19.1 state machine: any state → held while hold_count > 0; disposal runs skip held objects", "presence", "suspend every retention schedule, disposal run and vendor destruction order", "disposal suspension instruction"),
  R("return-5bd", "19.3 clause checklist: vendor records returned on request within 5 business days", "presence", "within five business days of a request", "five-business-day return clause"),
  R("release-joint", "POL-REC-02: release by officer + attorney jointly; holds are never auto-released", "presence", "released only in writing by an officer and an attorney", "joint release statement"),
  R("release-approvals", "POL-REC-02", "data_equality", "release_requires", "release requires officer and attorney", { predicate: { "==": [{ var: "release_requires" }, "officer_and_attorney"] } }),
  R("review-180", "SM_LEGAL_HOLD_REVIEW_180", "presence", "reviewed every 180 days", "180-day review statement"),
  R("reason-enum", "19.1 legal_holds.reason", "data_equality", "reason", "reason is one of the schedule's hold reasons", { predicate: { in: [{ var: "reason" }, HOLD_REASONS] } }),
  R("hold-id", "19.1 legal_holds.id", "presence", "Hold LH-[A-Za-z0-9-]+", "hold id present"),
  // the record types in scope are read from `record_types[]` itself — on the rendered text and on the payload — never from a caller-supplied count
  R("record-types", "19.1 legal_hold_objects: materialized by scope", "presence", "Record types covered: (?:[a-z0-9_]+; )+", "at least one record type in scope rendered"),
  R("record-types-data", "19.1 legal_hold_objects: materialized by scope", "conditional", "record_types", "record_types[] carries at least one type", { predicate: { present: "record_types.0" } }),
  R("ack-by", "19.1 outputs: hold notice to custodians/vendors (acknowledgment)", "presence", "Acknowledge receipt and confirm the preservation steps taken by", "acknowledgment request"),
  R("fnma-property", "Selling Guide A2-4.1-02", "presence", "property of Fannie Mae", "Fannie Mae ownership reminder"),
  NO_SSN,
  R("instructions-bold", "readability of the preservation instruction", "layout", "instructions", "instructions in bold", { layout: { bold: true, minPt: 11 } }),
];
const HOLD_SAMPLE = { issued_on: "2026-11-19", hold_id: "LH-2026-0093", reason: "subpoena", matter_ref: "Index No. 512345/2026", recipient_name: "Iron Vault Records Storage LLC", recipient_kind: "offsite paper-records vendor", servicer_name: "Supermortgage", placed_by: "agent:security-records", scope_kind: "loan", scope_ref: "loan ending 1234", date_range: "2021-10-01 to present", record_types: ["security_instrument", "payment_history", "contact_note", "call_recording", "lossmit_document_borrower"], storage_locations: "box IV-88213 (wet-ink assignment awaiting recording); carrier-hosted call recordings", next_review_on: "2027-05-18", acknowledge_by: "2026-11-24", records_contact: "records@supermortgage.example", records_phone: "(800) 555-0177", release_requires: "officer_and_attorney" };

// ------------------------------------------------------------------ NTC_DISPOSAL_CERTIFICATE (officer-attested run certificate)
const DISPOSAL = `{{#block "heading" page=1 y=0.05 pt=14 bold}}CERTIFICATE OF DISPOSAL — RUN {{run_id}}{{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date run_on}}. Retention class {{class_code}} ({{class_citation}}). Objects disposed: {{object_count}}. Method: {{method}}. Manifest {{manifest_document_id}} (SHA-256 {{manifest_sha256}}), retained seven years (corporate_7y).{{/block}}
{{#block "checks" page=1 y=0.2 pt=11}}Before execution the lifecycle engine verified for every object that: every retention gate had opened ({{#each gates_checked}}{{this}}; {{/each}}); the loan was liquidated or transferred out (no Fannie Mae-property object of an active loan was included); no legal hold applied (held objects in scope: {{held_objects}}); no open records request touched the loan; and the write-once (WORM) copy's hash was verified ({{#if worm_integrity_verified}}integrity verified{{else}}integrity NOT verified{{/if}}).{{/block}}
{{#block "method" page=1 y=0.4 pt=11}}{{#if electronic}}Electronic objects were crypto-shredded (per-object data key destroyed) and deleted after write-once retention expiry; database content columns were hard-deleted and a tombstone row with the object hash retained.{{/if}}{{#if physical}}Paper and physical media were destroyed by {{vendor_name}} under certificate of destruction {{vendor_certificate_document_id}}; the vendor's due-diligence file is current.{{/if}} Reasonable measures were taken to protect against unauthorized access to or use of the information in connection with its disposal, and the information cannot practicably be read or reconstructed.{{/block}}
{{#block "attestation" page=1 y=0.6 pt=11 bold}}Attestation: I, {{attested_by_name}}, {{attested_by_title}} ({{attested_by_role}}), attest that the checks above were performed, that the run was executed only after this attestation on {{date attested_on}}, and that no object was deleted outside this run.{{/block}}
{{#block "exceptions" page=1 y=0.75 pt=11}}{{#if exceptions}}Objects excluded from this run: {{#each exceptions}}{{object_id}} ({{reason}}); {{/each}}{{else}}No objects were excluded from this run.{{/if}} Contact: {{servicer_name}} Records, {{records_phone}}.{{/block}}`;
const DISPOSAL_RULES: ContentRule[] = [
  DATE_RULE,
  R("run-id", "19.1 disposal_runs.id", "presence", "RUN DR-[A-Za-z0-9-]+", "run id present"),
  R("class", "19.1 disposal_runs.class_code", "presence", "Retention class [a-z0-9_]+", "class code present"),
  R("manifest-hash", "19.1 rule 7: manifests retained corporate_7y", "presence", `SHA-256 ${SHA}`, "manifest hash present"),
  R("manifest-7y", "19.1 rule 7", "presence", "retained seven years \\(corporate_7y\\)", "manifest retention statement"),
  R("gates-checked", "19.1 decision record: gates_checked[]", "data_range", "gate_count", "at least one gate named", { range: { min: 1 } }),
  R("held-zero", "19.1 state machine: eligible requires hold_count = 0", "data_equality", "held_objects", "no held object in the run", { predicate: { "==": [{ var: "held_objects" }, 0] } }),
  R("worm-verified", "19.1 integrations: never delete without the verified WORM copy existence check passing first", "data_equality", "worm_integrity_verified", "WORM integrity verified before execution", { predicate: { "==": [{ var: "worm_integrity_verified" }, true] } }),
  R("worm-text", "19.1 integrations", "presence", "integrity verified", "WORM verification stated"),
  R("attested-officer", "19.1 rule 7: every run requires an officer attestation before execution", "data_equality", "attested_by_role", "attested by an officer", { predicate: { "==": [{ var: "attested_by_role" }, "officer"] } }),
  R("attested-before-run", "19.1 rule 7", "presence", "executed only after this attestation", "attestation-before-execution statement"),
  R("ftc-682-3", "16 CFR 682.3(a): reasonable measures to protect against unauthorized access to or use of the information in connection with its disposal", "presence", "Reasonable measures were taken to protect against unauthorized access to or use of the information in connection with its disposal", "FTC Disposal Rule statement"),
  R("cannot-reconstruct", "Fannie Mae Supplement: remove information such that it cannot be retrieved or reconstructed", "presence", "cannot practicably be read or reconstructed", "irretrievability statement"),
  R("method-enum", "19.1 retention_classes.disposal_method", "data_equality", "method", "method is crypto_shred, object_delete or physical_destroy", { predicate: { in: [{ var: "method" }, ["crypto_shred", "object_delete", "physical_destroy"]] } }),
  R("vendor-cert", "16 CFR 682.3(b)(3); 19.1 rule 7: paper requires a vendor certificate", "conditional", "vendor_certificate_document_id", "vendor certificate when media are physically destroyed", { when: { "==": [{ var: "physical" }, true] }, predicate: { present: "vendor_certificate_document_id" } }),
  R("object-count", "19.1 disposal_runs.object_count", "data_range", "object_count", "at least one object disposed", { range: { min: 1 } }),
  NO_SSN,
  R("attestation-bold", "signature block conventions", "layout", "attestation", "attestation in bold", { layout: { bold: true, minPt: 11 } }),
];
const DISPOSAL_SAMPLE = { run_id: "DR-2031-04-06-life-of-loan", run_on: "2031-04-06", class_code: "life_of_loan_plus_4y", class_citation: "Selling Guide A2-4.1-02", object_count: 1_284, method: "crypto_shred", manifest_document_id: "doc-manifest-DR-2031-04-06", manifest_sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", gates_checked: ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER", "NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY", "REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION"], gate_count: 4, held_objects: 0, worm_integrity_verified: true, electronic: true, physical: false, vendor_name: null, vendor_certificate_document_id: null, attested_by_name: "M. Officer", attested_by_title: "Chief Compliance Officer", attested_by_role: "officer", attested_on: "2031-04-05", exceptions: [{ object_id: "ro-77120", reason: "worm_integrity_failed_sev1 — held for 19.2 incident INC-2031-004" }], servicer_name: "Supermortgage", records_phone: "(800) 555-0177" };

export const VERSIONS_19_1: VersionInput[] = [
  V("NTC_RECORDS_CERTIFICATION", CERT, CERT_RULES, CERT_SAMPLE, "records.certification.2026-09", "Fed. R. Evid. 803(6)/902(11) business-records certification; 28 U.S.C. §1746; A2-4.1-02"),
  V("NTC_LEGAL_HOLD_INTERNAL", HOLD, HOLD_RULES, HOLD_SAMPLE, "records.legal_hold.2026-09", "POL-REC-02 legal-hold notice to custodians of paper records and vendors"),
  V("NTC_DISPOSAL_CERTIFICATE", DISPOSAL, DISPOSAL_RULES, DISPOSAL_SAMPLE, "records.disposal.2026-09", "16 CFR 682.3; 16 CFR 314.4(c)(6); 23 NYCRR 500.13(b); 19.1 rule 7 officer-attested run certificate"),
];
export const OVERRIDES_19_1: Record<string, Partial<NoticeTemplate>> = {
  NTC_RECORDS_CERTIFICATION: { channelPolicy: "electronic_ok_without_esign", citation: "Fed. R. Evid. 803(6), 902(11); 28 U.S.C. §1746 — court/regulator certification, not a consumer notice (15 U.S.C. 7001(c) does not apply)", separateDocument: true, retention: "corporate_7y", piiLevel: "low" },
  NTC_LEGAL_HOLD_INTERNAL: { channelPolicy: "electronic_ok_without_esign", citation: "19.1 legal_holds; POL-REC-02 — internal/vendor hold notice, not a consumer notice", retention: "corporate_7y", piiLevel: "low" },
  NTC_DISPOSAL_CERTIFICATE: { channelPolicy: "electronic_ok_without_esign", citation: "16 CFR 682.3; 16 CFR 314.4(c)(6); 23 NYCRR 500.13(b) — officer-attested run certificate, retained corporate_7y", retention: "corporate_7y", piiLevel: "low" },
};
