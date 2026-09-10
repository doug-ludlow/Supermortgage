/** §7.5 GLBA privacy notice — initial-notice trigger, annual exception, revised notices and the §1016.8 sharing gate. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
export function initialNoticeRequired(transfer: "msr_acquisition" | "master_to_sub" | "sub_to_sub" | "assumption"): boolean { return transfer === "msr_acquisition" || transfer === "assumption"; }
export function initialNoticeDue(transferEffective: PlainDate): PlainDate { return addDays(transferEffective, 30); }
/** 7.5 rule 3: the initial notice rides as an insert with the RESPA hello notice (15 days after transfer) and never later than 30 days (policy). */
export function initialNoticePlan(transferEffective: PlainDate): { template: "NTC_REGP_1016_4_INITIAL"; basis: "hello_insert"; hello_notice_by: PlainDate; due_on: PlainDate; timer: "REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30"; satisfied_by: "notice.sent{template=NTC_REGP_1016_4_INITIAL}" } {
  return { template: "NTC_REGP_1016_4_INITIAL", basis: "hello_insert", hello_notice_by: addDays(transferEffective, 15), due_on: initialNoticeDue(transferEffective), timer: "REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30", satisfied_by: "notice.sent{template=NTC_REGP_1016_4_INITIAL}" };
}
/** 7.5 rule 2 / §1016.4(d): a master-to-subservicer move generates no initial notice; the partner's notice version and date are recorded from the transfer file. */
export function partnerNoticeOnFile(f: { transfer: "master_to_sub" | "sub_to_sub"; partner_notice_version: string; partner_notice_date: PlainDate }): { initial_notice: false; recorded: { partner_privacy_notice_version: string; partner_privacy_notice_date: PlainDate } } {
  return { initial_notice: false, recorded: { partner_privacy_notice_version: f.partner_notice_version, partner_privacy_notice_date: f.partner_notice_date } };
}
export function annualExceptionEligible(sharingProfile: "exceptions_only" | "broader", practicesUnchangedAttested: boolean): boolean { return sharingProfile === "exceptions_only" && practicesUnchangedAttested; }
/** 7.5 rule 4 (Jan 2 test): the exception applies → `privacy.annual_exception.applied` with the attestation id and no mailing; otherwise annual notices by Dec 31 (`privacy.annual_sent`). */
export function annualCycle(f: { sharing_profile: "exceptions_only" | "broader"; attested_no_change: boolean; attestation_id: string | null; year: number }): { annual_notice: boolean; mailing: boolean; event: { type: "privacy.annual_exception.applied" | "privacy.annual_sent"; payload: { year: number; attestation_id: string | null; template: "NTC_REGP_1016_5_ANNUAL" | null } }; annual_by: PlainDate | null } {
  const exempt = annualExceptionEligible(f.sharing_profile, f.attested_no_change) && f.attestation_id !== null;
  if (exempt) return { annual_notice: false, mailing: false, event: { type: "privacy.annual_exception.applied", payload: { year: f.year, attestation_id: f.attestation_id, template: null } }, annual_by: null };
  return { annual_notice: true, mailing: true, event: { type: "privacy.annual_sent", payload: { year: f.year, attestation_id: f.attestation_id, template: "NTC_REGP_1016_5_ANNUAL" } }, annual_by: `${f.year}-12-31` as PlainDate };
}
/**
 * 7.5 rule 5 / §1016.8: a change that starts sharing outside the exceptions needs a revised notice plus a 30-day
 * opt-out window (policy) before any sharing — the gate stays closed until the window that runs from the revised
 * notice's send date has elapsed (worked example: mailed July 1 → opt-out through July 31 → sharing Aug 1), and
 * the annual clock restarts from the send date; a change that only ends the exception → annual notice within 100 days.
 */
export function policyChange(requiresRevisedNotice: boolean, endsException: boolean, on: PlainDate, revisedNoticeSentOn?: PlainDate | null): { revised_notice: boolean; opt_out_window_ends: PlainDate | null; sharing_blocked_until: PlainDate | null; sharing_allowed_from: PlainDate | null; annual_notice_due: PlainDate | null; annual_clock_restarts_from: PlainDate | null; gate: "REGP_1016_8_REVISED_NOTICE_GATE" | null; gate_closes_on: "privacy.revised_notice.optout_window_elapsed" | null } {
  if (requiresRevisedNotice) {
    const sent = revisedNoticeSentOn ?? null;
    const windowEnd = sent ? addDays(sent, 30) : null;
    return { revised_notice: true, opt_out_window_ends: windowEnd, sharing_blocked_until: windowEnd, sharing_allowed_from: windowEnd ? addDays(windowEnd, 1) : null, annual_notice_due: null, annual_clock_restarts_from: sent, gate: "REGP_1016_8_REVISED_NOTICE_GATE", gate_closes_on: "privacy.revised_notice.optout_window_elapsed" };
  }
  return { revised_notice: false, opt_out_window_ends: null, sharing_blocked_until: null, sharing_allowed_from: null, annual_notice_due: endsException ? addDays(on, 100) : null, annual_clock_restarts_from: null, gate: null, gate_closes_on: null };
}
export function portalAcknowledgmentFallback(postedOn: PlainDate): PlainDate { return addDays(postedOn, 30); }
