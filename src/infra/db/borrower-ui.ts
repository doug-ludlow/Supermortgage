/**
 * The UI-owned tables of the borrower surface (docs/ux/02-data-contracts.md §1.6; migration 0111): conversations (one
 * per party), messages (append-only), card_instances with their append-only status transitions, deep_links (01 §6.5)
 * and ui_events (01 §9, append-only). Domain evidence never lives here — the command handler writes it to the owning
 * table; these rows are the corroborating trail.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "./client.ts";
import { toJson } from "./client.ts";

export type CardStatus = "pending" | "resolved" | "expired" | "superseded" | "cancelled";
export type UiEventKind = "card_shown" | "card_resolved" | "document_opened" | "document_scrolled_to_end" | "consent_affirmed" | "connector_started" | "connector_completed" | "deep_link_opened" | "voice_started" | "human_requested";
export interface ConversationRow { readonly conversation_id: string; readonly party_id: string; readonly locale: string; readonly timezone: string; readonly retention_class: string; readonly created_at: string; }
export interface CardInstanceRow {
  readonly card_instance_id: string; readonly conversation_id: string; readonly party_id: string; readonly subject_application_id: string | null; readonly subject_loan_id: string | null; readonly kind: string; readonly status: CardStatus;
  readonly created_by: string; readonly copy_key: string; readonly props: Record<string, unknown>; readonly evidence: Record<string, unknown> | null; readonly command_ref: string | null; readonly expires_at: string | null; readonly created_at: string; readonly resolved_at: string | null;
}
export type DeepLinkTarget = { card_instance_id: string } | { document_id: string } | { route: string };
export interface DeepLinkRow { readonly token: string; readonly party_id: string; readonly target: DeepLinkTarget; readonly expires_at: string; readonly single_use: boolean; readonly created_for_message_id: string | null; readonly created_at: string; readonly used_at: string | null; }

export const DEEP_LINK_DAYS = 7;
export const addDaysIso = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString();
const CARD_COLS = "card_instance_id, conversation_id, party_id, subject_application_id, subject_loan_id, kind, status, created_by, copy_key, props, evidence, command_ref, expires_at, created_at, resolved_at";

export class PgBorrowerUiRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  /** One conversation per party (01 §6.1): created on first use. */
  async conversationFor(partyId: string, q: Queryable = this.db, opts: { locale?: string; timezone?: string } = {}): Promise<ConversationRow> {
    const rows = await q.query<ConversationRow & Record<string, unknown>>(
      `INSERT INTO conversations (party_id, locale, timezone) VALUES ($1, $2, $3) ON CONFLICT (party_id) DO UPDATE SET party_id = EXCLUDED.party_id RETURNING conversation_id, party_id, locale, timezone, retention_class, created_at`,
      [partyId, opts.locale ?? "en-US", opts.timezone ?? "America/New_York"]);
    return rows[0]!;
  }
  /** 02 §6: once an application exists the conversation follows the loan file's class. */
  async setRetentionClass(conversationId: string, retentionClass: "sm_lead_36m" | "fnma_loan_file_life_plus_4y", q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE conversations SET retention_class = $2 WHERE conversation_id = $1`, [conversationId, retentionClass]);
    await q.query(`UPDATE card_instances SET retention_class = $2 WHERE conversation_id = $1`, [conversationId, retentionClass]);
  }

  async appendMessage(i: { conversation_id: string; at: string; sender: "borrower" | "agent" | "human" | "notice" | "system"; sender_ref?: string | null; channel: "app" | "sms" | "email" | "voice" | "mail"; body_text?: string | null; card_instance_id?: string | null; subject_application_id?: string | null; subject_loan_id?: string | null; external_ref?: string | null; voice_turn?: boolean }, q: Queryable = this.db): Promise<string> {
    const id = randomUUID();
    await q.query(`INSERT INTO messages (message_id, conversation_id, at, sender, sender_ref, channel, body_text, card_instance_id, subject_application_id, subject_loan_id, external_ref, voice_turn) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, i.conversation_id, i.at, i.sender, i.sender_ref ?? null, i.channel, i.body_text ?? null, i.card_instance_id ?? null, i.subject_application_id ?? null, i.subject_loan_id ?? null, i.external_ref ?? null, i.voice_turn ?? false]);
    return id;
  }

  async createCard(i: { conversation_id: string; party_id: string; subject_application_id?: string | null; subject_loan_id?: string | null; kind: string; created_by: string; copy_key: string; props?: Record<string, unknown>; command_ref?: string | null; expires_at?: string | null; now: string }, q: Queryable = this.db): Promise<CardInstanceRow> {
    const id = randomUUID();
    const rows = await q.query<CardInstanceRow & Record<string, unknown>>(
      `INSERT INTO card_instances (card_instance_id, conversation_id, party_id, subject_application_id, subject_loan_id, kind, created_by, copy_key, props, command_ref, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING ${CARD_COLS}`,
      [id, i.conversation_id, i.party_id, i.subject_application_id ?? null, i.subject_loan_id ?? null, i.kind, i.created_by, i.copy_key, toJson(i.props ?? {}), i.command_ref ?? null, i.expires_at ?? null, i.now]);
    await q.query(`INSERT INTO card_instance_events (card_instance_id, from_status, to_status, at, actor) VALUES ($1, NULL, 'pending', $2, $3)`, [id, i.now, i.created_by]);
    return rows[0]!;
  }
  async card(id: string, q: Queryable = this.db): Promise<CardInstanceRow | undefined> {
    const rows = await q.query<CardInstanceRow & Record<string, unknown>>(`SELECT ${CARD_COLS} FROM card_instances WHERE card_instance_id = $1`, [id]);
    return rows[0];
  }
  /** A status transition: the row moves and the transition appends (evidence persisted on resolve). */
  async transitionCard(id: string, to: CardStatus, actor: string, at: string, evidence: Record<string, unknown> | null = null, q: Queryable = this.db): Promise<CardInstanceRow> {
    const before = await this.card(id, q); if (!before) throw new RangeError(`no card ${id}`);
    const rows = await q.query<CardInstanceRow & Record<string, unknown>>(`UPDATE card_instances SET status = $2, evidence = COALESCE($3::jsonb, evidence), resolved_at = CASE WHEN $2 = 'resolved' THEN $4 ELSE resolved_at END WHERE card_instance_id = $1 RETURNING ${CARD_COLS}`, [id, to, evidence ? toJson(evidence) : null, at]);
    await q.query(`INSERT INTO card_instance_events (card_instance_id, from_status, to_status, at, actor, evidence) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [id, before.status, to, at, actor, evidence ? toJson(evidence) : null]);
    return rows[0]!;
  }

  /** 01 §6.5: a random token → target; expires in 7 days; never encodes loan data (the target is a row, not a payload). */
  async createDeepLink(i: { party_id: string; target: DeepLinkTarget; now: string; created_for_message_id?: string | null; single_use?: boolean; expires_at?: string }, q: Queryable = this.db): Promise<DeepLinkRow> {
    const token = randomBytes(24).toString("base64url");
    const rows = await q.query<DeepLinkRow & Record<string, unknown>>(`INSERT INTO deep_links (token, party_id, target, expires_at, single_use, created_for_message_id, created_at) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING token, party_id, target, expires_at, single_use, created_for_message_id, created_at, used_at`,
      [token, i.party_id, toJson(i.target), i.expires_at ?? addDaysIso(i.now, DEEP_LINK_DAYS), i.single_use ?? false, i.created_for_message_id ?? null, i.now]);
    return rows[0]!;
  }
  async deepLink(token: string, q: Queryable = this.db): Promise<DeepLinkRow | undefined> {
    const rows = await q.query<DeepLinkRow & Record<string, unknown>>(`SELECT token, party_id, target, expires_at, single_use, created_for_message_id, created_at, used_at FROM deep_links WHERE token = $1`, [token]);
    return rows[0];
  }
  async markDeepLinkUsed(token: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE deep_links SET used_at = COALESCE(used_at, $2) WHERE token = $1`, [token, now]);
  }

  async logUiEvent(i: { party_id: string; session_id?: string | null; conversation_id?: string | null; card_instance_id?: string | null; kind: UiEventKind; at: string; ip?: string | null; user_agent?: string | null; disclosure_version_id?: string | null; payload?: Record<string, unknown> }, q: Queryable = this.db): Promise<string> {
    const id = randomUUID();
    await q.query(`INSERT INTO ui_events (ui_event_id, party_id, session_id, conversation_id, card_instance_id, kind, at, ip, user_agent, disclosure_version_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [id, i.party_id, i.session_id ?? null, i.conversation_id ?? null, i.card_instance_id ?? null, i.kind, i.at, i.ip ?? null, i.user_agent ?? null, i.disclosure_version_id ?? null, toJson(i.payload ?? {})]);
    return id;
  }
  async uiEvents(partyId: string, kind?: UiEventKind, q: Queryable = this.db): Promise<{ ui_event_id: string; kind: string; at: string; session_id: string | null; card_instance_id: string | null; payload: Record<string, unknown> }[]> {
    return q.query(`SELECT ui_event_id, kind, at, session_id, card_instance_id, payload FROM ui_events WHERE party_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY at, ui_event_id`, [partyId, kind ?? null]);
  }
}
