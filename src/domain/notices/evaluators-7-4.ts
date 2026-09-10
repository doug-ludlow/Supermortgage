/**
 * §7.4 gate evaluators, keyed "7.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-7-4.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there. Both gates are asserted by the 7.4 ops
 * (ops-7-4.ts `decideNoticeChannel` / `requestForm1098Furnish`) at the moment the decision event is appended, so the
 * reason recorded on `notice.channel_decision` / `tax_form.1098.furnish_requested` is the evaluator's own.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export interface ChannelRecipientFact { readonly party_id: string; readonly consent_active: boolean; readonly covers_class: boolean; }

export const EVALUATORS_7_4: Record<string, Evaluator> = {
  /**
   * ESIGN_7001C_CONSENT_GATE — "requires `consents(kind=esign, scope ∋ class, status=active)` for every intended
   * recipient" (15 U.S.C. §7001(c)(1)(A)); a state-mandated-mail notice (rule "Jurisdiction overrides", T10) never opens
   * the gate regardless of consent. Closed → "fall back to mail (no breach; logged)".
   */
  "7.4.esignConsentActiveForEveryRecipient": (f) => {
    if (b(f, "state_mandated_mail")) return no("state-mandated mail notice: channel is mail regardless of consent (7.4-T10)");
    const recipients = arr<ChannelRecipientFact>(f, "recipients");
    if (!recipients.length) return no("no intended recipients");
    const lacking = recipients.filter((r) => !r.consent_active || !r.covers_class);
    return lacking.length ? no(`no active E-SIGN consent covering the class for ${lacking.map((r) => r.party_id).join(", ")}`) : ok;
  },
  /** IRS_1098_ECONSENT_GATE — "requires `consents(kind=irs_estatement, status=active)`" (Treas. Reg. §1.6050H-2; rule 11): `periodic_statements` consent is not IRS consent (T9). */
  "7.4.irsEstatementConsentActive": (f) => (b(f, "irs_estatement_consent_active") ? ok : no("electronic 1098 needs an active irs_estatement consent (a periodic_statements consent does not qualify — 7.4 rule 11)")),
};
export const kit_7_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
