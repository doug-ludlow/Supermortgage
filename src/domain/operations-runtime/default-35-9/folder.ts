/**
 * §35.9 rule 1 — the post-commit fold. The seam's post-commit hook is `Runtime.onCommitted` (src/runtime/app.ts): every
 * event a unit of work persisted, published after COMMIT (and, for the breach pass, inside its transaction). The folder
 * subscribes once per runtime, keeps the loans whose committed events are consumed types, and folds each loan in its own
 * unit of work under 35.1's per-loan lock — serialized behind one promise chain (the BorrowerFlows pattern,
 * src/runtime/borrower/flows/index.ts), errors logged and never thrown, `settle()` for the daily pass and the tests.
 * The fold is idempotent by `event_id` and the daily unit re-folds anything a listener missed (`events_folded`), so a
 * fold that races the breach pass (its events not yet committed when the listener fires) loses nothing: the next command
 * or the next day's unit writes the row.
 */
import type { DomainEvent } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { CONSUMED_EVENT_TYPES, ENGINE_ACTOR, EV } from "../default-35-9.ts";
import { foldLoan, type FoldResult } from "./timeline.ts";
import { portsOf, type DefaultOpsPorts } from "./ports.ts";
import { EscalationService } from "../../../app/escalations.ts";

/** The 35.9 events themselves are never re-folded (they are not consumed types), but a fold that emits them must not re-trigger itself. */
const OWN = new Set<string>(Object.values(EV));

export class CaseFolder {
  private readonly rt: Runtime;
  private readonly ports: Required<DefaultOpsPorts>;
  private chain: Promise<void> = Promise.resolve();
  private stopFn: (() => void) | null = null;
  private pending = 0;
  readonly folded: FoldResult[] = [];
  readonly errors: { loan_id: string; error: string }[] = [];
  constructor(rt: Runtime, ports?: DefaultOpsPorts) { this.rt = rt; this.ports = portsOf(ports); }

  /** Subscribe to the runtime's committed events; returns the unsubscribe. */
  start(): () => void {
    if (this.stopFn) return this.stopFn;
    const off = this.rt.onCommitted((events) => this.enqueue(events));
    this.stopFn = () => { off(); this.stopFn = null; };
    return this.stopFn;
  }
  get started(): boolean { return this.stopFn !== null; }
  stop(): void { this.stopFn?.(); }

  /** The loans the batch touches with a consumed event, folded in order, one unit of work each. */
  enqueue(events: readonly DomainEvent[]): void {
    const loans = [...new Set(events.filter((e) => e.loanId && CONSUMED_EVENT_TYPES.has(e.type) && !OWN.has(e.type)).map((e) => e.loanId!))];
    for (const loanId of loans) {
      this.pending += 1;
      this.chain = this.chain.then(() => this.foldOne(loanId)).then(() => undefined, () => undefined).finally(() => { this.pending -= 1; });
    }
  }
  /** Wait for every queued fold (a test drives → settle → assert; the daily pass settles before it scans). */
  async settle(): Promise<void> { while (this.pending > 0) await this.chain; await this.chain; }

  async foldOne(loanId: string): Promise<FoldResult | null> {
    try {
      let escalations: EscalationService | undefined; let out: FoldResult | null = null;
      await this.rt.uow.run({ loanId }, async (ctx) => {
        escalations = new EscalationService(ctx.events, ctx.clock);
        out = await foldLoan({ q: ctx.q!, events: ctx.events, now: ctx.clock.now(), actor: ENGINE_ACTOR, workItems: this.ports.workItems, timers: ctx.timers }, loanId);
        if (out.folded) ctx.decide({ agent: ENGINE_ACTOR.id, action: "case.timeline.fold", rationale: `folded ${out.folded} event(s) through sequence ${out.through_sequence} (post-commit hook)`, ruleSetVersion: "default-ops.v1", loanId, subject: { kind: "case_timeline", id: loanId }, confidence: 1, modelVersion: "deterministic", promptVersion: "35.9-v1" });
        return out;
      }, { clock: this.rt.clock, commit: async (q) => { for (const e of escalations?.list() ?? []) await this.rt.escalationRepo.save(e, q); } });
      if (out) this.folded.push(out);
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errors.push({ loan_id: loanId, error: msg });
      this.rt.logger?.error("35.9 post-commit fold failed", { loan_id: loanId, error: msg });
      return null;
    }
  }
}
