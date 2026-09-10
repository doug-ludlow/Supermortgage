/** §4.2 Request for Information — per-item profiles, owner identity, exceptions, redaction. */
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import { federalDays } from "./clocks.ts";
export type ItemKind = "owner_identity" | "standard";
export function itemDeadlines(kind: ItemKind, receivedOn: PlainDate, state?: string): { ack_due: PlainDate; response_due: PlainDate; extendable: boolean } {
  if (kind === "owner_identity") { const fed = federalDays(receivedOn, 10); const ny = state === "NY" ? addDays(receivedOn, 10) : null; return { ack_due: federalDays(receivedOn, 5), response_due: ny && ny < fed ? ny : fed, extendable: false }; }
  return { ack_due: federalDays(receivedOn, 5), response_due: federalDays(receivedOn, 30), extendable: true };
}
export function extendItem(d: ReturnType<typeof itemDeadlines>, noticeOn: PlainDate): ReturnType<typeof itemDeadlines> | { error: "EXTENSION_NOT_PERMITTED" | "EXTENSION_LATE" } { if (!d.extendable) return { error: "EXTENSION_NOT_PERMITTED" }; if (noticeOn > d.response_due) return { error: "EXTENSION_LATE" }; return { ...d, response_due: federalDays(d.response_due, 15), extendable: false }; }
export function ownerIdentity(ownership: "fnma_portfolio" | "fnma_mbs_trust", askedForTrustName = false): string { return ownership === "fnma_portfolio" ? "Fannie Mae (as of the date of this letter; ownership may change)" : `Fannie Mae in its capacity as Trustee${askedForTrustName ? " of the identified trust" : ""} (as of the date of this letter; ownership may change)`; }
export function exception(f: { asks_for: "investor_guidelines" | "own_evaluation" | "records" | "call_recordings"; pages_est?: number; hours_est?: number; answered_same_item_within_12m?: boolean; received_on: PlainDate; transfer_out_or_discharge_on?: PlainDate | null }): "irrelevant" | "overbroad" | "duplicative" | "untimely" | null {
  if (f.transfer_out_or_discharge_on && f.received_on > addYears(f.transfer_out_or_discharge_on, 1)) return "untimely";
  if (f.asks_for === "investor_guidelines") return "irrelevant"; if (f.answered_same_item_within_12m) return "duplicative";
  if ((f.pages_est ?? 0) > 5000 || (f.hours_est ?? 0) > 40) return "overbroad"; return null;
}
export function redactions(requester: "borrower" | "confirmed_successor" | "agent"): string[] { return requester === "confirmed_successor" ? ["other_borrowers.location_contact", "other_borrowers.personal_financial"] : requester === "borrower" ? ["successors.personal_data"] : ["non_borrower_data"]; }
