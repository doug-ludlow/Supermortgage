import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatRate, mask4, plural, toCents, words } from "@/lib/format";

describe("money from bigint cents (never a number dollar)", () => {
  it("formats 33.1-T2's worked figures exactly", () => {
    expect(formatMoney("44136613")).toBe("$441,366.13");   // loan 1's UPB
    expect(formatMoney("306979")).toBe("$3,069.79");        // loan 1's P&I
    expect(formatMoney("60500000")).toBe("$605,000.00");    // loan 1's value
    expect(formatMoney(306979n)).toBe("$3,069.79");
  });
  it("keeps cents exact where a float would not", () => {
    expect(formatMoney("1")).toBe("$0.01");
    expect(formatMoney("123456789012345678")).toBe("$1,234,567,890,123,456.78");
    expect(formatMoney("-250075")).toBe("−$2,500.75");
  });
  it("shows a dash for nothing and rejects a non-integer string", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(() => toCents("12.50")).toThrow();
    expect(() => formatMoney("abc")).toThrow();
  });
});

describe("rates from the tape's percent strings", () => {
  it("renders 7.250%, 6.375% and the watch rate 5.625%", () => {
    expect(formatRate("7.25")).toBe("7.250%");
    expect(formatRate("6.375")).toBe("6.375%");
    expect(formatRate("5.625")).toBe("5.625%");
    expect(formatRate(null)).toBe("—");
    expect(() => formatRate("seven")).toThrow();
  });
});

describe("dates, masks and words", () => {
  it("formats a civil date without a time-zone shift and an instant in ET", () => {
    expect(formatDate("2026-09-01")).toBe("Sep 1, 2026");
    expect(formatDate("2026-09-15T11:05:00.000Z")).toBe("Sep 15, 2026");
    expect(formatDate(null)).toBe("—");
  });
  it("never shows more than the last four", () => {
    expect(mask4("NL-100001")).toBe("••••0001");
    expect(mask4("0001")).toBe("••••0001");
    expect(mask4(null)).toBe("—");
  });
  it("pluralises and words a code", () => {
    expect(plural(1, "loan", "loans")).toBe("1 loan");
    expect(plural(12, "loan", "loans")).toBe("12 loans");
    expect(words("not_on_latest_tape")).toBe("not on latest tape");
  });
});
