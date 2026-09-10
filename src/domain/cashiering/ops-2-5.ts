/**
 * §2.5 process operations — the inbound contractor-remittance path. A `third_party.remittance.received` record (ACH
 * CCD/CTX credit with addenda, or a check + remittance list) identified to a contractor becomes one `payments` row per
 * loan with `channel=third_party_contractor, payer_type=contractor` (rule 1) and is posted through the Standard
 * Allocation Engine: a full monthly amount is a periodic payment, a half is held as `biweekly_accumulation`, and the
 * amount the addenda designate as principal ("PRIN n") is a curtailment after the installment (rule 2, worked example I).
 * A conforming contractor payment is never refused because the payer is a contractor (C-1.1-04;
 * `FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE` is closed by the `payment.posted` this path produces). The receipt re-arms
 * `SM_CONTRACTOR_DORMANT_60`; `arrangement.updated{status=active}` (emitted first) closes the previous dormancy clock.
 * A remittance from a company other than the one the loan's arrangement names is a mismatched remittance — the item is
 * not posted and the `officer` is escalated to (suspected contractor fraud, §2.5 AI agent design).
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { CashieringService, PostResult } from "./service.ts";
import type { CashieringOps } from "./ops.ts";
import { designatedPrincipalFromAddenda, type Arrangement } from "./biweekly.ts";

export type RemittanceFormat = "ach_ccd" | "ach_ctx" | "check_list";
export interface ContractorRemittanceItem {
  readonly loan_id: string;
  readonly amount_cents: Cents;
  /** CCD/CTX addenda record or remittance-list line for the loan ("LOAN 0087654321 PMT 219257 PRIN 219257"). */
  readonly addenda?: string;
  /** The arrangement's cadence: a half of P remitted every 14 days is held as `biweekly_accumulation` (statement disclosure, no SUSP-PARTIAL-HOLD letter). */
  readonly cadence?: "biweekly_half" | "monthly_full_plus_extra";
}
export interface ContractorRemittance {
  /** ACH trace / batch id or the remittance list id — the idempotency root for its items. */
  readonly remittance_id: string;
  /** ACH company ID (or the list's contractor identity) → `parties{kind=payment_contractor}`. */
  readonly contractor_company_id: string;
  readonly format: RemittanceFormat;
  /** The contractor's settlement date — each loan's `received_on` (rule 1). */
  readonly settlement_date: PlainDate;
  /** ISO instant the credit / lockbox scan reached the servicer. */
  readonly received_at: string;
  readonly items: readonly ContractorRemittanceItem[];
}
export interface IngestResult {
  readonly remittance: DomainEvent;
  readonly postings: PostResult[];
  /** Items not posted: a mismatched remittance escalated to the officer, or a resubmitted item rejected as a duplicate. */
  readonly escalations: DomainEvent[];
  readonly duplicates: string[];
}
export interface ContractorIngestDeps {
  readonly svc: CashieringService;
  readonly ops: CashieringOps;
  readonly events: EventStore;
  readonly arrangements: { byLoan(loanId: string): Arrangement | undefined };
  readonly actor?: Actor;
}

const INGEST_ACTOR: Actor = { kind: "agent", id: "cashiering" };

export class ContractorRemittanceIngest {
  private readonly deps: ContractorIngestDeps;
  private readonly actor: Actor;
  constructor(deps: ContractorIngestDeps) { this.deps = deps; this.actor = deps.actor ?? INGEST_ACTOR; }

  /** Validate the inbound record, append `third_party.remittance.received`, then receive → identify → post one payment per loan. */
  ingest(r: ContractorRemittance): IngestResult {
    if (r.items.length === 0) throw new RangeError("empty contractor remittance");
    if (!r.remittance_id || !r.contractor_company_id) throw new RangeError("contractor remittance needs a remittance id and a contractor company id");
    for (const it of r.items) {
      if (!it.loan_id) throw new RangeError("contractor remittance item without a loan id (unidentified credits go to 6.5)");
      if (it.amount_cents <= 0n) throw new RangeError(`non-positive contractor remittance amount for ${it.loan_id}`);
    }
    const aggregate = { kind: "remittance", id: r.remittance_id };
    const remittance = this.deps.events.append({ type: "third_party.remittance.received", aggregate, actor: this.actor,
      payload: { remittance_id: r.remittance_id, contractor_company_id: r.contractor_company_id, format: r.format, settlement_date: r.settlement_date, received_at: r.received_at, item_count: r.items.length, total_cents: r.items.reduce((s, i) => s + i.amount_cents, 0n).toString(), loan_ids: r.items.map((i) => i.loan_id) } });
    const postings: PostResult[] = []; const escalations: DomainEvent[] = []; const duplicates: string[] = [];
    for (const it of r.items) {
      const a = this.deps.arrangements.byLoan(it.loan_id);
      if (a && a.contractor_company_id !== r.contractor_company_id) {
        escalations.push(this.deps.events.append({ type: "escalation.requested", loanId: it.loan_id, aggregate, actor: this.actor,
          payload: { to: "officer", severity: "sev-2", reason: `mismatched contractor remittance: ${r.remittance_id} from company ${r.contractor_company_id} for ${it.loan_id}, whose arrangement ${a.id} is with ${a.contractor_company_id} (suspected contractor fraud)`, remittance_id: r.remittance_id, arrangement_id: a.id, amount_cents: it.amount_cents.toString() } }));
        continue;
      }
      const designated = designatedPrincipalFromAddenda(it.addenda);
      if (designated > it.amount_cents) throw new RangeError(`addenda designate ${designated}¢ as principal but only ${it.amount_cents}¢ were remitted for ${it.loan_id}`);
      if (a && a.status !== "ended") this.deps.ops.recordContractorRemittance(a, r.settlement_date);   // `arrangement.updated{status=active}` before the receipt re-arms the 60-day clock
      const { payment, duplicate } = this.deps.svc.receive({
        channel: "third_party_contractor", instrument: r.format === "check_list" ? "check" : "ach", amount_cents: it.amount_cents, received_at: r.received_at, settlement_date: r.settlement_date,
        loan_id: it.loan_id, payer_type: "contractor", payer_name: r.contractor_company_id, trace_number: r.remittance_id, source_batch_id: r.remittance_id, source_item_id: `${r.remittance_id}:${it.loan_id}`, arrangement: "third_party_contractor",
        ...(it.addenda ? { borrower_instruction_text: it.addenda, instruction_source: `contractor_addenda:${r.format}` } : {}),
        ...(designated > 0n ? { curtailment_cents: designated } : {}),
        ...(it.cadence === "biweekly_half" ? { designation: "biweekly_half" as const } : {}),
      });
      if (duplicate) { duplicates.push(payment.id); continue; }
      this.deps.svc.identify(payment.id, it.loan_id);
      postings.push(this.deps.svc.post(payment.id));
    }
    return { remittance, postings, escalations, duplicates };
  }
}
