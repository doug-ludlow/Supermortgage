import { DocumentViewer } from "@/components/viewer/DocumentViewer";

export const dynamic = "force-dynamic";

/**
 * 01 §1.5 document viewer: /doc/{document_id} (authenticated). The viewer asks the API for the session-bound signed URL
 * (GET /v1/borrower/documents/{id}: 02 §6 — five minutes, bound to this session; opens are logged to ui_events{document_opened})
 * and renders the stored bytes through it with the text layer the API returns beside the link (35.2 rule 7: the bytes are the
 * stored ones, hashed on the way out; a disposed document answers 410 and the `document.unavailable` copy replaces the body).
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentViewer id={id} />;
}
