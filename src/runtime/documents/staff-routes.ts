/**
 * §35.2 rule 7 — the console's document view: `GET /ops/api/documents/{id}/content` serves a stored document's bytes to a
 * signed-in staff user (the roles the `documents.open` tool admits) through `documents.open`'s unit of work, so every staff
 * view is a `document_access_log{purpose: staff_view, staff_user_id}` row with the hash of what was served. Dispatched by
 * src/console/server.ts beside 34.4's controls routes (the same role gate, staff context and action log). The bytes ride as
 * base64 in the JSON answer (the console is a JSON API; its viewer builds a blob URL) with the text layer when the row has one.
 */
import type { ControlsRoute } from "../controls/routes.ts";
import type { Runtime } from "../app.ts";
import { openDocumentInUow, raiseServedMismatch } from "./open-uow.ts";

export const DOCUMENT_VIEW_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance", "ciso", "counsel"];

export function documentStaffRoutes(deps: { runtime: Runtime }): readonly ControlsRoute[] {
  const rt = deps.runtime;
  return [
    { method: "GET", path: "/api/documents/:id/content", roles: DOCUMENT_VIEW_ROLES, command: "documents.open", handler: async (req) => {
      const id = req.params["id"] ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, body: { code: "BAD_REQUEST", error: "document id must be a uuid" } };
      const r = await openDocumentInUow(rt, { document_id: id, purpose: "staff_view", staff_user_id: req.actor.id }, req.actor);
      const subject = { kind: "document", id };
      if (r.kind === "unknown") return { status: 404, body: { code: "NOT_FOUND", error: "no such document" }, subject };
      if (r.kind === "tombstone") return { status: 410, body: { code: "DOCUMENT_DISPOSED", document_id: id, sha256: r.sha256, disposal_run_id: r.disposal_run_id, disposed_at: r.disposed_at }, subject };
      if (r.kind === "unavailable") return { status: 404, body: { code: "DOCUMENT_CONTENT_UNAVAILABLE", document_id: id }, subject };
      if (r.kind === "mismatch") { await raiseServedMismatch(rt, id, req.actor).catch((e) => rt.logger?.error("staff view: served mismatch escalation failed", { document_id: id, error: e })); return { status: 409, body: { code: "INTEGRITY_FAILED", document_id: id, expected_sha256: r.expected_sha256, actual_sha256: r.actual_sha256 }, subject }; }
      if (r.store_missing) await raiseServedMismatch(rt, id, req.actor).catch((e) => rt.logger?.error("staff view: missing-object escalation failed", { document_id: id, error: e }));
      return { status: 200, subject, body: { document_id: id, kind: r.row.kind, mime_type: r.mime_type, sha256: r.sha256, byte_size: r.byte_size, page_count: r.row.page_count, served_from: r.served_from, storage_status: r.row.storage_status, verify_status: r.row.verify_status, legal_hold: r.row.legal_hold, retention_class: r.row.retention_class, template_code: r.row.template_code, template_version: r.row.template_version, text_layer: r.text, bytes_base64: r.bytes.toString("base64"), access_log_id: r.access_log_id } };
    } },
  ];
}
