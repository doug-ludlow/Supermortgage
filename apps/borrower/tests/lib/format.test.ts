import { describe, expect, it } from "vitest";
import { countdown, formatMoney, formatMoneySigned, formatRate, sumCents, toCents } from "@/lib/format";
import { COPY, COPY_KEY_COUNT, FORBIDDEN_WORDS, copy, copyExtra, copyOptions, renderTemplate } from "@/lib/copy";

describe("money from bigint cents (T-X-09)", () => {
  it("formats the refinance fixture loan amount exactly", () => {
    expect(formatMoney("56000000")).toBe("$560,000.00");
    expect(formatMoney("56000000", { whole: true })).toBe("$560,000");
    expect(formatMoney(56000000n)).toBe("$560,000.00");
  });
  it("keeps cents exact where a float would not", () => {
    expect(formatMoney("1")).toBe("$0.01");
    expect(formatMoney("10")).toBe("$0.10");
    expect(formatMoney("123456789012345678")).toBe("$1,234,567,890,123,456.78");
    expect(formatMoney("-250075")).toBe("−$2,500.75");
    expect(formatMoneySigned("21240")).toBe("+$212.40");
  });
  it("rejects non-integer strings", () => {
    expect(() => toCents("12.50")).toThrow();
    expect(() => formatMoney("abc")).toThrow();
  });
  it("sums as bigint", () => {
    expect(sumCents("100", "250", 5n)).toBe(355n);
  });
});

describe("rates from decimal strings", () => {
  it("renders 6.125% and 6.375%", () => {
    expect(formatRate("6.125")).toBe("6.125%");
    expect(formatRate("6.375")).toBe("6.375%");
    expect(formatRate("5.5")).toBe("5.500%");
  });
});

describe("countdown", () => {
  it("flags < 72h", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    expect(countdown("2026-10-22T12:00:00Z", now)).toMatchObject({ under72h: true, text: "2 days 0 hours left" });
    expect(countdown("2026-10-25T12:00:00Z", now).under72h).toBe(false);
    expect(countdown("2026-10-19T12:00:00Z", now).expired).toBe(true);
  });
});

describe("copy library (generated from docs/ux/12)", () => {
  it("has every section's keys", () => {
    expect(COPY_KEY_COUNT).toBeGreaterThanOrEqual(140);
    expect(Object.keys(COPY).length).toBe(COPY_KEY_COUNT);
    expect(COPY["entry.disclosure.first"].text).toContain("automated assistant");
    expect(copyOptions("entry.goal.question")).toEqual(["Buy a home", "Lower my rate or payment", "Take cash out"]);
    expect(copyExtra("le.delivered", "why")).toContain("Confirming receipt starts the timeline");
  });
  it("renders tokens, including repeated ones in order", () => {
    expect(copy("lock.executed", { rate: "6.125%", expires_at: "Nov 20, 2026" })).toBe(
      "Locked: 6.125% through Nov 20, 2026. An updated Loan Estimate follows within 3 business days.",
    );
    expect(renderTemplate("{{money}} then {{money}}", { money: ["$1.00", "$2.00"] })).toBe("$1.00 then $2.00");
    expect(renderTemplate("{{price|requested}}", { requested: "$500,000.00" })).toBe("$500,000.00");
  });
  it("T-X-14 forbidden words outside allowed keys", () => {
    const violations: string[] = [];
    for (const [key, entry] of Object.entries(COPY)) {
      const text = [entry.text, ...entry.extras].join(" ");
      for (const rule of FORBIDDEN_WORDS) {
        if (rule.word.test(text) && !rule.allowedKeyPrefixes.some((p) => key.startsWith(p))) violations.push(`${key}: ${rule.word}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
