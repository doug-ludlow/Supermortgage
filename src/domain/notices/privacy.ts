/** §7.5 GLBA privacy notice — initial-notice trigger, annual exception, revised notices. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
export function initialNoticeRequired(transfer: "msr_acquisition" | "master_to_sub" | "sub_to_sub" | "assumption"): boolean { return transfer === "msr_acquisition" || transfer === "assumption"; }
export function initialNoticeDue(transferEffective: PlainDate): PlainDate { return addDays(transferEffective, 30); }
export function annualExceptionEligible(sharingProfile: "exceptions_only" | "broader", practicesUnchangedAttested: boolean): boolean { return sharingProfile === "exceptions_only" && practicesUnchangedAttested; }
export function policyChange(requiresRevisedNotice: boolean, endsException: boolean, on: PlainDate): { revised_notice: boolean; opt_out_window_ends: PlainDate | null; annual_notice_due: PlainDate | null; sharing_blocked_until: PlainDate | null } {
  if (requiresRevisedNotice) return { revised_notice: true, opt_out_window_ends: addDays(on, 30), annual_notice_due: null, sharing_blocked_until: addDays(on, 30) };
  return { revised_notice: false, opt_out_window_ends: null, annual_notice_due: endsException ? addDays(on, 100) : null, sharing_blocked_until: null };
}
export function portalAcknowledgmentFallback(postedOn: PlainDate): PlainDate { return addDays(postedOn, 30); }
