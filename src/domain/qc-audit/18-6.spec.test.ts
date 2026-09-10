// 18.6 Reg AB / USAP attestation
// spec/sections/18-qc-audit-regulatory-reporting/18-6-reg-ab-usap-attestation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { exceptionList, removeException, generateControlEvidence, materialNoncompliance } from "./ops.ts";
import { assessmentPeriod, assessmentReport, materialNoncomplianceDisclosure } from "./ops-18-6.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";

// 18.6-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.6-T2 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.6-T3: Given a sev-1 QC finding tagged `1122.d.4.x` (escrow refund late on 40 loans), then it appears in the exceptions list and cannot be removed without an officer disposition.", () => {
  const finding = { id: "QCF-2026-118", severity: "sev1", taxonomy_nodes: ["escrow.refund.late", "regab.1122.d.4.x"], description: "escrow refund later than 30 calendar days of full repayment on 40 loans" };
  const untagged = { id: "QCF-2026-119", severity: "sev2", taxonomy_nodes: ["comms.letter.typo"], description: "cosmetic letter defect" };
  const list = exceptionList({ findings: [finding, untagged] });
  // guardrail: every 18.1 finding tagged to a criterion appears in the exception list — and only those
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { finding_id: "QCF-2026-118", criterion: "1122.d.4.x", severity: "sev1", description: finding.description, status: "open", officer_disposition: null });
  // the agent cannot remove it: no disposition, or a disposition without rationale, is refused
  const agent = removeException({ exception: list[0]!, officer_disposition: null });
  assert.equal(agent.removed, false); assert.match(agent.refusal!, /QCF-2026-118 \(1122\.d\.4\.x\) stays on the list until an officer disposition/);
  assert.equal(removeException({ exception: list[0]!, officer_disposition: { officer_id: "officer-7", rationale: "" } }).removed, false);
  // an officer disposition with rationale releases it, and the list keeps the dispositioned row (append-only, never omitted)
  assert.deepEqual(removeException({ exception: list[0]!, officer_disposition: { officer_id: "officer-7", rationale: "remediated under CAPA-2026-31; not a material instance per auditor materiality framework" } }), { removed: true, refusal: null });
  const after = exceptionList({ findings: [finding], dispositions: [{ finding_id: "QCF-2026-118", officer_id: "officer-7", disposition: "remediated; immaterial" }] });
  assert.equal(after.length, 1); assert.equal(after[0]!.status, "dispositioned"); assert.deepEqual(after[0]!.officer_disposition, { officer_id: "officer-7", disposition: "remediated; immaterial" });
});
// 18.6-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.6-T5: Given `control_evidence.generate('2026-07-01','2027-06-30')` for a June issuer year, then evidence spans the window regardless of Supermortgage's December fiscal year.", () => {
  // rule 18.6-4: a June issuer year runs 2026-07-01..2027-06-30, straddling Supermortgage's 2026-12-31 fiscal year-end
  assert.deepEqual(assessmentPeriod(D("2027-06-30")), { period_start: D("2026-07-01"), period_end: D("2027-06-30"), basis: "issuer_psa_period" });
  const matrix = [{ control_code: "CTL-2VII-RECON", criterion: "1122.d.2.vii" }, { control_code: "CTL-4X-ESCROW", criterion: "1122.d.4.x" }];
  const evidence = [
    { control_code: "CTL-2VII-RECON", occurred_on: D("2026-06-30"), document_id: "recon-2026-06" },   // before the window
    { control_code: "CTL-2VII-RECON", occurred_on: D("2026-07-31"), document_id: "recon-2026-07" },
    { control_code: "CTL-2VII-RECON", occurred_on: D("2026-12-31"), document_id: "recon-2026-12" },   // Supermortgage FYE — inside the issuer year
    { control_code: "CTL-2VII-RECON", occurred_on: D("2027-01-31"), document_id: "recon-2027-01" },   // after Supermortgage FYE — still inside
    { control_code: "CTL-2VII-RECON", occurred_on: D("2027-06-30"), document_id: "recon-2027-06", exception: true },
    { control_code: "CTL-2VII-RECON", occurred_on: D("2027-07-31"), document_id: "recon-2027-07" },   // after the window
    { control_code: "CTL-4X-ESCROW", occurred_on: D("2026-05-01"), document_id: "escrow-analysis-2026" }, // before the window
    { control_code: "CTL-4X-ESCROW", occurred_on: D("2027-03-15"), document_id: "escrow-analysis-2027" },
  ];
  const r = generateControlEvidence({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence, supermortgage_fye: D("2026-12-31") });
  assert.deepEqual(r.period, { start: D("2026-07-01"), end: D("2027-06-30") }); assert.equal(r.fiscal_year_basis, "issuer_psa_period"); assert.equal(r.supermortgage_fye, D("2026-12-31"));
  assert.deepEqual(r.rows, [
    { control_code: "CTL-2VII-RECON", criterion: "1122.d.2.vii", evidence_document_ids: ["recon-2026-07", "recon-2026-12", "recon-2027-01", "recon-2027-06"], exceptions_count: 1 },
    { control_code: "CTL-4X-ESCROW", criterion: "1122.d.4.x", evidence_document_ids: ["escrow-analysis-2027"], exceptions_count: 0 },
  ]);
  assert.equal(r.complete, true);   // → `attestation.package.status_changed{status=evidence_compiled}` satisfies SM_ATTEST_EVIDENCE_COMPILE_FYE_15
  // the same evidence cut on Supermortgage's own fiscal year gives a different binder — the window, not the FYE, governs
  const sm = generateControlEvidence({ period_start: D("2026-01-01"), period_end: D("2026-12-31"), matrix, evidence, supermortgage_fye: D("2026-12-31") });
  assert.deepEqual(sm.rows[0]!.evidence_document_ids, ["recon-2026-06", "recon-2026-07", "recon-2026-12"]); assert.deepEqual(sm.rows[1]!.evidence_document_ids, ["escrow-analysis-2026"]);
});
test("18.6-T6: Given a material-noncompliance determination, then the partner is notified within 1 BD and the item is in the assessment text.", () => {
  const given = { determined_on: D("2026-11-25"), criterion: "1122.d.4.x", description: "escrow refunds later than 30 calendar days of full repayment on 40 loans", counsel_advice_document_id: "doc-counsel-memo-2026-11" };
  // the agent cannot determine materiality — officer act on counsel's advice (rule 18.6-3)
  const agent = materialNoncompliance({ ...given, determined_by_role: "qc-audit" });
  assert.equal(agent.allowed, false); assert.match(agent.refusal!, /determined by the officer on counsel's advice/); assert.equal(agent.partner_notice, null); assert.equal(agent.assessment_text, null);
  // officer determination Wed 2026-11-25 → partner notice due 1 BD later = Fri 2026-11-27 (Thu 2026-11-26 is Thanksgiving)
  const d = materialNoncompliance({ ...given, determined_by_role: "officer" });
  assert.equal(d.allowed, true); assert.deepEqual(d.partner_notice, { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", due: D("2026-11-27") }); assert.equal(d.form_10k_disclosure, true);
  assert.match(d.assessment_text!, /Material instance of noncompliance with servicing criterion 1122\.d\.4\.x \(17 CFR 229\.1122\(d\)\): escrow refunds later than 30 calendar days of full repayment on 40 loans/);
  assert.match(d.assessment_text!, /on counsel's advice \(doc-counsel-memo-2026-11\)/);
  // the disclosure arms the 1 BD clock, names the satisfying event, and the item lands in the Item 1122(a) assessment report
  const x = materialNoncomplianceDisclosure({ ...given, determined_by_role: "officer", partner_notified_on: D("2026-11-27") });
  assert.deepEqual(x.timer, { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", anchor: D("2026-11-25"), due: D("2026-11-27"), satisfied_by: "partner.notified{reason=material_noncompliance}", status: "satisfied" });
  assert.deepEqual(x.escalations, []);
  const late = materialNoncomplianceDisclosure({ ...given, determined_by_role: "officer", partner_notified_on: D("2026-11-30") });
  assert.equal(late.timer!.status, "breached"); assert.equal(late.escalations[0]!.kind, "officer"); assert.match(late.escalations[0]!.reason, /sev-1/);
  const report = assessmentReport({ entity: "Supermortgage", period_start: D("2026-01-01"), period_end: D("2026-12-31"), criteria_scope: ["1122.d.2.vii", "1122.d.4.x"], material_noncompliance: [x.item!], attestation_firm: "Registered Firm LLP" });
  assert.equal(report.form_10k_disclosure, true); assert.equal(report.complete, true); assert.equal(report.refusal, null);
  assert.match(report.statements.assessment, /the following material instance of noncompliance was identified: criterion 1122\.d\.4\.x — escrow refunds later than 30 calendar days of full repayment on 40 loans \(determined 2026-11-25; involves the servicing of the assets backing the asset-backed securities\)/);
  assert.match(report.statements.responsibility, /responsible for assessing compliance with the servicing criteria applicable to it/);
  assert.match(report.statements.criteria_used, /used the criteria in paragraph \(d\) of Item 1122/);
  assert.match(report.statements.attestation, /registered public accounting firm, Registered Firm LLP, has issued an attestation report/);
  assert.ok(report.text.includes(x.item!.description));
  // the timer registry satisfies the 1 BD clock only by the partner notice the disclosure names
  const t = loadOverriddenRegistry().get("SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD")!;
  assert.equal(t.satisfiedPattern!.type, "partner.notified"); assert.match(t.satisfied, /partner\.notified\{reason=material_noncompliance\}/);
  // without the auditor's report the assessment is not deliverable (Item 1122(a)(4)) and no 10-K disclosure arises without an item
  const clean = assessmentReport({ entity: "Supermortgage", period_start: D("2026-01-01"), period_end: D("2026-12-31"), criteria_scope: ["1122.d.2.vii"], material_noncompliance: [], attestation_firm: null });
  assert.equal(clean.form_10k_disclosure, false); assert.equal(clean.complete, false); assert.match(clean.refusal!, /attestation report/); assert.match(clean.statements.assessment, /no material instance of noncompliance was identified/);
});
// 18.6-T7 — implemented in src/domain/qc-audit/qc-audit.test.ts
