"use client";

import { CardFrame } from "./CardFrame";
import type { CardComponentProps } from "./types";
import { BASE_PATH } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

/**
 * 01 §3.16 — a regulatory notice paired with its rendered document and the template's own
 * plain-language block. Never editable, never summarized by the assistant. Mail delivery
 * shows "Mailed {{date}}" and no receipt action.
 */
export function NoticeCard({ card, timezone, onOpen }: CardComponentProps<"NoticeCard">) {
  const p = card.props;
  const href = `${BASE_PATH}/doc/${encodeURIComponent(p.rendered_document_id)}`;
  return (
    <CardFrame card={card} timezone={timezone} title={p.title} collapsible={false}>
      {p.line ? <p className="sm-primary-text">{p.line}</p> : null}
      <div className="sm-card-block" data-testid="notice-plain-language">
        <p className="sm-primary-text" style={{ whiteSpace: "pre-wrap" }}>
          {p.plain_language}
        </p>
      </div>
      <div className="sm-viewer">
        <a
          href={href}
          onClick={(e) => {
            if (onOpen) {
              e.preventDefault();
              onOpen({ document_id: p.rendered_document_id });
            }
          }}
        >
          Open the notice ({p.notice_code})
        </a>
      </div>
      <p className="sm-card-footer sm-source">
        {p.template_version ? `Template ${p.template_version} · ` : ""}
        {p.channel === "mail" && p.mailed_at ? `Mailed ${formatDate(p.mailed_at, timezone)}` : p.delivered_at ? `Delivered ${formatDate(p.delivered_at, timezone, "datetime")}` : ""}
      </p>
    </CardFrame>
  );
}
