"use client";

import { CardFrame } from "./CardFrame";
import type { CardComponentProps } from "./types";
import { BASE_PATH } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { copy, copyExtra } from "@/lib/copy";
import { resolveCopyTokens } from "@/components/flows/6-decision-property";

/**
 * 01 §3.16 — a regulatory notice paired with its rendered document and the template's own
 * plain-language block. Never editable, never summarized by the assistant. Mail delivery
 * shows "Mailed {{date}}" and no receipt action.
 */
export function NoticeCard({ card, timezone, onOpen }: CardComponentProps<"NoticeCard">) {
  const p = card.props;
  const href = `${BASE_PATH}/doc/${encodeURIComponent(p.rendered_document_id)}`;
  // the copy library's title/line when the server named only the key (32.4 tolerance refund NoticeCard); the plain-language block is the template's own when present
  const tokens = resolveCopyTokens(p);   // 32.6 §5: `copy_token_keys` name library entries (the failing insurance element and its fix)
  const title = p.title || copy(card.copy_key, tokens);
  const line = p.line || copyExtra(card.copy_key, "line", tokens);
  const plain = p.plain_language || line || "";
  return (
    <CardFrame card={card} timezone={timezone} title={title} collapsible={false}>
      {line ? <p className="sm-primary-text">{line}</p> : null}
      <div className="sm-card-block" data-testid="notice-plain-language">
        <p className="sm-primary-text" style={{ whiteSpace: "pre-wrap" }}>
          {plain}
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
