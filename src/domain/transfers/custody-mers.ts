/** §1.4 Document custody and §1.5 MERS — recert deadlines, assignment logic, MIN transactions. */
import { type PlainDate, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { TransferType } from "./batch.ts";

export function recertDeadline(ted: PlainDate, code: "D" | "C" | "I" | "none"): { deadline: PlainDate; extension_request_by: PlainDate } { if (code === "I") { const d = addDays(ted, 30); return { deadline: d, extension_request_by: addDays(d, -15) }; } const d = addMonths(ted, 6); return { deadline: d, extension_request_by: addDays(d, -15) }; }
export function custodyClocks(ted: PlainDate, firstDocsReceivedOn?: PlainDate): { trial_balance_by: PlainDate; recert_start_by: PlainDate | null; missing_docs_notice_by: PlainDate | null; own_exception_review_by: PlainDate | null } {
  return { trial_balance_by: addDays(ted, 30), recert_start_by: firstDocsReceivedOn ? addDays(firstDocsReceivedOn, 10) : null, missing_docs_notice_by: firstDocsReceivedOn ? addDays(firstDocsReceivedOn, 30) : null, own_exception_review_by: firstDocsReceivedOn ? addDays(firstDocsReceivedOn, 20) : null };
}
export function assignmentAction(f: { mers_registered: boolean; assignment_to_fnma_recorded: boolean }): "min_update_only" | "none" | "record_assignment_to_transferee" { return f.mers_registered ? "min_update_only" : f.assignment_to_fnma_recorded ? "none" : "record_assignment_to_transferee"; }
export function custodyOk(f: { custodian: string | null; certification_status: string | null; enote_controller: string | null }): boolean { return (!!f.custodian && !!f.certification_status) || f.enote_controller === "FNMA"; }
export function form2009Overdue(openedOn: PlainDate, today: PlainDate, liquidation: boolean): boolean { return !liquidation && addDays(openedOn, 90) < today; }
export function mersTransaction(type: TransferType): "min_update_subservicer" | "min_update_replace_subservicer" | "tos_seller_initiated" | "none" { switch (type) { case "master_to_sub": return "min_update_subservicer"; case "sub_to_sub": return "min_update_replace_subservicer"; case "servicing_sale_with_sub": case "servicing_sale": return "tos_seller_initiated"; default: return "none"; } }
export function mersIntegrity(sor: Record<string, string>, snapshot: Record<string, string>, changing: readonly string[]): string[] { return Object.keys(sor).filter((k) => !changing.includes(k) && snapshot[k] !== undefined && snapshot[k] !== sor[k]); }
export function mersClocks(transferDate: PlainDate): { batch_submit_on: PlainDate; verify_by: PlainDate; registration_due_for_unregistered: PlainDate } { return { batch_submit_on: addBusinessDays(transferDate, -1, servicer), verify_by: addBusinessDays(transferDate, 3, servicer), registration_due_for_unregistered: addDays(transferDate, 7) }; }
export function violationResponseDue(noticeOn: PlainDate): PlainDate { return addDays(noticeOn, 30); }
