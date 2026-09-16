/**
 * waitAfterDeclaration after a throttled poll (deploy 191): the tap committed, the edge answered 429 to the next read of the thread
 * (three sessions on one address at the watch cadence); the wait retries instead of surfacing the tap's `error.generic`. A 4xx that is
 * the borrower's own (401, 409) still throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyCardInstance } from "@/lib/types/cards";

const thread = vi.fn();
vi.mock("@/lib/api/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...real, api: { ...real.api, thread: () => thread() } };
});
const { ApiRequestError } = await import("@/lib/api/client");
const { waitAfterDeclaration } = await import("@/components/apply/wire");

const card = (id: string, copy_key: string, status: "pending" | "resolved"): AnyCardInstance => ({ card_instance_id: id, conversation_id: "conv-1", party_id: "party-1", subject: { application_id: "app-1" }, kind: "ChoiceCard", status, created_by: "agent:intake", copy_key, props: { options: [] } } as unknown as AnyCardInstance);
const throttled = () => new ApiRequestError(429, { code: "http_429", copy_key: "error.generic" });

afterEach(() => { thread.mockReset(); });

describe("waitAfterDeclaration over a throttled thread read", () => {
  it("retries past a 429 and returns the cards once the next question is on the thread", async () => {
    thread.mockRejectedValueOnce(throttled()).mockRejectedValueOnce(throttled()).mockResolvedValue({ cards: [card("c1", "declarations.title", "resolved"), card("c2", "demographics.title", "pending")] });
    const cards = await waitAfterDeclaration("c1", 5_000, 1);
    expect(cards.map((c) => c.copy_key)).toEqual(["declarations.title", "demographics.title"]);
    expect(thread).toHaveBeenCalledTimes(3);
  });
  it("still throws the borrower's own refusal (a 401 is the door, not a retry)", async () => {
    thread.mockRejectedValue(new ApiRequestError(401, { code: "AUTH_REQUIRED", copy_key: "auth.sign_in" }));
    await expect(waitAfterDeclaration("c1", 5_000, 1)).rejects.toBeInstanceOf(ApiRequestError);
  });
});
