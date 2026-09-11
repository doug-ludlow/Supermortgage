/**
 * NoticeService: render → checklist → (held | ready) → channel decision →
 * delivery via the print/mail and e-delivery ports → proof of delivery.
 * `notices` rows are content-immutable (a correction supersedes); every
 * transition is an event (`notice.rendered` / `notice.held` / `notice.sent`
 * / `notice.delivered` / `notice.bounced` / `notice.returned`), so the
 * registry timers (production window, 45-day clocks, renewal notices) arm
 * and satisfy from the event log like everything else.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, Actor } from "../kernel/events/index.ts";
import type { PlainDate } from "../kernel/calendar/date.ts";
import { addBusinessDays, federal, type Calendar } from "../kernel/calendar/business.ts";
import { NoticeRegistry, type TemplateVersion, type NoticeTemplate } from "./registry.ts";
import { render, type Rendered } from "./render.ts";
import { evaluateChecklist, type ChecklistResult } from "./checklist.ts";
import { decideChannel, type Recipient, type ChannelDecision, type ChannelContext, type Channel } from "./channel.ts";
import type { PrintMailPort, EdeliveryPort } from "../infra/integrations/delivery.ts";

export const DISCLOSURES_AGENT: Actor = { kind: "agent", id: "disclosures" };

export type NoticeStatus = "rendered" | "held" | "sent" | "delivered" | "bounced" | "returned" | "superseded";
export interface Notice {
  readonly id: string;
  readonly templateCode: string;
  readonly templateVersion: string;
  readonly loanId?: string;
  /** Origination key: a notice rendered before funding is keyed by the application (its events must satisfy application-subject timers). */
  readonly applicationId?: string;
  readonly caseId?: string;
  readonly recipients: readonly Recipient[];
  /** `documents.id` of the rendered PDF (notices.rendered_document_id) when the caller has stored it; carried onto every delivery as evidence. */
  readonly renderedDocumentId?: string;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly rendered: Rendered;
  readonly checklist: ChecklistResult;
  readonly producedAt: string;
  status: NoticeStatus;
  heldReason?: string;
  channelDecision?: readonly ChannelDecision[];
  sentAt?: string;
  supersededBy?: string;
  readonly deliveries: Delivery[];
}
export interface Delivery { readonly attemptNo: number; readonly partyId: string; readonly channel: Channel; readonly vendor: string; readonly vendorPieceId: string; readonly submittedAt: string; mailedAt?: string; emailStatus?: "sent" | "delivered" | "bounced" | "complained"; returnedAt?: string; returnReason?: string; fallbackOf?: number; readonly satisfiesTimer: boolean;
  /** DELTA-08: for `esign_portal`, the card_instances row that carried the document — delivery evidence beside `renderedDocumentId`. */
  readonly cardInstanceId?: string; readonly renderedDocumentId?: string; }

export interface NoticeServiceDeps {
  readonly registry: NoticeRegistry;
  readonly events: EventStore;
  readonly clock: { now(): string };
  readonly printMail: PrintMailPort;
  readonly edelivery: EdeliveryPort;
  readonly federalCalendar?: Calendar;
  /** 32.12 backend delta: a shared map so notices rendered in one unit of work are readable in the next (17.2's content checklist over a notice rendered by an earlier command; the borrower flows' NoticeCard plain-language block). Default: private to the instance. */
  readonly notices?: Map<string, Notice>;
}

export class NoticeHeld extends Error {
  readonly notice: Notice;
  constructor(n: Notice) { super(`notice ${n.id} (${n.templateCode}) is held: ${n.heldReason}`); this.name = "NoticeHeld"; this.notice = n; }
}

export class NoticeService {
  private readonly deps: NoticeServiceDeps;
  private readonly notices: Map<string, Notice>;
  constructor(deps: NoticeServiceDeps) { this.deps = deps; this.notices = deps.notices ?? new Map<string, Notice>(); }

  get(id: string): Notice { const n = this.notices.get(id); if (!n) throw new RangeError(`no notice ${id}`); return n; }
  all(): readonly Notice[] { return [...this.notices.values()]; }
  template(code: string): NoticeTemplate { return this.deps.registry.template(code); }

  /** renderNotice + evaluateChecklist. A failing block rule holds the notice (it can never be sent); missing addresses hold too. */
  render(input: { templateCode: string; loanId?: string; applicationId?: string; caseId?: string; recipients: readonly Recipient[]; payload: Record<string, unknown>; asOf: PlainDate; renderedDocumentId?: string }): Notice {
    const t = this.deps.registry.template(input.templateCode);
    const v: TemplateVersion | undefined = this.deps.registry.activeVersion(t.code, input.asOf);
    if (!v) throw new RangeError(`no approved version of ${t.code} in effect on ${input.asOf}`);
    const rendered = render(v.source, input.payload);
    const checklist = evaluateChecklist(v, input.payload, rendered);
    const now = this.deps.clock.now();
    const n: Notice = { id: randomUUID(), templateCode: t.code, templateVersion: v.version, recipients: input.recipients, payload: input.payload, payloadHash: rendered.payloadHash, rendered, checklist, producedAt: now, status: "rendered", deliveries: [],
      ...(input.loanId ? { loanId: input.loanId } : {}), ...(input.applicationId ? { applicationId: input.applicationId } : {}), ...(input.caseId ? { caseId: input.caseId } : {}), ...(input.renderedDocumentId ? { renderedDocumentId: input.renderedDocumentId } : {}) };
    if (!checklist.passed) { n.status = "held"; n.heldReason = `checklist: ${checklist.blocking.map((r) => `${r.rule_id} (${r.citation})`).join(", ")}`; }
    else if (input.recipients.length === 0) { n.status = "held"; n.heldReason = "no recipients"; }
    this.notices.set(n.id, n);
    this.emit(n.status === "held" ? "notice.held" : "notice.rendered", n, { template_version: v.version, payload_hash: n.payloadHash, ...(n.heldReason ? { reason: n.heldReason } : {}), warnings: checklist.warnings.map((w) => w.rule_id) });
    return n;
  }

  /** decideChannel + sendNotice. Held notices are refused; the mail delivery satisfies the regulatory timer when parties split (7.4 rule 4). */
  async send(id: string, ctx: ChannelContext = {}): Promise<Notice> {
    const n = this.get(id);
    if (n.status === "held") throw new NoticeHeld(n);
    if (n.status !== "rendered") return n;
    const t = this.template(n.templateCode);
    const decisions = decideChannel(t, n.recipients, ctx);
    const unresolved = decisions.filter((d) => d.held);
    if (unresolved.length === decisions.length) { n.status = "held"; n.heldReason = "address unknown for every recipient"; n.channelDecision = decisions; this.emit("notice.held", n, { reason: n.heldReason }); return n; }
    n.channelDecision = decisions;
    const now = this.deps.clock.now();
    for (const d of decisions) {
      if (d.held) continue;
      const r = n.recipients.find((x) => x.partyId === d.partyId)!;
      if (d.channel.startsWith("mail")) await this.mail(n, r, d, now);
      else await this.electronic(n, r, d, now);
    }
    n.status = "sent"; n.sentAt = now;
    this.emit("notice.sent", n, { channels: decisions.map((d) => ({ party_id: d.partyId, channel: d.channel, satisfies_timer: d.satisfiesTimer, ...(d.cardInstanceId ? { card_instance_id: d.cardInstanceId } : {}) })), sent_at: now, ...(n.renderedDocumentId ? { rendered_document_id: n.renderedDocumentId } : {}) });
    return n;
  }

  private async mail(n: Notice, r: Recipient, d: ChannelDecision, now: string, fallbackOf?: number): Promise<void> {
    const t = this.template(n.templateCode);
    const attemptNo = n.deliveries.length + 1;
    const job = await this.deps.printMail.submit({ jobId: `${n.id}:${attemptNo}`, noticeId: n.id, template: n.templateCode, recipient: { name: r.name, address: r.mailingAddress ?? "" }, pages: Math.max(1, ...n.rendered.blocks.map((b) => b.page)), separateDocument: t.separateDocument }, now);
    n.deliveries.push({ attemptNo, partyId: r.partyId, channel: d.channel, vendor: "print-mail", vendorPieceId: job.jobId, submittedAt: now, satisfiesTimer: d.satisfiesTimer, ...(fallbackOf !== undefined ? { fallbackOf } : {}), ...(n.renderedDocumentId ? { renderedDocumentId: n.renderedDocumentId } : {}) });
    // §1024.37(d)(5) / comment 37(d)(5)-1: a notice put into production must mail within 5 federal business days.
    const productionDate = now.slice(0, 10) as PlainDate;
    this.emit("notice.production", n, { attempt_no: attemptNo, production_at: now, mail_by: addBusinessDays(productionDate, 5, this.deps.federalCalendar ?? federal) });
  }
  private async electronic(n: Notice, r: Recipient, d: ChannelDecision, now: string): Promise<void> {
    const attemptNo = n.deliveries.length + 1;
    // esign_portal (DELTA-08): the card in the borrower thread is the delivery; the e-delivery port only posts the availability message, and the card id is the evidence
    const res = await this.deps.edelivery.send({ messageId: `${n.id}:${attemptNo}`, noticeId: n.id, channel: d.channel === "portal_post" || d.channel === "esign_portal" ? "portal" : d.channel === "sms_link" ? "sms" : "email", to: r.email ?? "", subject: this.template(n.templateCode).name, consentId: d.consentId ?? "" }, now);
    const delivery: Delivery = { attemptNo, partyId: r.partyId, channel: d.channel, vendor: d.channel === "esign_portal" ? "borrower-app" : "e-delivery", vendorPieceId: res.messageId, submittedAt: now, emailStatus: res.status === "bounced" ? "bounced" : "sent", satisfiesTimer: d.satisfiesTimer,
      ...(d.cardInstanceId ? { cardInstanceId: d.cardInstanceId } : {}), ...(n.renderedDocumentId ? { renderedDocumentId: n.renderedDocumentId } : {}) };
    n.deliveries.push(delivery);
    if (res.status === "bounced") await this.bounce(n, r, delivery, now);
  }

  /** 7.4 rule 8: hard bounce → same-day mail of the affected notice; the consent owner marks the consent suspect. */
  private async bounce(n: Notice, r: Recipient, delivery: Delivery, now: string): Promise<void> {
    this.emit("notice.bounced", n, { party_id: r.partyId, attempt_no: delivery.attemptNo, reason: "hard bounce" });
    if (r.consent) r.consent.status = "suspect";
    await this.mail(n, r, { partyId: r.partyId, channel: "mail_first_class", reason: "bounce fallback (7.4 rule 8)", satisfiesTimer: true }, now, delivery.attemptNo);
  }

  /** Vendor manifest ingestion: proof of mailing. */
  recordMailed(id: string, attemptNo: number, mailedAt: string, proofOfMailingId: string): void {
    const n = this.get(id); const d = n.deliveries.find((x) => x.attemptNo === attemptNo); if (!d) throw new RangeError(`no delivery ${attemptNo}`);
    d.mailedAt = mailedAt; n.status = "delivered";
    this.emit("notice.mailed", n, { attempt_no: attemptNo, mailed_at: mailedAt, proof_of_mailing_id: proofOfMailingId, satisfies_timer: d.satisfiesTimer });
  }
  /** Returned mail (7.1 rule "returned → address_research → re_sent"). */
  recordReturned(id: string, attemptNo: number, returnedAt: string, reason: string): void {
    const n = this.get(id); const d = n.deliveries.find((x) => x.attemptNo === attemptNo); if (!d) throw new RangeError(`no delivery ${attemptNo}`);
    d.returnedAt = returnedAt; d.returnReason = reason; n.status = "returned";
    this.emit("notice.returned", n, { attempt_no: attemptNo, returned_at: returnedAt, reason });
  }
  /** Content never changes in place: a corrected notice supersedes the original. */
  supersede(id: string, replacementId: string): void {
    const n = this.get(id); this.get(replacementId);
    n.status = "superseded"; n.supersededBy = replacementId;
    this.emit("notice.superseded", n, { superseded_by: replacementId });
  }

  private emit(type: string, n: Notice, payload: Record<string, unknown>): void {
    this.deps.events.append({ type, ...(n.loanId ? { loanId: n.loanId } : {}), ...(n.applicationId ? { applicationId: n.applicationId } : {}), aggregate: { kind: "notice", id: n.id }, actor: DISCLOSURES_AGENT, payload: { notice_id: n.id, template: n.templateCode, ...(n.applicationId ? { application_id: n.applicationId } : {}), ...payload } });
  }
}
