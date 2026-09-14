/**
 * docs/ux/18 W1 — Workspace Home: glance always visible, Approvals resolve through
 * the existing card, Guide is a control, Pay is hidden on a monitored loan.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "@/components/workspace/WorkspaceHome";
import { loadFixture } from "@/lib/fixtures";
import { copy } from "@/lib/copy";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";

const user = userEvent.setup();
const cardMap = (cards: AnyCardInstance[]) => Object.fromEntries(cards.map((c) => [c.card_instance_id, c]));

describe("docs/ux/18 W1 — Workspace Home", () => {
  it("servicing glance shows Numbers (not empty) and a pending PaymentCard under Approvals; Pay shortcut focuses it", async () => {
    const f = loadFixture("servicing");
    const onFocus = vi.fn();
    render(
      <WorkspaceHome
        record={f.record}
        cards={cardMap(f.cards)}
        timezone={f.record.timezone}
        cardProps={{ onOpen: () => undefined, onLaunchVendor: async () => ({ vendor_session_id: "FAKE" }), onUpload: async () => ({ document_id: "d" }) }}
        resolve={async () => undefined}
        cardErrors={{}}
        currentAskId="card-s-pay"
        onOpenGuide={() => undefined}
        onFocusCard={onFocus}
        onOpenRecord={() => undefined}
        onOpenDocument={() => undefined}
      />,
    );
    expect(screen.getByTestId("workspace-home")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-numbers")).toHaveTextContent("Balance");
    expect(screen.getByTestId("workspace-autopay")).toHaveTextContent(copy("workspace.glance.autopay_on"));
    expect(screen.getByTestId("workspace-glance")).not.toHaveAttribute("data-empty");
    const payRow = document.querySelector('[data-rail-card="card-s-pay"]');
    expect(payRow).toHaveAttribute("data-expanded", "true");
    await user.click(screen.getByTestId("shortcut-pay"));
    expect(onFocus).toHaveBeenCalledWith("card-s-pay");
  });

  it("Approvals resolve a PaymentCard through resolveCard (no parallel commit)", async () => {
    const f = loadFixture("servicing");
    const resolve = vi.fn(async (_card: AnyCardInstance, _req: ResolveRequest) => undefined);
    render(
      <WorkspaceHome
        record={f.record}
        cards={cardMap(f.cards)}
        timezone={f.record.timezone}
        cardProps={{ onOpen: () => undefined, onLaunchVendor: async () => ({ vendor_session_id: "FAKE" }), onUpload: async () => ({ document_id: "d" }) }}
        resolve={resolve}
        cardErrors={{}}
        currentAskId="card-s-pay"
        onOpenGuide={() => undefined}
        onFocusCard={() => undefined}
        onOpenRecord={() => undefined}
        onOpenDocument={() => undefined}
      />,
    );
    await user.click(within(screen.getByTestId("workspace-approvals")).getByRole("button", { name: "Pay now" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0].card_instance_id).toBe("card-s-pay");
  });

  it("Guide control is on Home; refinance glance shows pre-funding numbers and Application, not Pay", () => {
    const f = loadFixture("refinance");
    const onOpenGuide = vi.fn();
    render(
      <WorkspaceHome
        record={f.record}
        cards={cardMap(f.cards)}
        timezone={f.record.timezone}
        cardProps={{ onOpen: () => undefined, onLaunchVendor: async () => ({ vendor_session_id: "FAKE" }), onUpload: async () => ({ document_id: "d" }) }}
        resolve={async () => undefined}
        cardErrors={{}}
        onOpenGuide={onOpenGuide}
        onFocusCard={() => undefined}
        onOpenRecord={() => undefined}
        onOpenDocument={() => undefined}
      />,
    );
    expect(screen.getByTestId("workspace-numbers")).toHaveTextContent("Rate");
    expect(screen.getByTestId("shortcut-application")).toBeInTheDocument();
    expect(screen.queryByTestId("shortcut-pay")).toBeNull();
    expect(screen.getByTestId("shortcut-guide")).toHaveTextContent(copy("workspace.guide.open"));
  });

  it("monitored Home names the partner as servicer, hides Pay, and uses partner_book.review for What's happening", () => {
    const f = loadFixture("monitored");
    render(
      <WorkspaceHome
        record={f.record}
        cards={cardMap(f.cards)}
        timezone={f.record.timezone}
        cardProps={{ onOpen: () => undefined, onLaunchVendor: async () => ({ vendor_session_id: "FAKE" }), onUpload: async () => ({ document_id: "d" }) }}
        resolve={async () => undefined}
        cardErrors={{}}
        onOpenGuide={() => undefined}
        onFocusCard={() => undefined}
        onOpenRecord={() => undefined}
        onOpenDocument={() => undefined}
      />,
    );
    expect(screen.getByTestId("workspace-glance")).toHaveAttribute("data-monitored", "true");
    expect(screen.getByTestId("workspace-status-line")).toHaveTextContent("Mesa Verde Mortgage Servicing still services this loan");
    expect(screen.getByTestId("workspace-status-line")).not.toHaveTextContent("Supermortgage is your servicer");
    expect(screen.queryByTestId("shortcut-pay")).toBeNull();
    expect(screen.getByTestId("workspace-no-pay")).toHaveTextContent(copy("workspace.shortcuts.no_pay_partner", { servicer: "Mesa Verde Mortgage Servicing" }));
    expect(screen.getByTestId("workspace-happening-list")).toHaveTextContent("The rate is not there yet");
    expect((screen.getByTestId("workspace-happening-list").textContent ?? "").match(/The rate is not there yet/g)?.length).toBe(1);
    expect(screen.getByTestId("workspace-numbers")).toHaveTextContent("Balance");
  });
});
