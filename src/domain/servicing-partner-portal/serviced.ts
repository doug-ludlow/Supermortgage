/**
 * 36.6 — the post-refinance serviced pane contract, dark in V1 (spec/sections/36-servicing-partner-portal/
 * 36-6-post-refinance-serviced-pane-contract.md). A contract, not a feature: the one code every unbuilt module answers
 * (rule 1), the modules V2 will hold and the section each reads and never writes (rule 2), the attach condition (rule 3)
 * and the one disabled Serviced tab's copy (rule 4). No I/O, no figure, no chart, no placeholder: this module introduces
 * no money field, table, timer, notice, command, role, event or worked figure (rule 5; 36.6-T3) — it fixes names so V2
 * attaches to 36.5's page and to `GET /v1/partner/loans/:id/serviced` without renaming, re-routing or a second product.
 *
 *   SERVICED_PANE_CODE     the code, and it is 409 (Verified requirement: the loan exists in the tenant, so 404 would say it does not)
 *   SERVICED_REFUSAL       the body the route and every path beneath it answer, and 36.5's `serviced` field carries
 *   SERVICED_TAB_COPY      rule 4's copy on the visible, disabled Serviced tab of every loan page
 *   SERVICED_MODULES       rule 2's table — the modules and what each will read; a new module is a new row here, never a second product
 *   servicedFieldOf        36.5 rule 8: the refusal object for a monitored or an active row in V1, null for a paid_off / transferred_out row
 *   paneLights             rule 3: V2's attach condition on the row (`active` and `origination_application_id` set) — read here, never branched on in V1
 */

export const SERVICED_PANE_CODE = "SERVICED_PANE_NOT_BUILT";
export const SERVICED_PANE_STATUS = 409;
/** Rule 1: `{ available: false, code: "SERVICED_PANE_NOT_BUILT" }` — no other key, no per-module variant, no `501`, no empty `200`. */
export interface ServicedRefusal { readonly available: false; readonly code: typeof SERVICED_PANE_CODE }
export const SERVICED_REFUSAL: ServicedRefusal = Object.freeze({ available: false, code: SERVICED_PANE_CODE }) as ServicedRefusal;
/** Rule 4: the copy of the one disabled tab — no chart, no table, no zero, no placeholder figure; no Supermortgage product, offer or funnel (GLBA). */
export const SERVICED_TAB_COPY = "Serviced pane not built (V1). When Supermortgage subservices the refinanced loan, its payment, escrow, insurance, delinquency, remittance, custodial, notice, QC and payoff detail will appear here.";
/** The tab as every loan page shows it (36.5 rule 9; 36.6 rule 4): visible, disabled, the copy — on a monitored, in-refinance, active and retired row alike. */
export interface ServicedTab { readonly visible: true; readonly disabled: true; readonly copy: string }
export const SERVICED_TAB: ServicedTab = Object.freeze({ visible: true, disabled: true, copy: SERVICED_TAB_COPY }) as ServicedTab;

/** Rule 2: the modules the pane will hold and no others without a new row here; each reads the named section's rows through that section's own reads and never writes. */
export interface ServicedModule { readonly module: string; readonly reads: string; readonly sections: readonly number[]; readonly guide: string }
export const SERVICED_MODULES: readonly ServicedModule[] = Object.freeze([
  { module: "Payment history / next due", reads: "§2 cashiering — the ledger, the installment schedule, the next due date", sections: [2], guide: "Servicing Guide Part C" },
  { module: "Escrow", reads: "§3 — the escrow account, the analysis, the shortage or surplus", sections: [3], guide: "Part B-1" },
  { module: "Insurance / flood / lender-placed", reads: "§9, §10 — policies, flood determinations, lender-placed status, MI", sections: [9, 10], guide: "Part B-2, B-3, B-6" },
  { module: "Delinquency / early intervention", reads: "§11 — days delinquent, the live-contact and written-notice record", sections: [11], guide: "D2-2" },
  { module: "Loss mitigation", reads: "§12 — the application, the evaluation, the plan", sections: [12], guide: "D2-3" },
  { module: "Investor remittance / LAR", reads: "§5 — the remittance and the loan activity report", sections: [5], guide: "C-3, C-4" },
  { module: "Custodial P&I and T&I", reads: "§6 — the custodial balances by account", sections: [6], guide: "A4-1-02; Forms 1013 / 1014" },
  { module: "Notices", reads: "§7 / the notice registry — the notices sent on the loan, by code and date", sections: [7], guide: "—" },
  { module: "QC exceptions", reads: "§18 — the exceptions by category", sections: [18], guide: "A1-1-03 STAR categories" },
  { module: "Payoff", reads: "§16 — the payoff quote and the release", sections: [16], guide: "—" },
]);
/** The sections the pane will read (Governing source): 2, 3, 5, 6, 7, 9, 10, 11, 12, 16 and 18 — none of them written, none of them read in V1. */
export const SERVICED_READ_SECTIONS: readonly number[] = Object.freeze([...new Set(SERVICED_MODULES.flatMap((m) => m.sections))].sort((a, b) => a - b));

/** Rule 3: a module lights only for the new loan 30.2 boarded from the refinance application — `loans.status = active` and `origination_application_id` set. V1 reads it and branches on nothing (36.6-T2: an active boarded loan still answers 409). */
export const paneLights = (row: { readonly status: string; readonly origination_application_id: string | null }): boolean => row.status === "active" && row.origination_application_id !== null;
/** 36.5 rule 8: the page's `serviced` field — the refusal object for a monitored row (36.5-T3) and for an active row in V1 (36.5-T4); null for a paid_off / transferred_out row, which will never have a pane. */
export const servicedFieldOf = (status: string): ServicedRefusal | null => (status === "monitored" || status === "active" ? SERVICED_REFUSAL : null);
