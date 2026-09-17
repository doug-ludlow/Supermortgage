/** The wire shapes of /v1/partner/* as src/runtime/partner-portal/{routes,home,eligibility,pipeline,book}.ts answer them. Money is a decimal string of cents; rates the tape's percent strings. */
export type PartnerRole = "partner_ops" | "partner_auditor" | "partner_admin";

export interface PartnerMe {
  partner_user_id: string; name: string | null; roles: PartnerRole[]; role: PartnerRole; acted_as: string;
  partner: { partner_party_id: string; legal_name: string | null; nmlsr_id: string | null };
  session: { session_id: string; created_at: string; expires_at: string; factors: string[] };
  factors: string[];
}

export interface PartnerHome {
  partner_party_id: string; as_of_date: string | null;
  partner: { legal_name: string; nmlsr_id: string | null };
  book: { loans_monitored: number; on_hold: number; last_as_of: string | null; next_tape_due: string | null; late: boolean; imports: number };
  eligibility: { eligible_now: number; likely_soon: number; not_near: number };
  pipeline: { in_flight: number; boarded_mtd: number };
  latest_report_id: string | null; latest_report_as_of: string | null;
  empty: boolean; copy: string;
}

export interface PartnerLoanRow {
  loan_id: string; servicer_loan_last4: string; servicer_loan_number?: string; partner_party_id: string; partner_legal_name: string; status: string; state: string | null;
  homeowner: { party_id: string | null; legal_name: string | null; email_masked?: string | null; phone_masked?: string | null };
  facts_as_of: string | null; upb_cents: string | null; note_rate_pct: string | null; pi_cents: string | null; ti_cents: string | null; next_due_date: string | null; last_payment_date: string | null;
  value: { value_cents: string; as_of: string | null } | null; servicing_status: string | null; account_activated: boolean; activated_at: string | null;
  latest_review: { as_of_date: string; verdict: string; reasons: string[] } | null; latest_readiness: { as_of_date: string; ready: boolean; missing: string[] } | null;
  on_hold: boolean; bucket: string | null; watch_rate_pct: string | null; reasons: string[]; reasons_in_words: string[]; pipeline_stage: string | null; banner: string | null; refinanced_by_loan_id: string | null;
}
export interface PartnerEligibility {
  partner_party_id: string; as_of_date: string | null;
  counts: { eligible_now: number; likely_soon: number; not_near: number; on_hold: number };
  query: { bucket: string | null; state: string | null; on_hold: boolean | null; applied: string[] };
  loans: PartnerLoanRow[];
}

export interface PipelineItem { loan_id: string; servicer_loan_last4: string; homeowner: { legal_name: string | null }; state: string | null; stage: string; entered_at: string; days_in_stage: number; opportunity_id?: string; application_id?: string; missing?: string[]; new_loan?: { loan_id: string; status: string } }
export interface PartnerPipeline { partner_party_id: string; as_of: string; items: PipelineItem[] }

export interface PartnerLoanDetail {
  loan_id: string; partner_party_id: string; banner: string | null; bucket: string | null; pipeline_stage: string | null;
  loan: PartnerLoanRow & { hold: { last_as_of_date: string; partner_as_of_date: string; held_since: string | null } | null; origination_application_id: string | null };
  facts_history: { as_of_date: string; import_id: string; change: string; changed: string[] }[];
  reviews: { as_of_date: string; verdict: string; verdict_words: string; reasons: string[]; reasons_in_words: string[]; watch_rate_pct: string | null; analyst_rationale_tokens: string | null; analyst_rationale: string | null; analyst_skipped: string | null; analyst_flags: string[] }[];
  readiness: { as_of_date: string; ready: boolean; missing: string[]; items: { item: string; status: string }[] } | null;
  offers: { opportunity_id: string; as_of_date: string | null; status: string | null; delivered_at: string | null; delivered_channels: string[]; expires_at: string | null; expired: boolean }[];
  links: { refinanced_by_loan_id: string | null; prior_loan_id: string | null; refinance_application_id: string | null; pipeline: string | null; board: string; holds: string | null };
  serviced: { available: false; code: string } | null;
  serviced_tab: { visible: true; disabled: true; copy: string };
}

export interface PartnerStatus { partner_party_id: string; partner_legal_name: string; as_of_date: string | null; imports: number; monitored_loans: number; on_hold: number; next_expected: string | null; late: boolean; empty: boolean; copy: string }
export interface ImportListing { import_id: string; partner_party_id: string; as_of_date: string; status: string; rows_total: number; rows_loaded: number; loans_created: number; invitations_sent: number; created_at: string; uploaded_by: string }
export interface ImportResult {
  import_id: string; status: "loaded" | "rejected" | "already_loaded"; partner_party_id: string;
  rows_total: number; rows_loaded: number; rows_exception: number; loans_created: number; loans_updated: number; parties_created: number; parties_linked: number; invitations_sent: number;
  report: { profile: string; exceptions: { row: number; code: string; servicer_loan_number?: string; field?: string }[]; rejected: { missing_headers: string[] } | null; supplement: { rows: number; matched: number; orphans: number }; not_on_tape?: { loan_id: string; servicer_loan_number: string; last_as_of_date: string }[]; invitations: { held_reason: string | null }[] };
  loans: { loan_id: string; servicer_loan_number: string; change: string }[];
  created_at?: string; uploaded_by?: string; copy?: string;
}
export interface HoldRow { loan_id: string; servicer_loan_last4: string; homeowner: { party_id: string | null; name: string | null }; state: string | null; status: string; last_as_of_date: string; partner_as_of_date: string; held_since: string | null }
export interface PartnerHolds { partner_party_id: string; as_of_date: string | null; count: number; holds: HoldRow[] }

export interface DailyReport {
  id: string; partner_party_id: string; partner_legal_name: string | null; as_of_date: string; produced_by: string; created_at: string; decision_id: string | null; document_id: string | null;
  review: { absent: boolean; reviewed: number; candidates: number; watching: number; not_now: number; excluded: number; offers_delivered: number; offers_portal_only: number; expired: number; analyst_turns: number; analyst_skipped: number; fair_lending_extract_id: string | null };
  readiness: { absent: boolean; checked: number; ready: number; not_ready: number; applications_opened: number; du_runs: number };
  book: { loans_monitored: number; on_hold: number; paid_off: number; transferred_out: number; last_as_of_date: string | null; next_expected: string | null; imports: number };
}
export interface PartnerUser { partner_user_id: string; name: string | null; email: string | null; roles: PartnerRole[]; status: string; invited_at: string | null; enrolled_at: string | null; disabled_at: string | null; locked_until: string | null }
