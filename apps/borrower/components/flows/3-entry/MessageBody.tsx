/**
 * 32.3 — Entry and the five-minute qualification: the flow-specific UI. The API authors thread lines as copy references
 * (`{{copy:key}}` — the automation disclosure of E2, the 20.3 "are you a real person?" script, the E-SIGN pending/active
 * lines, `intent.too_early`, the collapsed receipt lines); the shell renders the library's sentence with the tokens the
 * line needs (`partner.legal_name`), never the key and never a hard-coded sentence (01 §7.4, 13 §1).
 */
import { copy, isCopyKey } from "@/lib/copy";

const COPY_REF = /^\{\{copy:([A-Za-z0-9_.-]+)\}\}(.*)$/s;

/** `{{copy:key}}` → the library text (tokens applied); an unknown key renders its own name so a wrong key is visible in review; plain text renders as is. */
export function renderMessageBody(text: string, tokens: Record<string, string> = {}): { text: string; copy_key: string | null; automated: boolean } {
  const m = COPY_REF.exec(text.trim());
  if (!m) return { text, copy_key: null, automated: false };
  const key = m[1]!; const tail = (m[2] ?? "").trim();
  const body = isCopyKey(key) ? copy(key, tokens) : key;
  return { text: tail ? `${body} ${tail}` : body, copy_key: key, automated: key === "entry.disclosure.first" || key === "entry.disclosure.real_person" };
}

/** `tokens`: the message's own `copy_tokens` (32.14: `entry.resumed` carries `{{answers}}`), beside the partner name every line may use. */
export function MessageBody({ text, partnerLegalName, tokens }: { text: string; partnerLegalName: string; tokens?: Record<string, string> }) {
  const r = renderMessageBody(text, { "partner.legal_name": partnerLegalName, ...(tokens ?? {}) });
  return (
    <span data-copy-key={r.copy_key ?? undefined} data-automated={r.automated ? "true" : undefined}>
      {r.text}
    </span>
  );
}
