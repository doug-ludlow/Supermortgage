/**
 * §35.1 rule 11: "A tool that writes the kind `integration_messages` to the store (section16-3.ts:259) is projected into
 * the real outbox by `PgOutbox.enqueue` in `opts.commit` with the store id as idempotency key, so a second projection is
 * `duplicate: true`, never a second message." The map is a row projector into the real outbox (the runner special-cases
 * `outbox: true`): `adapter` is the version's `adapter` or `channel`, the payload is the version's `package` (or the whole
 * version), the idempotency key is the store id (`sfcpm-<uuid>-<ts>`), the loan is the command's.
 */
import { text, type ProjectorMap } from "./types.ts";

export const INTEGRATION_MESSAGES: ProjectorMap & { readonly outbox: true } = {
  kind: "integration_messages", table: "integration_messages", idColumn: "id", mode: "insert", phase: "commit", history: false, owner: "16.3", version: "35.1/integration_messages@v1",
  outbox: true,
  columns: { adapter: text("adapter"), channel: text("adapter") },
};

export const SECTION_16_PROJECTORS: readonly ProjectorMap[] = [INTEGRATION_MESSAGES];
