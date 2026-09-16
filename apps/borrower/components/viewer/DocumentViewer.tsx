"use client";

/**
 * 35.2 / 01 §1.5 — the document viewer. One GET for the link (the signed, session-bound URL plus the row's hash, template
 * version and text layer), then the PDF rendered through the proxy at that URL (the browser never holds a bearer; the proxy
 * forwards the session cookie) with the text layer beside it for screen readers, search and copy. A 404 (not this party's,
 * never confirmed to exist) and a 410 (disposed: the tombstone) render copy, never the API's reason text.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiBase, ApiRequestError } from "@/lib/api/client";
import { copy } from "@/lib/copy";
import { FooterDisclosure } from "@/components/shell/FooterDisclosure";

export interface DocumentLink {
  document_id: string;
  title: string;
  doc_class: string | null;
  mime_type: string | null;
  url: string;
  expires_at: string;
  sha256: string;
  page_count: number | null;
  template_code: string | null;
  template_version: string | null;
  text_layer: string | null;
}

type State = { kind: "loading" } | { kind: "ready"; link: DocumentLink } | { kind: "refused"; status: number; copyKey: string };

async function fetchLink(id: string): Promise<DocumentLink> {
  const res = await fetch(`${apiBase()}/v1/borrower/documents/${encodeURIComponent(id)}`, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    let body: { code: string; copy_key: string } = { code: `http_${res.status}`, copy_key: "error.generic" };
    try { body = (await res.json()) as { code: string; copy_key: string }; } catch { /* non-JSON error body */ }
    throw new ApiRequestError(res.status, body);
  }
  return (await res.json()) as DocumentLink;
}

export function DocumentViewer({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    fetchLink(id)
      .then((link) => { if (live) setState({ kind: "ready", link }); })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiRequestError) setState({ kind: "refused", status: e.status, copyKey: e.status === 410 ? "document.unavailable" : e.status === 401 ? "auth.sign_in" : e.body.copy_key || "error.generic" });
        else setState({ kind: "refused", status: 0, copyKey: "error.generic" });
      });
    return () => { live = false; };
  }, [id]);

  const title = state.kind === "ready" ? state.link.title : "Document";
  return (
    <main className="sm-viewer-page" style={{ padding: 24, maxWidth: 900 }} data-document-id={id}>
      <p>
        <Link href="/">← Back to your conversation</Link>
      </p>
      <h1 style={{ fontSize: "1.375rem" }}>{title}</h1>
      {state.kind === "loading" ? <p className="sm-viewer" data-testid="doc-loading">Opening your document…</p> : null}
      {state.kind === "refused" ? (
        <section className="sm-viewer" data-testid="doc-refused" data-status={state.status} data-copy-key={state.copyKey}>
          <p>{copy(state.copyKey)}</p>
        </section>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <div className="sm-viewer" style={{ minHeight: 320 }}>
            <object type={state.link.mime_type ?? "application/pdf"} data={`${apiBase()}${state.link.url}`} aria-label={state.link.title} width="100%" height="720" data-testid="doc-object">
              <p>Your browser cannot show this document inline; the text is below.</p>
            </object>
          </div>
          <section className="sm-viewer__text" data-testid="doc-text-layer" aria-label={`${state.link.title}, text`}>
            <p style={{ whiteSpace: "pre-wrap" }}>{state.link.text_layer ?? ""}</p>
          </section>
          <p className="sm-source" data-testid="doc-footer">
            {state.link.template_code ? `Template ${state.link.template_code} ${state.link.template_version ?? ""}`.trim() + " · " : ""}
            {`Document ${state.link.sha256.slice(0, 12)}… · link expires ${state.link.expires_at}`}
          </p>
        </>
      ) : null}
      <FooterDisclosure />
    </main>
  );
}
