# 18.3 — STAR performance measurement

| Attribute | Value |
|---|---|
| Section | 18 — QC, Audit & Regulatory Reporting |
| Automation class | b |
| Trigger & frequency | Annual |
| Governing source | FNMA STAR program |
| Key deadlines | Annual |
| Timers | `SM_STAR_COMPUTE_MONTHLY_BD5`, `SM_STAR_CONFIG_ANNUAL_JAN`, `SM_STAR_PARTNER_REPORT_MONTHLY`, `SM_STAR_RECON_10BD`, `SM_STAR_SCORECARD_INGEST_5BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | QC/Audit |
| Trigger & frequency | Annual |
| Governing source (blueprint) | FNMA STAR program |
| Key deadlines (blueprint) | Annual |
| Data/artifacts | STAR scorecard |
| Systems | Fannie Mae Connect |
| Automation class (blueprint) | b |
| SoR / Sub | "SoR is [scored…]" [cropped in source] — reconstructed: the SoR is scored on the **Master Servicing view** ("all loans where that servicer owns the Mortgage Servicing Rights (MSRs), regardless of whether a sub-servicer is employed"); Supermortgage's work appears in the partner's Master view and in Supermortgage's own **Acting Servicing view** ("all loans where the servicer is responsible for servicing activities, regardless of whether they own the MSRs or are the sub-servicer"); peer-group inclusion is by loan count as of January 1 (Select ≥ 40,000) |
| Nuances (blueprint) | [cropped in source] — reconstructed: monthly scorecards in Fannie Mae Connect (report id 511), not annual; results are confidential ("a servicer may not disclose STAR Scorecard results to any third parties"), so partner↔Supermortgage sharing must be covered by the subservicing agreement; 2026 metric set and weights; transfers excluded from transferor in the transfer month and from the transferee for two months; no score where a metric's denominator is under 30 loans |

### Verified requirement (as of 2026-09-09)

**STAR program page and FAQs (FAQ updated Apr. 6, 2026).** "The STAR Program is a performance management and recognition program based on a consistently applied framework to clearly define industry standards and leading practices." Peer groups by total Fannie Mae loan count: **Strategic ≥ 450,000; Premier 130,000–449,999; Select 40,000–129,999**; "Servicers meeting the inclusion criteria as of January 1, 2026, will remain in that peer group … throughout 2026, even if the acting servicer volume changes"; "The STAR team selects servicers based on criteria that identifies servicers who manage higher levels of credit risk for Fannie Mae due to their total portfolio size"; solicitations for inclusion are not accepted. **Scorecard:** "designed to help our servicers quickly identify opportunities for improvement by comparing a servicer's performance relative to other servicers based on set thresholds or relative to a comparable portfolio"; published in Fannie Mae Connect ("View your Scorecard" → connect.fanniemae.com report-center, `reportId=511`); email subscription available. **2026 changes:** investor-reporting metrics moved to supplemental; 10 supplemental metrics removed; two disaster metrics added (Disaster Forbearance Take-up Rate; Disaster 30+ to Cure); "No scores for metrics with <30 loans in denominator"; Retention Efficiency now excludes self-cures/full payoffs, credits repayment-plan initiations and excludes loans in active repayment plans as of the base month; 60+ to Cure excludes loans in active repayment plans as of the base month. **Weights — Strategic/Premier:** Transition to 60+ 30%, 60+ to Cure 25%, Retention Efficiency 15%, 6-Month Mod Performance 10%, 6-Month Payment Deferral Performance 10%, Transition to Beyond Timeframe 10%. **Select:** Transition to 60+ 45%, 60+ to Cure 40%, Retention Efficiency 15%. "The updates are effective January 1, 2026, and they are reflected in the Scorecard released in February 2026." **Cadence:** scorecards monthly (February release covers January); "Overall rankings in peer groups will be released beginning in April for Q1. Until April only metric rankings are available." **Comparables:** "The STAR Scorecard uses a conditional inference tree model, Decision Trees, to segment the loan attributes and create the Comp for each metric based on the historical performance of the Fannie Mae book of business"; MTMLTV = "the loan's current principal balance divided by the lesser of the sales price or appraised value at origination marked forward based on Fannie Mae's Home Price Index." **Transition to Beyond Timeline:** "measures the number of loans that are within 180 days of the state foreclosure time frame that transition to beyond time frame status over a six-month reporting period." **Transfers:** "Loans are excluded from the transferor's metrics in the transfer month. Transferred loans are excluded from the transferee's calculations for two months following transfer (except for 6-month Mod and Payment Deferral Performance metrics)." **Recognition:** annual, "top three performers in their peer group." **Confidentiality:** "STAR Scorecard results are confidential, and a servicer may not disclose STAR Scorecard results to any third parties by any means" (recognition may be shared with Fannie Mae's marketing package). **Servicing Compliance Review** is separate (18.2). **A1-1-03:** STAR is "one of Fannie Mae's performance management frameworks designed to determine the servicer's overall performance based on operational assessments and scorecards."

**Metric definitions.** The FAQ defers to "Credit Metric Details in the 2026 STAR Program Guide"; the guide is served through an "external-resource" wrapper that returned no content and no direct PDF URL was found **[UNVERIFIED — 2026 STAR Program Guide metric formulas; obtain via Fannie Mae Connect/SFME and load as `star_metrics_config` v2026.1]**. The platform's working definitions below are labeled provisional and must be reconciled to the guide before any variance is reported to the partner as a Fannie Mae discrepancy.

**Discrepancies with the blueprint row.** (1) Frequency is monthly (scorecards) with annual recognition, not annual. (2) "SoR is scored" is incomplete: two views exist; a subservicer with ≥ 40,000 acting-servicer loans gets its own scorecard. (3) Neither entity is in scope at launch (< 40,000 loans) — the pipeline's first use is internal management and partner reporting on the Master view once the partner is in a peer group. (4) Reporting-quality metrics are supplemental in 2026 (still computed; Section 5 evidence). (5) Confidentiality clause constrains sharing.

### Operational prerequisites
- **Fannie Mae Connect** access for the partner's STAR Scorecard report category (Corporate Administrator grants) and, if/when in scope, Supermortgage's own; Insights & Reporting API entitlement for report pulls **[UNVERIFIED whether report 511 is API-exposed — default: UI download by `fnma_portal_operator` monthly]**.
- **Subservicing agreement clause** permitting the partner to share its STAR Scorecard (and Servicing Final Report, which Fannie Mae says is shareable "upon signing a disclosure by both parties") with Supermortgage as its subservicer, and both parties' confidentiality undertakings.
- **2026 STAR Program Guide** loaded as `star_metrics_config` with formulas, populations, lookbacks and exclusions; refreshed each January (program year).
- **Foreclosure time-frame exhibit** (E-3.2-15/F-1-08, LL-2025-01 values) in `jurisdiction_rules` for the Beyond-Timeframe metric (Section 13).
- **Delinquency history projection** (`loan_delinquency_months`: per loan per month `fnma_delinquency_status`, workout status, foreclosure milestone) maintained from day one (Sections 5.x/11.x).

### Build spec
#### Inputs and triggers
- Schedule `star.compute.monthly` (BD5 after the Fannie Mae reporting period close, i.e., after investor reporting is final) and `star.ingest.scorecard` on `fnma.connect.report.available{511}` (email subscription → mailbox parser → `human_portal_task` download, or API pull).
- Events consumed: monthly snapshots of `fnma_delinquency_status`, `lossmit.*` outcomes (mod trial/permanent, deferral completed, repayment plan initiated/active, forbearance), `foreclosure.milestone.*`, `transfer.in/out.completed`, `disaster.declared{loan}`; `star_metrics_config` versions.

#### Data model
- `star_metrics_config` (versioned by program year): `metric_code` ∈ {T60, C60, RET_EFF, MOD6, PD6, BEYOND_TF, DIS_FB_TAKEUP, DIS_30_CURE, supplemental…}, `definition` (jsonb: population filter, numerator, denominator, lookback months, exclusions incl. transfer rules, min_denominator=30), `weight_by_peer_group`, `source_citation`, `verified` bool.
- `loan_delinquency_months`: `loan_id`, `as_of_month`, `fnma_delinquency_status`, `days_delinquent_fnma`, `workout_status`, `repayment_plan_active`, `forbearance_active`, `fc_referred_at`, `fc_timeframe_days_allowed`, `fc_days_elapsed`, `mtmltv_bps`, `transfer_in_month`, `transfer_out_month`, `disaster_flag`.
- `star_metric_results`: `program_year`, `as_of_month`, `view` ∈ {master_partner, acting_supermortgage, internal_total}, `metric_code`, `config_version`, `numerator`, `denominator`, `rate_bps`, `suppressed` (denominator < 30), `comp_rate_bps` (from scorecard when available), `computed_at`, `population_hash`.
- `star_scorecards` (ingested): `view`, `as_of_month`, `document_id`, `metric_code`, `fnma_numerator`, `fnma_denominator`, `fnma_rate_bps`, `comp_rate_bps`, `rank`, `peer_group`, `parsed_at`.
- `star_reconciliations`: `as_of_month`, `metric_code`, `internal_rate_bps`, `fnma_rate_bps`, `delta_bps`, `loan_level_diffs` (jsonb: loan ids in ours-not-theirs / theirs-not-ours), `explanation`, `status`.
- Retention `corporate_7y`.

#### State machine
Monthly run: `snapshot_built → metrics_computed → scorecard_awaited → scorecard_ingested → reconciled → reported`; `variance_investigation` when any `|delta_bps| > tolerance`; `suppressed` when denominators < 30 (report internally with the flag). Transitions by `qc-audit` (compute/reconcile), `fnma_portal_operator` (download), `officer` (partner report sign-off when the report carries STAR data under the confidentiality clause).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_STAR_COMPUTE_MONTHLY_BD5` | recurring | Fannie Mae period close (BD2) | month | BD5 `business_days_fannie_et` | `star.metrics.computed` | sev-3 |
| `SM_STAR_SCORECARD_INGEST_5BD` | deadline | `fnma.connect.report.available{511}` | availability | 5 business days | `star.scorecard.ingested` | sev-3 |
| `SM_STAR_RECON_10BD` | deadline | `star.scorecard.ingested` | ingested_at | 10 business days | `star.reconciled` (all metrics within tolerance or explained) | sev-2 → partner report |
| `SM_STAR_CONFIG_ANNUAL_JAN` | recurring | program year | Jan 1 | load by Jan 31 (Feb scorecard reflects changes) | `star.config.published{year}` | sev-2 |
| `SM_STAR_PARTNER_REPORT_MONTHLY` | deadline | `star.reconciled` | reconciled_at | 5 business days | partner report delivered | sev-3 |

#### Business rules and calculations
**Provisional metric definitions (to be reconciled to the 2026 STAR Program Guide — [UNVERIFIED] unless marked):**
- **Transition to 60+ (T60):** denominator = loans ≤ 30 days delinquent (current or 30-day bucket) at the base month; numerator = those reaching 60+ days delinquent within the measurement window; lower is better. **[UNVERIFIED window]**
- **60+ to Cure (C60):** denominator = loans 60+ delinquent at the base month excluding loans in an active repayment plan as of the base month (verified exclusion); numerator = those that cure (current or paid in full/workout complete per guide) within the window; higher is better.
- **Retention Efficiency (RET_EFF):** denominator = delinquent loans eligible for retention workouts; numerator = retention solutions (mod, deferral, and — credited in 2026 — repayment-plan initiations), excluding self-cures and full payoffs and loans in active repayment plans at the base month (verified exclusions); higher is better.
- **6-Month Mod Performance (MOD6) / 6-Month Payment Deferral Performance (PD6):** denominator = mods/deferrals completed in the cohort month; numerator = those ≤ 30 days delinquent (or not 60+) six months later; higher is better. **[UNVERIFIED delinquency test]**
- **Transition to Beyond Timeframe (BEYOND_TF, verified definition):** denominator = loans within 180 days of the state foreclosure time frame (allowed days − elapsed days ≤ 180) at the base month; numerator = those that transition to beyond-time-frame status over the six-month reporting period; lower is better.
- **Disaster metrics:** Disaster Forbearance Take-up Rate; Disaster 30+ to Cure (definitions **[UNVERIFIED]**).
- **Common rules (verified):** exclude transferred-out loans in the transfer month from the transferor; exclude transferred-in loans for two months after transfer except MOD6/PD6; suppress any metric with denominator < 30; peer-group weights as listed; overall rank uses metric rankings from April for Q1.

**Computation.** Rates are stored in basis points as integers: `rate_bps = round_half_up(numerator × 10000 / denominator)`. A weighted composite for internal tracking: `composite = Σ weight_i × normalized_score_i` where `normalized_score_i` is the metric's percentile vs. Comp when a scorecard exists, else vs. the internal prior-12-month distribution. **Worked example (Select weights):** base month Jan 2027, T60 denominator 6,210 loans ≤ 30 days at base, 87 reach 60+ → `rate = round(87 × 10000 / 6210) = 140 bps` (1.40%); C60: 435 loans 60+ at base, 23 excluded as in active repayment plans → denominator 412, 118 cure → `round(118 × 10000 / 412) = 2,864 bps` (28.64%); RET_EFF 190 eligible, 61 retention solutions → `3,211 bps`. Internal composite with Select weights (45/40/15) is reported alongside Comp deltas once Fannie Mae's Comp is available; a metric with denominator 27 (e.g., PD6 in a small book) is flagged `suppressed` and excluded from the composite.

**Reconciliation.** For each metric, compare `star_metric_results` to `star_scorecards`; tolerance ±25 bps or ±2 loans in numerator/denominator, whichever is larger; beyond tolerance → loan-level diff using the scorecard's loan-level download (if provided) or the Fannie Mae Connect delinquency reports, then classify: (a) reporting timing (our status vs. what Fannie Mae received — Section 5 evidence), (b) definition mismatch (fix config), (c) data defect (finding to 18.1), (d) Fannie Mae error (escalate to the Servicing Representative/STAR mailbox; "The STAR team makes every effort to respond within five business days").

**Use of results.** STAR-derived rates feed 18.1's tolerance monitoring (e.g., a rising T60 with stable QRPC rates prompts review of `default-collections` prioritization — the Behavioral Model Tool review A4-1-01 requires) and the partner's monthly performance report. Confidential data are never included in vendor-facing or marketing material; recognition may be shared only with Fannie Mae's package.

#### Integrations
- **Fannie Mae Connect** (`fnma-connect` adapter; F12 in 00b): report 511 STAR Scorecard — API pull if entitled, else UI download by `fnma_portal_operator` (`human_portal_task` package: report id, month, expected file name; operator uploads to `documents`); also delinquency/loan-level reports used for reconciliation. Auth: Technology Manager user (UI) / System ID + OAuth (API). Failure: retry next BD; sev-3 after 5 BD.
- **Partner:** monthly performance report (PDF/JSON) through the partner channel; Master-view scorecard received from the partner under the confidentiality clause.
- **Internal:** `loan_delinquency_months` projection from Sections 5/11/12/13 events; `jurisdiction_rules` foreclosure time frames.

#### Outputs and artifacts
- Monthly **STAR Replica & Reconciliation Report** (template `STAR-RPT-MONTHLY-v1`): metric table (internal vs. Fannie Mae vs. Comp), suppressed metrics, variance explanations, trend charts, action items; quarterly peer-group ranking commentary when available. Records: `star_metric_results`, `star_scorecards`, `star_reconciliations`, `documents` (scorecard files with hashes). No borrower notices, no ledger postings, no investor events.

#### AI agent design (AI-first)
- **Agent:** `qc-audit` (STAR module) with `investor-reporting` as data supplier. End-to-end: build the monthly snapshot → compute metrics per config → ingest/parse the scorecard (PDF/Excel → structured; LLM extraction with numeric validation against totals) → reconcile → investigate variances (loan-level diffs, cross-check with `investor_events` acknowledgments) → draft the report and STAR-mailbox inquiries → escalate.
- **Tools:** SQL over projections, config registry, document parser, report renderer, `human_portal_task.create`, partner delivery.
- **Decision record:** `{as_of_month, metric_code, config_version, internal, fnma, delta_bps, classification, evidence_refs, confidence}`.
- **Guardrails:** never alter delinquency history to match a scorecard; classification "Fannie Mae error" requires two independent evidence refs and `officer` sign-off before any inquiry is sent; confidentiality filter on report distribution lists.
- **Escalations:** `fnma_portal_operator` (downloads), `officer` (external inquiries; partner report containing STAR data), `attorney` (none routine).
- **AI-off path:** metrics and reconciliations are deterministic; parsing falls back to manual entry in the console.

#### Edge cases and failure modes
- **Not in a peer group:** compute anyway (`internal_total` view); no Comp; report suppressed metrics; do not claim "STAR performance" externally.
- **Program-year definition change** (as in 2026): keep both config versions; recompute the prior year only on request.
- **Transfers:** apply the transferor/transferee exclusion months from `transfer.*` events; a batch transfer month will visibly shrink denominators (< 30 suppression).
- **Disaster overlays:** disaster-flagged loans enter the disaster metrics and, per guide rules, may be excluded from others **[UNVERIFIED]**.
- **Bankruptcy/foreclosure holds:** BEYOND_TF elapsed days must honor allowable-delay adjustments (LL-2025-01 compensatory-fee delays) — Section 13 supplies `fc_allowable_delay_days`.
- **Late investor reporting:** if a delinquency status was reported late (Section 5), the Fannie Mae figure will differ; classify as timing and link the reject/ack record.
- **Scorecard format changes:** parser versioning; a parse failure never blocks the internal computation.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 18.3-T1 | Given 6,210 loans ≤ 30 days at base and 87 transitions to 60+, then `T60 = 140 bps`. |
| 18.3-T2 | Given 435 loans 60+ at base of which 23 are in active repayment plans, then the C60 denominator is 412 and 118 cures → `2,864 bps` (round-half-up of 2,864.08); with 119 cures → `2,888 bps` (2,888.35). |
| 18.3-T3 | Given a loan transferred in on 2027-02-01, then it is excluded from T60/C60/RET_EFF for Feb and Mar 2027 but included in MOD6/PD6. |
| 18.3-T4 | Given a metric with denominator 27, then the result is `suppressed=true` and excluded from the composite. |
| 18.3-T5 | Given an internal C60 of 2,864 bps and a scorecard value of 2,700 bps (delta 164 bps), then a `variance_investigation` opens with loan-level diffs and closes only with a classification and evidence refs. |
| 18.3-T6 | Given a "Fannie Mae error" classification with one evidence ref, then the inquiry cannot be sent (guardrail). |
| 18.3-T7 | Given a foreclosure with 900 allowed days and 740 elapsed (160 days remaining) at base, when it exceeds 900 days within six months, then it counts in BEYOND_TF's numerator. |
| 18.3-T8 | Given report 511 available on 2027-02-15, then ingestion completes by 2027-02-22 and reconciliation by 2027-03-08 (10 BD), else timers breach. |
| 18.3-T9 | Given a vendor newsletter draft citing "STAR-level performance," then the confidentiality filter blocks it. |

#### Audit and evidence
Config versions with citations, monthly population hashes, metric results, scorecard files and parsed values, reconciliation dossiers with classifications and evidence refs, partner report deliveries and confidentiality acknowledgments, decision records — `corporate_7y`. Supports A1-1-03 performance discussions, Servicing Compliance Reviews and partner oversight.

### Open questions / decisions
1. **Obtain the 2026 STAR Program Guide** (SFME/STAR mailbox) and mark each metric `verified=true` before external use — default: internal-only until verified.
2. **API vs. UI ingestion** — default UI download until the Insights API entitlement is confirmed.
3. **Reconciliation tolerance** — default ±25 bps / ±2 loans.
4. **Sharing of the partner's scorecard** — default: permitted by the subservicing agreement with both parties' confidentiality undertakings; otherwise operate on internal metrics only.

### Sources
- STAR Program page: https://singlefamily.fanniemae.com/servicing/star-program — verified 2026-09-09
- STAR FAQs (Apr. 6, 2026): https://singlefamily.fanniemae.com/servicing/faqs-servicer-total-achievement-and-rewards — verified 2026-09-09
- 2026 STAR Program Guide (wrapper; content not retrievable): https://singlefamily.fanniemae.com/external-resource/star-program-guide — attempted 2026-09-09 **[UNVERIFIED]**
- Fannie Mae Connect STAR Scorecard: https://connect.fanniemae.com/#/report-center/report-detail/insights/star-scorecard?reportId=511 — link verified 2026-09-09 (content requires login)
- Servicing Guide A1-1-03 (11/25/2015) — as in 18.2; research/00a §6.5; research/00b F12
