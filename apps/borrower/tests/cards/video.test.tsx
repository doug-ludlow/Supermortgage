/**
 * 32.17 — what the borrower SEES on /app/video (the API facts are in src/domain/borrower/32-17.spec.test.ts): the shell in
 * fixtures mode with the call pane in the thread's place (a FAKE call), the rail beside it with only the current ask open and
 * the rest behind "n more after this", the disclosure footer, no composer, no microphone control of Supermortgage's own, no
 * "Talk to a person"; the rail's proposal strip (Confirm · Edit on the proposed card's row) resolving with
 * evidence.source = borrower_stated; Leave → the ended line and a new call; the FAKE page posting the vendor's chat-completions
 * request and rendering the streamed reply as the replica's words.
 */
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "@/lib/copy";
import { VideoShell } from "@/components/video/VideoShell";
import { FakeVideoPage } from "@/components/video/FakeVideoPage";
import { Rail } from "@/components/record/Rail";
import { loadFixture } from "@/lib/fixtures";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import { makeCard, TZ } from "./helpers";

const user = userEvent.setup();

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "matchMedia", { writable: true, value: (q: string) => ({ matches: q.includes("1024"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }) });
});

describe("32.17 — /app/video in fixtures mode (the FAKE call, the rail beside it)", () => {
  it("T10/T12: the call pane replaces the thread; the footer disclosure is on the screen; no composer, no microphone control, no Talk to a person; the rail shows only the current ask open and the rest behind one line; no card component inside the call pane", async () => {
    render(<VideoShell fixturesMode fixtureName="refinance" />);
    const call = await screen.findByTestId("video-call");
    await waitFor(() => expect(call).toHaveAttribute("data-phase", "live"));
    expect(within(call).getByTestId("video-fake-marker")).toHaveTextContent(copy("video.fake.marker"));
    expect(screen.getByTestId("footer-disclosure")).toHaveTextContent("NMLS #");
    expect(screen.queryByTestId("action-bar")).toBeNull();
    expect(screen.queryByTestId("thread")).toBeNull();
    expect(screen.queryByTestId("talk-to-person")).toBeNull();
    expect(screen.queryByRole("button", { name: /microphone|mic|voice/i })).toBeNull();
    expect(call.querySelector("article[data-card-kind]")).toBeNull();
    const needed = screen.getByTestId("record").querySelector('[data-record-section="needed"]')!;
    const rows = Array.from(needed.querySelectorAll("[data-rail-card]"));
    expect(rows.filter((r) => r.getAttribute("data-tone") !== "caution")).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-expanded", "true");
    const later = within(needed as HTMLElement).getByTestId("needs-later");
    expect(later.textContent).toMatch(/\d+ more after this$/);
    expect(later).toHaveAttribute("aria-expanded", "false");
  });

  it("Leave ends the call: the ended line and a new call offered; the rail stays", async () => {
    render(<VideoShell fixturesMode fixtureName="refinance" />);
    const call = await screen.findByTestId("video-call");
    await waitFor(() => expect(call).toHaveAttribute("data-phase", "live"));
    await user.click(within(call).getByTestId("video-leave"));
    expect(await within(call).findByTestId("video-ended")).toHaveTextContent(copy("video.ended"));
    expect(within(call).getByTestId("video-new-call")).toHaveTextContent(copy("video.new_call"));
    expect(screen.getByTestId("record")).toBeInTheDocument();
    await user.click(within(call).getByTestId("video-new-call"));
    await waitFor(() => expect(call).toHaveAttribute("data-phase", "live"));
  });
});

describe("32.17 discrepancy (1) — the rail's proposal strip (no thread to hold the confirm chip)", () => {
  function railWith(card: AnyCardInstance, resolve: (c: AnyCardInstance, r: ResolveRequest) => Promise<void>, proposalStrip = true) {
    const f = loadFixture("refinance");
    return render(<Rail record={f.record} cards={{ [card.card_instance_id]: card }} timezone={TZ} cardProps={{ onOpen: () => undefined, onLaunchVendor: async () => ({ vendor_session_id: "x" }), onUpload: async () => ({ document_id: "d" }), onMessage: async () => undefined }} resolve={resolve} cardErrors={{}} currentAskId={card.card_instance_id} link={() => undefined} proposalStrip={proposalStrip} />);
  }
  const income = () => makeCard("ConfirmCard", { title: "Confirm your income", fields: [{ path: "monthly_income", label: "Monthly income", value: "", source: "borrower" }], commits_to: "application_income", money_paths: ["monthly_income"], required_paths: ["monthly_income"], proposal: { fields: [{ path: "monthly_income", value: "820000", source: "borrower_stated_unconfirmed" }], proposed_at: "2026-10-20T10:01:00-07:00" } } as never, { card_instance_id: "card-income-1", copy_key: "income.confirm.title" });

  it("T3: the proposed card's row shows the stated value with Confirm and Edit; Confirm resolves it with evidence.source = borrower_stated", async () => {
    const calls: ResolveRequest[] = [];
    railWith(income(), async (_c, r) => { calls.push(r); });
    const strip = screen.getByTestId("rail-proposal");
    expect(strip).toHaveAttribute("data-card-id", "card-income-1");
    expect(within(strip).getByTestId("confirm-chip-readback")).toHaveTextContent("$8,200.00");
    expect(within(strip).getByTestId("confirm-chip-confirm")).toHaveTextContent(copy("chip.confirm"));
    expect(within(strip).getByTestId("confirm-chip-edit")).toHaveTextContent(copy("chip.edit"));
    expect(strip).toHaveTextContent(copy("video.rail_confirm.hint"));
    await user.click(within(strip).getByTestId("confirm-chip-confirm"));
    expect(calls).toHaveLength(1);
    const ev = calls[0]!.evidence as { source?: string; fields?: { path: string; value_confirmed: string }[] };
    expect(ev.source).toBe("borrower_stated");
    expect(ev.fields?.[0]).toMatchObject({ path: "monthly_income", value_confirmed: "820000" });
  });

  it("the strip renders only when the shell asks for it (the thread keeps its confirm chip on /app)", () => {
    railWith(income(), async () => undefined, false);
    expect(screen.queryByTestId("rail-proposal")).toBeNull();
  });
});

describe("32.17 discrepancy (3) — the FAKE video page", () => {
  const sse = (lines: string[]) => new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } });
  const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "supermortgage-turn", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

  it("T11: the marker; an utterance is posted as the vendor's chat-completions request (stream: true, the last user message) to /v1/video/llm/{token}/chat/completions and the streamed reply shows as the replica's words; join and leave trigger the callbacks", async () => {
    const posts: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      posts.push({ url, body, headers });
      if (url.includes("/fake-callback")) return new Response(JSON.stringify({ received: true, outcome: body.event_type === "system.replica_joined" ? "joined" : "ended" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(sse([chunk(""), chunk("The next thing I need is on the card here. "), chunk("Tap it when you are ready.", null), chunk("", "stop"), "data: [DONE]\n\n"]), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    render(<FakeVideoPage token="tok_abc" videoSessionId="vs-1" />);
    expect(screen.getByTestId("fake-video-marker")).toHaveTextContent(copy("video.fake.marker"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/v1/borrower/video/sessions/vs-1/fake-callback") && p.body.event_type === "system.replica_joined")).toBe(true));
    await user.type(screen.getByTestId("fake-video-input"), "how does this work?");
    await user.click(screen.getByTestId("fake-video-send"));
    const llm = await waitFor(() => { const p = posts.find((x) => x.url.includes("/v1/video/llm/tok_abc/chat/completions")); expect(p).toBeTruthy(); return p!; });
    expect(llm.body.stream).toBe(true);
    const messages = llm.body.messages as { role: string; content: string }[];
    expect(messages.at(-1)).toEqual({ role: "user", content: "how does this work?" });
    expect(llm.headers.authorization).toBe("Bearer tok_abc");
    expect(JSON.stringify(llm.body)).not.toMatch(/conversation\.(echo|respond)/);
    await waitFor(() => expect(screen.getByTestId("fake-video-replica")).toHaveTextContent("The next thing I need is on the card here. Tap it when you are ready."));
    expect(screen.getByTestId("fake-video-you")).toHaveTextContent("how does this work?");
    fireEvent.click(screen.getByTestId("fake-video-leave"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/fake-callback") && p.body.event_type === "system.shutdown")).toBe(true));
    expect(screen.getByTestId("fake-video-left")).toHaveTextContent(copy("video.ended"));
  });
});
