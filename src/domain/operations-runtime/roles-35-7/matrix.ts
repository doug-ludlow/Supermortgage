/**
 * §35.7 rule 3 — the disjointness matrix on one person. `qc_officer` ⟂ officer, mlo_of_record, underwriting_reviewer,
 * funding_approver, settlement_agent, signing_officer (Selling Guide D1-1-02, verified); `funding_approver` ⟂ officer,
 * settlement_agent (26.3's releaser-never-preparer, policy); `underwriting_reviewer` ⟂ mlo_of_record (21.6, policy).
 * The same pairs are CHECK constraints on staff_users (migration 0170), so a hand-written UPDATE fails too. Pure.
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ["qc_officer", "officer"], ["qc_officer", "mlo_of_record"], ["qc_officer", "underwriting_reviewer"], ["qc_officer", "funding_approver"], ["qc_officer", "settlement_agent"], ["qc_officer", "signing_officer"],
  ["funding_approver", "officer"], ["funding_approver", "settlement_agent"],
  ["underwriting_reviewer", "mlo_of_record"],
];
/** The roles among `held` (roles ∪ reviewer_roles) that `role` may not sit beside; empty when the grant is allowed. */
export function conflictsWith(role: string, held: readonly string[]): string[] {
  const out: string[] = [];
  for (const [a, b] of PAIRS) { if (a === role && held.includes(b)) out.push(b); else if (b === role && held.includes(a)) out.push(a); }
  return [...new Set(out)];
}
export const DISJOINT_PAIRS = PAIRS;
