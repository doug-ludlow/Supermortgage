import Link from "next/link";

/**
 * 01 §1.5 document viewer: /doc/{document_id} (authenticated). Documents are served
 * through signed, short-lived URLs bound to the session (02 §6) obtained from
 * GET /v1/borrower/documents/{id}; opens are logged to ui_events{document_opened}.
 * Stub: renders the frame; the signed-URL fetch lands with the API seam.
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main style={{ padding: 24, maxWidth: 900 }}>
      <p>
        <Link href="/">← Back to your conversation</Link>
      </p>
      <h1 style={{ fontSize: "1.375rem" }}>Document</h1>
      <div className="sm-viewer" style={{ minHeight: 320 }} data-document-id={id}>
        The document viewer opens here with a text layer. (Document {id})
      </div>
      <p className="sm-source">Template version and delivery evidence appear in the footer of every notice.</p>
    </main>
  );
}
