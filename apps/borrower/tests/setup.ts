import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: unknown } & Record<string, unknown>) =>
    createElement("a", { href: typeof href === "string" ? href : "/", ...rest }, children as never),
}));
