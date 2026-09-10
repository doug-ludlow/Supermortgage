/**
 * §19.1 timer satisfaction overrides: for every 19.1 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides.
 *
 * Every not-before gate whose row says "gate opens" / "disposal blocked" is evaluator-backed:
 * the row carries no due instant (the engine never breaches it — the accounting-report row's
 * breach column is "n/a"), and the disposal command asserts the gate over the object's facts
 * (`assertGateOpen`, ops-19-1.ts). The registry merge recomputes `anchorField` from the anchor
 * column on every override, so rows with a computed anchor pass it explicitly. The monthly drill
 * row's "×25 within 5 minutes each" is a conditioned satisfying event: the compile tool tags each
 * drill compile with its index and whether every compile of the drill stayed within target.
 * The schedule rows' triggers (`schedule.tick`, `period.year_end`) are set in the section's
 * timers.ts; `scheduleTicks` in ops-19-1.ts emits them.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_19_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- not-before gates: condition-shaped, asserted by the disposal command; never a clock that breaches
  o("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", { evaluator: "19.1.fnmaRetentionGateOpen", why: "§19.1 timer table: later of `loan.liquidated` / `servicing.transferred_out` + 4 years (calendar anniversary; `jurisdiction_overrides` for longer local periods); 'gate opens; no satisfying event' — permanent while the loan is active and never while held; breach action 'disposal command blocked (`assertGateOpen`)' (A2-4.1-02)." });
  o("REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER", { evaluator: "19.1.regXRetentionGateOpen", why: "§19.1 timer table: `loan.discharged` / `servicing.transferred_out` + 1 year (calendar); 'gate opens' / 'disposal blocked' — later-of when both fire; a bankruptcy discharge never opens it (rule 2) (12 CFR 1024.38(c)(1))." });
  o("REGB_1002_12B_RETENTION_25M", { evaluator: "19.1.regBRetentionGateOpen", why: "§19.1 timer table: `lossmit.decision.notified` + 25 months; extended to `investigation.closed` when `enforcement_notice.received` (T9); 'gate opens' / 'disposal blocked' (12 CFR 1002.12(b)(1), (b)(4))." });
  o("TCPA_CONSENT_EVIDENCE_4Y", { trigger: "`consent.revoked`", evaluator: "19.1.tcpaConsentGateOpen", why: "§19.1 timer table: `consent.revoked` or last reliance — later of — + 4 years; 'gate opens' / 'disposal blocked' (47 CFR 64.1200; 28 U.S.C. 1658(a) [PARTIALLY VERIFIED])." });
  o("FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M", { evaluator: "19.1.accountingReportGateOpen", why: "§19.1 timer table: `investor_report.filed` + 18 months — 'gate opens (\"may destroy … unless instructed otherwise\")'; breach 'n/a — reports are kept `fnma_reporting_7y` anyway', so the row is a gate with no due instant (A2-4.1-02)." });
  o("REGZ_1026_25A_RETENTION_2Y", { anchorField: "disclosure_due_date", evaluator: "19.1.regZRetentionGateOpen", why: "§19.1 timer table: `notice.sent{regz}` anchored on the disclosure due date + 2 years; 'gate opens' / 'disposal blocked' — evidence of compliance 'for two years after the date disclosures are required to be made' (12 CFR 1026.25(a))." });
  o("REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION", { evaluator: "19.1.regFCollectionGateOpen", why: "§19.1 timer table: `collection.activity.last` + 3 years on `fdcpa_debt_collector_flag` loans; 'gate opens' / 'disposal blocked' (12 CFR 1006.100(a))." });
  o("REGF_1006_100B_CALL_RECORDING_3Y", { evaluator: "19.1.callRecordingGateOpen", why: "§19.1 timer table: `call.recorded` + 3 years (floor; default class keeps recordings `life_of_loan_plus_4y`); 'gate opens' / 'disposal blocked' (12 CFR 1006.100(b))." });
  o("NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY", { evaluator: "19.1.nyFinalEntryGateOpen", why: "§19.1 timer table: `loan.final_entry` (entry date) + 3 years for NY loans; 'gate opens' / 'disposal blocked' (3 NYCRR 419.9)." });
  o("NYDFS_500_6_AUDIT_TRAIL_5Y", { evaluator: "19.1.nydfsAuditTrailGateOpen", why: "§19.1 timer table: `security_log.written` / `ledger_entry.created` record date + 5 years; 'gate opens' / 'disposal blocked' (23 NYCRR 500.6)." });
  o("IRS_INFO_RETURN_RETENTION_4Y", { anchorField: "form_due_date", evaluator: "19.1.irsInfoReturnGateOpen", why: "§19.1 timer table: `tax.form.filed` anchored on the form due date + 4 years (3-year IRS minimum); 'gate opens' / 'disposal blocked' (IRS General Instructions for Certain Information Returns)." });
  // ---- deadline: regulator productions — the data model's requester vocabulary on both the trigger and the satisfying event; computed anchor kept
  o("SM_REGULATOR_RECORDS_REQUEST", { trigger: "`records.request.received{requester_type∈{regulator_state, regulator_federal}}`", anchorField: "delivery_due_stated", offset: "0", satisfied: "`records.request.delivered{requester_type∈{regulator_state, regulator_federal}}`", why: "§19.1 timer table: `records.request.received{regulator_*}` → `requester_type ∈ {regulator_state, regulator_federal}` (data model); per request; default +10 business_days_servicer [policy] — computed anchor `delivery_due_stated`; 'delivered' — the production's delivery event for the same requester types." });
  // ---- recurring control test: the drill's 25th compile, every compile of the drill within the 5-minute target
  o("SM_SERVICING_FILE_DRILL_MONTHLY", { satisfied: "`servicing_file.compiled{requested_by=drill, drill_index=25, drill_all_within_target=true}`", why: "§19.1 timer table: schedule (1st of month) → 'monthly, 25 random loans'; satisfied by '`servicing_file.compiled` ×25 within 5 minutes each' — `records.compileServicingFile` tags each drill compile with `drill_index` (its ordinal in the drill, from the log) and `drill_all_within_target` (every compile of the drill so far, this one included, ≤ 5 minutes measured wall-clock); a drill whose 25th bundle is not so tagged never satisfies the row (sev-2 → CTL-REC-01 failure → 18.1 QC finding)." });
}
