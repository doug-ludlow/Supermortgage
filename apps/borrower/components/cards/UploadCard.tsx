"use client";

import { useId, useRef, useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { UploadCardEvidence } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

/** 01 §3.9 — document upload; camera capture on mobile; resolves on document.classified (API), mismatch re-opens. */
export function UploadCard({ card, timezone, onResolve, onUpload, busy, error }: CardComponentProps<"UploadCard">) {
  const p = card.props;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const pending = card.status === "pending";
  const heading = p.title || copy(card.copy_key, p.copy_tokens);

  const onFile = async (file: File) => {
    setFileName(file.name);
    setUploading(true);
    setUploadError(undefined);
    try {
      if (onUpload) await onUpload(file, p.document_class);
      const evidence: UploadCardEvidence = { document_class: p.document_class, file_name: file.name, uploaded_at: nowIso() };
      await onResolve({ evidence, option_id: "upload" });
    } catch {
      setUploadError(copy("upload.unreadable"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={`${heading} — received${fileName ? ` (${fileName})` : ""}`} announce={fileName ? `Uploaded ${fileName}` : undefined}>
      <p>{p.why}</p>
      {p.mismatch ? (
        <p className="sm-error" role="alert">
          {copy("upload.mismatch", { detected: p.mismatch.detected, expected: p.mismatch.expected })}
        </p>
      ) : null}
      {p.stale ? (
        <p className="sm-error" role="alert" data-testid="upload-stale">
          {copy("upload.stale", { date: p.stale.date, n: String(p.stale.n) })}
        </p>
      ) : null}
      {p.reason_copy_key ? (
        <p className="sm-primary-text" data-testid="upload-reason">
          {copy(p.reason_copy_key, p.copy_tokens)}
        </p>
      ) : null}
      <p>
        <strong>Examples:</strong> {p.accepted_examples.join(", ")}
        {p.freshness_hint ? ` · ${p.freshness_hint}` : ""}
      </p>
      {pending ? (
        <div className="sm-card-actions">
          <input
            ref={input}
            id={id}
            type="file"
            className="sm-visually-hidden"
            accept="image/*,application/pdf"
            capture="environment"
            aria-label="Choose a file or take a photo"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <button type="button" className="sm-btn sm-btn-primary" onClick={() => input.current?.click()} disabled={busy || uploading}>
            {uploading ? "Uploading…" : "Take a photo or choose a file"}
          </button>
        </div>
      ) : null}
      {uploadError || error ? (
        <p className="sm-error" role="alert">
          {uploadError ?? error}
        </p>
      ) : null}
    </CardFrame>
  );
}
