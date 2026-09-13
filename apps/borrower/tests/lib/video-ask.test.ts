// 32.17 rule 16 / T20 — when a card rises over the stage: a proposal, a request by Michelle, or a kind only a tap answers; Not now under a stamp.
import { describe, expect, it } from "vitest";
import { askRises, askStamp, pickAsk, proposalComplete, riseReason } from "@/lib/video/ask";

const goal = { card_instance_id: "g", kind: "ChoiceCard", props: {} };
const income = { card_instance_id: "i", kind: "ConfirmCard", props: { proposal: { proposed_at: "2026-09-13T10:00:00Z", fields: [] } } };
describe("riseReason", () => {
  it("keeps a speakable card off the screen until a proposal or a request", () => {
    expect(riseReason(goal)).toBeNull(); expect(riseReason(null)).toBeNull();
    expect(riseReason(income)).toBe("proposal");
    expect(riseReason({ ...goal, props: { requested_by: "card.request" } })).toBe("requested");
  });
  it("raises a kind only a tap can answer", () => {
    for (const kind of ["ConsentCard", "ConnectCard", "UploadCard", "ScheduleCard", "PaymentCard", "DocumentCard", "DemographicsCard", "OfferCard"]) expect(riseReason({ card_instance_id: "c", kind, props: {} })).toBe("tap_only");
  });
});
describe("proposalComplete", () => {
  const identity = (fields: { path: string; value: string }[], onCard = "") => ({ card_instance_id: "id", kind: "ConfirmCard", props: { required_paths: ["legal_name", "email"], fields: [{ path: "legal_name", value: onCard }, { path: "email", value: "" }], proposal: { proposed_at: "2026-09-13T10:00:00Z", fields } } });
  it("the name alone does not rise: the card needs both (32.17 rule 12), and its Confirm could only refuse", () => {
    expect(proposalComplete(identity([{ path: "legal_name", value: "Doug" }]))).toBe(false);
    expect(riseReason(identity([{ path: "legal_name", value: "Doug" }]))).toBeNull();
  });
  it("both together rise as a proposal; a value already on the card counts", () => {
    expect(riseReason(identity([{ path: "legal_name", value: "Doug" }, { path: "email", value: "doug@example.test" }]))).toBe("proposal");
    expect(riseReason(identity([{ path: "email", value: "doug@example.test" }], "Doug"))).toBe("proposal");
    expect(proposalComplete(income)).toBe(true);
  });
});
describe("pickAsk", () => {
  const consent = { card_instance_id: "c1", kind: "ConsentCard", status: "pending", props: {} };
  const connector = { card_instance_id: "c2", kind: "ConnectCard", status: "pending", props: {} };
  const choice = { card_instance_id: "g", kind: "ChoiceCard", status: "pending", props: {} };
  const cards = { c1: consent, c2: connector, g: choice };
  it("the first of the record's needs that rises; Not now moves to the next, never to nothing while a tap is waiting", () => {
    expect(pickAsk(cards, ["c2", "c1", "g"], undefined, new Set())?.card_instance_id).toBe("c2");
    expect(pickAsk(cards, ["c2", "c1", "g"], undefined, new Set([askStamp(connector)]))?.card_instance_id).toBe("c1");
    expect(pickAsk(cards, ["c2", "c1", "g"], undefined, new Set([askStamp(connector), askStamp(consent)]))).toBeNull();
  });
  it("a proposal comes first, then the card Michelle asked for", () => {
    const proposed = { card_instance_id: "i", kind: "ConfirmCard", status: "pending", props: { proposal: { proposed_at: "2026-09-13T10:00:00Z", fields: [] } } };
    expect(pickAsk({ ...cards, i: proposed }, ["c2", "c1"], undefined, new Set())?.card_instance_id).toBe("i");
    expect(pickAsk({ ...cards, i: proposed }, ["c2", "c1"], undefined, new Set([askStamp(proposed)]))?.card_instance_id).toBe("c2");
    const asked = { card_instance_id: "g", kind: "ChoiceCard", status: "pending", props: { requested_by: "card.request" } };
    expect(pickAsk({ ...cards, g: asked }, ["c2", "c1", "g"], "g", new Set())?.card_instance_id).toBe("g");
  });
});
describe("askRises", () => {
  it("sets a card aside under its stamp and raises it again on a new proposal", () => {
    const aside = new Set([askStamp(income)]);
    expect(askRises(income, aside)).toBeNull();
    expect(askRises({ ...income, props: { proposal: { proposed_at: "2026-09-13T10:05:00Z" } } }, aside)).toBe("proposal");
    expect(askRises({ ...goal, props: { requested_by: "card.request" } }, new Set([askStamp(goal)]))).toBe("requested");
  });
});
