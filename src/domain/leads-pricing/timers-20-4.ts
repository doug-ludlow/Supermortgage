/**
 * §20.4 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 20.4 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by src/domain/timer-overrides.ts.
 *
 * Emitters live in src/domain/leads-pricing/ops-20-4.ts (the `pricing` agent's rules; every payload carries
 * `origination: true` so the origination rows arm): `rate_sheet.published{source, status, published_on, expires_at}`
 * (publishRateSheet), `quote.created{quoted_on, valid_until, expected_purchase_ready_date}` (priceQuote),
 * `quote.render.requested` / `quote.rendered{disclaimer_verified=true}` / `quote.render.blocked` (gateRender),
 * `pricing.exception.requested{requested_on, due_on}` (requestException), `pricing.exception.decided{outcome}`
 * (decideException / autoDenyException), `fee_schedule.refreshed{refreshed_on}` (refreshFeeSchedule).
 * Referenced, never redefined: `SM_MLO_PREAPP_TERMS_REVIEW_1BH` (20.3 owns — requestTermsReview emits its trigger
 * `terms.presentation.requested` and presentQuote consumes `mlo.review.completed`), `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`
 * (21.4 owns — arms on 21.4's `lock.executed`, which markQuoteLocked consumes).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_20_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Rule 1 / timer table row 1: the daily publish is a recurring clock re-armed by each publish (06:35 ET after the PE–WL maintenance window); an intra-day ≥ 12.5 bps move republishes early (republishNeeded) and re-anchors it.
  o("SM_RATE_SHEET_PUBLISH_DAILY", { trigger: "`rate_sheet.published{status=active}`", anchorField: "published_on", offset: "+1 calendar_days, 06:35 ET",
    why: "§20.4 timer table: recurring, anchor '06:35 America/New_York (after PE–WL maintenance 06:00–06:30)', offset '1 calendar_days; also on ≥ 12.5 bps intra-day move', satisfied by `rate_sheet.published`, breach 'no quotes until published; sev 2; operator UI read fallback' — the column has no trigger ('—'); publishRateSheet appends `rate_sheet.published{status=active, published_on}` (daily 06:35 ET, on a ≥ 12.5 bps move, or from the Browse Prices / manual_ui_read fallback), and the recurring row re-arms from each publish (spec: 'daily publish at 06:35 ET plus intra-day republishes')." });
  // Rule 6 / T5: a window gate — valid until min(sheet expiry, quoted_at + 24 h) — condition-shaped over the quote's `valid_until`; a lock (21.4) inside the window satisfies it, after it the quote expires and is re-quoted.
  o("SM_QUOTE_VALIDITY_GATE", { evaluator: "20.4.quoteValidityGate", anchorField: "quoted_on", satisfied: "`lock.executed`",
    why: "§20.4 timer table: not_before_gate (window) on `quote.created`, anchor quoted_at, offset 'valid until min(`rate_sheets.expires_at`, quoted_at + 24 h); consumer text: \"rates change daily; valid today until 5:00 p.m. ET\"', satisfied by 'lock (21.4) inside window', breach 'quote `expired`; re-quote from the current sheet' — quoteValidity computes `valid_until` onto `quote.created`; evaluators-20-4.ts quoteValidityGate opens while now ≤ valid_until (lockWindowCheck refuses a lock request after it with `quote_expired` and lockOrRequote re-quotes from the sheet in force — T5); 21.4's executeLock appends `lock.executed`." });
  // Timer table row 3: the Loan Pricing API quote id is usable until the expiry the response carries ([UNVERIFIED duration]); the Loan Committing API call (21.4/29.1 `commitment.executed`) closes the window.
  o("FNMA_PEWL_QUOTE_ID_WINDOW", { trigger: "`rate_sheet.published{source=pe_whole_loan_api}`", anchorField: "published_on", evaluator: "20.4.peWlQuoteIdWindow", satisfied: "`commitment.executed`",
    why: "§20.4 timer table: not_before_gate (window) on 'Loan Pricing API response', anchor `pe_wl_quote_expires_at`, offset 'per API response **[UNVERIFIED duration]**', satisfied by 'Loan Committing API call (21.4/29.1)', breach 're-price before commit' — the API response is published as a `rate_sheet.published{source=pe_whole_loan_api}` sheet whose prices carry `pe_wl_quote_id` / `pe_wl_quote_expires_at` (verification report item 17: the duration sits behind the Developer Portal, so the gate reads the expiry from the response); evaluators-20-4.ts peWlQuoteIdWindow opens while now ≤ pe_wl_quote_expires_at; 21.4 / 29.1 append `commitment.executed` from the Loan Committing API call." });
  // Rule 2 / T7: the matrix version is chosen by the forecast Purchase Ready date; a staged future version is used with `matrix_change_exposure`; no covering version → refused.
  o("SM_LLPA_TABLE_VERSION_GATE", { evaluator: "20.4.llpaTableVersionGate", anchorField: "expected_purchase_ready_date",
    why: "§20.4 timer table: not_before_gate on `quote.created`, anchor `expected_purchase_ready_date`, offset 'matrix version whose `effective_from ≤ expected_purchase_ready_date < effective_to`; if a newer version is announced with a future date the quote uses it and flags `matrix_change_exposure`', breach 'quote refused if no active table' — selectLlpaVersion (evaluators-20-4.ts llpaTableVersionGate) picks the version and computeLlpa carries the flag; a date no version covers is `QuoteRefused(no_active_table)` (LLPA Matrix: 'calculated on the Purchase Ready date … based on the unpaid principal balance')." });
  // Rule 7 / T4: the §1026.19(e)(2)(ii) statement at the top of page 1 in ≥ 12-pt and no H-24/H-25 resemblance — checked on the rendered blocks; a passing render closes the gate, a failing one blocks the document (sev 1).
  o("REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE", { trigger: "`quote.render.requested`", evaluator: "20.4.quoteDisclaimerGate", satisfied: "`quote.rendered{disclaimer_verified=true}`",
    why: "§20.4 timer table: not_before_gate on 'render of any consumer-specific written estimate before the LE', offset '`NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER` on top of page 1, ≥ 12-pt; template dissimilarity check vs H-24/H-25', breach 'render blocked; sev 1' — 12 CFR 1026.19(e)(2)(ii): the statement 'at the top of the front of the first page' in 'no smaller than 12-point font', and the estimate 'may not be made with headings, content, and format substantially similar to form H-24 or H-25'; gateRender appends `quote.render.requested`, evaluates disclaimerGate over the rendered blocks (evaluators-20-4.ts quoteDisclaimerGate) and appends `quote.rendered{disclaimer_verified=true}` or `quote.render.blocked{reasons}`." });
  // Rule 8 / T6: the officer's decision — approved or denied — is one `pricing.exception.decided{outcome}`; a breach auto-denies (autoDenyException emits the same event with outcome=denied).
  o("SM_PRICING_EXCEPTION_APPROVAL_1BD", { anchorField: "requested_on", satisfied: "`pricing.exception.decided{outcome∈{approved, denied}}`",
    why: "§20.4 timer table: deadline (escalation SLA) on `pricing.exception.requested`, anchor requested_at, '+1 business_days_servicer', satisfied by '`officer` decision', breach 'auto-denied; consumer re-quoted at policy price' — requestException appends the trigger with `requested_on` and `due_on` (next servicer business day; relationship exceptions are refused by policy); decideException (partner secondary `officer`) appends `pricing.exception.approved` / `.denied` plus `pricing.exception.decided{outcome}`; the quote stays at policy price until approval (applyManualPrice)." });
  // Timer table row 7: the jurisdiction fee tables refresh every 30 days; each refresh re-arms the recurring row from its own `refreshed_on`.
  o("SM_FEE_SCHEDULE_REFRESH_30", { anchorField: "refreshed_on",
    why: "§20.4 timer table: recurring on `fee_schedule.refreshed`, anchor refreshed_at, '+30 calendar_days (jurisdiction tables); vendor quotes per transaction', satisfied by `fee_schedule.refreshed`, breach 'LE fees flagged `stale_source` to 21.2; sev 3' — refreshFeeSchedule appends the event with `refreshed_on`; buildFeeItems marks items from a schedule older than 30 days `stale_source=true` for 21.2 (rule 11)." });
}
