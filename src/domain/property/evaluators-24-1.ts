/**
 * §24.1 gate evaluators, keyed "24.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-24-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Each evaluator is a thin adapter over the pure gate functions in ops-24-1.ts, so the `consummate` / assignment /
 * order guards and the timer engine assert the same rule from the same facts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { amcRegistrationGate, appraisalAge12mGate, appraiserLicenseGate, pdcSubmitGate, uad36RequiredForSubmission, type LicenseType } from "./ops-24-1.ts";

const d = (f: Record<string, unknown>, k: string): PlainDate | null => (typeof f[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f[k] as string) ? plainDate(f[k] as string) : null);
const need = (f: Record<string, unknown>, k: string): PlainDate => { const v = d(f, k); if (!v) throw new RangeError(`${k} (PlainDate) is required`); return v; };

export const EVALUATORS_24_1: Record<string, Evaluator> = {
  /** FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE — facts: property_data_id_fnma, accepted_on, collected_on?, note_date. The Property Data ID must be held before the note date (B4-1.4-11). */
  "24.1.pdcApiSubmitGate": (f) => {
    const r = pdcSubmitGate({ property_data_id_fnma: f.property_data_id_fnma ? s(f, "property_data_id_fnma") : null, accepted_on: d(f, "accepted_on"), collected_on: d(f, "collected_on"), note_date: need(f, "note_date") });
    return r.open ? ok : no(r.reason!);
  },
  /** FNMA_B4_1_2_04_APPRAISAL_12M — facts: effective_date, note_date. effective_date + 12 months > note date (B4-1.2-04). */
  "24.1.appraisalAge12mGate": (f) => {
    const r = appraisalAge12mGate(need(f, "effective_date"), need(f, "note_date"));
    return r.open ? ok : no(r.reason!);
  },
  /** FNMA_UAD_3_6_REQUIRED_GATE — facts: uad_version (engaged), first_ucdp_submission_on, deliverable_uad_version?. Reports first submitted to UCDP on/after Nov 2, 2026 must be UAD 3.6 (FNM0391). */
  "24.1.uad36RequiredGate": (f) => {
    const first = d(f, "first_ucdp_submission_on");
    const required = s(f, "uad_version") === "3.6" || (first !== null && uad36RequiredForSubmission(first));
    if (!required) return ok;
    if (s(f, "uad_version") !== "3.6") return no(`FNMA_UAD_3_6_REQUIRED_GATE: first UCDP submission ${first} is on/after 2026-11-02 — the engagement must specify UAD 3.6 (engaged ${s(f, "uad_version") || "none"})`);
    const delivered = f.deliverable_uad_version === undefined || f.deliverable_uad_version === null ? null : s(f, "deliverable_uad_version");
    return delivered === null || delivered === "3.6" ? ok : no(`FNM0391: This appraisal report was submitted in UAD ${delivered} format and is not accepted. As of November 2, 2026, all new UCDP submissions must be in UAD 3.6 format`);
  },
  /** SM_APPRAISER_LICENSE_GATE — facts: party_id, license_state, license_type, license_number, license_expires_on, asc_registry_status, asc_registry_checked_on, panel_status?, property_state, on. */
  "24.1.appraiserLicenseGate": (f) => {
    const r = appraiserLicenseGate({ party_id: s(f, "party_id") || "appraiser", license_state: s(f, "license_state"), license_type: (s(f, "license_type") || "licensed") as LicenseType, license_number: s(f, "license_number"), license_expires_on: need(f, "license_expires_on"),
      asc_registry_status: (s(f, "asc_registry_status") || "unknown") as "active" | "inactive" | "revoked" | "suspended" | "unknown", asc_registry_checked_on: need(f, "asc_registry_checked_on"), ...(f.panel_status ? { panel_status: s(f, "panel_status") as "active" | "suspended" | "removed" } : {}) }, s(f, "property_state"), need(f, "on"));
    return r.open ? ok : no(r.reason!);
  },
  /** SM_AMC_REGISTRATION_GATE — facts: registered (boolean), amc_registration_id, amc_party_id, state, registration_number, expires_on, asc_amc_registry_status, verified_at, property_state, on. */
  "24.1.amcRegistrationGate": (f) => {
    const r = amcRegistrationGate(b(f, "registered") ? { amc_registration_id: s(f, "amc_registration_id"), amc_party_id: s(f, "amc_party_id"), state: s(f, "state"), registration_number: s(f, "registration_number"), expires_on: need(f, "expires_on"), asc_amc_registry_status: (s(f, "asc_amc_registry_status") || "unknown") as "active" | "inactive" | "unknown", verified_at: s(f, "verified_at") } : null, s(f, "property_state"), need(f, "on"));
    return r.open ? ok : no(r.reason!);
  },
};
export const kit_24_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
