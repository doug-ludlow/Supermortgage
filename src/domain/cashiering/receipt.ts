/**
 * Reg Z §1026.36(c)(1) date of receipt by channel (2.1 rule 1), conformity
 * (rule 3) and `credited_as_of` with the nonconforming +5 option.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { nextBusinessDay, type Calendar } from "../../kernel/calendar/business.ts";
import type { Channel, ChannelConfig, PaymentInput } from "./types.ts";

export const DEFAULT_CHANNELS: Record<Channel, ChannelConfig> = {
  lockbox:               { channel: "lockbox", cutoff: { hhmm: "17:00", timeZone: "America/Chicago" }, conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  ach_debit_origin:      { channel: "ach_debit_origin", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: true },
  ach_credit_inbound:    { channel: "ach_credit_inbound", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  wire:                  { channel: "wire", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  portal_onetime:        { channel: "portal_onetime", cutoff: { hhmm: "23:59", timeZone: "America/New_York" }, conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: true },
  ivr:                   { channel: "ivr", cutoff: { hhmm: "23:59", timeZone: "America/New_York" }, conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: true },
  agent_assisted:        { channel: "agent_assisted", cutoff: { hhmm: "23:59", timeZone: "America/New_York" }, conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: true },
  mail_office:           { channel: "mail_office", conforming: false, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  card:                  { channel: "card", cutoff: { hhmm: "23:59", timeZone: "America/New_York" }, conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  third_party_contractor:{ channel: "third_party_contractor", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  assistance_program:    { channel: "assistance_program", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  bk_trustee:            { channel: "bk_trustee", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  transferor_forward:    { channel: "transferor_forward", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
  transfer_in_opening:   { channel: "transfer_in_opening", conforming: true, nonconforming_credit_days: 0, requirements_version: "PAYREQ-2026-01", direct_to_custodial: false },
};

export interface ReceiptDates { readonly received_on: PlainDate; readonly credited_as_of: PlainDate; readonly conforming: boolean; readonly nonconforming_reason?: string; readonly requirements_version: string; }

/** Civil date of an instant in the channel's time zone, rolled to the next business day when after cut-off. */
function datedByCutoff(receivedAt: string, cfg: ChannelConfig, cal: Calendar): PlainDate {
  const tz = cfg.cutoff?.timeZone ?? "America/New_York";
  const w = wallClock(Date.parse(receivedAt), tz);
  if (!cfg.cutoff) return w.date;
  const [hh, mm] = cfg.cutoff.hhmm.split(":").map(Number) as [number, number];
  const afterCutoff = w.hour > hh || (w.hour === hh && w.minute > mm);
  return afterCutoff ? nextBusinessDay(w.date, cal) : w.date;
}

export function receiptDates(p: PaymentInput, cfg: ChannelConfig, servicerCal: Calendar): ReceiptDates {
  let received_on: PlainDate;
  switch (p.channel) {
    case "ach_debit_origin":                                // our originated debit: scheduled settlement date
    case "ach_credit_inbound":
    case "wire":
      received_on = p.settlement_date ?? wallClock(Date.parse(p.received_at), "America/New_York").date; break;
    case "transferor_forward":                             // §1024.33(c): transferor's receipt date
      if (!p.transferor_received_on) throw new RangeError("transferor_forward requires transferor_received_on");
      received_on = p.transferor_received_on; break;
    default:
      received_on = datedByCutoff(p.received_at, cfg, servicerCal);
  }
  const conforming = cfg.conforming;
  const credited_as_of = conforming ? received_on : addDays(received_on, cfg.nonconforming_credit_days);
  return { received_on, credited_as_of, conforming, ...(conforming ? {} : { nonconforming_reason: `channel ${p.channel} is not a specified payment channel` }), requirements_version: cfg.requirements_version };
}

/** Reg Z (c)(1)(iii) validator: nonconforming credit may never exceed receipt + 5 calendar days. */
export function assertCreditedAsOfPermitted(received_on: PlainDate, credited_as_of: PlainDate, conforming: boolean): void {
  const latest = conforming ? received_on : addDays(received_on, 5);
  if (credited_as_of > latest) throw new RangeError(`credited_as_of ${credited_as_of} exceeds the latest permitted ${latest} (REGZ_1026_36C1III_NONCONFORMING_5CD)`);
}

export function idempotencyKey(p: PaymentInput, received_on: PlainDate): string {
  return createHash("sha256").update([p.channel, p.source_batch_id ?? "", p.source_item_id ?? p.trace_number ?? p.check_number ?? "", p.amount_cents.toString(), received_on].join("|")).digest("hex");
}
