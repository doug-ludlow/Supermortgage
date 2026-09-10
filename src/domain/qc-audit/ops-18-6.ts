/**
 * §18.6 Reg AB / USAP attestation — operating rules layered over ./regab.ts and
 * the 18.6 block of ./ops.ts (exceptionList, removeException,
 * generateControlEvidence, materialNoncompliance): the issuer-year assessment
 * period (rule 4), the Item 1122(a) assessment report text that carries every
 * material instance of noncompliance (rule 3 / 17 CFR 229.1122(a)), and the
 * partner-notice outcome that satisfies `SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD`.
 * One small pure function per rule; no I/O.
 */
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import { type Calendar } from "../../kernel/calendar/business.ts";
import { materialNoncompliance } from "./ops.ts";

/** Rule 18.6-4: the assessment period is the *issuer's* fiscal year (PSA), e.g. a June issuer year 2026-07-01..2027-06-30 — not Supermortgage's December year. */
export function assessmentPeriod(issuerFye: PlainDate): { period_start: PlainDate; period_end: PlainDate; basis: "issuer_psa_period" } {
  return { period_start: addDays(addYears(issuerFye, -1), 1), period_end: issuerFye, basis: "issuer_psa_period" };
}

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
