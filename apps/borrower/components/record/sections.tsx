"use client";

/**
 * The ten Record sections of 01 §4, rendered from `borrower_record` (02 §1.1).
 * Fixed order; a section with no data is hidden, not empty. Every dated item links to
 * the thread message that produced it; values flash for 300 ms on change (01 §1.4).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BorrowerRecord, RecordDocument, RecordPerson, StatusBadge } from "@/lib/types/record";
import { copy, copyOrUndefined } from "@/lib/copy";
import { ExitBanner, autopayExitLine } from "@/components/flows/12-exits";
import { PartyDeliveries, WhatWeAreDoing } from "@/components/flows/5-verification";
import { propertyStateLabel } from "@/components/flows/6-decision-property";
import { ArmEstimateRows } from "@/components/flows/9-servicing-requests";
import { form1098Label } from "@/components/flows/8-servicing-payments";
import { formatDate, formatMoney, formatRate, mask4, plural, withinDays } from "@/lib/format";
import { hardshipRows } from "@/components/flows/10-hardship";
import { rateWatchDetailRows } from "@/components/flows/11-rate-watch";

export type RecordLink = (target: { message_id?: string; card_instance_id?: string; document_id?: string }) => void;

/** Adds `.sm-highlight` for 300 ms whenever `value` changes (after first render). */
export function useHighlight(value: unknown): boolean {
  const [on, setOn] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const t = setTimeout(() => setOn(false), 300);
    return () => clearTimeout(t);
  }, [value]);
  return on;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="sm-record-section" aria-labelledby={`rec-${id}`} data-record-section={id}>
      <h2 id={`rec-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

function Value({ value, className }: { value: string; className?: string }) {
  const hl = useHighlight(value);
  return <span className={`${className ?? ""}${hl ? " sm-highlight" : ""}`.trim()}>{value}</span>;
}

export function badgeTone(badge: StatusBadge): "positive" | "caution" | "info" | "neutral" {
  if (["Funded", "Your loan", "Current", "Rate locked", "Clear to close", "Preapproved", "Prequalified", "Paid off"].includes(badge)) return "positive";
  if (["Past due", "Behind", "What's missing", "Cancel window", "Payment due", "Counteroffer", "Bankruptcy — protections in effect"].includes(badge)) return "caution";
  if (["Closed", "Withdrawn", "Decision letter sent", "Transferred out", "Cancelled"].includes(badge)) return "neutral";   // 32.12: read-only after cutover
  return "info";
}

const BADGE_ICON: Partial<Record<StatusBadge, string>> = {
  Current: "●",
  "Payment due": "◔",
  "Past due": "!",
  Behind: "!",
  Funded: "✓",
  "Rate locked": "🔒",
  "Clear to close": "✓",
  "Cancel window": "⏱",
  "Paid off": "✓",
  "Paying off": "◔",
  "Servicing moving": "→",
  "Transferred out": "→",
};

export function StatusBadgeView({ badge, oneLiner }: { badge: StatusBadge; oneLiner?: string }) {
  return (
    <span className="sm-badge" data-tone={badgeTone(badge)} data-testid="status-badge">
      <span aria-hidden="true">{BADGE_ICON[badge] ?? "●"}</span>
      <span>{badge}</span>
      {oneLiner ? <span className="sm-visually-hidden"> — {oneLiner}</span> : null}
    </span>
  );
}

// 1 Header
export function HeaderSection({ r }: { r: BorrowerRecord }) {
  return (
    <section className="sm-record-section sm-record-header" data-record-section="header" aria-label="Loan">
      <h1>{r.header.address_line || "Property to be determined"}</h1>
      <p>
        {r.header.purpose} · {r.header.loan_label}
      </p>
    </section>
  );
}

// 2 Status
export function StatusSection({ r, link }: { r: BorrowerRecord; link: RecordLink }) {
  const line = copy(r.status.one_liner, r.status.one_liner_tokens);
  const count = r.needed_from_you.length;
  return (
    <Section id="status" title="Status">
      <StatusBadgeView badge={r.status.badge} />
      <ExitBanner r={r} />
      <p style={{ margin: "6px 0 0" }}>
        <Value value={line} />
        {count > 0 ? (
          <>
            {" — "}
            <button type="button" className="sm-linkbtn" onClick={() => link({ card_instance_id: r.needed_from_you[0]?.card_instance_id })}>
              {plural(count, "thing", "things")} needed from you
            </button>
          </>
        ) : null}
      </p>
    </Section>
  );
}

// 3 Next
export function NextSection({ r, link }: { r: BorrowerRecord; link: RecordLink }) {
  if (!r.next) return null;
  const soon = withinDays(r.next.due_at, 3);
  const msg = r.dates.find((d) => d.timer_code === r.next?.timer_code)?.message_id;
  return (
    <Section id="next" title="Next">
      <p style={{ margin: 0 }} className="sm-primary-text">
        {r.next.label}{" "}
        <button type="button" className="sm-linkbtn" onClick={() => link({ message_id: msg })} disabled={!msg}>
          <time dateTime={r.next.due_at} className={soon ? "sm-caution-text sm-num" : "sm-num"}>
            <Value value={formatDate(r.next.due_at, r.timezone)} />
          </time>
        </button>
        {r.next.calendar_note ? <span className="sm-source"> · {r.next.calendar_note}</span> : null}
      </p>
    </Section>
  );
}

// 4 Needed from you
export function NeededSection({ r, link }: { r: BorrowerRecord; link: RecordLink }) {
  const items = r.needed_from_you;
  return (
    <Section id="needed" title={`Needed from you${items.length ? ` · ${items.length}` : ""}`}>
      {items.length === 0 ? (
        <p style={{ margin: 0 }} className="sm-primary-text" data-testid="needs-none">
          {copy("needs.none")}
        </p>
      ) : (
        <ul className="sm-list">
          {items.map((i) => (
            <li key={i.item_id}>
              <button type="button" className="sm-linkbtn" onClick={() => link({ card_instance_id: i.card_instance_id })}>
                {copyOrUndefined(i.label_copy_key, i.copy_tokens) ?? i.label}
              </button>
              {i.due_at ? (
                <time dateTime={i.due_at} className={`sm-muted${withinDays(i.due_at, 3) ? " sm-caution-text" : ""}`}>
                  by {formatDate(i.due_at, r.timezone)}
                </time>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <WhatWeAreDoing items={r.what_we_are_doing ?? []} />
    </Section>
  );
}

// 5 Numbers
export function NumbersSection({ r }: { r: BorrowerRecord }) {
  const n = r.numbers;
  if (!n) return null;
  if (n.phase === "post_funding") {
    return (
      <Section id="numbers" title="Numbers">
        <dl className="sm-kv">
          <dt>Balance</dt>
          <dd className="sm-big">
            <Value value={formatMoney(n.upb_cents)} />
          </dd>
          <dt>Next payment</dt>
          <dd>
            <Value value={formatMoney(n.next_payment.amount_cents)} /> on <time dateTime={n.next_payment.due_on}>{formatDate(`${n.next_payment.due_on}T12:00:00Z`, "UTC")}</time>
          </dd>
          <dt>Principal & interest</dt>
          <dd>
            <Value value={formatMoney(n.next_payment.pi_cents)} />
          </dd>
          <dt>Escrow</dt>
          <dd>
            <Value value={formatMoney(n.next_payment.escrow_cents)} />
          </dd>
          <dt>Escrow balance</dt>
          <dd>
            <Value value={formatMoney(n.escrow_balance_cents)} />
          </dd>
          <dt>Rate</dt>
          <dd>
            <Value value={formatRate(n.note_rate)} />
          </dd>
          {n.days_past_due > 0 ? (
            <>
              <dt>Days past due</dt>
              <dd className="sm-caution-text">{n.days_past_due}</dd>
            </>
          ) : null}
          {n.arm_estimate ? <ArmEstimateRows estimate={n.arm_estimate} /> : null}
        </dl>
      </Section>
    );
  }
  const hasAny = n.note_rate || n.rate_range || n.loan_amount_cents || n.pi_payment_cents;
  if (!hasAny) return null;
  const lockLine =
    n.lock.status === "executed" || n.lock.status === "confirmed"
      ? `Locked${n.note_rate ? ` ${formatRate(n.note_rate)}` : ""}${n.lock.expires_at ? ` through ${formatDate(n.lock.expires_at, r.timezone)}` : ""}`
      : n.lock.status === "pending_mlo_approval"
        ? "Lock pending your loan officer"
        : n.lock.status === "expired"
          ? "Lock expired"
          : n.lock.status === "floating"
            ? "Rate floating"
            : undefined;
  return (
    <Section id="numbers" title={`Numbers${n.figures_source !== "none" ? ` · ${n.figures_source.replace("_v", " v").toUpperCase()}` : ""}`}>
      <dl className="sm-kv">
        {n.rate_range && !n.note_rate ? (
          <>
            <dt>Estimated rate</dt>
            <dd>
              {formatRate(n.rate_range.low)} – {formatRate(n.rate_range.high)}
            </dd>
          </>
        ) : null}
        {n.note_rate ? (
          <>
            <dt>Rate</dt>
            <dd className="sm-big">
              <Value value={formatRate(n.note_rate)} />
            </dd>
          </>
        ) : null}
        {n.apr ? (
          <>
            <dt>APR (the yearly cost including fees)</dt>
            <dd>
              <Value value={formatRate(n.apr)} />
            </dd>
          </>
        ) : null}
        {n.pi_payment_cents ? (
          <>
            <dt>Principal & interest</dt>
            <dd>
              <Value value={`${formatMoney(n.pi_payment_cents)}/mo`} />
            </dd>
          </>
        ) : null}
        {n.escrow_payment_cents ? (
          <>
            <dt>Escrow (estimated)</dt>
            <dd>
              <Value value={`${formatMoney(n.escrow_payment_cents)}/mo`} />
            </dd>
          </>
        ) : null}
        {n.loan_amount_cents ? (
          <>
            <dt>Loan amount</dt>
            <dd>
              <Value value={formatMoney(n.loan_amount_cents, { whole: true })} />
            </dd>
          </>
        ) : null}
        {n.cash_to_close_cents ? (
          <>
            <dt>Cash to close</dt>
            <dd>
              <Value value={formatMoney(n.cash_to_close_cents)} />
            </dd>
          </>
        ) : null}
        {n.monthly_savings_cents ? (
          <>
            <dt>Monthly savings</dt>
            <dd className="sm-positive-text">
              <Value value={`${formatMoney(n.monthly_savings_cents)}/mo`} />
            </dd>
          </>
        ) : null}
        {lockLine ? (
          <>
            <dt>Lock</dt>
            <dd className={n.lock.expires_at && withinDays(n.lock.expires_at, 7) ? "sm-caution-text" : undefined}>
              <Value value={lockLine} />
            </dd>
          </>
        ) : null}
      </dl>
      {n.footer ? <p className="sm-source" style={{ marginBottom: 0 }}>{n.footer}</p> : null}
    </Section>
  );
}

// 6 Dates
export function DatesSection({ r, link }: { r: BorrowerRecord; link: RecordLink }) {
  if (r.dates.length === 0) return null;
  return (
    <Section id="dates" title="Dates">
      <ul className="sm-list">
        {r.dates.map((d) => (
          <li key={d.timer_code} data-timer-code={d.timer_code} data-tone={d.tone}>
            <span>
              {d.label}
              <span className="sm-source"> · {d.calendar}</span>
            </span>
            <button type="button" className="sm-linkbtn" onClick={() => link({ message_id: d.message_id })} disabled={!d.message_id}>
              <time dateTime={d.due_at} className={`sm-num${withinDays(d.due_at, 3) || d.tone === "caution" ? " sm-caution-text" : ""}`}>
                <Value value={formatDate(d.due_at, r.timezone)} />
              </time>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// 7 Documents
function docStatus(d: RecordDocument, tz: string): string {
  switch (d.status) {
    case "received":
      return `Received ${d.received_at ? formatDate(d.received_at, tz) : ""}`.trim();
    case "deemed_received":
      // 32.4 §1: the mailbox rule — "Received (deemed) {{date}}" (`le.deemed`), the date 21.2 computed
      return copy("le.deemed", { date: d.received_on ? formatDate(`${d.received_on}T12:00:00Z`, "UTC") : d.received_at ? formatDate(d.received_at, tz) : "" }).trim();
    case "mailed":
      return `Mailed ${d.mailed_at ? formatDate(d.mailed_at, tz) : ""}`.trim();
    case "delivered":
      return `Delivered ${d.delivered_at ? formatDate(d.delivered_at, tz) : ""}`.trim();
    case "superseded":
      return "Replaced";
    default:
      return "Pending";
  }
}

export function DocumentsSection({ r, link }: { r: BorrowerRecord; link: RecordLink }) {
  if (r.documents.length === 0) return null;
  return (
    <Section id="documents" title="Documents">
      <ul className="sm-list">
        {r.documents.map((d) => (
          <li key={d.document_id}>
            {d.status === "mailed" || d.status === "pending" ? (
              <span>{d.title}</span>
            ) : (
              <button type="button" className="sm-linkbtn" onClick={() => link({ document_id: d.document_id, message_id: d.message_id })}>
                {d.title}
              </button>
            )}
            <span className="sm-muted">
              <Value value={docStatus(d, r.timezone)} />
            </span>
            {d.deliveries?.length ? <PartyDeliveries deliveries={d.deliveries} timezone={r.timezone} /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// 8 People
function personLine(p: RecordPerson): string {
  const bits: string[] = [];
  if (p.nmlsr_id) bits.push(`NMLSR ID ${p.nmlsr_id}`);
  if (p.commission_state) bits.push(`Commissioned in ${p.commission_state}`);
  if (p.direct_number) bits.push(p.direct_number);
  if (p.waiting) bits.push("invited, waiting");
  if (p.progress) {
    const done = [p.progress.consents_ok && "consents", p.progress.confirmations_ok && "confirmations", p.progress.signed && "signed"].filter(Boolean);
    bits.push(done.length ? `${done.join(", ")} ✓` : "in progress");
  }
  return bits.join(" · ");
}
const ROLE_LABEL: Record<RecordPerson["role"], string> = {
  borrower: "Borrower",
  co_borrower: "Co-borrower",
  non_borrowing_spouse: "Non-borrowing spouse",
  mlo_of_record: "Loan officer",
  human_agent: "Your contact",
  notary: "Notary",
  settlement_agent: "Settlement agent",
  continuity_of_contact_team: "Your team",
  appraiser: "Appraiser",
};

export function PeopleSection({ r }: { r: BorrowerRecord }) {
  if (r.people.length === 0) return null;
  return (
    <Section id="people" title="People">
      <ul className="sm-list">
        {r.people.map((p) => (
          <li key={p.party_id}>
            <span>
              {p.display_name} <span className="sm-source">· {ROLE_LABEL[p.role]}</span>
            </span>
            <span className="sm-muted">
              <Value value={personLine(p)} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// 9 Property
export function PropertySection({ r }: { r: BorrowerRecord }) {
  const p = r.property;
  if (!p) return null;
  const rows: [string, string][] = [];
  if (p.property_type) rows.push(["Type", `${p.property_type}${p.units ? ` · ${p.units} unit${p.units === 1 ? "" : "s"}` : ""}`]);
  if (p.occupancy) rows.push(["Occupancy", p.occupancy === "primary" ? "Primary home" : p.occupancy === "second_home" ? "Second home" : "Investment"]);
  if (p.valuation) rows.push(["Valuation", p.valuation.label ?? propertyStateLabel("valuation", p.valuation.status)]);
  if (p.flood) rows.push(["Flood zone", p.flood.label ?? propertyStateLabel("flood", p.flood.status)]);
  if (p.hazard) rows.push(["Insurance", p.hazard.label ?? propertyStateLabel("hazard", p.hazard.status)]);
  if (p.project_review) rows.push(["Project review", p.project_review.label ?? propertyStateLabel("project_review", p.project_review.status)]);
  if (p.hoa_dues_cents) rows.push(["HOA", `${formatMoney(p.hoa_dues_cents)}/mo`]);
  if (rows.length === 0) return null;
  return (
    <Section id="property" title="Property">
      <dl className="sm-kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// 10 Loan (servicing)
export function LoanSection({ r }: { r: BorrowerRecord }) {
  const l = r.loan;
  if (!l) return null;
  const rows: [string, string][] = [];
  if (l.autodraft) {
    // 32.12: an enrollment ending with a transfer out shows its end date; a terminated one (payoff / transfer) says so — the stored dates, never computed here
    const next = l.autodraft.status === "active" && l.autodraft.amount_cents && l.autodraft.next_draft_on ? copy("autopay.next", { money: formatMoney(l.autodraft.amount_cents), date: formatDate(`${l.autodraft.next_draft_on}T12:00:00Z`, "UTC"), last4: l.autodraft.account_last4 ?? "" }) : null;
    const exit = autopayExitLine(l.autodraft);
    rows.push(["Autopay", exit ? [next, exit].filter(Boolean).join(" ") : (next ?? l.autodraft.status)]);
  }
  for (const line of l.escrow_lines ?? []) {
    rows.push([`Escrow · ${line.type}`, `${line.payee} · ${formatMoney(line.annual_cents)}/yr${line.next_disbursement_on ? ` · next ${formatDate(`${line.next_disbursement_on}T12:00:00Z`, "UTC")}` : ""}`]);
  }
  if (l.mi) rows.push(["Mortgage insurance", `${l.mi.status}${l.mi.projected_end_on ? ` · ends ${formatDate(`${l.mi.projected_end_on}T12:00:00Z`, "UTC")}` : ""}`]);
  if (l.arm) rows.push(["Rate change", `${formatDate(`${l.arm.next_change_on}T12:00:00Z`, "UTC")} · ${l.arm.notice_status}`]);
  if (l.year_end) rows.push(["Form 1098", form1098Label(l.year_end, r.timezone)]);   // 32.8 §5: *Mailed {{date}}* without `irs_estatement` consent
  if (l.continuity_team) rows.push(["Your team", `${l.continuity_team.name} · ${l.continuity_team.direct_number}`]);
  if (l.ratewatch) rows.push(["Rate-watch", copy("ratewatch.block", { rate: [formatRate(l.ratewatch.current_rate), formatRate(l.ratewatch.best_available_rate)] })]);
  for (const row of rateWatchDetailRows(l)) rows.push(row);   // 32.11: what "worth it" means, the block's state, the standing connections (components/flows/11-rate-watch)
  for (const row of hardshipRows(l.hardship)) rows.push(row);   // 32.10: trial payment / paused period / cease (components/flows/10-hardship)
  if (rows.length === 0) return null;
  return (
    <Section id="loan" title="Loan">
      <dl className="sm-kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd style={{ textAlign: "left" }}>
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export { mask4 };
