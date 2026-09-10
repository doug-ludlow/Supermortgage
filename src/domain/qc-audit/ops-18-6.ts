/**
 * §18.6 Reg AB / USAP attestation — operating rules layered over the 18.6 block of ./ops.ts
 * (exceptionList, removeException, generateControlEvidence, materialNoncompliance):
 *   rule 1  applicability per investor program (12 U.S.C. 1719(d); 17 CFR 229.1122/1123) and the REGAB_* timers it starts;
 *   timers  the FYE-anchored clocks of the timer table (PSA due, warning FYE + 30, assertion FYE + 45, evidence FYE + 15, SOC 1 FYE + 75);
 *   state   the `attestation_packages.status` machine — `assertion_signed` only on an officer signature record (18.6-T7);
 *   rule 2  (2)(vii) reconciling items aged > 90 calendar days → control exception (18.6-T4);
 *   rule 3  the Item 1122(a) assessment text carrying every material instance of noncompliance and the 1-BD partner notice;
 *   rule 4  the issuer-year assessment period and the evidence binder that honours each control's frequency (18.6-T5);
 *   gates   evidenceCompleteness / exceptionRegister / auditorReportCheck — what the state machine reads from the stores, never from
 *           a caller's flag (SM_ATTEST_EVIDENCE_COMPILE_FYE_15, "exception omissions are impossible by construction", Item 1122(b));
 *   §6.3    classifyReconItem / reconItemResolvedView — the Reg AB view of a §6.3 reconciling item keyed to the *item* (only accounts of a
 *           `regab_applicable` program start the clock; one item's resolution never satisfies another item's clock);
 *   record  applicabilityConflicts — the cycle reads the recorded `investor_programs` determination, never a caller's program_kind / PSA days;
 *   docs    evidenceDocumentsOnFile — a binder cites `documents` on file with their hashes, never a caller-asserted document id;
 *   warning assessmentWarning — the "warning at FYE + 30" of REGAB_1122_ASSESSMENT_PSA_DUE as a behaviour (officer escalation), not a date.
 * One small pure function per rule; no I/O. ./regab.ts keeps the original calculators; the corrected ones live here
 * (regab.assessmentClocks derives warning/assertion from the PSA date, the spec fixes them at FYE + 30 / FYE + 45).
 */
import { type PlainDate, addDays, addMonths, addYears, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar } from "../../kernel/calendar/business.ts";
import { materialNoncompliance, exceptionList, generateControlEvidence, type ControlException } from "./ops.ts";

// ============================================================ rule 1: applicability
/** Data model: `investor_programs.program_kind ∈ {fnma_mbs, fnma_portfolio, private_abs_registered, private_whole_loan, other}`. */
export type ProgramKind = "fnma_mbs" | "fnma_portfolio" | "private_abs_registered" | "private_whole_loan" | "other";
export const PROGRAM_KINDS: readonly ProgramKind[] = ["fnma_mbs", "fnma_portfolio", "private_abs_registered", "private_whole_loan", "other"];
export type PackageKind = "regab_1122_assessment" | "regab_1123_statement" | "soc1_type2" | "usap";
/** The registry rows that start only when `regab_applicable` (18.6-T1: none for a Fannie Mae program). */
export const REGAB_TIMERS = ["REGAB_1122_ASSESSMENT_PSA_DUE", "REGAB_1123_STATEMENT_PSA_DUE", "REGAB_1122_2VII_RECON_ITEMS_90"] as const;

/**
 * Rule 18.6-1: run at each investor onboarding. Fannie Mae programs → `regab_applicable=false` (12 U.S.C. 1719(d):
 * Fannie Mae securities are exempt securities; Fannie Mae requires no Reg AB or USAP report); registered ABS → true
 * (Supermortgage is a "party participating in the servicing function", Item 1122(a), Instruction 3); private whole-loan
 * investors → contractual (USAP / SOC 1) only. A SOC 1 Type II is produced from year one regardless (open question 1).
 */
export function regAbApplicability(i: { program_kind: ProgramKind; usap_requested?: boolean }): { regab_applicable: boolean; usap_contractual: boolean; deliverables: PackageKind[]; regab_timers: string[]; basis: string } {
  const usap = i.usap_requested === true;
  switch (i.program_kind) {
    case "fnma_mbs":
    case "fnma_portfolio":
      return { regab_applicable: false, usap_contractual: false, deliverables: ["soc1_type2"], regab_timers: [], basis: "12 U.S.C. 1719(d): Fannie Mae MBS and debt are exempt securities; Fannie Mae requires no Reg AB or USAP report (AFS / Forms 582 and 1002 / Supplement attestation instead)" };
    case "private_abs_registered":
      return { regab_applicable: true, usap_contractual: usap, deliverables: ["regab_1122_assessment", "regab_1123_statement", "soc1_type2", ...(usap ? ["usap" as const] : [])], regab_timers: [...REGAB_TIMERS], basis: "17 CFR 229.1122(a)/(d) and 229.1123: registered asset-backed securities — separate Item 1122 assessment + attestation for each party participating in the servicing function (Instruction 3); Item 1123 statement by the servicer's officer" };
    case "private_whole_loan":
      return { regab_applicable: false, usap_contractual: true, deliverables: ["soc1_type2", ...(usap ? ["usap" as const] : [])], regab_timers: [], basis: "no registered ABS: USAP / SOC 1 only where the investor contract requires it (open question 3: SOC 1 + 1122(d) matrix offered instead of USAP)" };
    case "other":
      return { regab_applicable: false, usap_contractual: usap, deliverables: ["soc1_type2", ...(usap ? ["usap" as const] : [])], regab_timers: [], basis: "not a registered ABS program: Reg AB does not apply; SOC 1 Type II produced from year one (open question 1)" };
  }
}

// ============================================================ timer table: the FYE clocks
/**
 * §18.6 timer table, anchored on FYE: `REGAB_1122_ASSESSMENT_PSA_DUE` per PSA (default FYE + 60 [UNVERIFIED]) with a warning at
 * FYE + 30; `REGAB_1123_STATEMENT_PSA_DUE` per PSA (default FYE + 60); `SM_ATTEST_EVIDENCE_COMPILE_FYE_15` FYE + 15;
 * `SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45` FYE + 45; `SM_SOC1_TYPE2_ANNUAL` FYE + 75. The warning and the assertion date are
 * fixed offsets from FYE — they do not move with the PSA date (a PSA at FYE + 90 still warns 01-30 and asserts 02-14).
 */
export function regAbClocks(fye: PlainDate, psa: { assessment_days?: number | null; statement_days?: number | null } = {}): { fye: PlainDate; attestation_due: PlainDate; statement_due: PlainDate; warning: PlainDate; assertion_due: PlainDate; evidence_due: PlainDate; soc1_due: PlainDate; psa_default_applied: boolean } {
  const a = psa.assessment_days ?? 60, s = psa.statement_days ?? psa.assessment_days ?? 60;
  return { fye, attestation_due: addDays(fye, a), statement_due: addDays(fye, s), warning: addDays(fye, 30), assertion_due: addDays(fye, 45), evidence_due: addDays(fye, 15), soc1_due: addDays(fye, 75), psa_default_applied: psa.assessment_days == null };
}

export interface AttestationCycleEvent { readonly type: "attestation.cycle.opened"; readonly aggregate: { readonly kind: "attestation_cycle"; readonly id: string }; readonly payload: { entity: string; fye: PlainDate; period_start: PlainDate; period_end: PlainDate; program_id: string; program_kind: ProgramKind; regab_applicable: boolean; psa_assessment_due: PlainDate; psa_statement_due: PlainDate; warning_on: PlainDate; assertion_due: PlainDate; evidence_due: PlainDate; soc1_due: PlainDate; cycle_id: string }; }
/**
 * The `attestation.cycle.opened` event the attestation cycle emits per investor program at the FYE of that program's assessment
 * period (rule 18.6-4: the issuer's PSA year, which may differ from Supermortgage's fiscal year — so this is *not* the corporate
 * `period.fiscal_year_end` event of §18.4/§19, whose clocks a cycle must never arm). The REGAB_* registry rows trigger only on
 * `{regab_applicable=true}` and anchor on the computed PSA dates (`psa_assessment_due` / `psa_statement_due`); the SM_* rows
 * (evidence, management assertion, SOC 1) anchor on `fye` — the payload date, not the day the cycle happened to be opened.
 */
export function attestationCycleEvent(i: { entity: string; fye: PlainDate; period_start?: PlainDate | null; program: { id: string; program_kind: ProgramKind; psa_assessment_days?: number | null; psa_statement_days?: number | null; usap_requested?: boolean } }): AttestationCycleEvent & { clocks: ReturnType<typeof regAbClocks>; applicability: ReturnType<typeof regAbApplicability> } {
  const applicability = regAbApplicability({ program_kind: i.program.program_kind, ...(i.program.usap_requested !== undefined ? { usap_requested: i.program.usap_requested } : {}) });
  const clocks = regAbClocks(i.fye, { assessment_days: i.program.psa_assessment_days ?? null, statement_days: i.program.psa_statement_days ?? null });
  const cycle_id = `${i.entity}:${i.program.id}:${i.fye}`;
  const period = i.period_start ? { period_start: i.period_start, period_end: i.fye, basis: "issuer_psa_period" as const } : assessmentPeriod(i.fye);
  if (period.period_start > period.period_end) throw new RangeError(`period_start ${period.period_start} is after the fiscal year-end ${i.fye}`);
  return { type: "attestation.cycle.opened", aggregate: { kind: "attestation_cycle", id: cycle_id }, clocks, applicability,
    payload: { entity: i.entity, fye: i.fye, period_start: period.period_start, period_end: period.period_end, program_id: i.program.id, program_kind: i.program.program_kind, regab_applicable: applicability.regab_applicable, psa_assessment_due: clocks.attestation_due, psa_statement_due: clocks.statement_due, warning_on: clocks.warning, assertion_due: clocks.assertion_due, evidence_due: clocks.evidence_due, soc1_due: clocks.soc1_due, cycle_id } };
}

// ============================================================ state machine
/** `attestation_packages.status`: planned → evidence_compiled → walkthroughs → testing (auditor) → exceptions_evaluated → assertion_signed → attestation_received → delivered → closed; `material_noncompliance_disclosed` branch. */
export const PACKAGE_STATES = ["planned", "evidence_compiled", "walkthroughs", "testing", "exceptions_evaluated", "material_noncompliance_disclosed", "assertion_signed", "attestation_received", "delivered", "closed"] as const;
export type PackageStatus = (typeof PACKAGE_STATES)[number];
const NEXT: Record<PackageStatus, readonly PackageStatus[]> = {
  planned: ["evidence_compiled"], evidence_compiled: ["walkthroughs"], walkthroughs: ["testing"], testing: ["exceptions_evaluated"],
  exceptions_evaluated: ["assertion_signed", "material_noncompliance_disclosed"], material_noncompliance_disclosed: ["assertion_signed"],
  assertion_signed: ["attestation_received"], attestation_received: ["delivered"], delivered: ["closed"], closed: [],
};
/** The officer signature record `assertion_signed` requires: `signed_by_officer_id`, the signer's role, when, and the signed document. */
export interface OfficerSignature { readonly officer_id: string; readonly signer_role: string; readonly signed_at: string; readonly document_id: string; }
/** The accountant's report as recorded in `documents` (Integrations: "report receipt to `documents`" — exports with hashes). */
export interface AuditorReportRecord { readonly document_id: string; readonly kind: string; readonly sha256: string | null; readonly firm: string | null; }
export interface PackageTransitionInput { package_id: string; kind: PackageKind; from: PackageStatus; to: PackageStatus; actor: { kind: "agent" | "human" | "system" | "external"; role?: string | null }; signature?: OfficerSignature | null; evidence?: Pick<EvidenceCompleteness, "complete" | "missing_controls" | "incomplete_controls" | "controls"> | null; open_exceptions?: number; material_noncompliance_count?: number; auditor_report?: AuditorReportRecord | null; delivered_to?: string | null; }
export interface PackageTransitionResult { allowed: boolean; status: PackageStatus; refusal: { code: string; reason: string } | null; events: { type: "attestation.package.status_changed" | "attestation.package.delivered"; payload: Record<string, unknown> }[]; }

/** A signature record counts only when it names an officer (non-empty id, role `officer`) and the signed document. */
export function officerSignatureRecord(s: OfficerSignature | null | undefined): { present: boolean; why: string | null } {
  if (!s) return { present: false, why: "no officer signature record" };
  if (!s.officer_id.trim()) return { present: false, why: "signature record has no officer id" };
  if (s.signer_role !== "officer") return { present: false, why: `signer role ${s.signer_role} is not officer` };
  if (!s.document_id.trim() || !s.signed_at.trim()) return { present: false, why: "signature record lacks the signed document / time" };
  return { present: true, why: null };
}

/** The `documents.kind` the accountant's report of a package kind is filed under (`attestation_report.receive`). */
export const REPORT_KIND: Readonly<Record<PackageKind, string | null>> = { regab_1122_assessment: "attestation_report:regab_1122_assessment", soc1_type2: "attestation_report:soc1_type2", usap: "attestation_report:usap", regab_1123_statement: null };

/**
 * Item 1122(b): the registered public accounting firm's attestation report is an exhibit — `attestation_received` needs the report
 * as a `documents` row of the package's report kind carrying its hash (Integrations: "exports with hashes … report receipt to
 * `documents`"); a bare document id the caller made up is not a report.
 */
export function auditorReportCheck(i: { package_kind: PackageKind; report: AuditorReportRecord | null | undefined }): { ok: boolean; code: "REGAB_ATTESTATION_REPORT_MISSING" | "REGAB_ATTESTATION_REPORT_KIND" | "REGAB_ATTESTATION_REPORT_HASH" | null; reason: string | null } {
  const expected = REPORT_KIND[i.package_kind];
  if (!i.report || !i.report.document_id.trim()) return { ok: false, code: "REGAB_ATTESTATION_REPORT_MISSING", reason: "attestation_received needs the registered public accounting firm's report recorded in documents (17 CFR 229.1122(b); attestation_report.receive)" };
  if (expected !== null && i.report.kind !== expected) return { ok: false, code: "REGAB_ATTESTATION_REPORT_KIND", reason: `document ${i.report.document_id} is ${i.report.kind || "not an attestation report"}, not the ${expected} report this package needs` };
  if (!(i.report.sha256 ?? "").trim()) return { ok: false, code: "REGAB_ATTESTATION_REPORT_HASH", reason: `document ${i.report.document_id} carries no sha256 — the evidence room exports with hashes (18.6 Integrations)` };
  return { ok: true, code: null, reason: null };
}

/**
 * 18.6-T7 and the guardrail "the agent never signs or asserts": every step follows the state machine in order from the *stored*
 * status; `evidence_compiled` needs the binder complete for all matrix rows as read from `control_evidence`
 * (SM_ATTEST_EVIDENCE_COMPILE_FYE_15; evidenceCompleteness); `exceptions_evaluated` needs every row of the exception register
 * (exceptionRegister: 18.1 findings tagged to a criterion + recorded timer breaches) dispositioned by the officer; `assertion_signed`
 * is an officer act on a signature record (SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45); `attestation_received` needs the accountant's
 * report on file with its hash (Item 1122(b); auditorReportCheck) except for the 1123 statement, which needs none and may be
 * delivered once signed; `delivered` names the recipient and emits `attestation.package.delivered{kind}` (REGAB_*_PSA_DUE satisfiers).
 */
export function packageTransition(i: PackageTransitionInput): PackageTransitionResult {
  const refuse = (code: string, reason: string): PackageTransitionResult => ({ allowed: false, status: i.from, refusal: { code, reason }, events: [] });
  const allowedNext = i.kind === "regab_1123_statement" && i.from === "assertion_signed" ? ["attestation_received", "delivered"] : NEXT[i.from];
  if (!allowedNext.includes(i.to)) return refuse("REGAB_PACKAGE_ORDER", `${i.from} → ${i.to} is not a step of the attestation state machine (next: ${allowedNext.join(", ") || "none"})`);
  if (i.to === "evidence_compiled" && i.evidence?.complete !== true) {
    const e = i.evidence ?? null;
    const detail = !e ? "no control_evidence binder generated for the package period" : e.controls === 0 ? "no control_matrix rows in scope — the binder has nothing to be complete for" : `${e.missing_controls.length ? `no evidence row for ${e.missing_controls.join(", ")}` : ""}${e.missing_controls.length && e.incomplete_controls.length ? "; " : ""}${e.incomplete_controls.length ? `incomplete at its frequency: ${e.incomplete_controls.join(", ")}` : ""}`;
    return refuse("REGAB_EVIDENCE_INCOMPLETE", `control_evidence is not complete for all control_matrix rows (SM_ATTEST_EVIDENCE_COMPILE_FYE_15): ${detail}`);
  }
  if (i.to === "exceptions_evaluated" && (i.open_exceptions ?? 0) > 0) return refuse("REGAB_EXCEPTIONS_OPEN", `${i.open_exceptions} control exception(s) await an officer disposition — exception omissions are impossible by construction`);
  if (i.to === "material_noncompliance_disclosed" && (i.material_noncompliance_count ?? 0) === 0) return refuse("REGAB_NO_MATERIAL_ITEM", "the material_noncompliance_disclosed branch needs an officer's material-noncompliance determination (rule 18.6-3)");
  if (i.to === "assertion_signed") {
    if (i.actor.kind === "agent") return refuse("REGAB_AGENT_NEVER_SIGNS", "the agent never signs or asserts; management assertions and 1123 statements are officer acts (baseline §8 item 3)");
    const sig = officerSignatureRecord(i.signature);
    if (!sig.present) return refuse("REGAB_ASSERTION_SIGNATURE_RECORD", `assertion_signed is refused without an officer signature record: ${sig.why}`);
    if (i.actor.kind === "human" && i.actor.role !== "officer") return refuse("REGAB_ASSERTION_OFFICER_ONLY", `only the officer records the management assertion (actor role ${i.actor.role ?? "none"})`);
  }
  if (i.to === "attestation_received") { const r = auditorReportCheck({ package_kind: i.kind, report: i.auditor_report }); if (!r.ok) return refuse(r.code!, r.reason!); }
  if (i.to === "delivered" && !(i.delivered_to ?? "").trim()) return refuse("REGAB_DELIVERY_RECIPIENT", "delivered needs the partner / investor / trustee it was delivered to");
  const base = { package_id: i.package_id, kind: i.kind, from: i.from, status: i.to };
  const events: PackageTransitionResult["events"] = [{ type: "attestation.package.status_changed", payload: i.to === "assertion_signed" ? { ...base, signed_by_role: "officer", signed_by_officer_id: i.signature!.officer_id, management_assertion_document_id: i.signature!.document_id } : base }];
  if (i.to === "delivered") events.push({ type: "attestation.package.delivered", payload: { package_id: i.package_id, kind: i.kind, delivered_to: i.delivered_to } });
  return { allowed: true, status: i.to, refusal: null, events };
}

// ============================================================ rule 2: (2)(vii) reconciling items
/**
 * 18.6-T4 / `REGAB_1122_2VII_RECON_ITEMS_90`: a custodial reconciling item on an ABS account must be resolved (§6.3 `cleared`/`posted`/
 * `funded`) within 90 calendar days of the item date (17 CFR 229.1122(d)(2)(vii)); aged 91 days — or resolved late — it is a control
 * exception for criterion 1122.d.2.vii that stays on the list until the officer dispositions it (sev-2 → control exception).
 */
export function reconItemControlException(i: { item_id: string; item_date: PlainDate; as_of: PlainDate; account_id?: string | null; resolved_on?: PlainDate | null; resolved_status?: "cleared" | "posted" | "funded" | null }): { aged_days: number; due: PlainDate; breached: boolean; timer: { code: "REGAB_1122_2VII_RECON_ITEMS_90"; status: "armed" | "satisfied" | "breached" | "satisfied_late" }; exception: ControlException | null } {
  const due = addDays(i.item_date, 90);
  const resolved = i.resolved_on ?? null;
  const aged_days = daysBetween(i.item_date, resolved ?? i.as_of);
  const status = resolved !== null ? (resolved <= due ? "satisfied" : "satisfied_late") : i.as_of > due ? "breached" : "armed";
  const breached = status === "breached" || status === "satisfied_late";
  const exception: ControlException | null = breached ? { finding_id: `TB-REGAB_1122_2VII_RECON_ITEMS_90-${i.item_id}`, criterion: "1122.d.2.vii", severity: "sev2", description: `custodial reconciling item ${i.item_id}${i.account_id ? ` on account ${i.account_id}` : ""} aged ${aged_days} calendar days (> 90) — not resolved within 90 calendar days (17 CFR 229.1122(d)(2)(vii); timer REGAB_1122_2VII_RECON_ITEMS_90 ${status})`, status: "open", officer_disposition: null } : null;
  return { aged_days, due, breached, timer: { code: "REGAB_1122_2VII_RECON_ITEMS_90", status }, exception };
}

export interface TimerBreachInput { readonly timer_code: string; readonly subject_id: string; readonly criterion: string; readonly description: string; readonly severity?: string; }
/**
 * Guardrail (exception omissions impossible by construction): the exception list is every 18.1 finding tagged to a 1122(d) criterion
 * (ops.exceptionList) plus every timer breach linked to a criterion — each row stays until the officer dispositions it.
 */
export function controlExceptions(i: { findings?: readonly { id: string; severity: string; taxonomy_nodes: readonly string[]; description: string }[]; timer_breaches?: readonly TimerBreachInput[]; dispositions?: readonly { finding_id: string; officer_id: string; disposition: string }[] }): ControlException[] {
  const fromFindings = exceptionList({ findings: i.findings ?? [], ...(i.dispositions ? { dispositions: i.dispositions } : {}) });
  const fromTimers = (i.timer_breaches ?? []).map((b): ControlException => {
    const id = `TB-${b.timer_code}-${b.subject_id}`;
    const d = i.dispositions?.find((x) => x.finding_id === id) ?? null;
    return { finding_id: id, criterion: b.criterion, severity: b.severity ?? "sev2", description: b.description, status: d ? "dispositioned" : "open", officer_disposition: d ? { officer_id: d.officer_id, disposition: d.disposition } : null };
  });
  return [...fromFindings, ...fromTimers];
}

// ============================================================ rule 4: assessment period and evidence binder
/** Rule 18.6-4: the assessment period is the *issuer's* fiscal year (PSA), e.g. a June issuer year 2026-07-01..2027-06-30 — not Supermortgage's December year. */
export function assessmentPeriod(issuerFye: PlainDate): { period_start: PlainDate; period_end: PlainDate; basis: "issuer_psa_period" } {
  return { period_start: addDays(addYears(issuerFye, -1), 1), period_end: issuerFye, basis: "issuer_psa_period" };
}

export type ControlFrequency = "monthly" | "quarterly" | "annual" | "event";
const monthKey = (d: PlainDate): string => d.slice(0, 7);
const quarterKey = (d: PlainDate): string => { const p = parts(d); return `${p.y}-Q${Math.floor((p.m - 1) / 3) + 1}`; };
function monthsIn(start: PlainDate, end: PlainDate): string[] {
  const out: string[] = []; const s = parts(start);
  for (let d = ymd(s.y, s.m, 1); d <= end; d = addMonths(d, 1)) out.push(monthKey(d));
  return out;
}
export interface BinderRow { control_code: string; criterion: string; frequency: ControlFrequency; evidence_document_ids: string[]; exceptions_count: number; expected_count: number; missing_periods: string[]; complete: boolean; }
/**
 * `control_evidence.generate(period)` honouring `control_matrix.frequency`: a monthly control (e.g. (2)(vii) reconciliations) needs a
 * document in every month of the window, a quarterly one in every quarter, an annual one at least once per twelve months, an
 * event-driven one at least once; `complete` for all rows is what moves the package to `evidence_compiled`
 * (SM_ATTEST_EVIDENCE_COMPILE_FYE_15). The window is the issuer's period — Supermortgage's FYE is recorded, never applied.
 */
export function controlEvidenceBinder(i: { period_start: PlainDate; period_end: PlainDate; matrix: readonly { control_code: string; criterion: string; frequency?: ControlFrequency }[]; evidence: readonly { control_code: string; occurred_on: PlainDate; document_id: string; exception?: boolean }[]; supermortgage_fye: PlainDate }): { period: { start: PlainDate; end: PlainDate }; fiscal_year_basis: "issuer_psa_period"; supermortgage_fye: PlainDate; rows: BinderRow[]; complete: boolean; incomplete_controls: string[] } {
  const base = generateControlEvidence(i);
  const months = monthsIn(i.period_start, i.period_end);
  const quarters = [...new Set(months.map((m) => quarterKey(`${m}-01` as PlainDate)))];
  const rows: BinderRow[] = base.rows.map((r) => {
    const m = i.matrix.find((x) => x.control_code === r.control_code)!;
    const frequency: ControlFrequency = m.frequency ?? "event";
    const dates = i.evidence.filter((e) => e.control_code === r.control_code && e.occurred_on >= i.period_start && e.occurred_on <= i.period_end).map((e) => e.occurred_on);
    let expected = 1, missing: string[] = [];
    if (frequency === "monthly") { expected = months.length; missing = months.filter((k) => !dates.some((d) => monthKey(d) === k)); }
    else if (frequency === "quarterly") { expected = quarters.length; missing = quarters.filter((k) => !dates.some((d) => quarterKey(d) === k)); }
    else if (frequency === "annual") { expected = Math.max(1, Math.ceil(months.length / 12)); missing = dates.length >= expected ? [] : [`${i.period_start}..${i.period_end}`]; }
    else { expected = 1; missing = dates.length > 0 ? [] : [`${i.period_start}..${i.period_end}`]; }
    return { ...r, frequency, expected_count: expected, missing_periods: missing, complete: missing.length === 0 };
  });
  return { period: base.period, fiscal_year_basis: base.fiscal_year_basis, supermortgage_fye: base.supermortgage_fye, rows, complete: rows.every((r) => r.complete), incomplete_controls: rows.filter((r) => !r.complete).map((r) => r.control_code) };
}

export interface EvidenceCompleteness { period: { start: PlainDate; end: PlainDate }; controls: number; complete: boolean; missing_controls: string[]; incomplete_controls: string[]; latest: { control_code: string; criterion: string; complete: boolean; generated_at: string }[]; }
/**
 * SM_ATTEST_EVIDENCE_COMPILE_FYE_15 "satisfied by: `control_evidence` complete for all matrix rows" — read from the stores, never from a
 * caller's flag: for the package's period every in-scope `control_matrix` row (all rows, or those whose criterion is in the package's
 * `criteria_scope`) must have a `control_evidence` row for exactly that window whose latest generation is `complete` at the control's
 * frequency (controlEvidenceBinder). No matrix rows, or no binder for the period, is not complete — an empty binder proves nothing.
 */
export function evidenceCompleteness(i: { period_start: PlainDate; period_end: PlainDate; matrix: readonly { control_code: string; criterion: string }[]; criteria_scope?: readonly string[]; evidence: readonly { control_code: string; criterion?: string; period_start: PlainDate; period_end: PlainDate; complete: boolean; generated_at: string }[] }): EvidenceCompleteness {
  const scope = i.criteria_scope ?? [];
  const rows = [...new Map(i.matrix.filter((m) => scope.length === 0 || scope.includes(m.criterion)).map((m) => [m.control_code, m] as const)).values()];
  const latest = rows.map((m) => i.evidence.filter((e) => e.control_code === m.control_code && e.period_start === i.period_start && e.period_end === i.period_end).sort((a, b) => (a.generated_at < b.generated_at ? 1 : a.generated_at > b.generated_at ? -1 : 0))[0] ?? null);
  const missing = rows.filter((_, k) => latest[k] === null).map((m) => m.control_code);
  const incomplete = rows.filter((_, k) => latest[k] !== null && latest[k]!.complete !== true).map((m) => m.control_code);
  return { period: { start: i.period_start, end: i.period_end }, controls: rows.length, complete: rows.length > 0 && missing.length === 0 && incomplete.length === 0, missing_controls: missing, incomplete_controls: incomplete,
    latest: latest.flatMap((e, k) => (e ? [{ control_code: rows[k]!.control_code, criterion: rows[k]!.criterion, complete: e.complete === true, generated_at: e.generated_at }] : [])) };
}

/**
 * Guardrail "exception omissions are impossible by construction (every 18.1 finding tagged to a criterion appears in the exception
 * list until dispositioned by the officer)": the register is the union of (a) every `qc_findings` row carrying a 1122(d) criterion in
 * its taxonomy (ops.exceptionList — no one has to "record" it) and (b) every recorded `control_exceptions` row (timer breaches, and
 * findings recorded explicitly); a row is `dispositioned` only by the officer's recorded disposition, never by omission.
 */
export function exceptionRegister(i: { findings: readonly { id: string; severity: string; taxonomy_nodes: readonly string[]; description: string }[]; recorded: readonly ControlException[] }): { register: ControlException[]; open: ControlException[] } {
  const dispositions = i.recorded.filter((r) => r.status === "dispositioned" && r.officer_disposition).map((r) => ({ finding_id: r.finding_id, officer_id: r.officer_disposition!.officer_id, disposition: r.officer_disposition!.disposition }));
  const byId = new Map<string, ControlException>();
  for (const x of exceptionList({ findings: i.findings, dispositions })) byId.set(x.finding_id, x);
  for (const r of i.recorded) { const cur = byId.get(r.finding_id); if (!cur) byId.set(r.finding_id, r); else if (cur.status === "open" && r.status === "dispositioned") byId.set(r.finding_id, { ...cur, status: "dispositioned", officer_disposition: r.officer_disposition }); }
  const register = [...byId.values()];
  return { register, open: register.filter((x) => x.status === "open") };
}

// ============================================================ §6.3 bridge: the Reg AB view of a custodial reconciling item
/**
 * The subject of REGAB_1122_2VII_RECON_ITEMS_90 is the *item*, never the account: the timer engine satisfies every open clock on the
 * same subject, so a clock keyed to the custodial-account aggregate would let the resolution of one item satisfy every other item's
 * clock on that account — an item aged 91 days with no breach and no control exception, the omission 18.6-T4 and the guardrail
 * forbid. The Reg AB view events therefore carry a per-item aggregate, and §6.3's `reconciliation_item.resolved` is re-keyed to it.
 */
export const RECON_ITEM_SUBJECT = "regab_reconciling_item" as const;
export const reconItemSubject = (item_id: string): { kind: typeof RECON_ITEM_SUBJECT; id: string } => ({ kind: RECON_ITEM_SUBJECT, id: item_id });
export interface ReconItemOpened { readonly type: "regab.reconciling_item.opened"; readonly aggregate: { readonly kind: typeof RECON_ITEM_SUBJECT; readonly id: string }; readonly payload: { item_id: string; account_id: string | null; item_date: PlainDate; program_id: string | null; regab_applicable: boolean; basis: string; source_event_id: string }; }
/**
 * `REGAB_1122_2VII_RECON_ITEMS_90` triggers on "custodial reconciling item aged" (item date). §6.3's `reconciliation_item.opened`
 * (bank.read_statement: `{category, kind, file_id, first_seen_on}` on the custodial-account aggregate) knows nothing of Reg AB, so
 * the attestation module derives the Reg AB view: the item date is `first_seen_on` (else the event date), the account is the
 * aggregate, and `regab_applicable` is the account's investor program's flag (Item 1122(d)(2)(vii) covers "all ABS bank accounts";
 * 18.6-T1: a Fannie Mae account never starts a REGAB_* clock). An account mapped to no program is not applicable — §6.3's own
 * SM_RECON_ITEM_AGE_* clocks still age it. The view is keyed to the item (reconItemSubject) so each item runs its own 90-day clock.
 */
export function classifyReconItem(i: { source_event_id: string; item_id: string; account_id: string | null; first_seen_on: PlainDate | null; event_date: PlainDate; program: { id: string; regab_applicable: boolean } | null }): ReconItemOpened {
  const basis = i.program ? (i.program.regab_applicable ? `account ${i.account_id} belongs to registered-ABS program ${i.program.id} (17 CFR 229.1122(d)(2)(vii))` : `account ${i.account_id} belongs to program ${i.program.id}, which is not regab_applicable (rule 18.6-1)`) : `account ${i.account_id ?? "(none)"} is mapped to no investor program — §6.3 aging only`;
  return { type: "regab.reconciling_item.opened", aggregate: reconItemSubject(i.item_id), payload: { item_id: i.item_id, account_id: i.account_id, item_date: i.first_seen_on ?? i.event_date, program_id: i.program?.id ?? null, regab_applicable: i.program?.regab_applicable === true, basis, source_event_id: i.source_event_id } };
}

export interface ReconItemResolved { readonly type: "regab.reconciling_item.resolved"; readonly aggregate: { readonly kind: typeof RECON_ITEM_SUBJECT; readonly id: string }; readonly payload: { item_id: string; account_id: string | null; status: string; source_event_id: string }; }
/**
 * "Satisfied by: item resolved (Section 6.3)" — §6.3's `reconciliation_item.resolved{item_id, status}` is emitted on the
 * custodial-account aggregate (or on none, from `ledger.post_reclass` / the shortage funding), so the module re-keys it to the item's
 * own subject; only `cleared` / `posted` / `funded` satisfy (the override's pattern), and only for an item the module classified as
 * Reg AB applicable (`tracked`) — a Fannie Mae item's resolution produces no Reg AB event at all.
 */
export function reconItemResolvedView(i: { source_event_id: string; item_id: string; account_id: string | null; status: string; tracked: boolean }): ReconItemResolved | null {
  if (!i.tracked || !i.item_id) return null;
  return { type: "regab.reconciling_item.resolved", aggregate: reconItemSubject(i.item_id), payload: { item_id: i.item_id, account_id: i.account_id, status: i.status, source_event_id: i.source_event_id } };
}

// ============================================================ rule 1 (continued): the recorded determination governs the cycle
export interface RecordedProgram { readonly id: string; readonly program_kind: ProgramKind; readonly psa_assessment_days: number | null; readonly psa_statement_days: number | null; readonly usap_requested: boolean; readonly criteria_applicable: readonly string[]; readonly partner_entity: string | null; }
/**
 * Prerequisite "Applicability determination recorded per investor/pool: registry `investor_programs` with `regab_applicable` flag,
 * PSA deliverable dates, criteria applicability list" and rule 18.6-1 ("run at each investor onboarding"): the attestation cycle
 * reads the *recorded* determination — a caller's `program_kind`, PSA days, `usap_requested` or criteria are never taken over the
 * record (a stored `fnma_mbs` program opened as `private_abs_registered` would arm REGAB_* clocks the record says do not apply;
 * the reverse would silence them). A restatement equal to the record is tolerated; a conflicting one is refused by name.
 */
export function applicabilityConflicts(stored: RecordedProgram, requested: { program_kind?: string | null; psa_assessment_days?: number | null; psa_statement_days?: number | null; usap_requested?: boolean | null; criteria_scope?: readonly string[] | null }): string[] {
  const out: string[] = [];
  if (requested.program_kind != null && requested.program_kind !== "" && requested.program_kind !== stored.program_kind) out.push(`program_kind ${requested.program_kind} conflicts with the recorded applicability determination of ${stored.id} (${stored.program_kind}, rule 18.6-1)`);
  if (requested.psa_assessment_days != null && requested.psa_assessment_days !== (stored.psa_assessment_days ?? 60)) out.push(`psa_assessment_days ${requested.psa_assessment_days} conflicts with the recorded PSA deliverable rule of ${stored.id} (${stored.psa_assessment_days ?? "default FYE + 60"})`);
  if (requested.psa_statement_days != null && requested.psa_statement_days !== (stored.psa_statement_days ?? stored.psa_assessment_days ?? 60)) out.push(`psa_statement_days ${requested.psa_statement_days} conflicts with the recorded PSA deliverable rule of ${stored.id} (${stored.psa_statement_days ?? stored.psa_assessment_days ?? "default FYE + 60"})`);
  if (requested.usap_requested != null && requested.usap_requested !== stored.usap_requested) out.push(`usap_requested ${requested.usap_requested} conflicts with the recorded determination of ${stored.id} (${stored.usap_requested})`);
  if (requested.criteria_scope && requested.criteria_scope.length && stored.criteria_applicable.length) { const extra = requested.criteria_scope.filter((c) => !stored.criteria_applicable.includes(c)); const dropped = stored.criteria_applicable.filter((c) => !requested.criteria_scope!.includes(c)); if (extra.length || dropped.length) out.push(`criteria_scope differs from the recorded criteria applicability list of ${stored.id} (Instruction 2)${extra.length ? `: not recorded ${extra.join(", ")}` : ""}${dropped.length ? `; omits ${dropped.join(", ")}` : ""}`); }
  return out;
}

// ============================================================ rule 4 (continued): evidence is documents on file
/**
 * "Evidence binders with hashes" / Integrations "exports with hashes": a binder row may only cite `documents` on file — a document id
 * the caller asserts is not evidence. Returns the ids missing from `documents` and the hash of each cited document.
 */
export function evidenceDocumentsOnFile(evidence: readonly { document_id: string }[], documents: readonly { id: string; sha256: string | null }[]): { missing: string[]; sha256: Record<string, string | null> } {
  const byId = new Map(documents.map((d) => [d.id, d.sha256] as const));
  const ids = [...new Set(evidence.map((e) => e.document_id))];
  return { missing: ids.filter((id) => !id || !byId.has(id)), sha256: Object.fromEntries(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id) ?? null])) };
}

// ============================================================ warning at FYE + 30
/**
 * REGAB_1122_ASSESSMENT_PSA_DUE "per PSA (default FYE + 60 days); warning at FYE + 30": the registry carries one deadline row, so the
 * warning is a behaviour of the module — on or after `warning_on`, while the 1122 assessment package is not yet delivered and no
 * warning has been raised for the cycle, the officer is escalated (breach column: sev-1 → `officer` + partner).
 */
export function assessmentWarning(i: { warning_on: PlainDate; due: PlainDate; as_of: PlainDate; delivered: boolean; already_raised: boolean }): { raise: boolean; reason: string } {
  if (i.delivered) return { raise: false, reason: "assessment + attestation already delivered" };
  if (i.already_raised) return { raise: false, reason: "warning already raised for this cycle" };
  if (i.as_of < i.warning_on) return { raise: false, reason: `warning date ${i.warning_on} (FYE + 30) not reached` };
  return { raise: true, reason: `FYE + 30 warning: 1122 assessment + attestation due ${i.due} (REGAB_1122_ASSESSMENT_PSA_DUE) not yet delivered as of ${i.as_of}` };
}

// ============================================================ rule 3: assessment text and material noncompliance
export interface MaterialNoncomplianceItem { readonly criterion: string; readonly description: string; readonly determined_on: PlainDate; readonly involves_pool_asset_servicing: boolean; }

/**
 * 17 CFR 229.1122(a): the assessment report states (1) the party's responsibility for assessing compliance,
 * (2) that the paragraph (d) criteria were used, (3) the assessment for the period "including … disclosure of
 * any material instance of noncompliance" (and, Instruction 2, the criteria found inapplicable), and (4) that a
 * registered public accounting firm has issued an attestation report. Every material item is in the text by construction.
 */
export function assessmentReport(i: { entity: string; period_start: PlainDate; period_end: PlainDate; criteria_scope: readonly string[]; inapplicable_criteria?: readonly { criterion: string; rationale: string }[]; material_noncompliance: readonly MaterialNoncomplianceItem[]; attestation_firm: string | null }): { statements: { responsibility: string; criteria_used: string; assessment: string; attestation: string }; material_noncompliance: MaterialNoncomplianceItem[]; form_10k_disclosure: boolean; text: string; complete: boolean; refusal: string | null } {
  const items = [...i.material_noncompliance];
  const disclosed = items.length === 0
    ? "no material instance of noncompliance was identified"
    : `the following material instance${items.length > 1 ? "s" : ""} of noncompliance ${items.length > 1 ? "were" : "was"} identified: ${items.map((m) => `criterion ${m.criterion} — ${m.description} (determined ${m.determined_on}; ${m.involves_pool_asset_servicing ? "involves" : "does not involve"} the servicing of the assets backing the asset-backed securities)`).join("; ")}`;
  const inapplicable = (i.inapplicable_criteria ?? []).map((x) => `${x.criterion} (${x.rationale})`);
  const statements = {
    responsibility: `${i.entity} is responsible for assessing compliance with the servicing criteria applicable to it (17 CFR 229.1122(a)(1)).`,
    criteria_used: `${i.entity} used the criteria in paragraph (d) of Item 1122 (17 CFR 229.1122(d)) to assess compliance with the applicable servicing criteria: ${i.criteria_scope.join(", ")}.${inapplicable.length ? ` Criteria inapplicable to ${i.entity} (Instruction 2): ${inapplicable.join("; ")}.` : ""}`,
    assessment: `For the period ${i.period_start} through ${i.period_end}, ${disclosed}.`,
    attestation: i.attestation_firm ? `A registered public accounting firm, ${i.attestation_firm}, has issued an attestation report on ${i.entity}'s assessment of compliance with the applicable servicing criteria as of and for the period ${i.period_start} through ${i.period_end} (17 CFR 229.1122(a)(4), (b)).` : "",
  };
  const complete = i.attestation_firm !== null;
  return { statements, material_noncompliance: items, form_10k_disclosure: items.length > 0, text: [statements.responsibility, statements.criteria_used, statements.assessment, statements.attestation].filter(Boolean).join("\n"), complete, refusal: complete ? null : "assessment report is not deliverable until the registered public accounting firm's attestation report is received (17 CFR 229.1122(a)(4))" };
}

/**
 * Rule 18.6-5: the Item 1123 sub-certification Supermortgage furnishes the partner's officer — the servicing obligations under the
 * PSA and every known failure (nature and status) — so the partner's statement "in all material respects throughout the reporting
 * period" rests on documented review (17 CFR 229.1123). Drafted by the agent, signed only by the officer.
 */
export function subCertification(i: { entity: string; partner_entity: string; period_start: PlainDate; period_end: PlainDate; psa_obligations: readonly string[]; known_failures: readonly { obligation: string; nature: string; status: string }[] }): { text: string; fulfilled_in_all_material_respects: boolean; failures_listed: number; signature_required_from: "officer" } {
  const failures = i.known_failures.length === 0
    ? `${i.entity} has fulfilled its obligations under the pooling and servicing agreement in all material respects throughout the reporting period.`
    : `${i.entity} has fulfilled its obligations under the pooling and servicing agreement in all material respects throughout the reporting period except as follows: ${i.known_failures.map((f) => `${f.obligation} — ${f.nature} (status: ${f.status})`).join("; ")}.`;
  return { text: `Sub-certification to ${i.partner_entity} for its Item 1123 servicer compliance statement (17 CFR 229.1123), period ${i.period_start} through ${i.period_end}. A review of ${i.entity}'s activities during the reporting period and of its performance under the servicing obligations listed below was conducted under the supervision of the undersigned officer. Obligations: ${i.psa_obligations.join("; ")}. ${failures}`, fulfilled_in_all_material_respects: i.known_failures.length === 0, failures_listed: i.known_failures.length, signature_required_from: "officer" };
}

/**
 * Rule 18.6-3 end to end: an officer's material-noncompliance determination arms
 * `SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD` (determination + 1 BD), puts the item into the assessment text and
 * is satisfied only by `partner.notified{reason=material_noncompliance}` on or before the due date.
 */
export function materialNoncomplianceDisclosure(i: { determined_on: PlainDate; criterion: string; description: string; determined_by_role: string; counsel_advice_document_id: string | null; involves_pool_asset_servicing?: boolean; partner_notified_on?: PlainDate | null; cal?: Calendar }): { allowed: boolean; refusal: string | null; item: MaterialNoncomplianceItem | null; timer: { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD"; anchor: PlainDate; due: PlainDate; satisfied_by: "partner.notified{reason=material_noncompliance}"; status: "armed" | "satisfied" | "breached" } | null; assessment_text: string | null; escalations: { kind: "officer" | "attorney"; reason: string }[] } {
  const d = materialNoncompliance({ determined_on: i.determined_on, criterion: i.criterion, description: i.description, determined_by_role: i.determined_by_role, counsel_advice_document_id: i.counsel_advice_document_id, ...(i.cal ? { cal: i.cal } : {}) });
  if (!d.allowed || !d.partner_notice) return { allowed: false, refusal: d.refusal, item: null, timer: null, assessment_text: null, escalations: [{ kind: "officer", reason: "material noncompliance is an officer determination on counsel's advice (rule 18.6-3)" }, { kind: "attorney", reason: "materiality / disclosure advice (17 CFR 229.1122(c))" }] };
  const notified = i.partner_notified_on ?? null;
  const status: "armed" | "satisfied" | "breached" = notified === null ? "armed" : notified <= d.partner_notice.due ? "satisfied" : "breached";
  const item: MaterialNoncomplianceItem = { criterion: i.criterion, description: i.description, determined_on: i.determined_on, involves_pool_asset_servicing: i.involves_pool_asset_servicing ?? true };
  return { allowed: true, refusal: null, item, timer: { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", anchor: i.determined_on, due: d.partner_notice.due, satisfied_by: "partner.notified{reason=material_noncompliance}", status }, assessment_text: d.assessment_text, escalations: status === "breached" ? [{ kind: "officer", reason: `partner not notified by ${d.partner_notice.due} (SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD sev-1)` }] : [] };
}
