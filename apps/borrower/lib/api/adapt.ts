/**
 * 32.13: the seam between the borrower API's wire shapes (src/runtime/borrower/serialize.ts — the allow-listed
 * `me`, `record`, `thread` responses) and the shell's types (lib/types/record.ts, transcribed from 02 §1). The API
 * sends exactly what 02 §1.1 names; the shell adds the few presentation fields 01 §4 derives (the header line, the
 * borrower's time zone, the numbers phase) and never computes a date, an amount or a rate itself (T-X-02, T-X-09):
 * every cents value and every rate is passed through as the decimal string the API sent.
 */
import type { AnyCardInstance, CardKind, Cents } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, LockBlock, RecordSubject, ThreadMessage } from "@/lib/types/record";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isCents = (v: unknown): v is Cents => typeof v === "string" && /^-?\d+$/.test(v);
const isRate = (v: unknown): v is string => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v);

/** The Record's subject key as the shell spells it ("loan:<uuid>" / "application:<uuid>") → the API's `?subject=<uuid>`. */
export function subjectId(subject: string): string {
  return subject.replace(/^(loan|application):/, "");
}

export function toMe(api: Json): BorrowerMe {
  const party = obj(api.party);
  const partner = obj(api.partner);
  const subjects = (Array.isArray(api.subjects) ? api.subjects : []).map((s) => toSubject(obj(s)));
  return {
    party_id: str(party.party_id),
    first_name: str(party.first_name) || str(party.display_name).split(" ")[0] || "",
    level: (str(api.level) as BorrowerMe["level"]) || "L1",
    subjects,
    partner: { legal_name: str(partner.legal_name) || "Supermortgage", nmlsr_id: str(partner.nmlsr_id) },
  };
}

function toSubject(s: Json): RecordSubject {
  const tt = str(s.transaction_type);
  return {
    ...(str(s.application_id) ? { application_id: str(s.application_id) } : {}),
    ...(str(s.loan_id) ? { loan_id: str(s.loan_id) } : {}),
    label: str(s.label),
    transaction_type: tt === "purchase" || tt === "cash_out" ? tt : "limited_cash_out",
    occupancy: str(s.occupancy) === "second_home" || str(s.occupancy) === "investment" ? (str(s.occupancy) as RecordSubject["occupancy"]) : "primary",
  };
}

/** `state_source` arrives as "table.column=state"; the shell shows it as {table, state}. */
function stateSource(v: unknown): { state: string; table: string } {
  if (v && typeof v === "object") return { state: str(obj(v).state), table: str(obj(v).table) };
  const s = str(v);
  const eq = s.indexOf("=");
  return eq >= 0 ? { table: s.slice(0, eq), state: s.slice(eq + 1) } : { table: s, state: "" };
}

function toNumbers(n: Json | null, stage: string): BorrowerRecord["numbers"] {
  if (!n) return undefined;
  if (stage === "servicing" || isCents(n.upb_cents)) {
    const np = obj(n.next_payment);
    if (!isCents(n.upb_cents) || !isCents(np.amount_cents) || !isRate(n.note_rate)) return undefined; // a paid-off or not-yet-boarded loan: no figures to show, nothing computed here
    return {
      phase: "post_funding",
      upb_cents: n.upb_cents,
      next_payment: { due_on: str(np.due_on), amount_cents: np.amount_cents, pi_cents: isCents(np.pi_cents) ? np.pi_cents : "0", escrow_cents: isCents(np.escrow_cents) ? np.escrow_cents : "0" },
      escrow_balance_cents: isCents(n.escrow_balance_cents) ? n.escrow_balance_cents : "0",
      note_rate: str(n.note_rate),
      days_past_due: typeof n.days_past_due === "number" ? n.days_past_due : 0,
    };
  }
  const lock = obj(n.lock);
  const status = str(lock.status);
  return {
    phase: "pre_funding",
    ...(str(n.note_rate) ? { note_rate: str(n.note_rate) } : {}),
    ...(str(n.apr) ? { apr: str(n.apr) } : {}),
    ...(isCents(n.pi_payment_cents) ? { pi_payment_cents: n.pi_payment_cents } : {}),
    ...(isCents(n.escrow_payment_cents) ? { escrow_payment_cents: n.escrow_payment_cents } : {}),
    ...(isCents(n.loan_amount_cents) ? { loan_amount_cents: n.loan_amount_cents } : {}),
    ...(isCents(n.cash_to_close_cents) ? { cash_to_close_cents: n.cash_to_close_cents } : {}),
    ...(isCents(n.monthly_savings_cents) ? { monthly_savings_cents: n.monthly_savings_cents } : {}),
    lock: {
      status: (["none", "requested", "pending_mlo_approval", "executed", "confirmed", "expired", "floating"].includes(status) ? status : "none") as LockBlock["status"],
      ...(str(lock.expires_at) ? { expires_at: str(lock.expires_at) } : {}),
      ...(typeof lock.period_days === "number" ? { period_days: lock.period_days } : {}),
    },
    figures_source: (str(n.figures_source) || "none") as "none",
  };
}

export function toRecord(api: Json): BorrowerRecord {
  const subject = toSubject(obj(api.subject));
  const stage = str(obj(api.subject).stage);
  const status = obj(api.status);
  const property = obj(api.property);
  const loan = obj(api.loan);
  const address = str(property.address);
  const purpose: BorrowerRecord["header"]["purpose"] = stage === "servicing" ? "Your loan" : subject.transaction_type === "purchase" ? "Buying" : "Refinancing";
  const next = api.next && typeof api.next === "object" ? (api.next as BorrowerRecord["next"]) : undefined;
  return {
    subject,
    status: { badge: str(status.badge) as BorrowerRecord["status"]["badge"], state_source: stateSource(status.state_source), one_liner: str(status.one_liner), ...(status.one_liner_tokens && typeof status.one_liner_tokens === "object" ? { one_liner_tokens: status.one_liner_tokens as Record<string, string | string[]> } : {}) },   // 32.8 §2: the badge one-liner's tokens
    ...(next ? { next } : {}),
    needed_from_you: (Array.isArray(api.needed_from_you) ? api.needed_from_you : []) as BorrowerRecord["needed_from_you"],
    ...(toNumbers(api.numbers && typeof api.numbers === "object" ? (api.numbers as Json) : null, stage) ? { numbers: toNumbers(api.numbers as Json, stage) } : {}),
    dates: (Array.isArray(api.dates) ? api.dates : []) as BorrowerRecord["dates"],
    documents: (Array.isArray(api.documents) ? api.documents : []).map((d) => ({ ...obj(d), requires_ack: obj(d).requires_ack === true, title: str(obj(d).title) || str(obj(d).kind) })) as unknown as BorrowerRecord["documents"],
    people: (Array.isArray(api.people) ? api.people : []).map((p) => ({ ...obj(p), party_id: str(obj(p).party_id) || `${str(obj(p).role)}:${str(obj(p).display_name)}`, progress: obj(p).progress && typeof obj(p).progress === "object" ? obj(p).progress : undefined })) as unknown as BorrowerRecord["people"],
    ...(api.property ? { property: { ...property, tbd: !address, ...(address ? { address } : {}), ...(isCents(property.hoa_dues_cents) ? {} : { hoa_dues_cents: undefined }) } as unknown as NonNullable<BorrowerRecord["property"]> } : {}),
    ...(api.loan
      ? {
          loan: {
            ...loan,
            ...(Array.isArray(loan.escrow_lines) ? { escrow_lines: loan.escrow_lines.filter((l) => isCents(obj(l).annual_cents)) } : {}),
            ...(loan.mi && str(obj(loan.mi).status) && str(obj(loan.mi).status) !== "none" ? { mi: obj(loan.mi) } : { mi: undefined }),
            ...(loan.arm ? {} : { arm: undefined }),
            ...(loan.continuity_team ? {} : { continuity_team: undefined }),
            ...(loan.autodraft ? {} : { autodraft: undefined }),
            ...(isRate(obj(loan.ratewatch).current_rate) && isRate(obj(loan.ratewatch).best_available_rate) ? {} : { ratewatch: undefined }),
          } as unknown as NonNullable<BorrowerRecord["loan"]>,
        }
      : {}),
    offers: (Array.isArray(api.offers) ? api.offers : []) as BorrowerRecord["offers"],
    header: { address_line: address, purpose, loan_label: subject.label },
    timezone: str(api.time_zone) || "America/Phoenix",
    ...(api.read_only === true ? { read_only: true } : {}),
  };
}

/** The thread as the API sends it (messages carrying their card) → the shell's messages + card map. */
export function toThread(api: Json): { messages: ThreadMessage[]; cards: AnyCardInstance[]; next_after?: string } {
  const messages: ThreadMessage[] = [];
  const cards: AnyCardInstance[] = [];
  for (const raw of Array.isArray(api.messages) ? api.messages : []) {
    const m = obj(raw);
    const subject = obj(m.subject);
    const msg: ThreadMessage = {
      message_id: str(m.message_id),
      conversation_id: str(m.conversation_id) || str(api.conversation_id),
      at: str(m.at),
      sender: (str(m.sender) as ThreadMessage["sender"]) || "system",
      sender_label: str(m.sender_label) || "Supermortgage",
      channel: (str(m.channel) as ThreadMessage["channel"]) || "app",
      ...(str(m.body_text) ? { body_text: str(m.body_text) } : {}),
      ...(str(m.card_instance_id) ? { card_instance_id: str(m.card_instance_id) } : {}),
      subject: { ...(str(subject.application_id) ? { application_id: str(subject.application_id) } : {}), ...(str(subject.loan_id) ? { loan_id: str(subject.loan_id) } : {}), ...(str(subject.label) ? { label: str(subject.label) } : {}) },
      voice_turn: m.voice_turn === true,
      delivery: { sent: true, delivered: true, read: obj(m.delivery).read === true },
      ...(m.automation_marker === true ? { automation_marker: true } : {}),
    };
    messages.push(msg);
    const c = m.card && typeof m.card === "object" ? obj(m.card) : null;
    if (c && str(c.card_instance_id)) {
      cards.push({
        card_instance_id: str(c.card_instance_id),
        conversation_id: msg.conversation_id,
        party_id: str(c.party_id),
        subject: msg.subject,
        kind: str(c.kind) as CardKind,
        status: (str(c.status) as AnyCardInstance["status"]) || "pending",
        created_by: (str(c.created_by) || "system") as AnyCardInstance["created_by"],
        copy_key: str(c.copy_key),
        created_at: str(c.created_at) || msg.at,
        ...(str(c.resolved_at) ? { resolved_at: str(c.resolved_at) } : {}),
        ...(str(c.command_ref) ? { command_ref: str(c.command_ref) } : {}),
        ...(str(c.expires_at) ? { expires_at: str(c.expires_at) } : {}),
        ...(c.evidence && typeof c.evidence === "object" ? { evidence: obj(c.evidence) } : {}),
        props: obj(c.props),
      } as unknown as AnyCardInstance);
    }
  }
  return { messages, cards, ...(str(api.next_after) ? { next_after: str(api.next_after) } : {}) };
}
