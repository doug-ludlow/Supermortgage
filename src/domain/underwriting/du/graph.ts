/**
 * `readDuGraph`: every live container of one application with its arcs, in the order 23.6 emits them — the read half
 * of 23.5's tool surface and the input of 23.6's `assembleDuDocument` (Phase 5 `loadGraph`). Rows are sorted by
 * `(created_at, id)` so the labels 23.6 assigns (`ASSET_n`, `LIABILITY_n`, …) are stable across two reads; retired
 * rows are excluded from every list and every arc (23.5 State machine). An examiner is shown exactly this (23.5 Audit
 * and evidence: "the live graph as `readDuGraph` returns it").
 */
import type { Queryable } from "../../../infra/db/client.ts";

type Row = Record<string, unknown>;
export interface DuGraphBorrower extends Row { readonly id: string; readonly borrower_ordinal: number | null; readonly borrower_role: string; readonly legal_name: string; readonly party_id: string | null; readonly created_at: string; }
export interface DuGraphArc { readonly application_borrower_id: string; readonly role: string; readonly created_at: string; }
export interface DuGraph {
  readonly application_id: string;
  readonly du_casefile_id: string | null;
  /** DU Borrower 1..4: the borrowing roles, by ordinal. */
  readonly borrowers: readonly DuGraphBorrower[];
  readonly assets: readonly (Row & { readonly owners: readonly DuGraphArc[]; readonly owned_property: Row | null })[];
  readonly liabilities: readonly (Row & { readonly obligors: readonly DuGraphArc[] })[];
  readonly expenses: readonly (Row & { readonly payers: readonly DuGraphArc[] })[];
  readonly employers: readonly Row[];
  /** `application_income` rows naming an employer (rule 2: the CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER arc is the FK). */
  readonly income_items: readonly Row[];
  readonly joint_credit_report_links: readonly Row[];
  readonly declarations: readonly (Row & { readonly bankruptcy_chapters: readonly string[] })[];
  readonly residences: readonly Row[];
  /** The trigger names that hold each invariant, for the examiner. */
  readonly invariants: Readonly<Record<string, string>>;
}

const BORROWING = "('borrower', 'co_borrower', 'non_occupant_co_borrower')";
const ORDER = "ORDER BY created_at, id";

export const DU_GRAPH_INVARIANTS: Readonly<Record<string, string>> = {
  owner_arc_at_commit: "du_assets_have_an_owner / du_liabilities_have_an_obligor / du_expenses_have_a_payer (deferred) + du_asset_parties_leave_an_owner and siblings",
  arcs_inside_the_application: "du_asset_parties_stay_inside_the_application / du_liability_parties_stay_inside_the_application / du_expense_parties_stay_inside_the_application / du_liabilities_stay_inside_the_application / application_income_employer_stays_inside_the_application",
  fifty_per_container: "du_assets_fit_fifty / du_liabilities_fit_fifty / du_expenses_fit_fifty (deferred)",
  lien_total_derived: "du_owned_properties_total_their_liens_write / du_liabilities_retotal_their_property_write",
  owned_property_inherits_application: "du_owned_properties_inherit_their_application_write",
  one_primary_per_joint_credit_group: "du_joint_credit_groups_have_one_primary_write",
  declarations_self_attested: "du_declarations_are_self_attested_write",
  bankruptcy_chapters_match: "du_bankruptcy_chapters_match_the_indicator_decl / du_bankruptcy_chapters_match_the_indicator_filing (deferred)",
  one_current_residence: "du_residences_keep_a_current_home (deferred) + du_residences_one_current_per_borrower",
  four_borrowers_in_order: "application_borrowers_allocate_ordinal_write + application_borrowers_one_first_borrower / application_borrowers_one_party_per_ordinal",
  borrowing_role_kept_while_owning: "application_borrowers_keep_their_du_rows_valid_update",
  casefile_write_once: "applications_du_casefile_is_write_once_update",
};

const arcsOf = async (q: Queryable, table: string, col: string, ids: readonly string[]): Promise<Map<string, DuGraphArc[]>> => {
  const out = new Map<string, DuGraphArc[]>();
  if (!ids.length) return out;
  const rows = await q.query<{ parent: string; application_borrower_id: string; role: string; created_at: string }>(`SELECT ${col}::text AS parent, application_borrower_id::text AS application_borrower_id, role, created_at::text AS created_at FROM ${table} WHERE ${col} = ANY ($1::uuid[]) ORDER BY created_at, id`, [ids]);
  for (const r of rows) { const list = out.get(r.parent) ?? []; list.push({ application_borrower_id: r.application_borrower_id, role: r.role, created_at: r.created_at }); out.set(r.parent, list); }
  return out;
};

export async function readDuGraph(q: Queryable, applicationId: string): Promise<DuGraph> {
  const app = (await q.query<{ id: string; du_casefile_id: string | null }>(`SELECT id::text AS id, du_casefile_id FROM applications WHERE id = $1`, [applicationId]))[0];
  if (!app) throw new RangeError(`no application ${applicationId}`);
  const borrowers = await q.query<DuGraphBorrower>(`SELECT id::text AS id, borrower_ordinal, borrower_role, legal_name, party_id::text AS party_id, created_at::text AS created_at FROM application_borrowers WHERE application_id = $1 AND borrower_role IN ${BORROWING} ORDER BY borrower_ordinal, created_at, id`, [applicationId]);
  const edgeIds = borrowers.map((b) => b.id);
  const assets = await q.query<Row & { id: string }>(`SELECT * FROM du_assets WHERE application_id = $1 AND retired_at IS NULL ${ORDER}`, [applicationId]);
  const properties = await q.query<Row & { asset_id: string }>(`SELECT * FROM du_owned_properties WHERE application_id = $1 ${ORDER}`, [applicationId]);
  const liabilities = await q.query<Row & { id: string }>(`SELECT * FROM du_liabilities WHERE application_id = $1 AND retired_at IS NULL ${ORDER}`, [applicationId]);
  const expenses = await q.query<Row & { id: string }>(`SELECT * FROM du_expenses WHERE application_id = $1 ${ORDER}`, [applicationId]);
  const [owners, obligors, payers] = await Promise.all([arcsOf(q, "du_asset_parties", "asset_id", assets.map((a) => a.id)), arcsOf(q, "du_liability_parties", "liability_id", liabilities.map((l) => l.id)), arcsOf(q, "du_expense_parties", "expense_id", expenses.map((e) => e.id))]);
  const employers = await q.query<Row>(`SELECT * FROM employers WHERE application_id = $1 ${ORDER}`, [applicationId]);
  const income = await q.query<Row>(`SELECT * FROM application_income WHERE application_id = $1 AND employer_id IS NOT NULL ${ORDER}`, [applicationId]);
  const links = await q.query<Row>(`SELECT * FROM du_joint_credit_report_links WHERE application_id = $1 ${ORDER}`, [applicationId]);
  const declarations = edgeIds.length ? await q.query<Row & { id: string }>(`SELECT * FROM du_declarations WHERE application_borrower_id = ANY ($1::uuid[]) ${ORDER}`, [edgeIds]) : [];
  const chapters = declarations.length ? await q.query<{ declaration_id: string; chapter: string }>(`SELECT declaration_id::text AS declaration_id, chapter FROM du_bankruptcy_filings WHERE declaration_id = ANY ($1::uuid[]) ORDER BY chapter`, [declarations.map((d) => d.id)]) : [];
  const residences = edgeIds.length ? await q.query<Row>(`SELECT * FROM du_residences WHERE application_borrower_id = ANY ($1::uuid[]) ORDER BY application_borrower_id, (residency_type <> 'Current'), created_at, id`, [edgeIds]) : [];
  const propertyByAsset = new Map(properties.map((p) => [p.asset_id, p]));
  return {
    application_id: app.id, du_casefile_id: app.du_casefile_id, borrowers,
    assets: assets.map((a) => ({ ...a, owners: owners.get(a.id) ?? [], owned_property: propertyByAsset.get(a.id) ?? null })),
    liabilities: liabilities.map((l) => ({ ...l, obligors: obligors.get(l.id) ?? [] })),
    expenses: expenses.map((e) => ({ ...e, payers: payers.get(e.id) ?? [] })),
    employers, income_items: income, joint_credit_report_links: links,
    declarations: declarations.map((d) => ({ ...d, bankruptcy_chapters: chapters.filter((c) => c.declaration_id === d.id).map((c) => c.chapter) })),
    residences, invariants: DU_GRAPH_INVARIANTS,
  };
}
