/**
 * Talk — the conversational entry (src/runtime/borrower/talk.ts). One route: POST /v1/borrower/talk { text? }.
 * The proxy turns `lead_token` and `token` into the two HttpOnly cookies, so the page only ever sees the transcript.
 */
import { apiBase, ApiRequestError } from "./client";

export type TalkRole = "you" | "agent" | "notice";
export type TalkLine = { role: TalkRole; text: string; copy_key?: string; at: string };
export type TalkTurn = {
  lead_id: string;
  agent: string;
  model: string | null;
  transcript: TalkLine[];
  lines: TalkLine[];
  step: string;
  session_opened: boolean;
  level: string | null;
  session?: "cookie";
  fake_code?: string;
};

export async function talk(text?: string): Promise<TalkTurn> {
  const res = await fetch(`${apiBase()}/v1/borrower/talk`, {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(text ? { text } : {}),
  });
  if (!res.ok) {
    let err = { code: `http_${res.status}`, copy_key: "error.generic" };
    try { err = (await res.json()) as typeof err; } catch { /* non-JSON */ }
    throw new ApiRequestError(res.status, err);
  }
  return (await res.json()) as TalkTurn;
}
