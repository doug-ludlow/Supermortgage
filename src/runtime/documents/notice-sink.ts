/**
 * §35.2 — the artifact layer beneath the Notice Registry on the hosted runtime. Every notice a command renders through
 * `NoticeService` becomes bytes through the in-repo writer (rule 2), its placements are the layout facts the checklist
 * evaluates (rule 3), and the bytes are stored as a `documents` row the notice carries as `renderedDocumentId` — staged in
 * `document_blobs` and drained to the object store in the same command (rule 4), `notices.document_id` pointing at it.
 *
 * `NoticeService.render` is synchronous, so the sink renders and appends the document events at once (`document.rendered`,
 * `document.staged`, and `document.stored` when the store is reachable — the timers arm and satisfy in this command) and
 * defers the SQL (`storeDocument` under the id it minted, then the notice row) to the command's commit transaction. The drain
 * inside that transaction re-reads the object and compares the hash; a mismatch throws HASH_MISMATCH_ON_PUT and the whole
 * command rolls back, so the optimistic `document.stored` never commits ahead of a failed swap (rule 1: "refused and
 * nothing is written"). A `GlyphUnsupported` from the writer propagates out of `render` before anything is registered.
 *
 * `MemoryArtifactSink` is the same layer without a database (the unit harnesses: 10.4's checklist over placements, T3).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { PgNoticeRepository } from "../../infra/db/notices.ts";
import { NoticeService, type ArtifactSink, type Notice } from "../../notices/service.ts";
import type { TemplateVersion } from "../../notices/registry.ts";
import type { Rendered } from "../../notices/render.ts";
import { MemoryEventStore, type Actor, type EventStore } from "../../kernel/events/index.ts";
import { renderBlocksPdf, blocksFromPlacements, type RenderedPdf } from "../../domain/operations-runtime/documents/render.ts";
import { storeDocument } from "../../domain/operations-runtime/documents/store.ts";
import { RETENTION_CLASSES, docKey } from "../../domain/operations-runtime/documents/shared.ts";
import type { ObjectStorePort } from "../../infra/blobs/pg-fake-blob-store.ts";
import type { Runtime } from "../app.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string): boolean => UUID_RE.test(v);

export const RENDERED_NOTICE_KIND = "rendered_notice";
/** The retention class of a rendered notice: the template's own when the retention matrix defines it, else the loan file's (life_of_loan_plus_4y). */
export const retentionFor = (templateRetention: string | undefined): string => (templateRetention && RETENTION_CLASSES.has(templateRetention) ? templateRetention : "life_of_loan_plus_4y");

export interface SinkDeps {
  readonly runtime: Runtime; readonly events: EventStore; readonly actor: Actor; readonly now: () => string; readonly blobs: ObjectStorePort;
  /** The document row's write, in the command's deferred writes in push order — before a row the calling tool defers with a foreign key onto it (20.3's prequalifications.letter_document_id). */
  readonly defer: (fn: (q: Queryable) => Promise<void>) => void;
  /** The notice rows' write, after every tool's deferred writes — a delivery's card_instances row (DELTA-08) is one of those. */
  readonly deferLate: (fn: (q: Queryable) => Promise<void>) => void;
}

export class PgArtifactSink implements ArtifactSink {
  /** Every PDF this command rendered, by document id (the render tool reads sha256/placements from here). */
  readonly results = new Map<string, RenderedPdf>();
  /** Document ids whose rows already exist (the render tool's idempotent pre-lookup): rendered again, never re-stored, no second staged/stored event. */
  readonly knownIds = new Set<string>();
  private readonly perCommand = new Map<string, string>();
  private readonly persisted = new Set<string>();
  private readonly deps: SinkDeps;
  constructor(deps: SinkDeps) { this.deps = deps; }

  /** The same render twice in one command is one document (edge case): keyed by template, version, payload hash and subject. */
  idFor(key: { templateCode: string; version: string; payloadHash: string; loanId?: string; applicationId?: string }): string {
    const k = `${key.templateCode}|${key.version}|${key.payloadHash}|${key.loanId ?? ""}|${key.applicationId ?? ""}`;
    let id = this.perCommand.get(k); if (!id) { id = randomUUID(); this.perCommand.set(k, id); }
    return id;
  }

  rendered(input: { documentId: string; templateCode: string; version: TemplateVersion; payload: Record<string, unknown>; loanId?: string; applicationId?: string; caseId?: string }, rendered: Rendered): { document_id: string; sha256: string; byte_size: number; page_count: number; blocks: Rendered["blocks"] } {
    const { blobs, runtime } = this.deps;
    const ctx = { events: this.deps.events, actor: this.deps.actor, now: this.deps.now() };
    const pdf = renderBlocksPdf(rendered, { template_code: input.templateCode, template_version: input.version.version, now: ctx.now });
    const id = input.documentId;
    this.results.set(id, pdf);
    const key = docKey({ loan_id: input.loanId ?? null, application_id: input.applicationId ?? null });
    const aggregate = { kind: "document", id };
    ctx.events.append({ type: "document.rendered", ...key, aggregate, actor: ctx.actor, payload: { document_id: id, template_code: input.templateCode, template_version: input.version.version, payload_hash: pdf.payload_hash, sha256: pdf.sha256, byte_size: pdf.byte_size, page_count: pdf.page_count } });
    if (!this.knownIds.has(id)) {
      this.knownIds.add(id);
      const template = runtime.noticeRegistry.template(input.templateCode);
      const retention = retentionFor(template.retention);
      ctx.events.append({ type: "document.staged", ...key, aggregate, actor: ctx.actor, payload: { document_id: id, staged_at: ctx.now, kind: RENDERED_NOTICE_KIND, sha256: pdf.sha256, byte_size: pdf.byte_size, mime_type: "application/pdf", retention_class: retention, ...(input.loanId ? { loan_id: input.loanId } : {}), ...(input.applicationId ? { application_id: input.applicationId } : {}) } });
      const storeReachable = !blobs.outage;
      const expectedUri = `${blobs.vendorName}://${id}#1`; const expectedGeneration = "1";
      if (storeReachable) ctx.events.append({ type: "document.stored", ...key, aggregate, actor: ctx.actor, payload: { document_id: id, storage_uri: expectedUri, stored_generation: expectedGeneration, sha256: pdf.sha256, stored_at: ctx.now } });
      const actor: Actor = ctx.actor;
      this.deps.defer(async (q) => {
        // the events were appended above; the store runs on a scratch log so nothing is logged twice
        const scratch: EventStore = new MemoryEventStore(runtime.clock, key);
        const r = await storeDocument({ q, blobs, events: scratch, actor, now: ctx.now }, { id, kind: RENDERED_NOTICE_KIND, bytes: pdf.bytes, mime_type: "application/pdf", retention_class: retention, loan_id: input.loanId ?? null, application_id: input.applicationId ?? null,
          template_code: input.templateCode, template_version: input.version.version, payload_hash: pdf.payload_hash, page_count: pdf.page_count, text_layer: true, locale: pdf.locale, metadata: { title: template.name, template_code: input.templateCode, template_version: input.version.version } });
        // the event above named the URI and generation the drain was going to write: a row that says otherwise (an outage between the two, a store that names its objects differently, a re-read that differed) rolls the command back rather than commit a log that contradicts the row
        if (storeReachable && !r.existing && (r.storage_status !== "stored" || r.storage_uri !== expectedUri || r.stored_generation !== expectedGeneration)) throw new Error(`${r.drain?.error ?? "STORE_OUTCOME_CHANGED"}: the object store answered ${r.storage_status} at ${r.storage_uri} (generation ${r.stored_generation ?? "none"}) for ${id} after document.stored named ${expectedUri}; the render is refused and nothing is written`);
        if (r.existing && r.sha256 !== pdf.sha256) throw new Error(`DOCUMENT_ID_TAKEN: ${id} already holds different bytes`);
      });
    }
    return { document_id: id, sha256: pdf.sha256, byte_size: pdf.byte_size, page_count: pdf.page_count, blocks: blocksFromPlacements(pdf.placements, rendered.blocks) };
  }

  /** The notice's rows, deferred to the command's transaction after the document row (idempotent upsert; the FKs the row carries are checked so a projection never fails a command). */
  persist(n: Notice): void {
    const { runtime } = this.deps;
    this.deps.deferLate(async (q) => {
      const repo = new PgNoticeRepository(q);
      if (!this.persisted.has(n.id)) {
        this.persisted.add(n.id);
        const t = runtime.noticeRegistry.template(n.templateCode);
        await repo.upsertTemplate(t, q);
        const v = runtime.noticeRegistry.versionsOf(n.templateCode).find((x) => x.version === n.templateVersion);
        if (v) await repo.saveVersion(v, q);
      }
      // a notice keyed by a loan the loans table does not hold (a unit fixture's loan id) cannot be a notices row; its document still is
      if (n.loanId && !(isUuid(n.loanId) && (await q.query(`SELECT 1 FROM loans WHERE id = $1`, [n.loanId])).length)) return;
      // a case id that is not a uuid (4.x cases keyed by a prefixed string, e.g. `noe-…`) is not a cases row: the notice keeps its loan, the column stays null
      const caseOk = n.caseId && isUuid(n.caseId) ? (await q.query(`SELECT 1 FROM cases WHERE id = $1`, [n.caseId])).length > 0 : false;
      const deliveries = [] as Notice["deliveries"];
      for (const d of n.deliveries) {
        const cardOk = d.cardInstanceId && isUuid(d.cardInstanceId) ? (await q.query(`SELECT 1 FROM card_instances WHERE card_instance_id = $1`, [d.cardInstanceId])).length > 0 : false;
        const { cardInstanceId: _c, ...rest } = d; void _c;
        deliveries.push(cardOk ? d : (rest as Notice["deliveries"][number]));
      }
      const { caseId: _k, ...restNotice } = n; void _k;
      const row: Notice = { ...restNotice, ...(caseOk ? { caseId: n.caseId } : {}), deliveries } as Notice;
      await repo.saveNotice(row, q);
    });
  }
}

/** The same layer without a database: bytes kept in memory by document id; the events go to the command's log. */
export class MemoryArtifactSink implements ArtifactSink {
  readonly results = new Map<string, RenderedPdf>();
  readonly bytes = new Map<string, Buffer>();
  private readonly now: () => string;
  private readonly perCommand = new Map<string, string>();
  constructor(clock: { now(): string }) { this.now = () => clock.now(); }
  idFor(key: { templateCode: string; version: string; payloadHash: string; loanId?: string; applicationId?: string }): string {
    const k = `${key.templateCode}|${key.version}|${key.payloadHash}|${key.loanId ?? ""}|${key.applicationId ?? ""}`;
    let id = this.perCommand.get(k); if (!id) { id = randomUUID(); this.perCommand.set(k, id); }
    return id;
  }
  rendered(input: { documentId: string; templateCode: string; version: TemplateVersion; payload: Record<string, unknown> }, rendered: Rendered): { document_id: string; sha256: string; byte_size: number; page_count: number; blocks: Rendered["blocks"] } {
    const pdf = renderBlocksPdf(rendered, { template_code: input.templateCode, template_version: input.version.version, now: this.now() });
    this.results.set(input.documentId, pdf); this.bytes.set(input.documentId, pdf.bytes);
    return { document_id: input.documentId, sha256: pdf.sha256, byte_size: pdf.byte_size, page_count: pdf.page_count, blocks: blocksFromPlacements(pdf.placements, rendered.blocks) };
  }
}

/** The command's NoticeService with the artifact layer wired (undefined without the delivery ports — the same semantics as before 35.2). */
export function noticeServiceFor(runtime: Runtime, ctx: UowContext, actor: Actor, deferLate: (fn: (q: Queryable) => Promise<void>) => void, defer: (fn: (q: Queryable) => Promise<void>) => void = deferLate): { notices: NoticeService | undefined; sink: PgArtifactSink | undefined } {
  if (!runtime.ports.printMail || !runtime.ports.edelivery) return { notices: undefined, sink: undefined };
  const sink = new PgArtifactSink({ runtime, events: ctx.events, actor, now: () => ctx.clock.now(), blobs: runtime.blobs, defer, deferLate });
  const notices = new NoticeService({ registry: runtime.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: runtime.ports.printMail, edelivery: runtime.ports.edelivery, notices: runtime.noticeMemory, artifacts: sink, persist: (n) => sink.persist(n) });
  return { notices, sink };
}
