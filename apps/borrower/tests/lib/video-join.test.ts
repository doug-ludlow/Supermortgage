// 32.17 rule 15 / T19 — the join options for the vendor's room: the page's own client, the borrower's first name as the display name, never the vendor's pre-join page.
import { describe, expect, it } from "vitest";
import { displayNameOf, joinOptionsFor } from "@/lib/video/join";

describe("joinOptionsFor", () => {
  const live = { conversation_url: "https://tavus.daily.co/c123", borrower_camera: "on" as const };
  it("joins the live room with the first name as the display name", () => {
    expect(joinOptionsFor(live, "Dana")).toEqual({ url: live.conversation_url, userName: "Dana", startVideoOff: false, startAudioOff: false });
  });
  it("never joins as an e-mail address or the platform's placeholder", () => {
    expect(joinOptionsFor(live, null)?.userName).toBe("You");
    expect(joinOptionsFor(live, "dana@example.test")?.userName).toBe("You");
    expect(joinOptionsFor(live, "Borrower")?.userName).toBe("You");
    expect(displayNameOf("Dana Reyes")).toBe("Dana");
  });
  it("honours the audio-only setting and refuses the FAKE page (a frame, not a room)", () => {
    expect(joinOptionsFor({ ...live, borrower_camera: "off" }, "Dana")?.startVideoOff).toBe(true);
    expect(joinOptionsFor({ conversation_url: "/app/video/fake/tok", borrower_camera: "on" }, "Dana")).toBeNull();
    expect(joinOptionsFor({ conversation_url: null }, "Dana")).toBeNull();
  });
});
