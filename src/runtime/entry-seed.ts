/**
 * Demo seed for the entry experience (32.14) — FAKE, nonprod only. What the anonymous minute needs on a fresh database:
 *
 *   1. 31.1 readiness rows for the demo states — a state with no rows is `matrix_unverified` and CLOSED (fail-closed), so
 *      without them every visitor hits the state gate (`licensing.gate.blocked`) and no range ever renders: two verified
 *      `license_requirements` per state (the partner lends under a state licence; Supermortgage needs no processing credential),
 *      the partner's approved lender licence, and one assignable `mlo_roster` member (32.14 §2 S1 rule 7 / 31.1).
 *   2. The partner's NMLSR ID on the global `partners/<partner_id>` row — 20.2's §1026.24 checklist requires it beside a rate
 *      (`state.nmls_id_present`); without it `lead.requestRange` refuses RANGE_CONTENT_CHECK.
 *   3. An active 20.4 rate sheet (`rs-FAKE-demo-…`, FAKE prices) — 20.3 rule 7's published range is the sheet's low–high.
 *   4. What the daily refinance check (src/runtime/refi-daily.ts) needs to run on the demo book: the partner's 20.1 program
 *      (`prog-refi-<partner>`, the data-model defaults), 20.4's LLPA matrix 09.09.2026 staged and activated, and one FAKE
 *      LCOR cost schedule (20.1 worked example 1's $3,485 of third-party costs) approved by a FAKE officer.
 *
 * Idempotent: a row that exists is left alone; a sheet is published only when none is active at `now`. Runs from
 * `main.ts seed-demo` after the demo transfer batch and from `POST /v1/entry/seed-demo` (ops token). Never in production.
 */
import { plainDate as D } from "../kernel/calendar/date.ts";
import type { Actor } from "../kernel/events/types.ts";
import { EntityStore } from "../app/tools.ts";
import { entryPartner } from "./borrower/partner.ts";
import { newLicense, type LicenseRequirement, type MloRosterMember } from "../domain/governance/ops-31-1.ts";
import { activeSheetAt, type RateSheet } from "../domain/leads-pricing/ops-20-4.ts";
import { fakeDemoPrices as fakeFeedPrices } from "../infra/integrations/rates.ts";
import type { Runtime } from "./app.ts";

export const DEMO_ENTRY_STATES = ["AZ", "CA", "CO", "UT", "TX", "FL", "WA", "NV"] as const;
/** FAKE: the demo partner's NMLSR ID (numeric, as the 20.2 checklist expects). */
export const FAKE_PARTNER_NMLSR_ID = "123456";
const SEED_ACTOR: Actor = { kind: "system", id: "seed-demo" };
const PRICING_AGENT: Actor = { kind: "agent", id: "pricing" };

export interface EntrySeedOptions { readonly states?: readonly string[]; readonly partner_id?: string | null; readonly nmlsr_id?: string; readonly now?: string }
export interface EntrySeedResult { readonly partner_id: string; readonly partner_name: string; readonly states: readonly string[]; readonly written: readonly string[]; readonly rate_sheet_id: string | null; readonly rate_sheet_published: boolean; /** the daily refinance check's prerequisites written on this run (program / matrix / cost schedule ids) */ readonly refi: readonly string[] }

/** FAKE demo prices: a 30-year and a 15-year fixed grid, 45-day locks (the shape of the fixtures' `grid45`) — the FAKE rate feed's grid (src/infra/integrations/rates.ts). */
export function fakeDemoPrices(): readonly Record<string, unknown>[] { return fakeFeedPrices().map((p) => ({ ...p })); }
/** FAKE: 20.1 worked example 1's AZ LCOR third-party costs ($3,485.00) as 20.4's cost schedule items. */
export const FAKE_COST_ITEMS: readonly Record<string, unknown>[] = [
  ["credit_report", "Credit report", "CreditReportFee", "B_cannot_shop", "CRA", "8400", "creditor_selected_third_party", false], ["appraisal_hybrid", "Hybrid appraisal / PDC", "AppraisalFee", "B_cannot_shop", "AMC", "45000", "creditor_selected_third_party", false],
  ["flood_determination", "Flood determination", "FloodCertification", "B_cannot_shop", "FloodCo", "1000", "creditor_selected_third_party", false], ["title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "FAKE Title", "165000", "list_provider", true],
  ["settlement_agent_fee", "Settlement fee", "TitleSettlementAgentFee", "C_can_shop", "FAKE Title", "95000", "list_provider", true], ["recording_fee", "Recording", "RecordingFeeForDeed", "E_taxes_gov", "County", "6100", "government", false], ["ron_enote", "eNote / RON", "NotaryFee", "B_cannot_shop", "RON vendor", "28000", "creditor_selected_third_party", false],
].map(([fee_code, description, mismo_fee_type, le_section, vendor, amount_cents, provider_source, shoppable]) => ({ fee_code, description, mismo_fee_type, le_section, vendor, amount_cents: BigInt(String(amount_cents)), provider_source, shoppable }));   // bigint cents: an in-process execute is not the HTTP path's `*_cents` revival
export const FAKE_COST_SCHEDULE_ID = "cs-FAKE-lcor-hybrid";
export const FAKE_LLPA_MATRIX_VERSION = "09.09.2026";
const SEED_OFFICER: Actor = { kind: "human", id: "seed-demo", role: "officer" };
const INTAKE_AGENT: Actor = { kind: "agent", id: "intake" };

const requirement = (st: string, applies_to: "partner" | "sm", activity: LicenseRequirement["activity"], kind: LicenseRequirement["requirement_kind"], code: string | null, on: string): LicenseRequirement =>
  ({ requirement_id: `R-${st}-${applies_to}-${activity}`, jurisdiction: st, activity, applies_to, requirement_kind: kind, license_type_code: code, citation: `${st} statute (FAKE demo seed)`, quoted_text: "FAKE demo seed — verified for the demo environment only",
    verification_status: "verified", verified_at: D(on), verified_by: "seed-demo", source_url: null, effective_from: D(on), superseded_by: null });

/** The demo partner: the configured default, else the newest servicer party, else a FAKE one is created. */
async function resolvePartner(runtime: Runtime, partnerId: string | null | undefined): Promise<{ id: string; legal_name: string }> {
  // partner.ts: the configured partner, else the newest servicer party that is not Supermortgage itself (the batch's own party is the subservicer, never the lender)
  const found = await entryPartner(runtime.db, partnerId ?? undefined);
  if (found) return found;
  const made = await runtime.db.query<{ id: string; legal_name: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id, legal_name`, ["Partner Bank (FAKE demo)"]);
  return made[0]!;
}

export async function seedEntryDemo(runtime: Runtime, opts: EntrySeedOptions = {}): Promise<EntrySeedResult> {
  const now = opts.now ?? runtime.clock.now(); const on = now.slice(0, 10);
  const states = [...(opts.states ?? DEMO_ENTRY_STATES)].map((s) => s.toUpperCase());
  const partner = await resolvePartner(runtime, opts.partner_id ?? process.env["BORROWER_DEFAULT_PARTNER_ID"]);
  const nmlsr = opts.nmlsr_id ?? FAKE_PARTNER_NMLSR_ID;

  // 1 + 2: global entity rows, written only where absent (the runtime's own global-scope save path: src/runtime/app.ts executeDef)
  const store = new EntityStore(); store.seed(await runtime.entities.load({}));
  const mark = store.versionCount(); const written: string[] = [];
  const put = (kind: string, id: string, data: Record<string, unknown>): void => { if (store.get(kind, id)) return; store.put(kind, id, data, SEED_ACTOR, now); written.push(`${kind}/${id}`); };
  for (const st of states) {
    for (const r of [requirement(st, "partner", "lend", "license", `${st}_MORTGAGE_BANKER`, on), requirement(st, "sm", "processing_underwriting_entity", "none", null, on)]) put("license_requirements", r.requirement_id, { ...r });
    const l = newLicense({ license_id: `L-${st}-PARTNER`, holder_kind: "partner_company", holder_ref: partner.id, jurisdiction: st, license_type_code: `${st}_MORTGAGE_BANKER`, activity_scope: ["lend"], status: "approved",
      issued_at: D(`${Number(on.slice(0, 4)) - 1}-01-15`), expires_at: D(`${Number(on.slice(0, 4)) + 1}-12-31`), evidence_document_id: "DOC-FAKE-DEMO-LICENCE", nmls_status_raw: "Approved" });
    put("licenses", l.license_id, { ...l } as unknown as Record<string, unknown>);
  }
  const mlo: MloRosterMember = { mlo_id: "M-FAKE-DEMO", person_id: "p-fake-demo", name: "A. Lee (FAKE demo MLO)", nmls_id: "222333", employer: "partner", sponsor_license_id: `L-${states[0] ?? "AZ"}-PARTNER`, state_licenses: [], states_assignable: states, lo_comp_plan_id: null, capacity_per_day: 20, status: "active", assignable: true, open_queue: 0 };
  // both spellings the platform reads today (31.1 writes nmls_id / state_licenses / status; 21.1, 32.11 and the 32.14 S4 flow read nmlsr_id / licensed_states / nmls_status ∈ {active, inactive} — 21.1's MloRosterEntry; a recorded follow-up)
  put("mlo_roster", mlo.mlo_id, { ...mlo, nmlsr_id: mlo.nmls_id, licensed_states: states, nmls_status: "active" });
  put("partners", partner.id, { partner_id: partner.id, legal_name: partner.legal_name, nmlsr_id: nmlsr, fake: true });
  if (written.length) await runtime.uow.run({}, async () => undefined, { clock: runtime.clock, commit: async (q) => { await runtime.entities.save(store.versionsSince(mark), {}, q); } });

  // 3: the FAKE rate sheet through 20.4's own publish (supersedes any earlier active sheet only when none is active now)
  const sheets = store.list("rate_sheets").map((r) => r.data as unknown as RateSheet);
  const active = activeSheetAt(sheets, now);
  let rate_sheet_id: string | null = active?.rate_sheet_id ?? null; let published = false;
  if (!active) {
    rate_sheet_id = `rs-FAKE-demo-${on}`;
    const expires = new Date(Date.parse(now) + 30 * 24 * 3600 * 1000).toISOString();
    await runtime.execute({ process: "20.4", name: "publishRateSheet", loanId: "", actor: PRICING_AGENT, input: { rate_sheet_id, partner_id: partner.id, source: "pe_whole_loan_api", published_at: now, expires_at: expires, prices: fakeDemoPrices(), published_by: "seed-demo (FAKE feed)" } });
    published = true;
  }
  // 4: the daily refinance check's prerequisites, each through its own 20.x tool, only where absent
  const refi: string[] = [];
  const programId = `prog-refi-${partner.id.slice(0, 8)}`;
  if (!store.list("partner_programs").some((r) => r.data.partner_id === partner.id)) { await runtime.execute({ process: "20.1", name: "loadUniverse", loanId: "", actor: INTAKE_AGENT, input: { op: "register_program", program: { program_id: programId, partner_id: partner.id, effective_from: on, approved_by: "human:seed-demo (FAKE officer)" } } }); refi.push(`partner_programs/${programId}`); }
  if (!store.get("llpa_tables", `llpa-${FAKE_LLPA_MATRIX_VERSION}`)) { await runtime.execute({ process: "20.4", name: "loadLlpaTable", loanId: "", actor: PRICING_AGENT, input: { op: "stage", matrix_version: FAKE_LLPA_MATRIX_VERSION, activate: true } }); refi.push(`llpa_tables/llpa-${FAKE_LLPA_MATRIX_VERSION}`); }
  if (!store.get("sm_cost_schedules", FAKE_COST_SCHEDULE_ID)) { await runtime.execute({ process: "20.4", name: "buildFeeItems", loanId: "", actor: SEED_OFFICER, input: { op: "cost_schedule", cost_schedule_id: FAKE_COST_SCHEDULE_ID, partner_id: partner.id, state: states[0] ?? "AZ", transaction_type: "limited_cash_out", valuation_method: "hybrid", items: FAKE_COST_ITEMS, effective_from: on, approved_by: "human:seed-demo (FAKE officer)" } }); refi.push(`sm_cost_schedules/${FAKE_COST_SCHEDULE_ID}`); }
  return { partner_id: partner.id, partner_name: partner.legal_name, states, written, rate_sheet_id, rate_sheet_published: published, refi };
}
