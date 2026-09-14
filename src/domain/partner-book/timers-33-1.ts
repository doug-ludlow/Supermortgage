/**
 * §33.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 33.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * `SM_PARTNER_BOOK_INVITATION_REMINDER_14` needs no override: the registry row parses as written — trigger
 * `partner_book.invitation.sent{kind=invitation}` (src/kernel/events/match.ts parses the `{kind=invitation}` payload
 * filter into a `=` condition the engine applies with eventMatches), anchor `sent_at` (a payload field), offset
 * `+14 calendar_days`, satisfied `partner_book.account.activated` — so `npm run spec:lint -- --verbose` lists it under
 * neither "unparsed triggers" nor "still unarmable" nor "not satisfiable", and tools/audit.py sees it armable and
 * satisfiable. It is a section-33 (≥ 20) row, so the engine arms it only for an event carrying origination context
 * (src/kernel/timers/engine.ts isOriginationContext: `origination: true` on every 33.x payload); the instance's subject
 * is the event's aggregate — a loan-scoped `partner_book.invitation.sent{loan_id}` arms a `{loan, <loan_id>}` clock and a
 * loan-scoped `partner_book.account.activated` on the same loan satisfies it (sameSubject). Breach action (spec timer
 * table: "sev 3 → `portfolio` (one reminder on the same channel, then the clock closes)") is src/runtime/partner-book.ts
 * sendPartnerBookReminders, run from the sweep's breach pass — not a registry concern.
 *
 * `SM_PARTNER_BOOK_TAPE_EXPECTED_7` (rule 8) is overridden below: `subject: "global"` — the row parses as written (trigger and satisfied
 * `partner_book.import.completed`, anchor `as_of_date`, +7 calendar_days) but its aggregate is the import row, so the clock must live on
 * the platform subject for the next import to satisfy and re-arm it — and `{status=loaded}` on both patterns (review finding): the
 * rejected branch of src/runtime/partner-book.ts emits the same event type with `status: "rejected"`, and rule 8 says the NEXT TAPE
 * satisfies the clock while a rejected file "writes nothing" (state machine) — without the condition a wrong-layout upload satisfied
 * and re-armed the clock from its own as-of date, masking a late book instead of escalating it.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_33_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 2: the partner's next tape is a recurring clock on the platform, not on the import that armed it — `partner_book.import.completed`'s
  // aggregate is the import row ({partner_book_import, <id>}), which the NEXT import never shares, so without the override the clock could never be
  // satisfied; armed on the global subject (the same pattern as 33.2's SM_PARTNER_BOOK_REVIEW_DAILY, src/domain/partner-book/timers-33-2.ts).
  o("SM_PARTNER_BOOK_TAPE_EXPECTED_7", { trigger: "`partner_book.import.completed{status=loaded}`", satisfied: "`partner_book.import.completed{status=loaded}`", anchorField: "as_of_date", offset: "+7 calendar_days", subject: "global",
    why: "§33.1 timer table: recurring on `partner_book.import.completed`, anchor `as_of_date`, offset '+7 calendar_days', satisfied by `partner_book.import.completed`, breach 'sev 3 → `ops_analyst` (the partner's next tape is late; the book is stale)'. Only a LOADED import is a tape (`{status=loaded}`): the state machine's `rejected` 'writes nothing', so a wrong-layout file neither satisfies nor re-arms the clock. Rule 8: 'The partner sends its tape on a cadence (weekly for the first partner); `partner_book.import.completed` arms `SM_PARTNER_BOOK_TAPE_EXPECTED_7` on the global subject from the tape's as-of date and the next import satisfies and re-arms it; a breach is an `ops_analyst` escalation (`partner_book.tape.late{partner_id, last_as_of_date, expected_by}`) and the console shows \"book as of <date>, next expected <date>\"'. T12: 'armed on the global subject with `due_at` 7 calendar days after the as-of date; given a second import 5 days later, then the clock is satisfied and re-armed from the new as-of date; given no import by the due date, when the sweep passes, then it reads `breached`, one `ops_analyst` escalation and `partner_book.tape.late` exist, and a second sweep adds nothing'. The event's payload carries `origination: true` so the section-33 clock arms; the breach action is src/runtime/partner-book.ts notifyPartnerBookTapeLate, run from the sweep after its breach pass — the partner and the last as-of date come from the `partner_book.import.completed` event that armed the clock." });
}
