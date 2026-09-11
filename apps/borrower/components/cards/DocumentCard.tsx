"use client";

import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { DocumentCardEvidence } from "@/lib/types/cards";
import { BASE_PATH } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

/**
 * 01 §3.6 — deliver a disclosure/document and capture receipt. The card exists only when
 * an active E-SIGN consent covers the class (the API's guard, T-X-04); otherwise the
 * platform sends a StatusCard "mailed on [date]" instead.
 */
export function DocumentCard({ card, timezone, onResolve, onOpen, busy, error }: CardComponentProps<"DocumentCard">) {
  const p = card.props;
  const pending = card.status === "pending";
  const receivedAt = (card.evidence as DocumentCardEvidence | undefined)?.received_at ?? p.received_at;
  const href = `${BASE_PATH}/doc/${encodeURIComponent(p.document_id)}`;

  const confirm = () => {
    const evidence: DocumentCardEvidence = { receipt_evidence: "esign_confirmed", received_at: nowIso() };
    void onResolve({ evidence, option_id: "confirm_receipt" });
  };

  return (
    <CardFrame
      card={card}
      timezone={timezone}
      title={p.title}
      receipt={`${p.title} received ${receivedAt ? formatDate(receivedAt, timezone, "datetime") : ""}`.trim()}
      announce={receivedAt ? `${p.title} received` : undefined}
    >
      <p>{p.why_you_see_this}</p>
      <div className="sm-viewer" data-testid="document-viewer">
        <a
          href={href}
          onClick={(e) => {
            if (onOpen) {
              e.preventDefault();
              onOpen({ document_id: p.document_id });
            }
          }}
        >
          Open {p.notice_code ? `(${p.notice_code})` : "document"}
        </a>
      </div>
      {pending && p.requires_ack ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={confirm} disabled={busy}>
            Confirm receipt
          </button>
        </div>
      ) : null}
      {!p.requires_ack ? <p className="sm-card-footer">No action needed — this is for your records.</p> : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
