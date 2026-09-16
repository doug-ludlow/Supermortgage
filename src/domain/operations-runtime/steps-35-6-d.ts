/**
 * §35.6 State machine — certified → purchased → completed (rule 8). The pass polls the FAKE Sellers API and reads the collection
 * bank's credits each sweep; the SAME 27.2 `purchase_advices` row is handed to 29.4 (`loan.purchased`), 30.1 (`loan.investor_updated`)
 * and 27.2's three-way match; `orchestration.reconcile` writes the three sides once; only a reconciled purchase moves the money
 * (27.2 postWaterfall, releaseCollateral) and completes the row. Every owning command runs as its owner's agent.
 */
import type { StepDef, StepOutcome } from "./steps-35-6.ts";
import type { OrchRecord } from "./facts-35-6.ts";
import { RecordGap, src } from "./facts-35-6.ts";
import { loanTerms } from "./facts-35-6-b.ts";
import { exitOn, fundingIdOf, WAREHOUSE, S } from "./steps-35-6-b.ts";
import { needClosing, servicingLoanNumber, loanIdOf, deliveryIdOf, SECONDARY } from "./steps-35-6-c.ts";
import { settlementAdvice, settlementRegistration, adviceFor294, investorMatchInput, pricingQuoteRow } from "./facts-35-6-d.ts";
import { EV, ORCH_ACTOR } from "./orchestration-35-6.ts";
import type { SettlementServices, BankCredit } from "../warehouse/ops-27-2.ts";
import type { Runtime } from "../../runtime/app.ts";

type Row = Record<string, unknown>;
const INVESTOR = { kind: "agent", id: "investor-reporting" } as const;

/** 27.2's ports (the Purchase Advice Sellers API, the collection bank) — the runtime-wide FAKEs the fixtures queue on; the pass reads the bank's feed and hands this loan's credits to 27.2 unchanged. */
function settlementPort(rt: Runtime): SettlementServices {
  const v = rt.originationServices.vendor("settlement") as SettlementServices | undefined;
  if (!v) throw new RangeError("unavailable: the settlement vendor port (27.2 Sellers API / collection bank) is not configured on this runtime");
  return v;
}
/** 20.4's LLPA total in cents from the lock-day quote — 29.4 R3's `llpa_expected_cents`. */
function quoteLlpaCents(rec: OrchRecord): { value: string; source: ReturnType<typeof src> } {
  const row = pricingQuoteRow(rec, loanTerms(rec));
  return { value: String(row.data["llpa_cents"]), source: src("entity", `pricing_quotes:${row.id}:${row.version}`, "20.4") };
}

// ───────────────────────────── certified → purchased: 27.2's registration and forecast, the Sellers API poll, 29.4's ingestion ─────────────────────────────
export const certifiedStep: StepDef = {
  name: "certified",
  exit: exitOn("loan.purchased"),
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now; const closing = needClosing(rec);
    const loanId = loanIdOf(rec); if (!loanId) throw new RecordGap("applications.loan_id", "no servicing loan (30.2)");
    const sln = await servicingLoanNumber(ctx, loanId); const deliveryId = S(rec.last("delivery.submitted")?.payload["delivery_id"]) ?? deliveryIdOf(rec);
    // 27.2 rule 1: the settlement facts registered at delivery (keys, terms, 20.4's quote, the CD figures, the collateral facts) from the record — as `warehouse`
    if (!rec.entities("settlement_loans", (d) => d["loan_id"] === loanId).length) {
      const reg = await settlementRegistration(rec, { loan_id: loanId, seller_loan_number: sln, delivery_id: deliveryId, funding_id: fundingIdOf(rec), closing });
      await ctx.run({ process: "27.2", name: "forecastProceeds", actor: WAREHOUSE, scope: { loanId }, input: { op: "register", loan: reg.loan }, detail: { sources: reg.sources } });
      rec = await ctx.refresh();
    }
    // the forecast posted to purchase_proceeds_receivable (once) and 29.4's certification observed by 27.2 (arms SM_WH_PROCEEDS_EXPECTED_1BD)
    if (!rec.has("settlement.forecast.posted")) { await ctx.run({ process: "27.2", name: "forecastProceeds", actor: WAREHOUSE, scope: { loanId }, input: { loan_id: loanId }, detail: { op: "forecast" } }); rec = await ctx.refresh(); }
    if (!rec.has("custody.certified", (p) => p["observed_by"] !== undefined)) {
      const cert = rec.last("custody.certified", (p) => p["certified_on"] !== undefined); if (!cert) throw new RecordGap("custody.certified", "29.4's certification is not on the record");
      await ctx.run({ process: "27.2", name: "forecastProceeds", actor: WAREHOUSE, scope: { loanId }, input: { op: "certified", loan_id: loanId, certification_date: String(cert.payload["certified_on"]) }, detail: { sources: { certified: src("event", `custody.certified:${cert.id}`, "29.4") } } });
      rec = await ctx.refresh();
    }
    // the Purchase Advice Sellers API, polled once per pass for today's advices (27.2 keys them by the seller loan number; duplicates are skipped by the owner)
    let advice = settlementAdvice(rec, loanId);
    if (!advice) {
      await ctx.run({ process: "27.2", name: "pollPurchaseAdvices", actor: WAREHOUSE, scope: { loanId }, input: { op: "sellers", advice_date: rec.etDate(now) }, detail: { port: "purchase_advice_api_sellers", advice_date: rec.etDate(now) } });
      rec = await ctx.refresh(); advice = settlementAdvice(rec, loanId);
      if (!advice) return { wait: { status: "waiting_vendor", waiting_on: "sellers_api", clocked: true } };
    }
    // rule 8: 29.4 ingests the SAME row (its own projection id `<id>:delivery`) → `loan.purchased{loan_id, application_id}` exits the step — as `secondary`
    if (!rec.has("loan.purchased")) {
      const a = adviceFor294(rec, advice);
      await ctx.run({ process: "29.4", name: "ingestPurchaseAdvice", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId, advice: a.advice, at: now }, detail: { sources: a.sources, purchase_advice_id: advice.id } });
    }
    return {};
  },
};

// ───────────────────────────── purchased → completed: 29.4's variance, 30.1's update, the bank's credit, 27.2's match, the three-sided reconciliation, the waterfall ─────────────────────────────
export const purchasedStep: StepDef = {
  name: "purchased",
  exit: (rec) => rec.last(EV.reconciled),   // this process's own event (rule 3); read lazily — the orchestration module imports the steps
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now; const closing = needClosing(rec);
    const loanId = loanIdOf(rec); if (!loanId) throw new RecordGap("applications.loan_id", "no servicing loan (30.2)");
    const sln = await servicingLoanNumber(ctx, loanId); const deliveryId = S(rec.last("delivery.submitted")?.payload["delivery_id"]) ?? deliveryIdOf(rec);
    const advice = settlementAdvice(rec, loanId); if (!advice) throw new RecordGap("purchase_advices", "27.2's advice for the loan is not on the record");
    const adviceSrc = src("entity", `purchase_advices:${advice.id}:${advice.version}`, "27.2");
    // 29.4 R3: the advice against 29.4's expected net (20.4's LLPA total as the expected LLPA) → `purchase_advice.reconciled{variance_cents}` — as `secondary`
    if (!rec.has("purchase_advice.reconciled", (p) => p["purchase_advice_id"] === `${advice.id}:delivery`)) {
      const llpa = quoteLlpaCents(rec);
      await ctx.run({ process: "29.4", name: "reconcileProceeds", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId, purchase_advice_id: `${advice.id}:delivery`, llpa_expected_cents: llpa.value, fees_expected_cents: "0", at: now }, detail: { sources: { advice: adviceSrc, llpa: llpa.source } } });
      rec = await ctx.refresh();
    }
    // 30.1: the investor update on the same loan row from the SAME advice — only when no update exists yet (an update from another figure is one-sided: rule 8 leaves it to the officer, never papers over it) — as `investor-reporting`
    if (!rec.all("loan.investor_updated").length) {
      const m = await investorMatchInput(rec, advice, { loan_id: loanId, seller_loan_number: sln, closing });
      await ctx.run({ process: "30.1", name: "matchPurchaseAdvice", actor: INVESTOR, scope: { loanId }, input: { loan_id: loanId, application_id: rec.app.id, loan: m.loan, advice: m.advice }, detail: { sources: m.sources } });
      rec = await ctx.refresh();
      if (rec.has("loan.investor_updated") && !rec.entities("investor_loan_positions", (d) => d["loan_id"] === loanId).length) {
        await ctx.run({ process: "30.1", name: "seedInvestorPosition", actor: INVESTOR, scope: { loanId }, input: { loan_id: loanId, application_id: rec.app.id, loan: m.loan, advice: m.advice }, detail: { sources: m.sources } });
        rec = await ctx.refresh();
      }
    }
    // the collection bank's credits: the pass reads the port and hands this loan's new credits to 27.2 unchanged (`proceeds.received`); nothing yet → wait on the bank
    if (!rec.has("proceeds.received")) {
      const since = rec.last("custody.certified")?.occurredAt ?? rec.last("loan.purchased")!.occurredAt; const fnma = S(rec.last("delivery.submitted")?.payload["fnma_loan_number"]);
      const known = new Set(rec.entities("proceeds_receipts").map((r) => String(r.data["bank_ref"])));
      const credits = (await settlementPort(ctx.rt).collectionBank.credits(since)).filter((c: BankCredit) => !known.has(c.bank_ref) && (c.reference_text.includes(sln) || (fnma !== null && c.reference_text.includes(fnma))));
      if (!credits.length) return { wait: { status: "waiting_vendor", waiting_on: "collection_bank", clocked: true } };
      await ctx.run({ process: "27.2", name: "ingestReceipts", actor: WAREHOUSE, scope: { loanId }, input: { receipts: credits.map((c) => ({ bank_ref: c.bank_ref, value_date: c.value_date, amount_cents: String(c.amount_cents), originator_name: c.originator_name, reference_text: c.reference_text, account_ref: c.account_ref, received_at: c.received_at, loan_id: loanId })) }, detail: { port: "collection_bank", since, bank_refs: credits.map((c) => c.bank_ref) } });
      rec = await ctx.refresh();
    }
    // 27.2 rule 2: the three-way match (advice vs forecast vs bank) on the SAME advice — as `warehouse`
    let match = rec.entities("proceeds_matches", (d) => d["loan_id"] === loanId).at(-1) ?? null;
    if (!match) {
      await ctx.run({ process: "27.2", name: "matchProceeds", actor: WAREHOUSE, scope: { loanId }, input: { loan_id: loanId, advice_id: advice.id }, detail: { sources: { advice: adviceSrc } } });
      rec = await ctx.refresh(); match = rec.entities("proceeds_matches", (d) => d["loan_id"] === loanId).at(-1) ?? null;
      if (!match) return { wait: { status: "waiting_vendor", waiting_on: "collection_bank", clocked: true } };
    }
    // rule 8: the three sides, decided by this process's own tool (the decision record); an exception carries 27.2's explanation to the officer and holds here
    const explanation = match.data["status"] === "matched" ? null : await ctx.run<Row>({ process: "27.2", name: "explainVariance", actor: WAREHOUSE, scope: { loanId }, input: { match_id: String(match.data["match_id"]) }, detail: { match_id: match.data["match_id"] } });
    const decided = await ctx.run<Row>({ process: "35.6", name: "orchestration.reconcile", actor: ORCH_ACTOR, input: { at: now, ...(explanation ? { explanation } : {}) }, detail: { purchase_advice_id: advice.id, match_id: match.data["match_id"] } });
    if (decided["status"] === "exception") return { wait: { status: "waiting_human", waiting_on: "officer", clocked: false } };
    if (decided["status"] !== "reconciled") return { wait: { status: "waiting_vendor", waiting_on: String(decided["waiting_on"] ?? "collection_bank"), clocked: true } };
    // reconciled: the money moves through 27.2 — the LSA waterfall (27.1's payoff; `warehouse.advance.repaid`, `settlement.waterfall.posted`) and the collateral release — as `warehouse`
    if (!rec.has("settlement.waterfall.posted")) { await ctx.run({ process: "27.2", name: "postWaterfall", actor: WAREHOUSE, scope: { loanId }, input: { loan_id: loanId, match_id: String(match.data["match_id"]) }, detail: { match_id: match.data["match_id"] } }); rec = await ctx.refresh(); }
    if (!rec.has("warehouse.collateral.status_changed", (p) => p["to"] === "released") && !rec.has("warehouse.bailee_letter.released")) { await ctx.run({ process: "27.2", name: "releaseCollateral", actor: WAREHOUSE, scope: { loanId }, input: { loan_id: loanId }, detail: { note_form: closing.note_form } }); rec = await ctx.refresh(); }
    await ctx.run({ process: "35.6", name: "orchestration.reconcile", actor: ORCH_ACTOR, input: { op: "complete", at: now }, detail: { purchase_advice_id: advice.id } });
    return {};
  },
};
