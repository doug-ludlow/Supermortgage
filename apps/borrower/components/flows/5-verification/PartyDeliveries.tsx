"use client";

/**
 * 32.5 §7 / 7.4 rule 4 — a disclosure is electronic only to the parties with active E-SIGN; the others get it by mail
 * and that mailing satisfies the timer. One document, one line per consumer: their first name, the channel their own
 * consent state allowed, and the status the owning process recorded (delivered · mailed · received). Dates are the
 * owning process's; nothing is computed here.
 */
import type { RecordDocument } from "@/lib/types/record";
import { formatDate } from "@/lib/format";

type Delivery = NonNullable<RecordDocument["deliveries"]>[number];
const CHANNEL_LABEL: Record<string, string> = { esign_portal: "electronically", email: "by e-mail", mail: "by mail", courier: "by courier", in_person: "in person" };
const STATUS_LABEL: Record<Delivery["status"], string> = { delivered: "Delivered", mailed: "Mailed", received: "Received" };

export function PartyDeliveries({ deliveries, timezone }: { deliveries: Delivery[]; timezone: string }) {
  return (
    <ul className="sm-list sm-party-deliveries" data-testid="party-deliveries" aria-label="Delivery to each borrower">
      {deliveries.map((d) => (
        <li key={d.borrower_id} data-borrower-id={d.borrower_id} data-channel={d.channel} data-status={d.status}>
          <span>{d.display_name}</span>
          <span className="sm-muted">
            {STATUS_LABEL[d.status]} {CHANNEL_LABEL[d.channel] ?? d.channel} <time dateTime={d.at}>{formatDate(d.at, timezone)}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}
