/**
 * §35.12 — the narrow ports on sibling processes, each with an in-repo default so this process runs (and its tests pass) whether or
 * not the neighbour has merged (35.7's roles-35-7/ports.ts pattern):
 *   35.5 / 35.1  OurFiguresPort — the eight reconciliation fields of a loan as of a day, from the typed rows (rule 7). The default reads
 *                `loans`, `loan_installments`, `fees` and the ledger as they exist at HEAD; 35.5's installment schedule replaces it.
 *   35.4         CloseAttestationsPort — the month-end close attestations (GL-10); the default reads `close_attestations` when it exists.
 *   35.2         RetentionMatrixPort — the counsel-signed retention matrix and the bucket lock (GL-07); the default reads a `documents` row
 *                of kind `retention_matrix` with metadata.signed_by_role = counsel and metadata.bucket_lock_applied = true.
 *   35.11        OpsDailyReportsPort — `ops_daily_reports{environment, as_of_date, fake_approvals}` (GL-11); the default reads the table when it exists.
 *   35.5 / 35.9  ServicingConfigPort — per-loan zone and servicer identity from configuration (GL-09); the default reads
 *                `loan_servicing_configs` and `servicer_profiles` when they exist and answers the missing tables otherwise.
 *   this process UnverifiedConfirmationsPort — the signed confirmation documents of the [UNVERIFIED] items (GL-12): `documents` rows of kind
 *                `unverified_confirmation` with metadata.item_key ∈ UNVERIFIED_ITEMS (35.2 and 35.7 add their keys through the port).
 * A test injects ports with `setPosturePorts(runtime, …)` (keyed by the root runtime, so a command view sees them too).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Runtime } from "../../../runtime/app.ts";

export interface OurFigures { readonly upb_cents: bigint; readonly escrow_balance_cents: bigint; readonly next_due_date: string | null; readonly late_charges_accrued_cents: bigint; readonly interest_paid_ytd_cents: bigint; readonly amount_due_cents: bigint; readonly days_delinquent: number; readonly form_496_remittance_cents: bigint }
export interface OurFiguresPort { figures(q: Queryable, loanId: string, asOf: string): Promise<OurFigures | null> }
export interface CloseAttestation { readonly id: string; readonly period: string; readonly attested_at: string }
export interface CloseAttestationsPort { attestations(q: Queryable, environment: string, since: string): Promise<readonly CloseAttestation[]> }
export interface RetentionMatrixPort { signed(q: Queryable): Promise<{ document_id: string; signed_by_role: string; bucket_lock_applied: boolean } | null> }
export interface OpsDailyReport { readonly id: string; readonly as_of_date: string; readonly fake_approvals: number }
export interface OpsDailyReportsPort { reports(q: Queryable, environment: string, since: string): Promise<readonly OpsDailyReport[]> }
export interface ServicingConfigPort { status(q: Queryable): Promise<{ config_rows: number; profile_rows: number; loans_without_config: number; missing_tables: string[] }> }
export interface UnverifiedConfirmationsPort { confirmations(q: Queryable): Promise<readonly { item_key: string; document_id: string }[]> }
export interface PosturePorts { readonly ourFigures?: OurFiguresPort; readonly closeAttestations?: CloseAttestationsPort; readonly retentionMatrix?: RetentionMatrixPort; readonly opsDailyReports?: OpsDailyReportsPort; readonly servicingConfig?: ServicingConfigPort; readonly unverifiedConfirmations?: UnverifiedConfirmationsPort }

/** The [UNVERIFIED] items this process and 35.2/35.7 name (GL-12: each needs a signed confirmation document). */
export const UNVERIFIED_ITEMS: readonly string[] = ["35.12/nydfs-500-16d-quarterly-policy", "35.12/parallel-run-policy", "35.12/gcp-terraform-attributes", "35.12/cloudsql-admin-api", "35.12/gcp-terraform-facts-fields", "35.12/incumbent-trial-balance-format", "35.12/vendor-canary", "35.12/secret-age-policy", "35.12/keyed-subject-override", "35.2/retention-matrix-unverified", "35.7/identity-provider-unverified"];

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(String(v)));

export const defaultOurFigures: OurFiguresPort = {
  async figures(q, loanId, asOf) {
    const [loan] = await q.query<{ id: string; original_upb_cents: string }>(`SELECT id::text AS id, original_upb_cents::text AS original_upb_cents FROM loans WHERE id = $1`, [loanId]);
    if (!loan) return null;
    const inst = await q.query<{ due_date: string; pi_cents: string; interest_cents: string; principal_cents: string; escrow_cents: string; status: string; satisfied_on: string | null }>(`SELECT due_date::text AS due_date, pi_cents::text AS pi_cents, interest_cents::text AS interest_cents, principal_cents::text AS principal_cents, escrow_cents::text AS escrow_cents, status::text AS status, satisfied_on::text AS satisfied_on FROM loan_installments WHERE loan_id = $1 ORDER BY due_date`, [loanId]);
    const paid = inst.filter((i) => i.satisfied_on !== null && i.satisfied_on <= asOf);
    const open = inst.filter((i) => i.due_date <= asOf && (i.satisfied_on === null || i.satisfied_on > asOf));
    const upb = big(loan.original_upb_cents) - paid.reduce((s, i) => s + big(i.principal_cents), 0n);
    const [esc] = await q.query<{ bal: string | null }>(`SELECT coalesce(sum(l.amount_cents), 0)::text AS bal FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE l.loan_id = $1 AND l.account LIKE 'escrow%' AND s.effective_date <= $2::date`, [loanId, asOf]);
    const [lc] = await q.query<{ due: string | null }>(`SELECT coalesce(sum(amount_cents - coalesce(collected_cents, 0) - coalesce(waived_cents, 0)), 0)::text AS due FROM fees WHERE loan_id = $1 AND fee_type::text = 'late_charge' AND assessed_on IS NOT NULL AND assessed_on <= $2::date AND state::text NOT IN ('waived', 'reversed', 'suppressed')`, [loanId, asOf]);
    const nextDue = inst.find((i) => i.satisfied_on === null || i.satisfied_on > asOf)?.due_date ?? null;
    const oldestOpen = open[0]?.due_date ?? null;
    const daysDelinquent = oldestOpen ? Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${oldestOpen}T00:00:00Z`)) / 86_400_000)) : 0;
    return { upb_cents: upb, escrow_balance_cents: big(esc?.bal), next_due_date: nextDue, late_charges_accrued_cents: big(lc?.due), interest_paid_ytd_cents: paid.filter((i) => i.satisfied_on!.slice(0, 4) === asOf.slice(0, 4)).reduce((s, i) => s + big(i.interest_cents), 0n), amount_due_cents: open.reduce((s, i) => s + big(i.pi_cents) + big(i.escrow_cents), 0n), days_delinquent: daysDelinquent, form_496_remittance_cents: 0n };
  },
};
export const defaultCloseAttestations: CloseAttestationsPort = {
  async attestations(q, _environment, since) {
    if (!(await exists(q, "close_attestations"))) return [];
    try { return (await q.query<{ id: string; period: string; attested_at: string }>(`SELECT id::text AS id, coalesce(period, period_key, '')::text AS period, coalesce(attested_at, created_at)::text AS attested_at FROM close_attestations WHERE coalesce(attested_at, created_at) >= $1::timestamptz ORDER BY 3`, [since])).map((r) => ({ id: r.id, period: r.period, attested_at: r.attested_at })); } catch { return []; }
  },
};
export const defaultRetentionMatrix: RetentionMatrixPort = {
  async signed(q) {
    const [d] = await q.query<{ id: string; metadata: Record<string, unknown> }>(`SELECT id::text AS id, metadata FROM documents WHERE kind = 'retention_matrix' AND metadata->>'signed_by_role' = 'counsel' ORDER BY created_at DESC LIMIT 1`);
    return d ? { document_id: d.id, signed_by_role: String(d.metadata["signed_by_role"]), bucket_lock_applied: d.metadata["bucket_lock_applied"] === true } : null;
  },
};
export const defaultOpsDailyReports: OpsDailyReportsPort = {
  async reports(q, environment, since) {
    if (!(await exists(q, "ops_daily_reports"))) return [];
    try { return (await q.query<{ id: string; as_of_date: string; fake_approvals: string }>(`SELECT id::text AS id, as_of_date::text AS as_of_date, coalesce(fake_approvals, 0)::text AS fake_approvals FROM ops_daily_reports WHERE coalesce(environment, $1) = $1 AND as_of_date >= $2::date ORDER BY as_of_date`, [environment, since])).map((r) => ({ id: r.id, as_of_date: r.as_of_date, fake_approvals: Number(r.fake_approvals) })); } catch { return []; }
  },
};
export const defaultServicingConfig: ServicingConfigPort = {
  async status(q) {
    const missing = (await Promise.all(["loan_servicing_configs", "servicer_profiles"].map(async (t) => ((await exists(q, t)) ? null : t)))).filter((x): x is string => !!x);
    if (missing.length) return { config_rows: 0, profile_rows: 0, loans_without_config: -1, missing_tables: missing };
    try {
      const [c] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_servicing_configs`); const [p] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM servicer_profiles`);
      const [w] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loans l WHERE l.status::text IN ('active', 'boarded') AND NOT EXISTS (SELECT 1 FROM loan_servicing_configs c WHERE c.loan_id = l.id)`);
      return { config_rows: Number(c!.n), profile_rows: Number(p!.n), loans_without_config: Number(w!.n), missing_tables: [] };
    } catch { return { config_rows: 0, profile_rows: 0, loans_without_config: -1, missing_tables: ["loan_servicing_configs?"] }; }
  },
};
export const defaultUnverifiedConfirmations: UnverifiedConfirmationsPort = {
  async confirmations(q) { return q.query<{ item_key: string; document_id: string }>(`SELECT DISTINCT ON (metadata->>'item_key') metadata->>'item_key' AS item_key, id::text AS document_id FROM documents WHERE kind = 'unverified_confirmation' AND metadata->>'signed_by_role' IS NOT NULL ORDER BY metadata->>'item_key', created_at DESC`); },
};
const registry = new WeakMap<object, PosturePorts>();
export function setPosturePorts(rt: Runtime, ports: PosturePorts | null): void { const key = (rt as { root?: Runtime }).root ?? rt; if (ports) registry.set(key, ports); else registry.delete(key); }
export function posturePortsOf(rt: Runtime): Required<PosturePorts> {
  const p = registry.get((rt as { root?: Runtime }).root ?? rt) ?? {};
  return { ourFigures: p.ourFigures ?? defaultOurFigures, closeAttestations: p.closeAttestations ?? defaultCloseAttestations, retentionMatrix: p.retentionMatrix ?? defaultRetentionMatrix, opsDailyReports: p.opsDailyReports ?? defaultOpsDailyReports, servicingConfig: p.servicingConfig ?? defaultServicingConfig, unverifiedConfirmations: p.unverifiedConfirmations ?? defaultUnverifiedConfirmations };
}
