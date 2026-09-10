/** §1.2 / §17.1 Fannie Mae transfer approval — transfer-date rule, Form 629 clocks, Quick Exchange cadence, batch-type mapping. */
import { type PlainDate, addDays, parts, ymd } from "../../kernel/calendar/date.ts";
import { rollForward, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";

export type TransferType = "master_to_sub" | "sub_to_sub" | "sub_to_master" | "servicing_sale" | "servicing_sale_with_sub" | "fnma_directed" | "master_change_sub_retained" | "custodian_only";
export function firstFannieBusinessDay(monthOf: PlainDate): PlainDate { const { y, m } = parts(monthOf); return rollForward(ymd(y, m, 1), fannieEt); }
export function transferDateGate(proposed: PlainDate): { ok: true } | { ok: false; gate: "FNMA_A2_7_03_TRANSFER_DATE_GATE"; expected: PlainDate } { const exp = firstFannieBusinessDay(proposed); return proposed === exp ? { ok: true } : { ok: false, gate: "FNMA_A2_7_03_TRANSFER_DATE_GATE", expected: exp }; }
export function form629Clocks(type: TransferType, transferDate: PlainDate, saleDate?: PlainDate | null): { deadline: PlainDate; internal_buffer: PlainDate; rule: "30_day_subservicing" | "60_day_sale" | "fnma_directed"; liability_start: PlainDate } {
  const liability = saleDate && saleDate < transferDate ? saleDate : transferDate;
  if (type === "fnma_directed") return { deadline: transferDate, internal_buffer: transferDate, rule: "fnma_directed", liability_start: liability };
  if (type === "servicing_sale" || type === "servicing_sale_with_sub" || type === "master_change_sub_retained") { const anchor = saleDate && saleDate < transferDate ? saleDate : transferDate; const d = addDays(anchor, -60); return { deadline: d, internal_buffer: addDays(d, -7), rule: "60_day_sale", liability_start: liability }; }
  const d = addDays(transferDate, -30); return { deadline: d, internal_buffer: addDays(d, -7), rule: "30_day_subservicing", liability_start: liability };
}
export function quickExchangeCadence(transferDate: PlainDate): { adds_by: PlainDate; reconciliation_by: PlainDate; attestation_by: PlainDate; processing_on: PlainDate; portal_task_on: PlainDate } {
  const prior = addDays(transferDate, -1); const { y, m } = parts(prior);
  const cd = (d: number) => ymd(y, m, d);
  const deadline = addDays(transferDate, -30);
  return { adds_by: cd(10), reconciliation_by: cd(20), attestation_by: addBusinessDays(cd(26), -1, fannieEt), processing_on: addBusinessDays(transferDate, 2, fannieEt), portal_task_on: addBusinessDays(deadline, -1, servicer) < deadline ? addBusinessDays(deadline, -1, servicer) : addBusinessDays(deadline, -1, servicer) };
}
export function respaNoticeRequired(type: TransferType, unchanged: { payee: boolean; address: boolean; account: boolean; amount: boolean }): boolean { return !(type === "master_change_sub_retained" && unchanged.payee && unchanged.address && unchanged.account && unchanged.amount); }
export function form101TerminationDue(lastCutover: PlainDate): PlainDate { return addBusinessDays(lastCutover, 5, servicer); }
export function saleArrangementDue(terminationNoticeOn: PlainDate): PlainDate { return addDays(terminationNoticeOn, 90); }
export function portalTaskEscalation(assignedOn: PlainDate): PlainDate { return addBusinessDays(assignedOn, 2, servicer); }
