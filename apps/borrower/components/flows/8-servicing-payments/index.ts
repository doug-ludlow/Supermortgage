/**
 * 32.8 — Servicing: loan home, payments, autopay, statements, escrow: the flow-specific UI. The shell renders whatever
 * cards the API creates (src/runtime/borrower/flows/8-servicing-payments.ts); these helpers carry what a plain card
 * cannot: the PaymentCard's title from its copy key (`payment.due` / `payment.another_way`, 32.8 §3.1), the check that an
 * autopay ConsentCard shows every 2.x rule-1 element (T5), and the Loan section's year-end row (*Mailed {{date}}*, T11).
 * Nothing here computes a date or an amount — every value is the owning process's, passed through as it was sent.
 */
import { copyOrUndefined, type Tokens } from "@/lib/copy";
import { formatDate } from "@/lib/format";

/** 2.3 rule 1 / 32.8 §4: the elements an autodraft authorization must display, by element id (32.7's ConsentElements renders them). */
export const AUTOPAY_ELEMENT_IDS = ["borrower", "loan", "account", "amount", "amount_variable", "timing", "first_debit", "company", "revoke", "date", "esign"] as const;

/** The 2.x rule-1 element ids an autopay ConsentCard's `elements` leave out ([] when complete) — T5. */
export function autopayElementsMissing(elements: readonly { id: string }[] | undefined): string[] {
  const ids = new Set((elements ?? []).map((e) => e.id));
  return AUTOPAY_ELEMENT_IDS.filter((id) => !ids.has(id));
}

/** A PaymentCard's heading: the literal title, else its copy key with the server's tokens, else the mode's default. */
export function paymentTitle(copyKey: string, p: { title?: string; mode: string; copy_tokens?: Tokens }): string {
  return p.title || copyOrUndefined(copyKey, p.copy_tokens) || (p.mode === "extra_principal" ? "Extra principal" : p.mode === "autopay_change" ? "Change autopay" : "Make a payment");
}

/** 32.8 §5: the Loan section's "Form 1098" value — *Mailed {{date}}* without `irs_estatement` consent, *Available* electronically, else the status as sent. */
export function form1098Label(y: { form_1098_status: string; furnished_on?: string | null; tax_year?: number | string | null }, timezone?: string): string {
  const when = y.furnished_on ? ` ${formatDate(`${y.furnished_on}T12:00:00Z`, timezone ?? "UTC")}` : "";
  const year = y.tax_year ? ` (${y.tax_year})` : "";
  if (y.form_1098_status === "mailed") return `Mailed${when}${year}`;
  if (y.form_1098_status === "available") return `Available${when}${year}`;
  if (y.form_1098_status === "pending") return "Ready by January 31";
  return y.form_1098_status;
}
