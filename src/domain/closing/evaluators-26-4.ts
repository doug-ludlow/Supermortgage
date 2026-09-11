/**
 * §26.4 gate evaluators, keyed "26.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-26-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are the `note_endorsements` row and the note's identifiers as prepareShipment (ops-26-4.ts) sees them.
 */
import { ok, no, s, c, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { ensureEndorsement, type NoteEndorsement, type NoteFacts } from "./ops-26-4.ts";

export const EVALUATORS_26_4: Record<string, Evaluator> = {
  /** SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE (B8-3-04 / RDC §8): printed facsimile with the four-document authority file for the property's state, or a pre-executed allonge affixed whose identifiers match the note; else the endorsement desk. */
  "26.4.endorsementBeforeShipGate": (f) => {
    const e = (f.endorsement as NoteEndorsement | null | undefined) ?? null;
    const n = f.note as Partial<NoteFacts> | undefined;
    if (!n || typeof n.note_date !== "string" || !n.partner_legal_name) return no("note facts (note_date, note_amount_cents, borrower_names, property_address, property_state, partner_legal_name) required");
    const note: NoteFacts = { borrower_names: Array.isArray(n.borrower_names) ? n.borrower_names : [], note_date: plainDate(n.note_date), note_amount_cents: c(n as Record<string, unknown>, "note_amount_cents"), property_address: s(n as Record<string, unknown>, "property_address"), property_state: s(n as Record<string, unknown>, "property_state"), partner_legal_name: n.partner_legal_name };
    const g = ensureEndorsement(e, note);
    return g.open ? ok : no(`${g.reason} (route: ${g.route})`);
  },
};
